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
import { renderPages, type RenderedPage } from "../../../lib/pagerender";
import { buildReadout } from "../../../lib/readout";
import { type PackageDrawing } from "../../../lib/packagedrawing";
import { type PackageChoice } from "../../../lib/exporters";
import { type ConfidenceCheck } from "../../../lib/confidence";
import { type ReviewItem } from "../../../lib/review";
import { type PartRecord } from "../../../lib/types";

export const runtime = "nodejs";
// Ceiling so a slow retrieval or parse cannot hold a serverless function open indefinitely.
export const maxDuration = 30;

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

// Layer 2 extraction on already-retrieved bytes. The deterministic text pass always runs and always
// wins; a model only fills fields it could not resolve. makeExtractionModel picks the model for the
// deployment mode and reaches concrete models through dynamic imports, so the cloud model is never
// loaded in air-gapped mode. This mirrors the resolver air-gap guard.
async function extractPart(
  ref: { fileName: string; bytes: ArrayBuffer; pdfUrl?: string },
  mode: DeploymentMode,
  partNumberHint?: string,
  packageHint?: string
): Promise<{ part: PartRecord; method: string; doc: DatasheetText; rendered: RenderedPage[] }> {
  // Deterministic pass first, always. A model only fills what it could not read.
  const { doc, part } = await extractPartRecord(ref.fileName, ref.bytes, ref.pdfUrl, {
    packageType: packageHint
  });

  const model = await makeExtractionModel(mode);
  if (!model) return { part, method: "deterministic", doc, rendered: [] };

  try {
    const outcome = await runExtraction(part, doc, ref.bytes, model, ref.fileName, partNumberHint);
    if (!outcome) return { part, method: "deterministic", doc, rendered: [] };
    // The pages the model asked to SEE, kept rather than dropped. The review
    // panel shows a reviewer the page a value was read from, and re-rendering a
    // page already rasterised for the model is pure waste. This route discarded
    // them, which is part of why it had no panel to show.
    const rendered = await renderPages(ref.bytes, outcome.renderedPages, { maxPages: 8 });
    return {
      part: outcome.part,
      method: outcome.filled.length > 0 ? `deterministic+${model.name}` : "deterministic",
      doc,
      rendered
    };
  } catch (error) {
    // The deterministic record is still useful; a model outage must not lose it.
    console.error("extraction model failed", error);
    return {
      part: { ...part, notes: [...part.notes, `The ${model.name} extraction pass failed; only text extraction was applied.`] },
      method: "deterministic",
      doc,
      rendered: []
    };
  }
}

export async function POST(request: Request) {
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
    ({ part, method, doc, rendered } = await extractPart(ref, mode, partNumber, packageType));
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
