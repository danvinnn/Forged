import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getDeploymentMode,
  makeResolver,
  toRetrievalSource,
  type DeploymentMode,
  type RetrievalError,
  type RetrievalErrorCode,
  type RetrievalSuccess
} from "../../../lib/retrieval";
import { parseDatasheetPdf } from "../../../lib/datasheet";
import { type PartRecord } from "../../../lib/types";

export const runtime = "nodejs";

const lookupSchema = z.object({
  partNumber: z.string().trim().min(1),
  manufacturer: z.string().trim().min(1).optional()
});

function fail(code: RetrievalErrorCode, error: string, mode: DeploymentMode, status: number) {
  return NextResponse.json<RetrievalError>({ error, code, mode }, { status });
}

function normalizePartNumber(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

// Layer 2 extraction on already-retrieved bytes. Gemini is a cloud model, so it is gated to
// commercial mode and reached only through a dynamic import: in air-gapped mode the cloud module
// is never loaded and the deterministic parser is used. This mirrors the resolver air-gap guard.
// Proper extraction (the ExtractionModel interface, local open-weight fallback for air-gapped)
// is Layer 2 work; this is a demo-mode bridge that preserves the existing Gemini path safely.
async function extractPart(
  ref: { fileName: string; bytes: ArrayBuffer; pdfUrl?: string },
  mode: DeploymentMode,
  partNumberHint?: string
): Promise<{ part: PartRecord; method: "gemini" | "regex" }> {
  if (mode === "commercial" && process.env.GOOGLE_GEMINI_API_KEY) {
    const { parseDatasheetWithGemini } = await import("../../../lib/datasheet-gemini");
    const result = await parseDatasheetWithGemini(
      Buffer.from(ref.bytes),
      ref.pdfUrl ?? ref.fileName,
      partNumberHint
    );
    return { part: result.part, method: "gemini" };
  }
  const part = await parseDatasheetPdf(ref.fileName, ref.bytes, ref.pdfUrl);
  return { part, method: "regex" };
}

export async function POST(request: Request) {
  const mode = getDeploymentMode();

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
  // the URL; that hallucinates dead links. Nexar primary, scrape fallback.
  let ref;
  try {
    ref = await resolver.resolve(partNumber, manufacturer ? { manufacturer } : undefined);
  } catch (error) {
    return fail(
      "RESOLVER_FAILED",
      error instanceof Error ? error.message : "Failed to resolve datasheet.",
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
  const { part, method } = await extractPart(ref, mode, partNumber);

  // Keep the user-requested part number when the parser captured an unrelated token, and fill the
  // manufacturer hint when the parser could not find one.
  const requestedPart = normalizePartNumber(partNumber);
  const parsedPart = normalizePartNumber(part.partNumber || "");
  if (!parsedPart || (!parsedPart.includes(requestedPart) && !requestedPart.includes(parsedPart))) {
    part.partNumber = requestedPart;
  }
  if (manufacturer && part.manufacturer === "Unknown") {
    part.manufacturer = manufacturer;
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
