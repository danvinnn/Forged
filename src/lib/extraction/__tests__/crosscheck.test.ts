import { test } from "node:test";
import assert from "node:assert/strict";
import { datasheetTextFromPages } from "../../pdftext";
import { buildPartRecord } from "../../datasheet";
import { collectReviewItems, reviewPages } from "../../review";
import { mergeModelValues } from "../merge";
import { valuesAgree } from "../crosscheck";
import { resolveForExport, type PartRecord } from "../../types";
import type { ExtractionResult } from "../contracts";

// Cross-checking exists to make ONE failure visible: the deterministic reader
// being confidently wrong. Every other reason a value is doubtful already has a
// review item; this is the case where nothing was doubtful and the answer was
// still wrong, because nobody was ever asked a second time.
//
// The measured instance behind it: an ISO7841 reported a 10.30 x 10.30 body for
// a sixteen-pin SOIC, read off a CSA certification notice. Square, and no SOIC
// is. It reached the emitted body outline and was found by hand.

const doc = datasheetTextFromPages([
  "ACME1234 Digital Isolator. ACME Semiconductor.\nAvailable in a 16-pin SOIC package.",
  "Mechanical Data\nCSA Component Acceptance Notice 5A, IEC 10.30mm x 10.30mm creepage envelope.",
  "PACKAGE OUTLINE 16X SOIC\nBody 10.30 mm x 7.50 mm. Lead pitch 1.27 mm."
]);

function withDeterministic(field: string, value: unknown, page: number | null): PartRecord {
  const part = buildPartRecord(doc, "ACME1234.pdf");
  const [group, key] = field.includes(".") ? field.split(".") : [null, field];
  const slot = { value, confidence: 0.9, method: "deterministic" as const, citation: page ? { page, snippet: "x", region: null } : null };
  if (group) (part as never as Record<string, Record<string, unknown>>)[group][key] = slot;
  else (part as never as Record<string, unknown>)[key] = slot;
  return part;
}

test("a cited model reading DISPLACES the code, and the code is kept beside it", () => {
  // Model-first, 2026-08-11. The code read 10.30 off page 2, which is a creepage
  // envelope rather than a body; the model reads 7.50 off the actual package
  // outline on page 3. The model's page claim verifies, so it wins.
  const part = withDeterministic("dimensions.bodyWidthMm", 10.3, 2);
  const result: ExtractionResult = { values: { "dimensions.bodyWidthMm": { value: 7.5, page: 3 } } };

  const { part: merged } = mergeModelValues(part, doc, result, "gemini");

  assert.equal(merged.dimensions.bodyWidthMm.value, 7.5, "the model's reading is on the record");
  assert.equal(merged.dimensions.bodyWidthMm.citation?.page, 3);
  assert.equal(merged.conflicts.length, 1, "and the displaced reading is kept beside it");
  // Each slot holds the reading its NAME promises, whichever side won. This
  // test previously asserted the opposite (`deterministic.display === "7.5"`,
  // which is the MODEL's number) and so made a swap look deliberate; the bench
  // and the review panel both read the struct by its names and reported every
  // model-won field as though the readers had traded places.
  assert.equal(merged.conflicts[0].deterministic.display, "10.3", "what the CODE read");
  assert.equal(merged.conflicts[0].deterministic.page, 2, "and the page it read it on");
  assert.equal(merged.conflicts[0].model.display, "7.5", "what the MODEL read");
  assert.equal(merged.conflicts[0].model.page, 3);
  assert.equal(merged.conflicts[0].holding, "model", "the record took the model's, one click from undo");
});

test("the disagreement reaches the review panel, ahead of everything else", () => {
  const part = withDeterministic("dimensions.bodyWidthMm", 10.3, 2);
  const result: ExtractionResult = { values: { "dimensions.bodyWidthMm": { value: 7.5, page: 3 } } };
  const { part: merged } = mergeModelValues(part, doc, result, "gemini");

  const items = collectReviewItems(merged);
  const first = items[0];
  assert.equal(first.reason, "disagreement");
  assert.equal(first.display, "7.5", "the value on the record, which is now the model's");
  assert.equal(first.alternative?.display, "10.3", "and the reading it displaced");
  assert.equal(first.alternative?.page, 2);
  assert.equal(first.blocking, false, "a difference nobody has looked at yet does not stop an export");
});

