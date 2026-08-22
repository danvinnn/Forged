import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { createExportZip, FootprintUnavailableError } from "../exporters";
import type { PinRecord, ResolvedPart } from "../types";

/**
 * Where a footprint's numbers are allowed to come from, driven through the real
 * generator.
 *
 * This replaces the fifty-five tests that pinned a hand-typed family table to
 * published land patterns. The table asserted a lead span, a foot and a width
 * per family NAME, each read off one drawing, and `RULES.md` rule 1 does not
 * allow that: every value describing a part comes from that part's datasheet.
 *
 * So there are exactly three sources left, and these tests are the boundary
 * between them:
 *
 *   1. the recommended footprint the datasheet PRINTS      -> used as the pads
 *   2. this part's own package outline + IPC-7351B         -> computed
 *   3. neither                                             -> ASK
 *
 * There is no fourth. A package name on its own produces nothing, which is the
 * property the deleted table violated and the one worth the most tests.
 */

function pins(count: number): PinRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    number: String(index + 1),
    name: `P${index + 1}`,
    electricalType: "passive" as const
  }));
}

/** A record with NOTHING geometric read. Each test adds only what it is about. */
function bare(overrides: Partial<ResolvedPart> = {}): ResolvedPart {
  const count = overrides.pinCount ?? 8;
  return {
    id: "test",
    partNumber: "ACME1",
    manufacturer: "ACME",
    packageType: "SOIC-8",
    packageOutlineCode: null,
    jedecOutline: null,
    vendorLandPattern: null,
    exposedPad: false,
    pinCount: count,
    pins: pins(count),
    dimensions: {
      // A body, because every package outline dimensions one and these tests are
      // about the LAND pattern. Without it the export would also ask for the 3D
      // body's size, which is a different question.
      bodyLengthMm: 4.9,
      bodyWidthMm: 3.9,
      bodyHeightMm: 1.75,
      pitchMm: null,
      leadLengthMm: null,
      leadCount: count,
      leadWidthMm: null,
      leadSpanMm: null,
      leadSpanCrossMm: null,
      leadContactMm: null,
      thermalPadLengthMm: null,
      thermalPadWidthMm: null,
      landPadLengthMm: null,
      landPadWidthMm: null,
      landSpanMm: null,
      landSpanCrossMm: null,
      leadSides: null,
      leadForm: null,
      mounting: null,
      leadDiameterMm: null,
      vacantLeadSlot: null,
      leadsPerSide: null,
      solderMaskExpansionMm: null,
      solderMaskDefined: null,
      thermalViaDiameterMm: null,
      thermalViaPitchMm: null
    },
    radiation: { tid: null, see: null, sel: null, qmlClass: null },
    sourceFileName: "acme1.pdf",
    notes: [],
    ...overrides
  };
}

function withDimensions(
  overrides: Partial<ResolvedPart["dimensions"]>,
  part: Partial<ResolvedPart> = {}
): ResolvedPart {
  const base = bare(part);
  return { ...base, dimensions: { ...base.dimensions, ...overrides } };
}

async function footprintOf(part: ResolvedPart): Promise<string> {
  const bundle = await createExportZip(part, "kicad");
  const zip = await JSZip.loadAsync(bundle.buffer);
  const name = Object.keys(zip.files).find((file) => file.endsWith(".kicad_mod"));
  assert.ok(name, "a footprint was emitted");
  return zip.files[name].async("string");
}

async function refusal(part: ResolvedPart): Promise<FootprintUnavailableError> {
  try {
    await createExportZip(part, "kicad");
  } catch (error) {
    assert.ok(error instanceof FootprintUnavailableError, `unexpected error: ${error}`);
    return error;
  }
  throw new assert.AssertionError({ message: "expected a refusal, got a bundle" });
}

// ---------------------------------------------------------------------------
// 1. The datasheet's own printed footprint
// ---------------------------------------------------------------------------

/**
 * The published SOIC-8 land pattern, from KiCad's official
 * `Package_SO/SOIC-8_3.9x4.9mm_P1.27mm`: eight lands of 1.95 x 0.6 mm at
 * x = +/-2.475, i.e. a 4.95 mm centre span.
 *
 * A real external file rather than a fixture of our own making. It is the only
 * kind of expectation that can fail for the right reason.
 */
