import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPdfBytes, PdfValidationError, MAX_PDF_BYTES } from "../pdf";
import { sanitizeFileName } from "../filename";
import { sha256Hex } from "../hash";
import { finalizeRef } from "../ref";

function pdfBytes(size = 128): ArrayBuffer {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode("%PDF-1.7\n"), 0);
  return bytes.buffer;
}

// assertPdfBytes
test("assertPdfBytes accepts a real PDF header", () => {
  assert.doesNotThrow(() => assertPdfBytes(pdfBytes()));
});

test("assertPdfBytes rejects non-PDF bytes", () => {
  const html = new TextEncoder().encode("<html>not a pdf</html>".repeat(8)).buffer;
  assert.throws(() => assertPdfBytes(html), PdfValidationError);
});

test("assertPdfBytes rejects tiny and oversized files", () => {
  const tiny = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]).buffer; // "%PDF-" but only 5 bytes
  assert.throws(() => assertPdfBytes(tiny), PdfValidationError);
  // Fake an oversized length without actually allocating 50MB.
  const oversized = { byteLength: MAX_PDF_BYTES + 1 } as ArrayBuffer;
  assert.throws(() => assertPdfBytes(oversized), PdfValidationError);
});

// sanitizeFileName
test("sanitizeFileName strips path traversal to a basename", () => {
  assert.equal(sanitizeFileName("../../etc/passwd.pdf"), "passwd.pdf");
  assert.equal(sanitizeFileName("C:\\\\secret\\\\part.pdf"), "part.pdf");
});

test("sanitizeFileName enforces a single .pdf and cleans junk chars", () => {
  assert.equal(sanitizeFileName("LMP7704 SP.pdf"), "LMP7704-SP.pdf");
  assert.equal(sanitizeFileName("weird$$name"), "weird-name.pdf");
});

test("sanitizeFileName falls back when nothing usable remains", () => {
  assert.equal(sanitizeFileName("///"), "datasheet.pdf");
});

// sha256Hex
test("sha256Hex is stable and content-addressed", () => {
  const a = pdfBytes();
  const b = pdfBytes();
  assert.equal(sha256Hex(a), sha256Hex(b));
  assert.match(sha256Hex(a), /^[0-9a-f]{64}$/);
});

// finalizeRef
test("finalizeRef validates, sanitizes, sizes, and hashes in one place", () => {
  const ref = finalizeRef({ fileName: "../LMP7704 SP.pdf", bytes: pdfBytes(200), pdfUrl: "https://x.test/a.pdf" });
  assert.equal(ref.fileName, "LMP7704-SP.pdf");
  assert.equal(ref.byteLength, 200);
  assert.match(ref.sha256, /^[0-9a-f]{64}$/);
  assert.equal(ref.pdfUrl, "https://x.test/a.pdf");
});

test("finalizeRef refuses non-PDF bytes", () => {
  const html = new TextEncoder().encode("<html></html>".repeat(8)).buffer;
  assert.throws(() => finalizeRef({ fileName: "x.pdf", bytes: html }), PdfValidationError);
});
