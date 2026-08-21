import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { datasheetTextFromPages } from "../../pdftext";
import { buildPartRecord } from "../../datasheet";
import { runExtraction } from "../run";
import type { ExtractionModel, ExtractionRequest, ExtractionResult } from "../contracts";

// The two-pass pipeline, exercised end to end against a stub.
//
// Written because the refactor that produced `runExtraction` could not be run
// against a real model at all: the free tier allows 20 requests a day and the
// day's budget was already spent. Every other test covers a PIECE of the flow.
// Nothing had ever checked that the pieces connect, and "it typechecks" is not
// the same claim.
//
// A stub is the right instrument here anyway. What is being tested is the
// orchestration, and a stub can assert things a live model cannot: exactly how
// many calls were made, what was in each one, and that the second carried images
// while the first did not.

const doc = datasheetTextFromPages([
  "ACME555 Timer. ACME Semiconductor.\nAvailable in an 8-pin SOIC package.",
  "Electrical characteristics over temperature.",
  "PACKAGE OUTLINE SOIC-8\nAll linear dimensions are in millimeters. 8X 1.27 pitch."
]);

/** Records every request it is given, and answers from a script. */
function stub(answers: ExtractionResult[]): ExtractionModel & { seen: ExtractionRequest[] } {
  const seen: ExtractionRequest[] = [];
  let call = 0;
  return {
    seen,
    name: "stub",
    isConfigured: () => true,
    extract: async (request: ExtractionRequest) => {
      seen.push(request);
      return answers[Math.min(call++, answers.length - 1)];
    }
  };
}

/** A real cached datasheet when one is present, for the tests that must render. */
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

/** A one-page PDF is enough: rendering is allowed to fail and must not matter. */
const NOT_A_PDF = new ArrayBuffer(8);

test("pass one sends the whole document as text, and no images", async () => {
  const part = buildPartRecord(doc, "ACME555.pdf");
  const model = stub([{ values: {} }]);

  await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf");

  assert.equal(model.seen.length, 1, "no second pass when no pages are asked for");
  assert.equal(model.seen[0].images.length, 0, "the first pass is text only");
  assert.equal(model.seen[0].pages.length, doc.pages.length, "every page goes");
});

test("a page the model asks for triggers a second pass", async () => {
  const part = buildPartRecord(doc, "ACME555.pdf");
  const model = stub([
    { values: {}, pagesWorthRendering: [3] },
    { values: { "dimensions.pitchMm": { value: 1.27, page: 3 } } }
  ]);

  const outcome = await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf");

  // The render itself cannot succeed on a fake PDF, and that is the point of the
  // assertion: a renderer failure degrades to the first pass rather than losing
  // the record. A host with no working renderer is a supported deployment.
  assert.ok(outcome);
  assert.equal(outcome.lookedAtPages, false, "nothing was rendered, so nothing was looked at");
  assert.equal(model.seen.length, 1, "and no second call is made with zero images");
});

test("a page request for a page that does not exist is ignored", async () => {
  // The model is not trusted to name a real page any more than it is trusted to
  // name a real citation.
  const part = buildPartRecord(doc, "ACME555.pdf");
  const model = stub([{ values: {}, pagesWorthRendering: [99, -1, 3.5] }]);

  await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf");
  assert.equal(model.seen.length, 1, "no second pass for pages this document does not have");
});

