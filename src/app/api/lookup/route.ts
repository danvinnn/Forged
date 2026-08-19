import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getDeploymentMode,
  makeResolver,
  clientKey,
  activeLookupLimiter,
  toRetrievalSource,
  type DeploymentMode,
  type RetrievalError,
  type RetrievalErrorCode,
  type RetrievalSuccess
} from "../../../lib/retrieval";
import { extractPartRecord } from "../../../lib/datasheet";
import { PdfExtractionError, type DatasheetText } from "../../../lib/pdftext";
import { makeExtractionModel, runExtraction } from "../../../lib/extraction";
import {
  ModelDeadlineError,
  modelBudgetMs,
  withDeadline,
  worthAsking
} from "../../../lib/extraction/budget";
import { type RenderedPage } from "../../../lib/pagerender";
import { buildReadout } from "../../../lib/readout";
import { type PackageDrawing } from "../../../lib/packagedrawing";
import { type PackageChoice } from "../../../lib/exporters";
import { type ConfidenceCheck } from "../../../lib/confidence";
import { type ReviewItem } from "../../../lib/review";
import { type PartRecord } from "../../../lib/types";

/**
 * How much of a route's remaining budget rendering may take.
 *
 * `renderPages` returns FEWER PAGES rather than throwing when it runs out of
 * time, so an unbounded render inside a deadlined route does not fail loudly: it
 * quietly thins the second pass, and the part reads worse for a reason nothing
 * reports. That became live on 2026-08-18 when the page budget went from 8 to
 * 16 and the render ceiling, which is sized from it, went to about 24 seconds
 * inside a route allowed 30.
 *
 * A third leaves two thirds for the two model calls, which are the part of the
 * work that cannot be made cheaper by doing less of it.
 */
const RENDER_SHARE_OF_BUDGET = 1 / 3;

export const runtime = "nodejs";
// Ceiling so a slow retrieval or parse cannot hold a serverless function open indefinitely.
export const maxDuration = 30;

/**
 * The model pass gets a budget carved out of this route's own, exactly as on
 * `/api/parse`. See `extraction/budget.ts` for the measured numbers.
 */
const ROUTE_BUDGET_MS = maxDuration * 1000;

// Bounded on purpose. Real manufacturer part numbers top out well under 64 characters, and these
// strings are interpolated into vendor URLs and search queries, so an unbounded input is both a
// memory concern and a way to generate absurd outbound requests from a public endpoint.
const MAX_PART_NUMBER_LENGTH = 64;
const MAX_MANUFACTURER_LENGTH = 64;

// A package designator is a short printed token; anything longer is not one.
const MAX_PACKAGE_LENGTH = 64;

const lookupSchema = z.object({
  partNumber: z.string().trim().min(1).max(MAX_PART_NUMBER_LENGTH),
  manufacturer: z.string().trim().min(1).max(MAX_MANUFACTURER_LENGTH).optional(),
  // The package the caller picked, on a second lookup made because the first
  // could not tell which of the document's packages they hold. See
  // `buildPartRecord`; this is the argument the pin readers use to choose among
  // per-package pinouts.
  packageType: z.string().trim().min(1).max(MAX_PACKAGE_LENGTH).optional()
});

function fail(code: RetrievalErrorCode, error: string, mode: DeploymentMode, status: number) {
  return NextResponse.json<RetrievalError>({ error, code, mode }, { status });
}

