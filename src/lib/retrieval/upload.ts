// Enterprise / air-gapped retrieval: the user hands us the PDF directly. This is the primary real
// path for customers whose controlled datasheets cannot leave their network.
//
// Air-gap safety: this module makes no network calls and imports nothing that does. It is the
// retrieval path that runs in air-gapped mode, so it must stay network-free forever.

import type { DatasheetRef } from "./resolver";
import { finalizeRef } from "./ref";
import { PdfValidationError } from "./pdf";

export interface UploadInput {
  fileName: string;
  bytes: ArrayBuffer;
}

export class UploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadValidationError";
  }
}

// Turns raw uploaded bytes into a DatasheetRef, the same hand-off type the resolvers produce, so
// the parser plug-in point does not care where the PDF came from. Byte validation, filename
// sanitization, and hashing all happen inside finalizeRef; this function adds the upload-specific
// checks (a name is present and claims to be a PDF) and normalizes PDF byte errors into an upload
// error for a clean 400 at the route.
export function ingestUpload(input: UploadInput): DatasheetRef {
  const fileName = input.fileName?.trim();
  if (!fileName) {
    throw new UploadValidationError("Upload is missing a file name.");
  }
  if (!fileName.toLowerCase().endsWith(".pdf")) {
    throw new UploadValidationError("Only PDF uploads are supported.");
  }

  try {
    return finalizeRef({ fileName, bytes: input.bytes });
  } catch (error) {
    if (error instanceof PdfValidationError) {
      throw new UploadValidationError(error.message);
    }
    throw error;
  }
}
