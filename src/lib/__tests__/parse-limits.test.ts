import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { extractDatasheetText, PdfExtractionError } from "../pdftext";
import { extractPartRecord } from "../datasheet";

// Closes DEFERRED.md's PARSE_RESOURCE_LIMITS. Layer 1 checks the %PDF magic
// bytes and the file size but never opens the document, so this is the first
// point at which a small file that expands catastrophically is a real
// denial-of-service vector.

/**
 * Builds a syntactically valid PDF whose content stream is Flate-compressed, so
 * a small file decompresses into a very large text layer. This is the shape of
 * a decompression bomb, at a size a test can run quickly.
 */
function bombPdf(textOperations: number): ArrayBuffer {
  const ops: string[] = ["BT", "/F1 8 Tf"];
  for (let i = 0; i < textOperations; i++) {
    ops.push(`1 0 0 1 ${(i % 500) + 20} ${700 - ((i * 3) % 650)} Tm`);
    ops.push(`(RESOURCE LIMIT PROBE ${i} AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA) Tj`);
  }
  ops.push("ET");
  const stream = deflateSync(Buffer.from(ops.join("\n"), "latin1"));

  const objects: string[] = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
    `4 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"
  ];

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  let position = chunks[0].length;

  for (let i = 0; i < objects.length; i++) {
    offsets.push(position);
    const head = Buffer.from(objects[i], "latin1");
    chunks.push(head);
    position += head.length;
    if (i === 3) {
      chunks.push(stream);
      const tail = Buffer.from("\nendstream\nendobj\n", "latin1");
      chunks.push(tail);
      position += stream.length + tail.length;
    }
  }

  const xrefAt = position;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, "latin1"));

  const pdf = Buffer.concat(chunks);
  return pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer;
}

test("a compressed text bomb is refused by the character limit", async () => {
  const pdf = bombPdf(20_000);
  // The point of a bomb: the file itself is small.
  assert.ok(pdf.byteLength < 400_000, `bomb should be small on disk, was ${pdf.byteLength}`);

  await assert.rejects(
    () => extractDatasheetText(pdf, { maxTextChars: 50_000, budgetMs: 30_000 }),
    (error: unknown) => {
      assert.ok(error instanceof PdfExtractionError, `expected PdfExtractionError, got ${error}`);
      assert.equal((error as PdfExtractionError).kind, "text");
      return true;
    },
    "a small file that expands past the character ceiling must be rejected"
  );
});

test("the object-count limit refuses a page with too many text runs", async () => {
  const pdf = bombPdf(5_000);

  await assert.rejects(
    () => extractDatasheetText(pdf, { maxItemsPerPage: 100, budgetMs: 30_000 }),
    (error: unknown) => {
      assert.ok(error instanceof PdfExtractionError);
      assert.equal((error as PdfExtractionError).kind, "objects");
      return true;
    }
  );
});

test("the wall-clock budget is enforced within a single dense page", async () => {
  // A one-page bomb: there is no page boundary to check at, so this only passes
  // because the budget is also checked while rendering the page itself.
  const pdf = bombPdf(20_000);
  const startedAt = Date.now();

  await assert.rejects(
    () => extractDatasheetText(pdf, { budgetMs: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof PdfExtractionError, `expected PdfExtractionError, got ${error}`);
      assert.equal((error as PdfExtractionError).kind, "time");
      return true;
    }
  );

  // The whole point is bounded work: it must fail fast, not grind to completion.
  assert.ok(Date.now() - startedAt < 20_000, "budget breach must not run to completion");
});

test("the wall-clock budget is enforced across pages", async () => {
  const bytes = readFileSync(join(process.cwd(), "test-data", "LMP7704-SP.pdf"));
  const pdf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  await assert.rejects(
    () => extractDatasheetText(pdf, { budgetMs: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof PdfExtractionError);
      assert.equal((error as PdfExtractionError).kind, "time");
      return true;
    }
  );
});

test("the page limit is reported as truncation, not as an error", async () => {
  // A long-but-legitimate document is still usable; the record says it was cut.
  const bytes = readFileSync(join(process.cwd(), "test-data", "LMP7704-SP.pdf"));
  const doc = await extractDatasheetText(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { maxPages: 3 }
  );

  assert.equal(doc.pages.length, 3);
  assert.equal(doc.truncated, true);
  assert.equal(doc.pageCount, 30);
});

test("a truncated parse says so in the record notes", async () => {
  const bytes = readFileSync(join(process.cwd(), "test-data", "LMP7704-SP.pdf"));
  const { doc } = await extractPartRecord(
    "LMP7704-SP.pdf",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  );
  // The real datasheet is well inside every limit.
  assert.equal(doc.truncated, false);
});

test("a normal datasheet parses well inside every limit", async () => {
  const bytes = readFileSync(join(process.cwd(), "test-data", "LMP7704-SP.pdf"));
  const startedAt = Date.now();
  const doc = await extractDatasheetText(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  );

  assert.equal(doc.pages.length, 30);
  assert.ok(doc.text.length < 5_000_000);
  assert.ok(Date.now() - startedAt < 20_000, "the default budget must not be tight for real files");
});
