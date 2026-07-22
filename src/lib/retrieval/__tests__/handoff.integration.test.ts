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
  assert.match(part.partNumber.toUpperCase(), /LMP7704/);
  assert.ok(part.pins.length > 0, "expected the parser to find pins");
});