test("both pages of a disagreement are put in front of the reviewer", () => {
  // Rendering one side of a contradiction is worse than rendering neither.
  const part = withDeterministic("dimensions.bodyWidthMm", 10.3, 2);
  const result: ExtractionResult = { values: { "dimensions.bodyWidthMm": { value: 7.5, page: 3 } } };
  const { part: merged } = mergeModelValues(part, doc, result, "gemini");

  const pages = reviewPages(collectReviewItems(merged));
  assert.ok(pages.includes(2), `the page the code read, got ${pages.join(",")}`);
  assert.ok(pages.includes(3), `the page the model read, got ${pages.join(",")}`);
});

test("an UNVERIFIABLE model claim never displaces anything", () => {
  // The guard that survives the flip to model-first, and the one the product
  // rests on. A claim whose page does not say what the model says it says is not
  // evidence at all, so it neither wins nor gets shown as a contradiction.
  // Model-first means the model wins among readings that can BOTH be checked.
  const part = withDeterministic("dimensions.bodyWidthMm", 10.3, 2);
  const result: ExtractionResult = { values: { "dimensions.bodyWidthMm": { value: 4.4, page: 3 } } };

  const { part: merged } = mergeModelValues(part, doc, result, "gemini");
  assert.equal(merged.dimensions.bodyWidthMm.value, 10.3, "the code's reading stands");
  assert.equal(merged.conflicts.length, 0, "4.4 is not on page 3, so the claim is not evidence");
});

test("agreement is silent", () => {
  const part = withDeterministic("dimensions.pitchMm", 1.27, 3);
  const result: ExtractionResult = { values: { "dimensions.pitchMm": { value: 1.27, page: 3 } } };

  const { part: merged } = mergeModelValues(part, doc, result, "gemini");
  assert.equal(merged.conflicts.length, 0);
  assert.equal(collectReviewItems(merged).length, 0);
});

// --- what counts as the same reading -----------------------------------------
//
// Every false disagreement spends attention and teaches the user to click past
// the real ones, so the comparison has to know the ways two readers write the
// same answer.

test("the same package written three ways is not a disagreement", () => {
  assert.ok(valuesAgree("packageType", "8-Pin SOIC", "SOIC-8"));
  assert.ok(valuesAgree("packageType", "SOIC (D) 8", "SOIC-8"));
  assert.ok(!valuesAgree("packageType", "TSSOP-8", "SOIC-8"), "a different family IS a disagreement");
});

test("a nominal quoted against a min/max pair is not a disagreement", () => {
  assert.ok(valuesAgree("dimensions.leadWidthMm", { minMm: 0.31, maxMm: 0.51 }, 0.4));
  assert.ok(!valuesAgree("dimensions.leadWidthMm", { minMm: 0.31, maxMm: 0.51 }, 0.9));
});

test("pin tables are compared on names, not on descriptions", () => {
  const left = [{ number: "1", name: "VCC", electricalType: "power" as const, description: "Supply" }];
  const right = [{ number: "1", name: "V CC", electricalType: "unspecified" as const, description: "Positive supply rail" }];
  assert.ok(valuesAgree("pins", left, right), "wording and punctuation are not the netlist");

  const wrong = [{ number: "1", name: "GND", electricalType: "ground" as const }];
  assert.ok(!valuesAgree("pins", left, wrong), "a different NAME is a wrong symbol");
});

test("a value only one side read is not a disagreement", () => {
  assert.ok(valuesAgree("dimensions.pitchMm", null, 1.27));
  assert.ok(valuesAgree("dimensions.pitchMm", 1.27, null));
});

test("a model's INTEGER pin numbers are not a disagreement with the record's strings", () => {
  // The false-conflict class, measured on AD620: the record holds `"1"` and a
  // model returns `1`. Keyed on one and looked up with the other, every lookup
  // missed and every pin table on every part was reported as a disagreement.
  // Two character-identical readings must compare equal.
  const record = [
    { number: "1", name: "RG", electricalType: "passive" as const },
    { number: "2", name: "-IN", electricalType: "input" as const }
  ];
  const raw = [
    { number: 1 as never, name: "RG", electricalType: null as never },
    { number: 2 as never, name: "-IN", electricalType: null as never }
  ];

  assert.ok(valuesAgree("pins", record, raw), "same pinout, different JSON types");
});

