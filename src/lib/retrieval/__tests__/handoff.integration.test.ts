import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ingestUpload } from "../upload";
import { parseDatasheetPdf } from "../../datasheet";

// The seam between Layer 1 (retrieval) and Layer 2 (extraction): a DatasheetRef's bytes feed
// parseDatasheetPdf unchanged. Run the real LMP7704-SP datasheet through the upload path (zero
// network, no credentials needed) and confirm the parser reads it. This exercises the exact
// plug-in point the commercial resolvers also target.
test("upload ref bytes parse into a PartRecord for LMP7704-SP", async () => {
  const bytes = readFileSync(join(process.cwd(), "test-data", "LMP7704-SP.pdf"));
  const ref = ingestUpload({
    fileName: "LMP7704-SP.pdf",
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  });

  const part = await parseDatasheetPdf(ref.fileName, ref.bytes, ref.pdfUrl);
  assert.match((part.partNumber.value ?? "").toUpperCase(), /LMP7704/);

  // What the record carries WITHOUT a model, after the deterministic parser was
  // deleted on 2026-08-14: the packages the ordering table offers, and nothing
  // else. The pins and every dimension are the model's to read.
  assert.ok(part.packageVariants.length > 0, "the ordering table still yields the package list");
  assert.equal(part.pins.value, null, "no pin table is invented in the absence of a reader");

  // The part number is the FILE NAME, and it says so. It is not a citation-backed
  // read and must never be dressed as one: the person uploading `LMP7704-SP.pdf`
  // told us what they think it is, which is a different claim from the document
  // stating it.
  assert.equal(part.partNumber.method, "user");
  assert.equal(part.partNumber.citation, null);
});
