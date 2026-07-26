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
import { PdfExtractionError } from "../../../lib/pdftext";
import { buildExtractionRequest, makeExtractionModel, mergeModelValues } from "../../../lib/extraction";
import { type PartRecord } from "../../../lib/types";

export const runtime = "nodejs";
// Ceiling so a slow retrieval or parse cannot hold a serverless function open indefinitely.
export const maxDuration = 30;

// Bounded on purpose. Real manufacturer part numbers top out well under 64 characters, and these
// strings are interpolated into vendor URLs and search queries, so an unbounded input is both a
// memory concern and a way to generate absurd outbound requests from a public endpoint.
const MAX_PART_NUMBER_LENGTH = 64;
const MAX_MANUFACTURER_LENGTH = 64;

const lookupSchema = z.object({
  partNumber: z.string().trim().min(1).max(MAX_PART_NUMBER_LENGTH),
  manufacturer: z.string().trim().min(1).max(MAX_MANUFACTURER_LENGTH).optional()
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
  partNumberHint?: string
): Promise<{ part: PartRecord; method: string }> {
  // Deterministic pass first, always. A model only fills what it could not read.
  const { doc, part } = await extractPartRecord(ref.fileName, ref.bytes, ref.pdfUrl);

  const model = await makeExtractionModel(mode);
  if (!model) return { part, method: "deterministic" };

  const request = buildExtractionRequest(part, doc, ref.fileName, partNumberHint);
  if (!request) return { part, method: "deterministic" };

  try {
    const result = await model.extract(request);
    const outcome = mergeModelValues(part, doc, result, model.name);
    return {
      part: outcome.part,
      method: outcome.filled.length > 0 ? `deterministic+${model.name}` : "deterministic"
    };
  } catch (error) {
    // The deterministic record is still useful; a model outage must not lose it.
    console.error("extraction model failed", error);
    return {
      part: { ...part, notes: [...part.notes, `The ${model.name} extraction pass failed; only text extraction was applied.`] },
      method: "deterministic"
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
  const { partNumber, manufacturer } = parsed.data;

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
  try {
    ({ part, method } = await extractPart(ref, mode, partNumber));
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

  return NextResponse.json<RetrievalSuccess & { method: string }>({
    part,
    source: toRetrievalSource(ref, "resolver", resolver.name),
    mode,
    method
  });
}
