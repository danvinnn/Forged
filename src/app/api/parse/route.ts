import { NextResponse } from "next/server";
import {
  getDeploymentMode,
  ingestUpload,
  clientKey,
  activeUploadLimiter,
  MAX_PDF_BYTES,
  UploadValidationError,
  toRetrievalSource,
  type RetrievalError,
  type RetrievalSuccess
} from "../../../lib/retrieval";
import { extractPartRecord } from "../../../lib/datasheet";
import { PdfExtractionError } from "../../../lib/pdftext";
// The extraction layer's public surface deliberately excludes the concrete
// models, so importing it cannot pull a networked model into the air-gapped
// module graph. makeExtractionModel reaches those by dynamic import.
import { buildExtractionRequest, makeExtractionModel, mergeModelValues } from "../../../lib/extraction";

export const runtime = "nodejs";
// Ceiling so a slow retrieval or parse cannot hold a serverless function open indefinitely.
export const maxDuration = 30;

// Enterprise / air-gapped retrieval path: the user uploads the PDF directly. ingestUpload is the
// Layer 1 step (validate, produce a DatasheetRef) and makes no network call, so this route is safe
// in air-gapped mode.
//
// Extraction (Layer 2): the deterministic text pass always runs and always wins. A model is asked
// only about fields it could not resolve, and can never overwrite one it did. Which model is even
// available is decided by makeExtractionModel, which reaches concrete models through dynamic
// imports so the cloud model is never loaded in air-gapped mode.
export async function POST(request: Request) {
  const mode = getDeploymentMode();

  // Each call buffers and hashes megabytes, so the endpoint needs a ceiling even though it makes
  // no outbound request.
  const limit = await activeUploadLimiter().check(clientKey(request));
  if (!limit.allowed) {
    return NextResponse.json<RetrievalError>(
      { error: "Too many uploads. Try again shortly.", code: "RATE_LIMITED", mode },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  // Reject on the declared body size BEFORE parsing the multipart body. request.formData() buffers
  // the entire body into memory, so by the time assertPdfBytes runs inside ingestUpload the damage
  // is done: a 1GB POST would OOM the process long before anything validated it. Same bug class as
  // the download path, and it needed the same fix. The header can lie, which is why the real
  // file.size check below still runs.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_BYTES) {
    return NextResponse.json<RetrievalError>(
      { error: "File is larger than the 50MB limit.", code: "UPLOAD_INVALID", mode },
      { status: 413 }
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    // Malformed multipart, or a body the platform cut off. Not a crash.
    return NextResponse.json<RetrievalError>(
      { error: "Could not read the uploaded file.", code: "UPLOAD_INVALID", mode },
      { status: 400 }
    );
  }

  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json<RetrievalError>(
      { error: "Missing PDF upload.", code: "UPLOAD_INVALID", mode },
      { status: 400 }
    );
  }

  // Check the real size before calling arrayBuffer(), which is the allocation that would hurt.
  if (file.size > MAX_PDF_BYTES) {
    return NextResponse.json<RetrievalError>(
      { error: "File is larger than the 50MB limit.", code: "UPLOAD_INVALID", mode },
      { status: 413 }
    );
  }

  let ref;
  try {
    ref = ingestUpload({ fileName: file.name, bytes: await file.arrayBuffer() });
  } catch (error) {
    if (error instanceof UploadValidationError) {
      return NextResponse.json<RetrievalError>(
        { error: error.message, code: "UPLOAD_INVALID", mode },
        { status: 400 }
      );
    }
    throw error;
  }

  // Deterministic pass ALWAYS runs first and always wins. A model is only ever
  // asked about fields the code could not read off the page.
  let doc;
  let part;
  try {
    const extracted = await extractPartRecord(ref.fileName, ref.bytes);
    doc = extracted.doc;
    part = extracted.part;
  } catch (error) {
    // A structurally valid PDF that is too large or too complex to parse is bad
    // input, not a server fault, and must not read as a crash.
    if (error instanceof PdfExtractionError) {
      return NextResponse.json<RetrievalError>(
        { error: error.message, code: "PARSE_LIMIT_EXCEEDED", mode },
        { status: 422 }
      );
    }
    throw error;
  }
  let method = "deterministic";

  const model = await makeExtractionModel(mode);
  if (model) {
    const request = buildExtractionRequest(part, doc, ref.fileName);
    if (request) {
      try {
        const result = await model.extract(request);
        const outcome = mergeModelValues(part, doc, result, model.name);
        part = outcome.part;
        if (outcome.filled.length > 0) method = `deterministic+${model.name}`;
      } catch (error) {
        // A model failure must never cost the user the deterministic record.
        console.error("extraction model failed", error);
        part = {
          ...part,
          notes: [...part.notes, `The ${model.name} extraction pass failed; only text extraction was applied.`]
        };
      }
    }
  }

  return NextResponse.json<RetrievalSuccess & { method: string }>({
    part,
    source: toRetrievalSource(ref, "upload"),
    mode,
    method
  });
}