function normalizePartNumber(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

// Layer 2 extraction on already-retrieved bytes. makeExtractionModel picks the model for the
// deployment mode and reaches concrete models through dynamic imports, so the cloud model is never
// loaded in air-gapped mode. This mirrors the resolver air-gap guard.
async function extractPart(
  ref: { fileName: string; bytes: ArrayBuffer; pdfUrl?: string },
  mode: DeploymentMode,
  partNumberHint?: string,
  packageHint?: string,
  /** What is left of the route's own budget when this is called. */
  budgetMs = ROUTE_BUDGET_MS
): Promise<{ part: PartRecord; method: string; doc: DatasheetText; rendered: RenderedPage[] }> {
  const { doc, part } = await extractPartRecord(ref.fileName, ref.bytes, ref.pdfUrl, {
    packageType: packageHint
  });

  const model = await makeExtractionModel(mode);
  if (!model) return { part, method: "text only", doc, rendered: [] };

  // THE SAME DEADLINE `/api/parse` ENFORCES.
  //
  // This route ran the model with no budget at all while the other one carved
  // one out, checked it was worth asking, and raced the call against it. Both
  // have `maxDuration = 30`, a model call can take 41.6 seconds, and THIS route
  // spends part of its budget fetching the PDF over the network first, so it is
  // the likelier of the two to be killed by the platform. Being killed costs the
  // user the record that had already succeeded and returns a 504, which is
  // exactly what `budget.ts` exists to prevent. One rule, both callers.
  if (!worthAsking(budgetMs)) {
    return {
      part: {
        ...part,
        notes: [
          ...part.notes,
          `Finding and parsing the datasheet used the request's time budget, so the ${model.name} extraction pass was skipped.`
        ]
      },
      method: "text only",
      doc,
      rendered: []
    };
  }

  try {
    const outcome = await withDeadline(
      runExtraction(
        part,
        doc,
        ref.bytes,
        model,
        ref.fileName,
        partNumberHint,
        Math.round(budgetMs * RENDER_SHARE_OF_BUDGET)
      ),
      budgetMs
    );
    if (!outcome) return { part, method: "text only", doc, rendered: [] };
    // The renders the model was already shown, rather than a second pass over
    // the same pages. The review panel shows a reviewer the page a value was
    // read from, and `runExtraction` has already rasterised exactly those pages.
    return {
      part: outcome.part,
      method: outcome.filled.length > 0 ? `read by ${model.name}` : "text only",
      doc,
      rendered: outcome.renderedImages
    };
  } catch (error) {
    // The record is still useful; a model outage must not lose it. A deadline is
    // reported as what it is rather than as a failure, because the two call for
    // different actions: one is retryable, the other means this document is too
    // big for this route's budget.
    const timedOut = error instanceof ModelDeadlineError;
    if (!timedOut) console.error("extraction model failed", error);
    return {
      part: {
        ...part,
        notes: [
          ...part.notes,
          timedOut
            ? `The ${model.name} extraction pass did not answer within its ${Math.round(budgetMs / 1000)}s budget and was abandoned, so nothing was read off the document.`
            : `The ${model.name} extraction pass failed, so nothing was read off the document.`
        ]
      },
      method: "text only",
      doc,
      rendered: []
    };
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const mode = getDeploymentMode();

  // Rate limit BEFORE any parsing or resolution work. This route fans out to vendor sites and
  // search engines, so an unlimited endpoint turns Forge into a traffic amplifier pointed at
  // third parties we depend on.
  const limit = await activeLookupLimiter().check(clientKey(request));
  if (!limit.allowed) {
    return NextResponse.json<RetrievalError>(
      { error: "Too many lookups. Try again shortly.", code: "RATE_LIMITED", mode },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  const payload = await request.json().catch(() => null);
  const parsed = lookupSchema.safeParse(payload);
  if (!parsed.success) {
    return fail("PART_NUMBER_REQUIRED", "Part number is required.", mode, 400);
  }
  const { partNumber, manufacturer, packageType } = parsed.data;

  // Air-gap gate. In air-gapped mode makeResolver returns null after failing closed, so no network
  // code is even loaded. Part-number lookup is a network operation and is unavailable here.
  const resolver = await makeResolver(mode);
  if (!resolver) {
    return fail(
      "AIRGAP_LOOKUP_DISABLED",
      "Part-number lookup is disabled in air-gapped mode. Upload the datasheet PDF instead.",
      mode,
      403
    );
  }

  // Retrieval (Layer 1): a deterministic resolver finds the datasheet. We never let a model find
  // the URL; that hallucinates dead links. Manufacturer-direct primary, scrape fallback.
  let ref;
  try {
    ref = await resolver.resolve(partNumber, manufacturer ? { manufacturer } : undefined);
  } catch (error) {
    // Never return the raw error to the client. The composite's aggregate message names internal
    // resolvers, URLs, and upstream failure detail, which is operator information, not user
    // information, and handing it to an anonymous caller maps out our internals for them.
    console.error("[lookup] resolver chain failed", {
      partNumber,
      message: error instanceof Error ? error.message : String(error)
    });
    return fail(
      "RESOLVER_FAILED",
      "Could not retrieve the datasheet right now. Upload the PDF directly instead.",
      mode,
      502
    );
  }

  if (!ref) {
    return fail(
      "DATASHEET_NOT_FOUND",
      `No datasheet found for ${partNumber}. Try a manufacturer hint or upload the PDF directly.`,
      mode,
      404
    );
  }

  // Extraction (Layer 2 hand-off): the resolver produced validated bytes; parse them.
  let part;
  let method;
  let doc;
  let rendered;
  try {
    ({ part, method, doc, rendered } = await extractPart(
      ref,
      mode,
      partNumber,
      packageType,
      modelBudgetMs(ROUTE_BUDGET_MS, Date.now() - startedAt)
    ));
  } catch (error) {
    // The resolver found a real PDF, but it is too large or complex to parse.
    // That is a property of the document, not a server fault.
    if (error instanceof PdfExtractionError) {
      return NextResponse.json<RetrievalError>(
        { error: error.message, code: "PARSE_LIMIT_EXCEEDED", mode },
        { status: 422 }
      );
    }
    throw error;
  }

  // Keep the user-requested part number when the parser captured an unrelated token, and fill the
  // manufacturer hint when the parser could not find one.
  const requestedPart = normalizePartNumber(partNumber);
  const parsedPart = normalizePartNumber(part.partNumber.value ?? "");
  if (!parsedPart || (!parsedPart.includes(requestedPart) && !requestedPart.includes(parsedPart))) {
    // Supplied by the requester, not read off the datasheet, so it carries no
    // citation and is marked as such rather than inheriting the parser's.
    part.partNumber = { value: requestedPart, confidence: 1, method: "user", citation: null };
  }
  if (manufacturer && part.manufacturer.value === null) {
    part.manufacturer = { value: manufacturer, confidence: 1, method: "user", citation: null };
  }
  part.sourceUrl = ref.pdfUrl;
  part.notes = [`Resolved via ${resolver.name} (${method}): ${ref.pdfUrl ?? ref.fileName}.`, ...part.notes];

  // THE SECOND HALF, which this route did not do until 2026-08-16.
  //
  // It answered with the bare record: no package chooser, no confidence checks,
  // no review panel, no rendered pages, and no repair of `vendorLandPattern`.
  // The UI's `absorb` then blanked all of them, so a looked-up part arrived with
  // the questions answered and none of the answers shown.
  //
  // Not merely cosmetic. `resolveForExport` refuses a model value carrying no
  // citation, and confirming one in the review panel is the only thing that
  // clears it, so a looked-up part with an uncited geometry value could not be
  // exported by any route the user has.
  //
  // Shared with `/api/parse` rather than copied. Past the point where the bytes
  // are in hand the two are the same operation, and two copies is exactly how
  // the second half came to exist on only one of them.
  const readout = await buildReadout(part, doc, ref.bytes, rendered);

  return NextResponse.json<
    RetrievalSuccess & {
      method: string;
      packageDrawing: PackageDrawing | null;
      packageChoice: PackageChoice;
      checks: ConfidenceCheck[];
      review: ReviewItem[];
      reviewPages: RenderedPage[];
    }
  >({
    part: readout.part,
    source: toRetrievalSource(ref, "resolver", resolver.name),
    mode,
    method,
    packageDrawing: readout.packageDrawing,
    packageChoice: readout.packageChoice,
    checks: readout.checks,
    review: readout.review,
    reviewPages: readout.reviewPages
  });
}