const PUBLISHED_SOIC8 = { padLengthMm: 1.95, padWidthMm: 0.6, spanMm: 4.95 };

test("a printed land pattern IS the pads, to the micron", async () => {
  const footprint = await footprintOf(
    withDimensions({
      pitchMm: 1.27,
      leadSides: 2,
      landPadLengthMm: PUBLISHED_SOIC8.padLengthMm,
      landPadWidthMm: PUBLISHED_SOIC8.padWidthMm,
      landSpanMm: PUBLISHED_SOIC8.spanMm,
      landSpanCrossMm: null,
    })
  );

  assert.match(
    footprint,
    /\(pad "1" smd roundrect \(at -2\.475 -1\.905\) \(size 1\.950 0\.600\)/,
    "pin 1 sits where KiCad's own SOIC-8 puts it"
  );
  assert.match(
    footprint,
    /\(pad "5" smd roundrect \(at 2\.475 1\.905\)/,
    "and so does pin 5, which is the counterclockwise corner"
  );
  assert.match(footprint, /RECOMMENDED FOOTPRINT PRINTED IN THIS DATASHEET/, "and it says so");
});

test("a partial printed pattern is not a pattern", async () => {
  // Two of the three numbers read is not two thirds of a footprint. Filling the
  // gap from a computed one would mix two sources into pads that claim to be the
  // vendor's.
  const error = await refusal(
    withDimensions({
      pitchMm: 1.27,
      leadSides: 2,
      landPadLengthMm: PUBLISHED_SOIC8.padLengthMm,
      landPadWidthMm: PUBLISHED_SOIC8.padWidthMm
    })
  );
  assert.deepEqual(
    error.needs.map((need) => need.field),
    ["landSpanMm"],
    "and it asks for exactly the one that is missing"
  );
});

// ---------------------------------------------------------------------------
// 2. This part's own package outline
// ---------------------------------------------------------------------------

/** The TI D0008A drawing in the UCC27524 datasheet, JEDEC MS-012. */
const DRAWN_SOIC8 = {
  pitchMm: 1.27,
  leadSides: 2 as const,
  leadForm: "gullwing" as const,
  leadSpanMm: { minMm: 5.8, maxMm: 6.2 },
  leadSpanCrossMm: null,
  leadContactMm: { minMm: 0.4, maxMm: 0.625 },
  leadWidthMm: { minMm: 0.31, maxMm: 0.51 }
};

test("a package outline and the standard produce a footprint, and say which they are", async () => {
  const footprint = await footprintOf(withDimensions(DRAWN_SOIC8));
  assert.match(footprint, /computed from this datasheet's own package drawing/);
  assert.doesNotMatch(footprint, /PRINTED IN THIS DATASHEET/, "it must not claim to be the vendor's");
});

test("the computed toe-to-toe extent lands on the published one", async () => {
  // The independent check that this arithmetic is right. KiCad's SOIC-8 reaches
  // 6.9 mm toe to toe (2 * 2.475 + 1.95); ours is computed from the drawing's
  // lead dimensions and never sees that number.
  const footprint = await footprintOf(withDimensions(DRAWN_SOIC8));
  const pad = /\(pad "1" smd roundrect \(at (-?[\d.]+) -?[\d.]+\) \(size ([\d.]+) [\d.]+\)/.exec(footprint);
  assert.ok(pad, "pin 1 has a land");
  const zMax = Math.abs(Number(pad[1])) * 2 + Number(pad[2]);
  assert.ok(
    Math.abs(zMax - 6.9) < 0.05,
    `computed ${zMax.toFixed(3)} mm toe to toe against the published 6.900 mm`
  );
});

test("an unread lead form produces nothing, because the model does not apply to every lead", async () => {
  // A name list used to answer this: `\b(SOIC|SOP|SSOP|TSSOP|...)\b`, consulted
  // whenever the drawing's own lead form had not been read. It is gone, and not
  // as a simplification. Applied to a no-lead package the gull-wing model
  // computes a fillet around a lead that does not exist, and the result looks
  // entirely plausible in CAD.
  const error = await refusal(withDimensions({ ...DRAWN_SOIC8, leadForm: null }));
  assert.ok(error.needs.length > 0, "it asks rather than dead-ending");
});

test("a no-lead package is never computed from the gull-wing goals", async () => {
  const error = await refusal(withDimensions({ ...DRAWN_SOIC8, leadForm: "nolead" }));
  assert.ok(
    error.needs.some((need) => need.field === "landPadLengthMm"),
    "it asks for the land instead"
  );
});

test("a lead nearly as wide as its pitch is a misread, and is refused", async () => {
  // Found 2026-08-10 on an ADS1115. Its DYN0010A drawing tags several max-over-min
  // pairs and the width reader took `10X 0.45/0.25`, which is not the lead width.
  // At 0.45 against a 0.5 pitch the leads would sit 0.05 mm apart, which no
  // package does and no stencil could print. Without this the part exported.
  const error = await refusal(
    withDimensions({
      ...DRAWN_SOIC8,
      pitchMm: 0.5,
      leadWidthMm: { minMm: 0.25, maxMm: 0.45 }
    })
  );
  assert.ok(error.needs.length > 0);
});

test("a computed land the datasheet's own printed page contradicts is refused", async () => {
  // The only independent check the computed path has. Every number came from one
  // drawing read minutes ago, and if the page two sheets later prints a different
  // land, the reading or the lead form is wrong.
  const error = await refusal(
    withDimensions(DRAWN_SOIC8, {
      // Nothing like the ~1.5 x 0.65 on a 5.4 mm span this drawing computes to.
      vendorLandPattern: { page: 12, valuesMm: [0.82, 0.3, 2.2] }
    })
  );
  assert.ok(error.needs.length > 0, "it asks rather than emitting either pattern");
});

test("and one that agrees with the printed page is kept", async () => {
  const footprint = await footprintOf(
    withDimensions(DRAWN_SOIC8, {
      vendorLandPattern: { page: 12, valuesMm: [1.53, 0.65, 5.38] }
    })
  );
  assert.match(footprint, /computed from this datasheet's own package drawing/);
});

// ---------------------------------------------------------------------------
// 3. Straight leads: the one case where the answer cannot be on any datasheet
// ---------------------------------------------------------------------------

test("an untrimmed flat pack asks for the formed span, once per assembler", async () => {
  // TI's HKU0010A drawing shows the leads plainly: 22.7 mm tip to tip on a 7 mm
  // body, straight, for the assembler to trim and form. The drawing's span is
  // therefore NOT the seated span, and using it would place every pad about
  // 8 mm too far out.
  //
  // A family table used to know this, and it knew it by name. The drawing shows
  // it, so it is read off the drawing.
  // TWO numbers since 2026-08-17, both made by the same forming die. Hand-read
  // evidence: TI's PW0008A prints the seated foot on Detail A because a gull-wing
  // lead arrives formed, and the HBH0014A ceramic flat pack prints no such
  // dimension at all. So a straight lead has no foot to read either, and taking
  // one off the drawing would size the land around a number describing the
  // UNFORMED part.
  //
  // This fixture is a SOIC-8 drawing with the lead form flipped, so it still
  // carries a printed contact length that a real flat pack would not.
  const error = await refusal(withDimensions({ ...DRAWN_SOIC8, leadForm: "straight" }));

  assert.deepEqual(
    error.needs.map((need) => need.field).sort(),
    ["formedLeadContactMm", "formedLeadSpanMm"]
  );
  for (const need of error.needs) {
    assert.equal(need.scope, "install", "an assembler forms to one convention, not per part");
  }
});

test("and builds from it, taking the figure as given rather than widening it", async () => {
  const part = withDimensions({ ...DRAWN_SOIC8, leadForm: "straight" });
  const bundle = await createExportZip(part, "kicad", { formedLeadSpanMm: 10.16, formedLeadContactMm: 0.6 });
  const zip = await JSZip.loadAsync(bundle.buffer);
  const name = Object.keys(zip.files).find((file) => file.endsWith(".kicad_mod"))!;
  const footprint = await zip.files[name].async("string");

  const pad = /\(pad "1" smd roundrect \(at (-?[\d.]+) -?[\d.]+\) \(size ([\d.]+) [\d.]+\)/.exec(footprint);
  assert.ok(pad, "a footprint is built from the supplied span");
  const zMax = Math.abs(Number(pad[1])) * 2 + Number(pad[2]);
  // Zero-width span range: 10.16 + 2 * the density-B toe goal of 0.35, plus the
  // RSS of a zero span tolerance with the fabrication and placement allowances.
  assert.ok(
    Math.abs(zMax - (10.16 + 0.7 + Math.hypot(0.05, 0.025))) < 0.01,
    `toe-to-toe came out ${zMax.toFixed(3)} mm`
  );
});

// ---------------------------------------------------------------------------
// 4. There is no fourth source
// ---------------------------------------------------------------------------

test("a package NAME on its own produces nothing at all", async () => {
  // The property the deleted table violated. `SOIC-8` is a designator; it is not
  // a lead span, a foot, a width or a pitch, and nothing in this repo will treat
  // it as one again.
  // Each designator gets the pin count it DECLARES. They all ran on the default
  // eight-pin record, so a "TSSOP-16" carried eight pins and the lead-count
  // guard refused it before the land-pattern question was ever reached. The
  // property under test is that a NAME yields no geometry, and it is only
  // demonstrated on a record that is otherwise coherent.
  for (const [packageType, pinCount] of [
    ["SOIC-8", 8],
    ["TSSOP-16", 16],
    ["LQFP-64", 64],
    ["CFP-14", 14],
    ["VSSOP-8", 8]
  ] as const) {
    const error = await refusal(bare({ packageType, pinCount }));
    assert.ok(
      error.needs.length > 0,
      `${packageType} must ask rather than resolve to a characterised family`
    );
    assert.ok(
      error.needs.some((need) => need.field.startsWith("land")),
      `${packageType} asks for the land pattern`
    );
  }
});

test("the refusal names fields the export route accepts, not a list of families", async () => {
  const error = await refusal(bare());
  for (const need of error.needs) {
    assert.ok(need.label, `${need.field} needs a label`);
    assert.ok(need.why, `${need.field} needs a reason the datasheet cannot answer it`);
    assert.ok(["mm", "count", "counts"].includes(need.unit), `${need.field} declares what kind of answer it wants`);
  }
});

// ---------------------------------------------------------------------------
// Through-hole: holes rather than lands
// ---------------------------------------------------------------------------

/**
 * A DIP-8, as KiCad's official `Package_DIP/DIP-8_W7.62mm` draws it.
 *
 * Eight plated holes on a 2.54 mm pitch in two rows 7.62 mm apart, pin 1
 * rectangular and the rest round, `(attr through_hole)`, on `*.Cu` and `*.Mask`
 * with no paste at all.
 *
 * `Pad.mounting` admitted only `"smd"` until 2026-08-14, so a through-hole part
 * had nowhere to go however well its datasheet was read. What makes it work now
 * is not a package name: it is `dimensions.mounting`, which the drawing shows
 * and the model reads.
 */
function dip8(): ResolvedPart {
  return withDimensions({
    pitchMm: 2.54,
    leadSides: 2,
    mounting: "through-hole",
    leadDiameterMm: 0.5,
    landSpanMm: 7.62,
    landSpanCrossMm: null,
    bodyLengthMm: 9.27,
    bodyWidthMm: 6.35
  }, { partNumber: "ACMEDIP", packageType: "DIP-8" });
}

test("a through-hole part produces plated holes, sized by IPC-7251", async () => {
  const footprint = await footprintOf(dip8());

  // Hole = 0.5 mm lead + the 0.2 mm density-B allowance. Land = hole + 2 x 0.4 mm
  // of annular ring, which is the 1.6 mm the reference DIP-8 uses on a 0.8 mm
  // hole.
  assert.match(footprint, /\(drill 0\.700\)/, "the hole is the lead plus its allowance");
  assert.match(footprint, /\(size 1\.500 1\.500\)/, "and the land is the hole plus its ring");
  assert.match(footprint, /\(attr through_hole\)/, "stated, so the assembler's tools treat it right");
  assert.doesNotMatch(footprint, /F\.Paste/, "a hole gets no paste: the joint is made by wave or by hand");
  assert.match(footprint, /\(layers "\*\.Cu" "\*\.Mask"\)/, "and it exists on every copper layer");
});

test("pin 1 is the shape that marks it, the rest are round", async () => {
  const footprint = await footprintOf(dip8());
  assert.match(footprint, /\(pad "1" thru_hole roundrect/, "pin 1 is square, as the reference DIP draws it");
  assert.match(footprint, /\(pad "2" thru_hole circle/, "and every other pin is round, like the lead");
});

test("the rows sit where the drawing says, not where a package name implies", async () => {
  const footprint = await footprintOf(dip8());
  const pads = [...footprint.matchAll(/\(pad "(\d+)" thru_hole \w+ \(at (-?[\d.]+) (-?[\d.]+)\)/g)];
  assert.equal(pads.length, 8, "eight holes");
  const one = pads.find((pad) => pad[1] === "1")!;
  const eight = pads.find((pad) => pad[1] === "8")!;
  assert.equal(Math.abs(Number(one[2])) * 2, 7.62, "7.62 mm between the two rows, as read");
  assert.equal(Number(eight[3]), Number(one[3]), "pin 8 sits opposite pin 1, counterclockwise");
});

test("a through-hole part with no lead diameter asks rather than sizing a hole itself", async () => {
  const error = await refusal(
    withDimensions({ pitchMm: 2.54, leadSides: 2, mounting: "through-hole", landSpanMm: 7.62 })
  );
  assert.ok(error.needs.length > 0, "a hole nobody measured is a question, not a default");
});

// ---------------------------------------------------------------------------
// How many rows of pins, which is read and never assumed
// ---------------------------------------------------------------------------

/**
 * The through-hole path hardcoded two opposing rows and never looked at
 * `leadSides`. A TO-220 is three pins in ONE line, so it came out with pins 1
 * and 2 in one column and pin 3 in the other: a wrong footprint, emitted
 * silently, that looks entirely ordinary in CAD. `leadSides` is null for a
 * one-sided package by instruction in the prompt, so the common case for a
 * regulator was precisely the one that fell through to the default.
 *
 * These pin the rule on both paths: the arrangement is read, and where it was
 * not read there is a question rather than a default.
 */
test("a through-hole part whose row count was not read asks, rather than assuming two rows", async () => {
  const error = await refusal(
    withDimensions({
      pitchMm: 2.54,
      leadSides: null,
      mounting: "through-hole",
      leadDiameterMm: 0.7,
      landSpanMm: 5.0,
      landSpanCrossMm: null,
    }, { partNumber: "ACMEREG", packageType: "TO-220", pinCount: 3 })
  );
  assert.ok(
    error.needs.some((need) => need.field === "leadSides"),
    "how many rows the pins form is the question, and it names the field that receives it"
  );
});

/**
 * The refusal has to SAY that a single line of pins is not built.
 *
 * `leadSides` admits only 2 or 4, so a one-sided package cannot be stated as
 * one side: it arrives as null, indistinguishable from a DIP nobody read. The
 * question is therefore the right one to ask, and it is only honest if the
 * answer "my part has one row" is visibly accounted for. Otherwise this is the
 * shape of ask that trains someone to type 2 and take the wrong footprint.
 */
test("the through-hole question asks which row count it is, now that BOTH are built", async () => {
  // This test asserted the opposite until 2026-08-17: that a single line of pins
  // "is not built", which was true and was a limit of the RECORD rather than of
  // the reading. `leadSides` was typed `2 | 4`, so a TO-220 could not be
  // represented however well its datasheet was read.
  //
  // Widening the type is what made the honest answer sayable. What has NOT
  // changed, and is the half worth protecting, is that an unread row count still
  // refuses: null is not a default, and null is the state that once shipped a
  // 3-lead regulator as two columns 5 mm apart.
  const error = await refusal(
    withDimensions({
      pitchMm: 2.54,
      leadSides: null,
      mounting: "through-hole",
      leadDiameterMm: 0.7,
      landSpanMm: 5.0,
      landSpanCrossMm: null,
    }, { partNumber: "ACMEREG", packageType: "TO-220", pinCount: 3 })
  );
  const need = error.needs.find((entry) => entry.field === "leadSides");
  assert.ok(need, "the row count is what is asked for");
  assert.match(need.why, /single line/, "and both shapes are named, so the answer is obvious");
  assert.match(need.label, /1 for a TO-220/, "the label says what a 1 means");
});

// ---------------------------------------------------------------------------
// Every question carries the page its answer is printed on
// ---------------------------------------------------------------------------

test("a land-pattern question points at the page the footprint is printed on", async () => {
  // The whole reason the ask exists is that the document usually HAS the answer
  // and we failed to read it. Sending someone to "the vendor's application note"
  // for a number printed on page 47 of the PDF they just uploaded is the friction
  // this removes: the UI renders that page beside the input.
  const error = await refusal(
    withDimensions({ pitchMm: 1.27, leadSides: 2 }, { vendorLandPattern: { page: 47, valuesMm: [1.55, 0.6, 5.4] } })
  );

  const land = error.needs.filter((need) => need.field.startsWith("land"));
  assert.ok(land.length > 0, "the land pattern is what is being asked for");
  for (const need of land) {
    assert.equal(need.page, 47, `${need.field} should point at the printed footprint`);
    assert.match(need.pageLabel ?? "", /printed in this datasheet/i);
  }
});

test("the one question no datasheet can answer carries no page", async () => {
  // `formedLeadSpanMm` is the exception, and it has to stay one. The manufacturer
  // ships the leads straight and never bends them, so no page of any datasheet
  // contains the seated span. Showing a page here would be a lie about where to
  // look, and the UI renders the absence as its own sentence.
  const error = await refusal(withDimensions({ ...DRAWN_SOIC8, leadForm: "straight" }));

  // Both formed numbers are exceptions, for the same reason: the manufacturer
  // ships the leads straight and never bends them, so no page of any datasheet
  // carries the seated span OR the foot it produces.
  assert.deepEqual(
    error.needs.map((need) => need.field).sort(),
    ["formedLeadContactMm", "formedLeadSpanMm"]
  );
  for (const need of error.needs) {
    assert.ok(!need.page, `${need.field} claims a page, but no datasheet has one`);
  }
});

test("a question about a document that prints no footprint has no page either", async () => {
  const error = await refusal(withDimensions({ pitchMm: 1.27, leadSides: 2 }));
  for (const need of error.needs) {
    assert.ok(!need.page, `${need.field} claims a page on a document that prints no footprint`);
  }
});

// ---------------------------------------------------------------------------
// The 3D body is read or asked for. Never guessed.
// ---------------------------------------------------------------------------

test("an unread package body is a question, not a guess", async () => {
  // What this replaces, and why it mattered.
  //
  // The STEP builder used to fill an unread dimension from the pin count:
  // `Math.max(pinCount * 0.8, 4.0)`. For an 8-pin SOIC that shipped a
  // 6.4 x 4.4 x 1.5 mm solid for a part that is 4.9 x 3.9 x 1.75 mm.
  //
  // A 3D body answers one question: does the part fit, under a heatsink or
  // inside an enclosure. A guessed one answers it WRONGLY while looking
  // authoritative, and nothing in the file said the numbers were invented. It is
  // the same arithmetic the footprint path deleted long ago; it survived because
  // nobody looked in the STEP builder.
  const error = await refusal(
    withDimensions({ ...DRAWN_SOIC8, bodyLengthMm: null, bodyWidthMm: null, bodyHeightMm: null })
  );

  assert.deepEqual(
    error.needs.map((need) => need.field).sort(),
    ["bodyHeightMm", "bodyLengthMm", "bodyWidthMm"],
    "all three are asked for, because all three are dimensioned on the outline"
  );
  for (const need of error.needs) {
    assert.equal(need.unit, "mm");
    assert.match(need.why, /mechanical check|real size/i, "the reason says why an approximation will not do");
  }
});

test("supplying the body size builds the solid from it", async () => {
  const part = withDimensions({ ...DRAWN_SOIC8, bodyLengthMm: null, bodyWidthMm: null, bodyHeightMm: null });
  const bundle = await createExportZip(part, "kicad", {
    supplied: { bodyLengthMm: 4.9, bodyWidthMm: 3.9, bodyHeightMm: 1.75 }
  });
  const zip = await JSZip.loadAsync(bundle.buffer);
  const step = Object.keys(zip.files).find((file) => file.endsWith(".step"))!;
  const text = await zip.files[step].async("string");

  // The solid sits ON the board, spanning 0 to the height, and it is the height
  // that was supplied rather than a default.
  assert.match(text, /1\.75/, "the supplied height reaches the solid");
  assert.doesNotMatch(text, /,1\.5\)/, "and no 1.5 mm default survives anywhere");
});

test("every outstanding value is asked for in one pass, not one round trip each", async () => {
  // The footprint and the 3D body fail independently. Asking for one and then the
  // other turns a part needing four numbers into four separate refusals.
  const error = await refusal(
    withDimensions({ pitchMm: 1.27, leadSides: 2, bodyLengthMm: null, bodyWidthMm: null, bodyHeightMm: null })
  );
  const fields = error.needs.map((need) => need.field);
  assert.ok(fields.some((field) => field.startsWith("land")), "the land pattern is asked for");
  assert.ok(fields.includes("bodyLengthMm"), "and the body, in the same refusal");
});

test("a through-hole footprint has a silkscreen outline", async () => {
  // Found on 2026-08-15 by reading a generated DIP back with an independent
  // Altium parser: it reported four courtyard tracks and ZERO on the silkscreen
  // layer. The whole outline had been erased.
  //
  // The cause was the clipping rule that keeps silk off the pads. On a
  // surface-mount package the body is bigger than the lead rows in at least one
  // axis, so clipping leaves corner stubs. On a through-hole package the holes
  // sit outside the body on one axis and past its ends on the other, so every
  // edge crosses a pad and clipping removed all four.
  //
  // An assembler orients a through-hole part by its outline and its pin-1 mark.
  // An empty silkscreen layer is not a cosmetic loss.
  const footprint = await footprintOf(dip8());
  const silk = [...footprint.matchAll(/\(fp_line \(start (-?[\d.]+) (-?[\d.]+)\) \(end (-?[\d.]+) (-?[\d.]+)\) \(layer "F\.SilkS"\)/g)];
  assert.equal(silk.length, 4, "all four edges are drawn");

  // And the outline still describes the BODY rather than the pad envelope. The
  // body is 6.35 x 9.27 mm, so each edge should sit within half a millimetre of
  // its true half-extent.
  const xs = silk.flatMap((s) => [Number(s[1]), Number(s[3])]);
  const ys = silk.flatMap((s) => [Number(s[2]), Number(s[4])]);
  assert.ok(Math.abs(Math.max(...xs) - 6.35 / 2) < 0.5, `silk half-width ${Math.max(...xs)} against a 3.175 mm body`);
  assert.ok(Math.abs(Math.max(...ys) - 9.27 / 2) < 0.5, `silk half-height ${Math.max(...ys)} against a 4.635 mm body`);
});

test("no silkscreen segment crosses a pad", async () => {
  // The property the clipping exists for, asserted on the case that broke it.
  const footprint = await footprintOf(dip8());
  const pads = [...footprint.matchAll(/\(pad "[^"]*" \w+ \w+ \(at (-?[\d.]+) (-?[\d.]+)\) \(size ([\d.]+) ([\d.]+)\)/g)].map((m) => ({
    x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4])
  }));
  for (const s of footprint.matchAll(/\(fp_line \(start (-?[\d.]+) (-?[\d.]+)\) \(end (-?[\d.]+) (-?[\d.]+)\) \(layer "F\.SilkS"\)/g)) {
    const [x1, y1, x2, y2] = [Number(s[1]), Number(s[2]), Number(s[3]), Number(s[4])];
    for (const pad of pads) {
      const overlapsX = Math.min(x1, x2) < pad.x + pad.w / 2 && Math.max(x1, x2) > pad.x - pad.w / 2;
      const overlapsY = Math.min(y1, y2) < pad.y + pad.h / 2 && Math.max(y1, y2) > pad.y - pad.h / 2;
      assert.ok(!(overlapsX && overlapsY), `a silk segment runs across the pad at ${pad.x},${pad.y}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The solder mask clearance belongs to ONE of the two variants
// ---------------------------------------------------------------------------

/**
 * A land-pattern drawing prints two mask details side by side: the
 * NON-solder-mask-defined one, where copper defines the land and the mask
 * opening is larger, and the solder-mask-defined one, where the mask opening is
 * smaller and defines the pad. The clearance figure means opposite things in the
 * two, and the prompt asks for the pair together for exactly that reason.
 *
 * `solderMaskDefined` was read, stored, carried through `resolveForExport` and
 * consumed by NOTHING until 2026-08-16, so whichever variant the model happened
 * to report was written as a positive mask expansion. On a mask-defined figure
 * that opens the mask wider precisely where it should be narrower.
 *
 * Neither emitter can express a mask-defined land today, so the honest outcome
 * is to emit no clearance rather than the wrong one.
 */
test("a non-solder-mask-defined clearance reaches the pad, because that is what we emit", async () => {
  const footprint = await footprintOf(
    withDimensions({
      pitchMm: 1.27,
      leadSides: 2,
      landPadLengthMm: 1.95,
      landPadWidthMm: 0.6,
      landSpanMm: 4.95,
      landSpanCrossMm: null,
      solderMaskExpansionMm: 0.05,
      solderMaskDefined: "non-solder-mask-defined"
    })
  );
  assert.match(footprint, /\(solder_mask_margin 0\.050\)/, "the datasheet's own figure is written");
});

test("a solder-mask-defined clearance is NOT written as an expansion", async () => {
  const footprint = await footprintOf(
    withDimensions({
      pitchMm: 1.27,
      leadSides: 2,
      landPadLengthMm: 1.95,
      landPadWidthMm: 0.6,
      landSpanMm: 4.95,
      landSpanCrossMm: null,
      solderMaskExpansionMm: 0.05,
      solderMaskDefined: "solder-mask-defined"
    })
  );
  assert.doesNotMatch(
    footprint,
    /solder_mask_margin/,
    "the mask opening is smaller than the copper on this variant, so a positive margin is the wrong instruction"
  );
});

test("an UNREAD variant does not take the clearance, because the number means two opposite things", async () => {
  // This test asserted the opposite until 2026-08-21, on the premise that "most
  // drawings print one detail and do not label it". MEASURED over the 57 cached
  // tuned datasheets: 24 of the 25 that carry a mask detail print BOTH variants,
  // labelled, side by side. Exactly one does not. The premise was backwards.
  //
  // Hand-read from LM139AQML-SP page 31 (NAC0014A): the two details carry THE
  // SAME FIGURE - ".003 MAX ALL AROUND [0.07]" for non-solder-mask-defined and
  // ".003 MIN ALL AROUND [0.07]" for solder-mask-defined. One opens the mask
  // wider than the copper; the other holds it back inside the copper. The number
  // cannot tell you which, so writing it as an expansion is a coin flip on a
  // value the fabricator builds to.
  //
  // Omitting is not a refusal to answer, it is the ordinary library behaviour:
  // the board's own mask rule applies, exactly as it does for every footprint
  // that carries no per-pad override.
  const footprint = await footprintOf(
    withDimensions({
      pitchMm: 1.27,
      leadSides: 2,
      landPadLengthMm: 1.95,
      landPadWidthMm: 0.6,
      landSpanMm: 4.95,
      landSpanCrossMm: null,
      solderMaskExpansionMm: 0.05,
      solderMaskDefined: null
    })
  );
  assert.doesNotMatch(
    footprint,
    /solder_mask_margin/,
    "the variant was not read, so which of the two opposite meanings this 0.05 carries is unknown"
  );
});