test("a REAL name difference still disagrees, whatever the number type", () => {
  // The guard above must not be so forgiving that it hides the defect this whole
  // mechanism exists for. LTC2400, measured: the deterministic reader glued
  // neighbouring text into three pin names and the model read them clean.
  const glued = [
    { number: "4", name: "+ 0.3V)GND", electricalType: "power" as const },
    { number: "5", name: "CSS8 PART MARKING", electricalType: "input" as const }
  ];
  const clean = [
    { number: 4 as never, name: "GND", electricalType: null as never },
    { number: 5 as never, name: "CS", electricalType: null as never }
  ];

  assert.ok(!valuesAgree("pins", glued, clean), "a wrong name is a wrong netlist");
});

test("an unsettled disagreement blocks the bundle until a person decides", () => {
  // The control that makes model-first safe to ship. Two readers returned
  // different numbers for something that places copper, and which one the record
  // holds was decided by a precedence rule rather than by evidence. Shipping on
  // that is shipping a coin toss with a citation attached.
  //
  // It is also the backstop against prompt injection: a crafted document can get
  // a value onto the record, but not into a generated part without a person
  // seeing both readings and both pages.
  const part = withDeterministic("dimensions.bodyWidthMm", 10.3, 2);
  part.pinCount = { value: 8, confidence: 1, method: "deterministic", citation: { page: 1, snippet: "8", region: null } };
  part.pins = {
    value: [{ number: "1", name: "A", electricalType: "unspecified" }],
    confidence: 1,
    method: "deterministic",
    citation: { page: 1, snippet: "pins", region: null }
  };
  const result: ExtractionResult = { values: { "dimensions.bodyWidthMm": { value: 7.5, page: 3 } } };
  const { part: merged } = mergeModelValues(part, doc, result, "gemini");

  const blocked = resolveForExport(merged, { requireTraceableGeometry: false });
  assert.equal(blocked.ok, false, "an open disagreement is not exportable");
  if (!blocked.ok) assert.deepEqual(blocked.unsettled, ["dimensions.bodyWidthMm"]);

  // Confirming it in the review panel is what clears it: `user-confirmed` means
  // a person looked at the cited page and agreed.
  const settled = JSON.parse(JSON.stringify(merged)) as typeof merged;
  settled.dimensions.bodyWidthMm = { ...settled.dimensions.bodyWidthMm, method: "user-confirmed" };
  assert.equal(resolveForExport(settled, { requireTraceableGeometry: false }).ok, true);
});


/**
 * Package designators written in two different VOCABULARIES.
 *
 * Measured on the 2026-08-12 hold-out run, where eight parts read cleanly and
 * were then held back from export by a cross-check disagreement. One of the
 * eight, TL431, was purely notational: an outline code against prose. A hold
 * that nobody can act on costs a part and teaches the user to click past the
 * holds that matter.
 */
test("an outline code and its prose spelling are not a disagreement", () => {
  // Both resolve to SOIC narrow, so both produce the same land pattern.
  assert.ok(valuesAgree("packageType", "D (SOIC)", "SOIC (8)", 8));
});

/**
 * The counterexample, and the reason this is resolution and not fuzzy matching.
 *
 * ISO7841, same run: the code read the outline code `DW (16)` and the model read
 * the front matter's "16-pin SOIC". They share the token `16` and read almost
 * alike, but they are 4.3 mm apart in lead span, and believing the prose puts
 * every pad about 1.96 mm inboard of the leads. The model was WRONG here, and a
 * comparison loose enough to pass TL431 must still fail this.
 */
test("SOIC wide against SOIC narrow stays a disagreement", () => {
  assert.ok(!valuesAgree("packageType", "DW (16)", "16-pin SOIC", 16), "4.3 mm of lead span apart");
});

test("designators that state different lead counts disagree whatever they resolve to", () => {
  assert.ok(!valuesAgree("packageType", "SOIC-8", "SOIC-16", 8));
});

test("an unresolvable designator still falls back to token comparison", () => {
  // Neither side is a characterised family, so resolution cannot decide it and
  // the token rule must still be doing its job.
  assert.ok(valuesAgree("packageType", "8-Pin XYZZY", "XYZZY-8", 8));
  assert.ok(!valuesAgree("packageType", "XYZZY-8", "PLUGH-8", 8));
});
