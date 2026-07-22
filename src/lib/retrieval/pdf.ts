// Shared PDF byte validation, used by every path that produces a DatasheetRef (upload and
// resolvers alike). A resolver that downloads HTML, an error page, or garbage gets caught here
// instead of blowing up later in the parser.
//
// Air-gap safety: no network, no imports that reach the network.

export class PdfValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfValidationError";
  }
}

// A PDF begins with "%PDF-" (25 50 44 46 2D). Check the magic number rather than trusting a
// filename or a content-type header, both of which lie.
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];

// A datasheet smaller than this is truncated or empty. Larger than this is almost certainly not
// a datasheet and risks memory blowups downstream. LMP7704-SP is ~1.2MB for reference.
export const MIN_PDF_BYTES = 64;
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

function hasPdfMagic(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < PDF_MAGIC.length) return false;
  const head = new Uint8Array(bytes, 0, PDF_MAGIC.length);
  return PDF_MAGIC.every((expected, index) => head[index] === expected);
}

// Throws PdfValidationError if the bytes are not a plausible PDF. Returns nothing on success.
export function assertPdfBytes(bytes: ArrayBuffer): void {
  if (bytes.byteLength < MIN_PDF_BYTES) {
    throw new PdfValidationError("File is empty or too small to be a datasheet.");
  }
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new PdfValidationError(
      `File is larger than the ${Math.round(MAX_PDF_BYTES / (1024 * 1024))}MB limit.`
    );
  }
  if (!hasPdfMagic(bytes)) {
    throw new PdfValidationError("File is not a valid PDF (missing %PDF header).");
  }
}
