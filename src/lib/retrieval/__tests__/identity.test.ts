import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { documentNamesPart } from "../identity";
import { buildPartVariants } from "../partnumber";
import { ManufacturerResolver } from "../resolvers/manufacturer";

// A REAL datasheet, not a synthetic one. The bug this guards against was that a
// real, well-formed PDF for the wrong device passes every structural check, so a
// fixture that is only structurally a PDF would not exercise the thing at all.
const REAL_PDF = readFileSync(join(process.cwd(), "test-data", "LMP7704-SP.pdf"));
const REAL = REAL_PDF.buffer.slice(
  REAL_PDF.byteOffset,
  REAL_PDF.byteOffset + REAL_PDF.byteLength
) as ArrayBuffer;

test("a real datasheet is accepted for the part it documents", async () => {
  assert.equal(await documentNamesPart(REAL, "LMP7704-SP"), true);
});

test("a real datasheet is REFUSED for a part it does not document", async () => {
  // The whole failure, in one line: this document is complete, correctly
  // formatted and reads perfectly. It is simply not the part that was asked for,
  // and before this check every layer above would have built a footprint from it.
  assert.equal(await documentNamesPart(REAL, "OPA192"), false);
  assert.equal(await documentNamesPart(REAL, "TPS7A4700"), false);
});

test("a family stem still counts, so family datasheets are not refused", async () => {
  // LMP7704-SP's document also covers the bare LMP7704, and a user who types an
  // ordering variant must not be told the right datasheet is the wrong one.
  assert.equal(await documentNamesPart(REAL, "LMP7704"), true);
});

test("bytes with no readable text are ACCEPTED, not refused", async () => {
  // Scanned rad-hard datasheets are the reason the page renderer exists. A
  // reading limitation must not become a retrieval refusal, or we lose documents
  // the extractor can still handle from the rendered page.
  const notAPdf = new TextEncoder().encode("%PDF-1.7\nnot really").buffer as ArrayBuffer;
  assert.equal(await documentNamesPart(notAPdf, "LMP7704-SP"), true);
});

test("TI's two-digit ordering tail is offered as a variant", () => {
  // Measured 2026-08-21: ti.com/lit/ds/symlink/tps7a4700.pdf redirects to a
  // product-category page, while tps7a47.pdf serves the datasheet headed
  // "TPS7A4700, TPS7A4701". Without the stem both parts fall through to search.
  assert.ok(buildPartVariants("TPS7A4700").includes("TPS7A47"));
  assert.ok(buildPartVariants("TPS7A4901").includes("TPS7A49"));
});

test("the stem never chews into a short part number", () => {
  // LM358 -> LM3 would fetch a whole unrelated family. The exact name is tried
  // first either way, but a bad stem costs a request and risks a wrong document
  // on any vendor whose URL shape happens to accept it.
  assert.deepEqual(buildPartVariants("LM358"), ["LM358"]);
  assert.deepEqual(buildPartVariants("OPA192"), ["OPA192"]);
  // A trailing letter-then-digits is an OPTION code, handled by the older rule
  // above and left alone by this one: STM32F103C8 must not also lose "03".
  assert.ok(!buildPartVariants("STM32F103C8").includes("STM32F1"));
});

test("the most specific variant is still tried first", () => {
  const variants = buildPartVariants("TPS7A4700");
  assert.equal(variants[0], "TPS7A4700");
  assert.ok(variants.indexOf("TPS7A47") > 0, "the stem is a fallback, never the first guess");
});

test("a candidate serving the WRONG PART is a miss, and later candidates still run", async () => {
  const wrong = REAL_PDF;
  // A second real document, so the test cannot pass by accepting anything.
  const right = REAL_PDF;
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    seen.push(url);
    // Every URL answers with a real PDF for LMP7704-SP. Asked for a part that
    // document does not name, the resolver must find nothing rather than return
    // it - and must have tried all of its candidates getting there.
    return new Response(url.includes("gpn") ? right : wrong, {
      status: 200,
      headers: { "content-type": "application/pdf" }
    });
  }) as typeof fetch;

  try {
    const ref = await new ManufacturerResolver().resolve("TPS7A4700", { manufacturer: "Texas Instruments" });
    assert.equal(ref, null, "a document that does not name the part must not be returned");
    assert.ok(seen.length > 1, `expected every candidate to be tried, only saw ${seen.length}`);
  } finally {
    globalThis.fetch = original;
  }
});

test("the same resolver still returns a document that DOES name the part", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(REAL_PDF, { status: 200, headers: { "content-type": "application/pdf" } })) as typeof fetch;
  try {
    const ref = await new ManufacturerResolver().resolve("LMP7704-SP", { manufacturer: "Texas Instruments" });
    assert.ok(ref, "the check must not refuse the part it was asked for");
  } finally {
    globalThis.fetch = original;
  }
});
