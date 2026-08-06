import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderPages, DEFAULT_RENDER_LIMITS } from "../pagerender";
import { citeRenderedPage } from "../extraction/merge";
import type { DatasheetText } from "../pdftext";

/**
 * These tests use a real cached datasheet when one is present and skip
 * otherwise, the same posture the rest of the bench-adjacent tests take: no
 * vendor PDF is committed to this repo, so a fresh checkout must still run
 * green. The budget and refusal behaviour is tested with no PDF at all.
 */
function anyCachedPdf(): ArrayBuffer | null {
  for (const dir of [".bench-cache", ".holdout-cache"]) {
    const path = join(process.cwd(), dir);
    if (!existsSync(path)) continue;
    const pdf = readdirSync(path).find((file) => file.endsWith(".pdf"));
    if (!pdf) continue;
    const bytes = readFileSync(join(path, pdf));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  return null;
}

test("a page renders to a PNG big enough to read a dimension label off", async () => {
  const pdf = anyCachedPdf();
  if (!pdf) return;

  const [first] = await renderPages(pdf, [1]);
  assert.ok(first, "page 1 should render");
  assert.equal(first.page, 1);
  assert.equal(first.mimeType, "image/png");

  // The PNG magic bytes, so this is an image and not an error string.
  const head = Buffer.from(first.base64, "base64").subarray(0, 8);
  assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // 150 DPI on any real page size clears this comfortably. The floor matters:
  // the values being read are 2 mm tall dimension labels, and a thumbnail would
  // return confident nonsense rather than nothing.
  assert.ok(first.widthPx > 600, `width ${first.widthPx} too small to read labels`);
  assert.ok(first.heightPx > 600, `height ${first.heightPx} too small to read labels`);
});

test("pages come back in the order asked for, so images line up with the prompt", async () => {
  const pdf = anyCachedPdf();
  if (!pdf) return;

  const rendered = await renderPages(pdf, [3, 1, 2]);
  if (rendered.length < 3) return; // very short document
  assert.deepEqual(
    rendered.map((page) => page.page),
    [3, 1, 2],
    "order is the caller's: selectPages already ranked by relevance"
  );
});

test("the page cap is honoured, and it cuts the LEAST relevant page", async () => {
  const pdf = anyCachedPdf();
  if (!pdf) return;

  const rendered = await renderPages(pdf, [1, 2, 3, 4], { maxPages: 2 });
  assert.equal(rendered.length, 2);
  assert.deepEqual(rendered.map((page) => page.page), [1, 2]);
});

test("a byte ceiling drops pages rather than returning a truncated image", async () => {
  const pdf = anyCachedPdf();
  if (!pdf) return;

  const rendered = await renderPages(pdf, [1, 2, 3], { maxTotalBytes: 1 });
  assert.equal(rendered.length, 0, "nothing fits, so nothing is returned");
});

test("out-of-range and duplicate page numbers are dropped, not rendered twice", async () => {
  const pdf = anyCachedPdf();
  if (!pdf) return;

  const rendered = await renderPages(pdf, [1, 1, 0, -3, 99_999]);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].page, 1);
});

test("bytes that are not a PDF produce no pages instead of throwing", async () => {
  const notAPdf = new TextEncoder().encode("this is not a pdf").buffer as ArrayBuffer;
  assert.deepEqual(await renderPages(notAPdf, [1]), []);
});

test("asking for no pages does no work", async () => {
  const pdf = anyCachedPdf();
  assert.deepEqual(await renderPages(pdf ?? new ArrayBuffer(0), []), []);
});

test("the default resolution is the one the accuracy was measured at", () => {
  // Changing this silently would invalidate the six-drawing measurement recorded
  // in pagerender.ts, so it is pinned rather than left to drift.
  assert.equal(DEFAULT_RENDER_LIMITS.dpi, 150);
});

// --- the citation half -------------------------------------------------------

function docWith(page: number, text: string): DatasheetText {
  return {
    text,
    pages: [{ page, text }],
    pageCount: page,
    truncated: false
  } as DatasheetText;
}

test("a drawing citation is refused for a page we never rendered", () => {
  const doc = docWith(33, "PACKAGE OUTLINE PW0008A ALL DIMENSIONS ARE IN MILLIMETERS");
  assert.equal(citeRenderedPage(doc, { value: 0.65, page: 33 }, []), null);
  assert.equal(citeRenderedPage(doc, { value: 0.65, page: 33 }, [12, 14]), null);
});

test("a drawing citation names what identifies the page as a drawing", () => {
  const doc = docWith(33, "PACKAGE OUTLINE PW0008A ALL DIMENSIONS ARE IN MILLIMETERS");
  const citation = citeRenderedPage(doc, { value: 0.65, page: 33 }, [33]);
  assert.ok(citation);
  assert.equal(citation.page, 33);
  assert.match(citation.snippet, /rendered page/);
  // It quotes the document rather than asserting on its own authority.
  assert.match(citation.snippet, /PACKAGE OUTLINE|DIMENSIONS ARE IN/i);
});

test("a value with no page claim gets no citation, rendered or not", () => {
  const doc = docWith(33, "PACKAGE OUTLINE PW0008A");
  assert.equal(citeRenderedPage(doc, { value: 0.65, page: null }, [33]), null);
});

test("a page claim outside the document is refused even if we rendered that index", () => {
  const doc = docWith(33, "PACKAGE OUTLINE PW0008A");
  assert.equal(citeRenderedPage(doc, { value: 0.65, page: 34 }, [34]), null);
});
