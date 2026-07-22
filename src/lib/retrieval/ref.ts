// The one sanctioned way to build a DatasheetRef. Every path that produces a ref (upload and all
// resolvers) goes through here, so a single choke point guarantees three things about anything
// that leaves the retrieval layer: the bytes are a real PDF, the filename is safe, and the ref
// carries the size and hash that downstream audit and citations need.
//
// Air-gap safety: no network, no imports that reach the network.

import type { DatasheetRef } from "./resolver";
import { assertPdfBytes } from "./pdf";
import { sanitizeFileName } from "./filename";
import { sha256Hex } from "./hash";

export interface RefInput {
  fileName: string;
  bytes: ArrayBuffer;
  pdfUrl?: string;
  sourcePageUrl?: string;
}

export function finalizeRef(input: RefInput): DatasheetRef {
  // Throws PdfValidationError if the bytes are not a plausible PDF. This is what turns a resolver
  // that fetched HTML or an error page into a clean failure instead of a parser crash.
  assertPdfBytes(input.bytes);

  return {
    fileName: sanitizeFileName(input.fileName),
    pdfUrl: input.pdfUrl,
    sourcePageUrl: input.sourcePageUrl,
    bytes: input.bytes,
    byteLength: input.bytes.byteLength,
    sha256: sha256Hex(input.bytes)
  };
}
