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
import { parseDatasheetPdf } from "../../../lib/datasheet";

export const runtime = "nodejs";
// Ceiling so a slow retrieval or parse cannot hold a serverless function open indefinitely.
export const maxDuration = 30;

// Enterprise / air-gapped retrieval path: the user uploads the PDF directly. ingestUpload is the
// Layer 1 step (validate, produce a DatasheetRef) and makes no network call, so this route is safe
// in air-gapped mode.
//
// Extraction (Layer 2): Gemini is a cloud model, so it is gated to commercial mode and reached
// only through a dynamic import. In air-gapped mode the cloud module is never loaded and the
// deterministic parser runs. Proper extraction (local open-weight fallback for air-gapped) is
// Layer 2 work; this preserves the existing Gemini demo path without breaking the air gap.
export async function POST(request: Request) {
  const mode = getDeploymentMode();

  // Each call buffers and hashes megabytes, so the endpoint needs a ceiling even though it makes
  // no outbound request.
  const limit = activeUploadLimiter().check(clientKey(request));
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

  let part;
  let method: "gemini" | "regex";
  if (mode === "commercial" && process.env.GOOGLE_GEMINI_API_KEY) {
    const { parseDatasheetWithGemini } = await import("../../../lib/datasheet-gemini");
    const result = await parseDatasheetWithGemini(Buffer.from(ref.bytes), ref.fileName);
    part = result.part;
    method = "gemini";
  } else {
    part = await parseDatasheetPdf(ref.fileName, ref.bytes);
    method = "regex";
  }

  return NextResponse.json<RetrievalSuccess & { method: string }>({
    part,
    source: toRetrievalSource(ref, "upload"),
    mode,
    method
  });
}