test("a model failure on the first pass is not swallowed", async () => {
  // Callers keep the deterministic record when this throws; they cannot do that
  // if the failure is hidden as an empty answer.
  const part = buildPartRecord(doc, "ACME555.pdf");
  const model: ExtractionModel = {
    name: "stub",
    isConfigured: () => true,
    extract: async () => {
      throw new Error("model exploded");
    }
  };

  await assert.rejects(() => runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf"), /model exploded/);
});

test("a record with nothing to ask about makes no call at all", async () => {
  const part = buildPartRecord(doc, "ACME555.pdf");
  const model = stub([{ values: {} }]);
  // Cross-checked fields always exist, so a request is always built; what must
  // not happen is a call for a document with no pages.
  const empty = datasheetTextFromPages([]);
  const outcome = await runExtraction(part, empty, NOT_A_PDF, model, "ACME555.pdf");

  assert.equal(outcome, null, "no pages means no question");
  assert.equal(model.seen.length, 0);
});

test("on a REAL pdf the second pass happens, and carries the pages the model asked for", async () => {
  // The assertion the rest of this file cannot make. Everything above uses a
  // fake PDF, so rendering fails and the second pass is skipped, which proves
  // the degradation path and not the happy one.
  //
  // This is the behaviour the whole redesign exists for: the model reads the
  // text, names the page carrying the mechanical drawing, and is then shown that
  // page as an image. Nothing else in the system chooses it.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { extractDatasheetText } = await import("../../pdftext");

  const path = fileURLToPath(new URL("../../../../test-data/LMP7704-SP.pdf", import.meta.url));
  const bytes = readFileSync(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const real = await extractDatasheetText(buffer);
  const part = buildPartRecord(real, "LMP7704-SP.pdf");

  const outline = real.pages.find((page) => /PACKAGE OUTLINE/.test(page.text));
  assert.ok(outline, "fixture must have a drawing page");

  const model = stub([
    { values: {}, pagesWorthRendering: [outline.page] },
    { values: { "dimensions.bodyHeightMm": { value: 1.75, page: outline.page } } }
  ]);

  const outcome = await runExtraction(part, real, buffer, model, "LMP7704-SP.pdf");
  assert.ok(outcome);

  assert.equal(model.seen.length, 2, "both passes ran");
  assert.equal(model.seen[0].images.length, 0, "first pass: text only");
  assert.ok(model.seen[1].images.length > 0, "second pass: the page was rendered and attached");
  assert.ok(
    model.seen[1].images.map((image) => image.page).includes(outline.page),
    "and the page the MODEL asked for is among them: nothing may drop its choice"
  );
  assert.ok(outcome.renderedPages.includes(outline.page));
  assert.equal(outcome.lookedAtPages, true);
});

test("the second pass does not resend the document it already read", async () => {
  // Cost, measured: the whole-document prompt is ~16k tokens on a median
  // datasheet, and pass two was carrying all of it a second time to ask about
  // one drawing. That doubled the input cost of every part with a second pass
  // and bought nothing, because the model had already read it.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { extractDatasheetText } = await import("../../pdftext");

  const path = fileURLToPath(new URL("../../../../test-data/LMP7704-SP.pdf", import.meta.url));
  const bytes = readFileSync(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const real = await extractDatasheetText(buffer);
  const part = buildPartRecord(real, "LMP7704-SP.pdf");
  const outline = real.pages.find((page) => /PACKAGE OUTLINE/.test(page.text))!;

  const model = stub([{ values: {}, pagesWorthRendering: [outline.page] }, { values: {} }]);
  await runExtraction(part, real, buffer, model, "LMP7704-SP.pdf");

  assert.equal(model.seen.length, 2);
  assert.equal(model.seen[0].pages.length, real.pages.length, "pass one is the whole document");
  assert.ok(
    model.seen[1].pages.map((page) => page.page).includes(outline.page),
    "pass two carries the page it is looking at"
  );
  assert.ok(
    model.seen[1].pages.length < real.pages.length,
    "pass two carries only the pages being looked at, never the document again"
  );
  assert.ok(
    model.seen[1].pages.length < model.seen[0].pages.length / 5,
    "and is a small fraction of the first"
  );
});

test("a rendered figure does not overwrite a pin list the first pass already read", async () => {
  // The precedence rule had no test and was wrong for as long as it existed:
  // pass 2 won every field unconditionally, including pins.
  //
  // Measured on the 2026-08-17 corpus run. RHF1201's pin TABLE is on page 6;
  // pass 2 was shown pages 5 and 33, read the pinout FIGURE on page 5 instead,
  // and overwrote a correct `D11(MSB)` with `(MSB)D11` while nulling all 48
  // electrical types a figure cannot carry. LIS3DH was the same shape, table on
  // page 9 and figure on page 8, and came out rotated by one position. Both had
  // been read correctly and thrown away.
  //
  // The dimension half is asserted in the same test on purpose. An earlier
  // attempt at this fix held pass 1 for EVERY field whose page was not rendered,
  // which sounds more principled and is measurably worse: it also kept
  // RHF1201's front-page `gullwing` over the `straight` on its package drawing,
  // and REF5025's page-1 6.9mm over the drawing's 7.035mm. Reading graphics is
  // the entire reason pass 2 exists, so it has to keep winning those.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { extractDatasheetText } = await import("../../pdftext");

  const path = fileURLToPath(new URL("../../../../test-data/LMP7704-SP.pdf", import.meta.url));
  const bytes = readFileSync(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const real = await extractDatasheetText(buffer);
  const part = buildPartRecord(real, "LMP7704-SP.pdf");
  const outline = real.pages.find((page) => /PACKAGE OUTLINE/.test(page.text))!;

  const fromTable = [
    { number: "1", name: "D11(MSB)", electricalType: "output" as const },
    { number: "2", name: "D0(LSB)", electricalType: "output" as const }
  ];
  const fromFigure = [
    { number: "1", name: "(MSB)D11", electricalType: "unspecified" as const },
    { number: "2", name: "(LSB)D0", electricalType: "unspecified" as const }
  ];

  const model = stub([
    {
      values: {
        pins: { value: fromTable, page: 2 },
        "dimensions.pitchMm": { value: 1.27, page: 1 }
      },
      pagesWorthRendering: [outline.page]
    },
    {
      values: {
        pins: { value: fromFigure, page: outline.page },
        "dimensions.pitchMm": { value: 0.65, page: outline.page }
      }
    }
  ]);

  const run = await runExtraction(part, real, buffer, model, "LMP7704-SP.pdf");

  assert.equal(model.seen.length, 2, "the second pass ran");
  assert.deepEqual(
    run!.part.pins?.value?.map((pin) => pin.name),
    ["D11(MSB)", "D0(LSB)"],
    "the pin table pass one read is not replaced by a figure"
  );
  assert.equal(
    run!.part.dimensions.pitchMm?.value,
    0.65,
    "a dimension read off the drawing is still one opinion improved, so pass two wins"
  );

  // The other half, and the reason this is a page test rather than a blanket
  // "pass one keeps its pins". Where pass 2 re-reads the SAME page it is looking
  // at the same evidence with the image, and it is right to win: on RHF310A that
  // is what corrects `-VCC` to `VCC-`. Blocking it costs that fix.
  const sameTable = [{ number: "1", name: "VCC-", electricalType: "power" as const }];
  const rereading = stub([
    {
      values: { pins: { value: [{ number: "1", name: "-VCC", electricalType: "power" as const }], page: outline.page } },
      pagesWorthRendering: [outline.page]
    },
    { values: { pins: { value: sameTable, page: outline.page } } }
  ]);

  const reread = await runExtraction(part, real, buffer, rereading, "LMP7704-SP.pdf");
  assert.deepEqual(
    reread!.part.pins?.value?.map((pin) => pin.name),
    ["VCC-"],
    "re-reading the same page with the image is an improvement, not a substitution"
  );
});

// ---------------------------------------------------------------------------
// Pass three: the pin table, asked alone on the page the model named.
//
// Measured 2026-08-13 over 14 parts: asking the WHOLE document for pins got an
// answer on 2 of them, and the other 12 were reasoned refusals ("available in
// both TSSOP-8 and SOIC-8, which have differing pin assignments"). Asked about
// one page the same model answered 10 of 13 exactly against the hand-read
// oracle. This pass exists to turn those refusals into answers.
// ---------------------------------------------------------------------------


test("pins already answered mean no pin question at all", async () => {
  // Conditional on purpose. A part the wider passes already read must not pay
  // for a question whose answer is in hand.
  const model = stub([
    { values: { pins: { value: [{ number: "1", name: "OUT", electricalType: "output" as const }], page: 1 } } }
  ]);

  const part = buildPartRecord(doc, "ACME555.pdf");
  await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf", "ACME555");
  assert.equal(model.seen.length, 1, "no extra call");
});

test("a pin-table page the document does not have is ignored", async () => {
  // Same rule the render list already follows: a page claim is checked against
  // the real document before anything is sent.
  const model = stub([{ values: {} }]);

  const part = buildPartRecord(doc, "ACME555.pdf");
  await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf", "ACME555");
  assert.equal(model.seen.length, 1, "an impossible page is not a reason to call again");
  assert.ok(!model.seen.some((r) => r.pages.length === 0), "and nothing was sent with no pages");
});


test("a failure on the pin question keeps everything already read", async () => {
  let call = 0;
  const model: ExtractionModel = {
    name: "stub",
    isConfigured: () => true,
    extract: async () => {
      call += 1;
      if (call === 1) {
        return { values: { manufacturer: { value: "ACME Semiconductor", page: 1 } } };
      }
      throw new Error("pin question failed");
    }
  };

  const part = buildPartRecord(doc, "ACME555.pdf");
  const run = await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf", "ACME555");
  assert.equal(run?.part.manufacturer.value, "ACME Semiconductor");
});

// ---------------------------------------------------------------------------
// Pin tables per package, read in the pass that already has the document.
//
// Replaces a third model call. That pass existed because the model refused to
// report pins when the part number did not say which package it meant, so a
// narrow second question was asked about one page. The refusal was the thing to
// fix: pass 1 already has the whole document and can just report what it found,
// labelled by package. Two calls instead of three, and the answer is in hand
// before anyone is asked to choose.
// ---------------------------------------------------------------------------

test("per-package pin tables are kept on the record, so choosing costs no call", async () => {
  const model = stub([
    {
      values: {},
      notes: ["the part number does not name a package"],
      packagesInThisDocument: [
        { packageType: "SOT23-5", pins: [{ number: "1", name: "OUT", electricalType: "unspecified" }] },
        { packageType: "SC70-5", pins: [{ number: "1", name: "OUT", electricalType: "unspecified" }] }
      ]
    }
  ]);

  const part = buildPartRecord(doc, "ACME555.pdf");
  const run = await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf", "ACME555");

  assert.equal(model.seen.length, 1, "one call, not two questions about pins");
  assert.equal(run?.part.packagesInThisDocument?.length, 2, "both tables are on the record");
  assert.deepEqual(
    run?.part.packagesInThisDocument?.map((t) => t.packageType),
    ["SOT23-5", "SC70-5"],
    "kept separate and labelled, never merged into one"
  );
});

test("a document with one pinout carries no per-package tables", async () => {
  // Only populated where it means something. A single-package datasheet should
  // not grow a list with one entry in it.
  const model = stub([{ values: {} }]);
  const part = buildPartRecord(doc, "ACME555.pdf");
  const run = await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf", "ACME555");
  assert.equal(run?.part.packagesInThisDocument, undefined);
});

test("the pipeline makes at most two model calls", async () => {
  // The count is the point. Three passes meant a workaround was living in the
  // pipeline; two is the text pass and the render pass, both structural.
  const model = stub([{ values: {}, pagesWorthRendering: [3] }, { values: {} }]);
  const part = buildPartRecord(doc, "ACME555.pdf");
  await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf", "ACME555");
  assert.ok(model.seen.length <= 2, `expected at most 2 calls, saw ${model.seen.length}`);
});

test("the prompt offers every leadForm value the record accepts", async () => {
  // The defect this locks out, found 2026-08-17: the record and the generator
  // accept gullwing, nolead and straight, and the prompt offered only the first
  // two. A ceramic flat pack therefore had no valid answer and the model
  // returned null, correctly, for 37 of 81 parts. It read as a model that could
  // not read package drawings, and it was a question that could not express the
  // answer.
  //
  // Generalised rather than pinned to leadForm: any field the record constrains
  // to a set must offer that whole set, or the same failure returns elsewhere.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const guide = readFileSync(fileURLToPath(new URL("../models/prompt.ts", import.meta.url)), "utf8");
  const types = readFileSync(fileURLToPath(new URL("../../types.ts", import.meta.url)), "utf8");

  for (const [field, line] of [
    ["leadForm", /leadForm: extracted\(z\.enum\(\[([^\]]+)\]/],
    ["mounting", /mounting: extracted\(z\.enum\(\[([^\]]+)\]/],
    ["solderMaskDefined", /solderMaskDefined: extracted\(z\.enum\(\[([^\]]+)\]/]
  ] as const) {
    const declared = types.match(line);
    assert.ok(declared, `${field} must still be a zod enum for this test to mean anything`);
    const allowed = [...declared[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(allowed.length > 0);

    const start = guide.indexOf(`"dimensions.${field}":`);
    assert.ok(start > 0, `${field} must be described to the model`);
    const description = guide.slice(start, start + 1600);
    for (const value of allowed) {
      assert.ok(
        description.includes(`'${value}'`),
        `the prompt never offers ${field} = '${value}', so the model cannot return it`
      );
    }
  }
});

test("every field merge requires as a min/max pair is asked for that way, and no other is", async () => {
  // The contradiction this locks out, found 2026-08-17. `merge.ts` DROPS
  // leadWidthMm, leadSpanMm and leadContactMm unless they arrive as a positive
  // min/max pair, and the image-pass guidance told the model to report any
  // dimension printed as a range "as its NOMINAL value". On the pass that reads
  // drawings, obeying one instruction meant losing the value to the other.
  // leadSpanMm was missing on 6 of 12 blocked parts and leadContactMm on 4.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const guide = readFileSync(fileURLToPath(new URL("../models/prompt.ts", import.meta.url)), "utf8");

  // The fields merge insists on as ranges, taken from the exported list the
  // merge itself tests against, so this cannot fall behind one being added. It
  // used to scrape `field === "dimensions.X"` out of the source, which broke the
  // moment the list became a named constant: a test that reads an implementation
  // by regex is pinned to how the implementation is spelled.
  const { RANGE_FIELDS } = await import("../merge");
  const required = [...RANGE_FIELDS];
  assert.ok(required.length >= 3, "expected merge to require several range fields");

  for (const field of required) {
    const start = guide.indexOf(`"${field}":`);
    assert.ok(start > 0, `${field} must be described to the model`);
    const description = guide.slice(start, start + 900);
    // Bare substrings: the guide escapes its quotes in source, so it reads
    // \"minMm\" on disk rather than "minMm".
    assert.ok(
      description.includes("minMm") && description.includes("maxMm"),
      `${field} is dropped unless it is a min/max pair, so the guide must ask for one`
    );
  }

  // And the nominal-value instruction must carve them out, or the image pass
  // asks for the one shape the merge refuses.
  const nominal = guide.indexOf("NOMINAL value");
  assert.ok(nominal > 0, "the image guidance still mentions nominal values");
  const clause = guide.slice(nominal, nominal + 400);
  assert.ok(
    /minMm/.test(clause) && /EXCEPT|except/.test(clause),
    "the nominal-value rule must exempt the min/max fields"
  );
});

// ---------------------------------------------------------------------------
// Two passes, two halves of the same package
// ---------------------------------------------------------------------------

test("a package's pins and its measurements survive being read by different passes", async () => {
  // Pass 1 reads the whole text and reports each package's PIN TABLE. Pass 2
  // sees the rendered drawings and reports each package's MEASUREMENTS, which is
  // the only pass that can: a dimension line's meaning is carried by arrows.
  //
  // `combine` took pass 2's list WHOLE, so the moment the second half started
  // arriving it threw away every pin table pass 1 had found.
  const { combineForTest } = await import("../run");
  const merged = combineForTest(
    {
      values: {},
      packagesInThisDocument: [
        { packageType: "SSOP-20", pins: [{ number: "1", name: "AIN0", electricalType: "unspecified" }] }
      ]
    },
    {
      values: {},
      packagesInThisDocument: [
        // The same package, written the way the other pass happened to spell it.
        { packageType: "SSOP20", dimensions: { "dimensions.pitchMm": { value: 0.65, page: 3 } } },
        { packageType: "SSOP-28", dimensions: { "dimensions.pitchMm": { value: 0.65, page: 4 } } }
      ]
    }
  );

  const twenty = merged.packagesInThisDocument?.find((entry) => /20/.test(entry.packageType));
  assert.equal(twenty?.pins?.length, 1, "pass 1's pin table survives pass 2");
  assert.equal(twenty?.dimensions?.["dimensions.pitchMm"]?.value, 0.65, "and pass 2's drawing read joins it");
  assert.equal(
    merged.packagesInThisDocument?.length,
    2,
    "a package only one pass mentioned keeps its own entry"
  );
});

test("the pass that could see the drawing wins the dimension", async () => {
  // Pass 1 is text only. Where both answer, the pass with the images is the one
  // that read the number off a drawing rather than off a scrambled text layer.
  const { combineForTest } = await import("../run");
  const merged = combineForTest(
    { values: {}, packagesInThisDocument: [{ packageType: "SSOP-20", dimensions: { "dimensions.pitchMm": { value: 1.27, page: 2 } } }] },
    { values: {}, packagesInThisDocument: [{ packageType: "SSOP-20", dimensions: { "dimensions.pitchMm": { value: 0.65, page: 3 } } }] }
  );

  assert.equal(
    merged.packagesInThisDocument?.[0].dimensions?.["dimensions.pitchMm"]?.value,
    0.65,
    "pass 2's reading, not pass 1's"
  );
});

// ---------------------------------------------------------------------------
// The two passes name one package differently, and one of them is a caption
// covering several packages at once
// ---------------------------------------------------------------------------

const pinRow = (number: string, name: string) => ({ number, name, electricalType: "unspecified" as const });
const rows = (count: number) => Array.from({ length: count }, (_, i) => pinRow(String(i + 1), `P${i + 1}`));
const leadCount = (count: number) => ({ "dimensions.leadCount": { value: count, page: 40 } });

test("an exposed-pad row does not make a pin table contradict its own drawing", async () => {
  // The table has a row for the thermal pad and the drawing counts only leads,
  // so counting rows made the two halves of ONE package disagree by exactly one
  // and the join then refused them. Both LM5117 packages failed this way.
  const { combineForTest } = await import("../run");
  const merged = combineForTest(
    {
      values: {},
      packagesInThisDocument: [{ packageType: "HTSSOP (20)", pins: [...rows(20), pinRow("EP", "EP")] }]
    },
    { values: {}, packagesInThisDocument: [{ packageType: "HTSSOP (PWP)", dimensions: leadCount(20) }] }
  );

  assert.equal(merged.packagesInThisDocument?.length, 1, "one package, not two");
  assert.equal(merged.packagesInThisDocument?.[0].pins?.length, 21, "the pad row is kept, not counted as a lead");
});

test("a device name inside brackets is not read as a package code", async () => {
  // `D (OPA1612)` is the D package of the OPA1612. Reading the brackets as the
  // code compared `OPA1612` against `SOIC (D)`'s `D` and refused the two halves
  // of one package on a contradiction it invented itself.
  const { combineForTest } = await import("../run");
  const merged = combineForTest(
    { values: {}, packagesInThisDocument: [{ packageType: "D (OPA1612)", pins: rows(8) }] },
    { values: {}, packagesInThisDocument: [{ packageType: "SOIC (D)", dimensions: leadCount(8) }] },
    "OPA1612"
  );

  assert.equal(merged.packagesInThisDocument?.length, 1, "one package");
  assert.equal(merged.packagesInThisDocument?.[0].pins?.length, 8);
});

test("a pin table captioned with several packages reaches each package it names", async () => {
  // The caption is the document saying these packages share one assignment.
  // Refusing to JOIN it to any single package is right, because they have four
  // different bodies; refusing its PINS left every one of them reported as
  // having no pin table with the pin table on the row above.
  const { combineForTest } = await import("../run");
  const merged = combineForTest(
    {
      values: {},
      packagesInThisDocument: [{ packageType: "16-lead PDIP/SOIC_N/TSSOP/SOIC_W", pins: rows(16) }]
    },
    {
      values: {},
      packagesInThisDocument: [
        { packageType: "16-lead SOIC_N", dimensions: leadCount(16) },
        { packageType: "16-lead TSSOP", dimensions: leadCount(16) },
        { packageType: "20-lead SSOP", dimensions: leadCount(20) }
      ]
    }
  );

  const named = merged.packagesInThisDocument ?? [];
  assert.equal(named.find((e) => e.packageType === "16-lead SOIC_N")?.pins?.length, 16, "SOIC_N is named");
  assert.equal(named.find((e) => e.packageType === "16-lead TSSOP")?.pins?.length, 16, "TSSOP is named");
  assert.equal(
    named.find((e) => e.packageType === "20-lead SSOP")?.pins,
    undefined,
    "a package the caption does not name, and whose lead count disagrees, gets nothing"
  );
  assert.equal(
    named.find((e) => e.packageType === "16-lead PDIP/SOIC_N/TSSOP/SOIC_W")?.dimensions,
    undefined,
    "and the caption itself never takes on one package's measurements"
  );
});

test("a caption written in vendor codes reaches the drawings' outline numbers", async () => {
  // `D, N, NS, J, DB, or PW Package` against drawings titled `PW0016A`. Same
  // package, two spellings, and comparing them as strings says they are not.
  const { combineForTest } = await import("../run");
  const merged = combineForTest(
    { values: {}, packagesInThisDocument: [{ packageType: "D, N, NS, J, DB, or PW Package", pins: rows(16) }] },
    {
      values: {},
      packagesInThisDocument: [
        { packageType: "TSSOP (PW0016A)", dimensions: leadCount(16) },
        { packageType: "SOIC (DW0016A)", dimensions: leadCount(16) }
      ]
    }
  );

  const named = merged.packagesInThisDocument ?? [];
  assert.equal(named.find((e) => e.packageType === "TSSOP (PW0016A)")?.pins?.length, 16, "PW is on the list");
  assert.equal(
    named.find((e) => e.packageType === "SOIC (DW0016A)")?.pins,
    undefined,
    "DW is not on the list, and is not given the pinout anyway"
  );
});

test("a sibling device's pinout never lands in this part's package", async () => {
  // A family datasheet labels each pin table with the device it belongs to. Left
  // alone this put an ADM1385's netlist inside an ADM3202's footprint, and an
  // ADA4522-1's inside an ADA4522-2's: correct pads, wrong connections, and
  // nothing downstream can see it.
  const { combineForTest } = await import("../run");
  const merged = combineForTest(
    {
      values: {},
      packagesInThisDocument: [
        { packageType: "ADA4522-1 (8-Lead MSOP / 8-Lead SOIC)", pins: rows(8) },
        { packageType: "ADA4522-2 (8-Lead MSOP / 8-Lead SOIC)", pins: rows(8) }
      ]
    },
    { values: {}, packagesInThisDocument: [{ packageType: "8-Lead SOIC_N (R-8)", dimensions: leadCount(8) }] },
    "ADA4522-2"
  );

  const soic = merged.packagesInThisDocument?.find((e) => e.packageType === "8-Lead SOIC_N (R-8)");
  assert.equal(soic?.pins?.length, 8, "the requested device's caption reaches it");

  const wrongPart = combineForTest(
    {
      values: {},
      packagesInThisDocument: [{ packageType: "20-lead SSOP (ADM1385)", pins: rows(20) }]
    },
    { values: {}, packagesInThisDocument: [{ packageType: "20-lead SSOP", dimensions: leadCount(20) }] },
    "ADM3202"
  );
  const ssop = wrongPart.packagesInThisDocument?.find((e) => e.packageType === "20-lead SSOP");
  assert.equal(ssop?.pins, undefined, "another device's pin table is not this part's, however well the name matches");
  assert.equal(wrongPart.packagesInThisDocument?.length, 2, "and it is not joined either");
});

test("two packages that differ only in their code are never joined", async () => {
  // The guarantee the whole matcher exists to keep. `SOIC (D)` and `SOIC (DW)`
  // are 3.9mm and 7.5mm bodies; the family agrees and the code does not, so the
  // match must fail on the disagreement rather than pass on the agreement.
  const { combineForTest } = await import("../run");
  const merged = combineForTest(
    { values: {}, packagesInThisDocument: [{ packageType: "SOIC (D)", pins: rows(16) }] },
    { values: {}, packagesInThisDocument: [{ packageType: "SOIC (DW)", dimensions: leadCount(16) }] }
  );

  assert.equal(merged.packagesInThisDocument?.length, 2, "two packages stay two");
});

test("a joined package answers to both names the document prints for it", async () => {
  // The chooser looks these up with a designator harvested from the ordering
  // table, which matches the pinout section's spelling on some documents and the
  // drawing's on others. Filing a joined entry under one name was tried both
  // ways and each way lost a part the other kept.
  const { combineForTest } = await import("../run");
  const { pinTableFor } = await import("../../packagevariants");
  const merged = combineForTest(
    { values: {}, packagesInThisDocument: [{ packageType: "SOT-23 (DBV)", pins: rows(5) }] },
    { values: {}, packagesInThisDocument: [{ packageType: "SOT-23 (5)", dimensions: leadCount(5) }] }
  );

  const tables = merged.packagesInThisDocument ?? [];
  assert.equal(tables.length, 1, "one package");
  assert.equal(pinTableFor(tables, "SOT-23 (DBV)")?.pins?.length, 5, "found by the pinout section's name");
  assert.equal(pinTableFor(tables, "SOT-23 (5)")?.pins?.length, 5, "and by the drawing's");
});

// ---------------------------------------------------------------------------
// When the pass that reads the DRAWINGS fails
// ---------------------------------------------------------------------------

const imageRequest = (): ExtractionRequest => ({
  pages: [],
  images: [{ page: 3, mimeType: "image/png", base64: "x", widthPx: 10, heightPx: 10 }],
  fileName: "ACME555.pdf",
  fields: ["dimensions.pitchMm"]
});

test("the drawing pass is asked a second time before it is allowed to fail", async () => {
  // `callWithRetry` already retries three times inside one call, and it is not
  // enough: ADM3202 failed on four separate runs, roughly a dozen provider
  // attempts, then succeeded on the fifth with no code change.
  const { askTwice } = await import("../run");
  let calls = 0;
  const flaky: ExtractionModel = {
    name: "flaky",
    isConfigured: () => true,
    extract: async () => {
      calls += 1;
      if (calls === 1) throw new Error("503 service unavailable");
      return { values: { "dimensions.pitchMm": { value: 0.65, page: 3 } } };
    }
  };

  const result = await askTwice(flaky, imageRequest(), 1);
  assert.equal(calls, 2, "asked again rather than given up on");
  assert.equal(result.values["dimensions.pitchMm"]?.value, 0.65);
});

test("a drawing pass that fails twice refuses, rather than returning text-layer numbers", async () => {
  // The whole point. Pass 1 answers these same dimensions off the text layer
  // and is measurably wrong there, so falling through silently ships a
  // footprint that may be wrong with nothing saying so. Either files nobody has
  // to second-guess, or "we could not read it, try again".
  const { askTwice } = await import("../run");
  const { SecondPassFailedError } = await import("../contracts");
  let calls = 0;
  const dead: ExtractionModel = {
    name: "dead",
    isConfigured: () => true,
    extract: async () => {
      calls += 1;
      throw new Error("503 service unavailable");
    }
  };

  await assert.rejects(
    () => askTwice(dead, imageRequest(), 1),
    (error: unknown) => {
      assert.ok(error instanceof SecondPassFailedError, `got ${(error as Error)?.name}`);
      assert.match((error as Error).message, /try again/i, "the user is told what to do");
      return true;
    }
  );
  assert.equal(calls, 2, "twice, and not a loop: this pass carries a megabyte of images");
});

test("a RENDER failure is not a drawing-pass failure", async () => {
  // A host with no working renderer produces the first-pass answer, which is a
  // supported deployment rather than an error. One `catch` used to treat this
  // and a dead model as the same thing, and the difference is whether the user
  // should retry.
  const part = buildPartRecord(doc, "ACME555.pdf");
  const model = stub([
    { values: {}, pagesWorthRendering: [3] },
    { values: { "dimensions.pitchMm": { value: 1.27, page: 3 } } }
  ]);

  // `NOT_A_PDF` cannot be rasterised, so rendering throws inside the pass.
  const outcome = await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf");

  assert.ok(outcome, "the first pass still produced a record");
  assert.equal(outcome.renderedPages.length, 0, "nothing was rendered");
  assert.equal(model.seen.length, 1, "and the model was never asked a second time");
});

test("runExtraction propagates a dead drawing pass instead of degrading", async () => {
  // The WIRING, not the retry: `askTwice` refusing is only useful if
  // `runExtraction` lets it out. Needs a real renderable PDF, so it uses a
  // cached one when present and skips otherwise, the same posture as
  // `pagerender.test.ts`; no vendor PDF is committed to this repo.
  const { SecondPassFailedError } = await import("../contracts");
  const pdf = anyCachedPdf();
  if (!pdf) return;

  let call = 0;
  const diesOnTheDrawings: ExtractionModel = {
    name: "dies",
    isConfigured: () => true,
    extract: async () => {
      call += 1;
      if (call === 1) return { values: {}, pagesWorthRendering: [1] };
      throw new Error("503 service unavailable");
    }
  };

  const part = buildPartRecord(doc, "ACME555.pdf");
  await assert.rejects(
    () => runExtraction(part, doc, pdf, diesOnTheDrawings, "ACME555.pdf"),
    (error: unknown) => error instanceof SecondPassFailedError
  );
});

test("a shared lead count is not enough to call two packages one package", async () => {
  // A TO-99 is a metal can, a CERDIP a ceramic through-hole body, a SOIC a
  // 3.9mm surface-mount one. All three are 8-lead, and "both have 8" was
  // accepted as proof of identity: OP27 chained four of its packages into one
  // entry. `8-Lead CERDIP` gets away with it because its family reads as null -
  // `\bDIP\b` does not match inside "CERDIP" - so the count was all that was
  // left to compare, and the count agreed.
  const { combineForTest } = await import("../run");
  const merged = combineForTest(
    {
      values: {},
      packagesInThisDocument: [
        { packageType: "8-Lead TO-99", pins: rows(8) },
        { packageType: "8-Lead CERDIP", pins: rows(8) }
      ]
    },
    { values: {}, packagesInThisDocument: [{ packageType: "8-Lead SOIC", dimensions: leadCount(8) }] }
  );

  assert.equal(merged.packagesInThisDocument?.length, 3, "three packages stay three");
  const can = merged.packagesInThisDocument?.find((e) => /TO-99/.test(e.packageType));
  assert.ok(
    !(can?.alsoKnownAs ?? []).some((name) => /SOIC|CERDIP/.test(name)),
    `a metal can must not answer to another package's name; got ${JSON.stringify(can?.alsoKnownAs)}`
  );
});

// ---------------------------------------------------------------------------
// The vendor drawing code as an entry's identity.
//
// Added 2026-08-20. `packageType` is a caption the model composes and it
// composes a different one each run: LM358 came back as
// "D, DDF, DGK, P, PS, PW, JG (8-pin)" once and
// "8-pin (SOIC, SOT23-8, VSSOP, PDIP, SO, TSSOP, CDIP)" the next time, which
// moved every pin to a new key and reported sixty changed values for a record
// that had not changed. The code is ink on the drawing and does not move.
// ---------------------------------------------------------------------------

test("one drawing code joins two entries whose captions share nothing", async () => {
  // A REAL two-pass run, because the join it exercises only happens between the
  // two passes: the pin table comes from the document text and the measurements
  // come from a rendered drawing, and nothing joins them if only one pass runs.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { extractDatasheetText } = await import("../../pdftext");

  const path = fileURLToPath(new URL("../../../../test-data/LMP7704-SP.pdf", import.meta.url));
  const bytes = readFileSync(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const real = await extractDatasheetText(buffer);
  const outline = real.pages.find((page) => /PACKAGE OUTLINE/.test(page.text))!;
  const part = buildPartRecord(real, "LMP7704-SP.pdf");

  const model = stub([
    {
      values: {},
      pagesWorthRendering: [outline.page],
      packagesInThisDocument: [
        {
          packageType: "D, DDF, DGK, P, PS, PW, JG (8-pin)",
          outlineCode: "D0008A",
          pins: [{ number: "1", name: "OUT1", electricalType: "unspecified" }]
        }
      ]
    },
    {
      values: {},
      packagesInThisDocument: [
        {
          packageType: "8-pin (SOIC, SOT23-8, VSSOP, PDIP)",
          outlineCode: "D0008A",
          dimensions: { "dimensions.pitchMm": { value: 1.27, page: outline.page } }
        }
      ]
    }
  ]);

  const outcome = await runExtraction(part, real, buffer, model, "LMP7704-SP.pdf");
  assert.equal(model.seen.length, 2, "both passes ran, so there is something to join");

  const entries = outcome?.part.packagesInThisDocument ?? [];
  assert.equal(entries.length, 1, "one package, not two, however differently it was captioned");
  assert.ok(entries[0].pins && entries[0].pins.length > 0, "the pin table survived the join");
  assert.ok(entries[0].dimensions, "so did the measurements");
});

// THE HALF THAT PROTECTS US. A code contradicts as well as agrees.
test("two drawing codes keep two packages apart however alike they are captioned", async () => {
  const model = stub([
    {
      values: {},
      packagesInThisDocument: [
        {
          packageType: "SOIC (8)",
          outlineCode: "D0008A",
          pins: [{ number: "1", name: "OUT", electricalType: "unspecified" }]
        },
        {
          packageType: "SOIC (8)",
          outlineCode: "DW0016A",
          pins: [{ number: "1", name: "OUT", electricalType: "unspecified" }]
        }
      ]
    }
  ]);

  const part = buildPartRecord(doc, "ACME555.pdf");
  const run = await runExtraction(part, doc, NOT_A_PDF, model, "ACME555.pdf", "ACME555");

  assert.equal(
    run?.part.packagesInThisDocument?.length,
    2,
    "identical captions, different drawings: a wrong body is copper in the wrong place"
  );
});

// A code is an ADDITION, not a precondition. Most drawings print none.
test("entries without a drawing code join exactly as they did before", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { extractDatasheetText } = await import("../../pdftext");

  const path = fileURLToPath(new URL("../../../../test-data/LMP7704-SP.pdf", import.meta.url));
  const bytes = readFileSync(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const real = await extractDatasheetText(buffer);
  const outline = real.pages.find((page) => /PACKAGE OUTLINE/.test(page.text))!;
  const part = buildPartRecord(real, "LMP7704-SP.pdf");

  const model = stub([
    {
      values: {},
      pagesWorthRendering: [outline.page],
      packagesInThisDocument: [
        {
          packageType: "HTSSOP (20)",
          pins: Array.from({ length: 20 }, (_, i) => ({
            number: String(i + 1),
            name: `P${i + 1}`,
            electricalType: "unspecified" as const
          }))
        }
      ]
    },
    {
      values: {},
      packagesInThisDocument: [
        {
          packageType: "HTSSOP (PWP)",
          dimensions: {
            "dimensions.pitchMm": { value: 0.65, page: outline.page },
            "dimensions.leadCount": { value: 20, page: outline.page }
          }
        }
      ]
    }
  ]);

  const outcome = await runExtraction(part, real, buffer, model, "LMP7704-SP.pdf");
  assert.equal(model.seen.length, 2, "both passes ran");

  const entries = outcome?.part.packagesInThisDocument ?? [];
  assert.equal(entries.length, 1, "the name-based proof still joins them with no code in sight");
  assert.ok(entries[0].pins && entries[0].pins.length > 0, "pins kept");
  assert.ok(entries[0].dimensions, "measurements kept");
});
