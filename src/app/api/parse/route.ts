import { NextResponse } from "next/server";
import {
  getDeploymentMode,
  ingestUpload,
  UploadValidationError,
  toRetrievalSource,
  type RetrievalError,
  type RetrievalSuccess
} from "../../../lib/retrieval";
import { parseDatasheetPdf } from "../../../lib/datasheet";

export const runtime = "nodejs";

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
  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json<RetrievalError>(
      { error: "Missing PDF upload.", code: "UPLOAD_INVALID", mode },
      { status: 400 }
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
