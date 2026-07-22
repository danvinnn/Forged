import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ingestUpload, UploadValidationError } from "../upload";

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const realPdf = readFileSync(join(process.cwd(), "test-data", "LMP7704-SP.pdf"));

test("ingests the real LMP7704-SP datasheet and preserves bytes", () => {
  const ref = ingestUpload({ fileName: "LMP7704-SP.pdf", bytes: toArrayBuffer(realPdf) });
  assert.equal(ref.fileName, "LMP7704-SP.pdf");
  assert.equal(ref.pdfUrl, undefined); // uploads have no URL
  assert.equal(ref.bytes.byteLength, realPdf.byteLength);
});

test("rejects a non-pdf extension", () => {
  assert.throws(
    () => ingestUpload({ fileName: "part.txt", bytes: toArrayBuffer(realPdf) }),
    UploadValidationError
  );
});

test("rejects a file whose bytes are not a PDF even if named .pdf", () => {
  const notPdf = toArrayBuffer(new TextEncoder().encode("this is not a pdf, it is plain text padding".repeat(4)));
  assert.throws(() => ingestUpload({ fileName: "fake.pdf", bytes: notPdf }), UploadValidationError);
});

test("rejects an empty or tiny upload", () => {
  const tiny = toArrayBuffer(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
  assert.throws(() => ingestUpload({ fileName: "tiny.pdf", bytes: tiny }), UploadValidationError);
});

test("rejects a missing file name", () => {
  assert.throws(() => ingestUpload({ fileName: "  ", bytes: toArrayBuffer(realPdf) }), UploadValidationError);
});
