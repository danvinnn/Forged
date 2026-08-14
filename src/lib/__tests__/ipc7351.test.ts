import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLandPattern, LandPatternError, type LeadDimensions } from "../ipc7351";
import { findPackageDefinition, resolvePackageDefinition, SUPPORTED_PACKAGE_FAMILIES } from "../packages";

// The point of these tests is that they can FAIL against reality. A land pattern
// calculator that only agrees with itself is worth nothing: the numbers below
// are the pattern IPC-7351B publishes for a narrow-body SOIC, so a wrong fillet
// goal, a wrong tolerance combination or a wrong lead dimension in the package
// table shows up here rather than on a fabricated board.

/** How close a computed land has to sit to the published one, in mm. */
const TOLERANCE_MM = 0.05;

function assertClose(actual: number, expected: number, what: string): void {
  assert.ok(
    Math.abs(actual - expected) <= TOLERANCE_MM,
    `${what}: computed ${actual.toFixed(3)} mm, published ${expected.toFixed(3)} mm, difference ${Math.abs(actual - expected).toFixed(3)} mm exceeds the ${TOLERANCE_MM} mm tolerance`
  );
}

test("narrow-body SOIC reproduces the published IPC-7351B land pattern", () => {
  const lookup = findPackageDefinition("8-pin SOIC", 8);
  assert.equal(lookup.ok, true, "SOIC must resolve");
  if (!lookup.ok) return;

  const land = computeLandPattern(lookup.definition.lead, { densityLevel: "B" });

  // Published nominal (density B) pattern for SOIC127P600X175-8N.
  assertClose(land.padWidthMm, 0.6, "land width X");
  assertClose(land.padLengthMm, 1.55, "land length Y");
  assertClose(land.padCentreMm * 2, 5.4, "centre-to-centre span C");
});

test("density level changes the land the way the standard says it should", () => {
  const lookup = findPackageDefinition("SOIC (8)", 8);
  assert.equal(lookup.ok, true);
  if (!lookup.ok) return;

  const most = computeLandPattern(lookup.definition.lead, { densityLevel: "A" });
  const nominal = computeLandPattern(lookup.definition.lead, { densityLevel: "B" });
  const least = computeLandPattern(lookup.definition.lead, { densityLevel: "C" });

  assert.ok(most.padLengthMm > nominal.padLengthMm, "level A lands are longer than level B");
  assert.ok(nominal.padLengthMm > least.padLengthMm, "level B lands are longer than level C");
  assert.ok(most.courtyardHalfMm > nominal.courtyardHalfMm, "level A courtyard is larger");
  assert.ok(most.padWidthMm > least.padWidthMm, "side fillet grows with density level");
});

test("a missing lead dimension refuses instead of defaulting", () => {
  // The failure this whole module exists to prevent. The old exporter defaulted
  // an unknown pitch to 1.27 mm and carried on, which is how a part that does
  // not fit the board gets a footprint that looks authoritative.
  const incomplete = {
    form: "gullwing",
    span: { minMm: 5.8, maxMm: 6.2 },
    contact: { minMm: Number.NaN, maxMm: Number.NaN },
    width: { minMm: 0.31, maxMm: 0.51 }
  } as LeadDimensions;

  assert.throws(
    () => computeLandPattern(incomplete),
    (error: unknown) => {
      assert.ok(error instanceof LandPatternError);
      assert.ok(
        error.missing.some((entry) => /contact length/.test(entry)),
        "the refusal must name what is missing"
      );
      return true;
    }
  );
});

test("inconsistent lead dimensions are refused, not silently inverted", () => {
  // Feet longer than half the span put the heel past the toe. That is a data
  // error, and emitting overlapping lands from it would be worse than refusing.
  const impossible: LeadDimensions = {
    form: "gullwing",
    span: { minMm: 5.8, maxMm: 6.2 },
    contact: { minMm: 3.0, maxMm: 4.0 },
    width: { minMm: 0.31, maxMm: 0.51 }
  };

  assert.throws(() => computeLandPattern(impossible), LandPatternError);
});

test("an uncharacterised package is refused and says what is supported", () => {
  const lookup = findPackageDefinition("12-Pin BGA", 12);

  assert.equal(lookup.ok, false, "BGA has no entered fillet goals, so it must refuse");
  if (lookup.ok) return;
  assert.match(lookup.failure.reason, /12-Pin BGA/, "the refusal names the package it saw");
  assert.deepEqual(lookup.failure.supported, SUPPORTED_PACKAGE_FAMILIES);
});

test("wide-body SOIC is not treated as narrow body", () => {
  // The two share a name and differ by more than 4 mm of lead span. Matching one
  // entry to both would put every pad on a wide-body part in the wrong place.
  // Wide body used to be refused outright; now it resolves to its own entry, and
  // what must never happen is it borrowing the narrow-body geometry.
  const lookup = findPackageDefinition("16-pin SOIC-WB wide", 16);

  assert.equal(lookup.ok, true, "wide body is characterised in its own right");
  if (!lookup.ok) return;
  assert.equal(lookup.definition.family, "SOIC wide");
  assert.notEqual(lookup.definition.lead.span.minMm, 5.8, "it must not take the narrow-body span");
});

test("eight-lead VSSOP reproduces the land pattern TI prints for it", () => {
  // Ground truth is the vendor's own drawing: the LM358 datasheet prints the
  // DGK0008A outline (JEDEC MO-187, its note 5) and, on the facing page, 8 lands
  // of 1.4 x 0.45 on a 4.4 mm centre span.
  const lookup = findPackageDefinition("8-Pin VSSOP", 8);
  assert.equal(lookup.ok, true, "eight-lead VSSOP is characterised in its own right");
  if (!lookup.ok) return;
  assert.equal(lookup.definition.family, "VSSOP-8");
  assert.equal(lookup.definition.pitchMm, 0.65, "0.65 is what separates it from the ten-lead body");

  const land = computeLandPattern(lookup.definition.lead, { densityLevel: "B" });
  assertClose(land.padCentreMm * 2, 4.4, "centre-to-centre span");

  // The land WIDTH needed no calibration on this family, which is the first time
  // that has happened here: 0.25 + 2(0.03) + rss(0.13) is 0.4515 against TI's
  // printed 0.45. Asserted tightly on purpose, because a drift would mean the
  // drawing figures behind it had changed.
  assertClose(land.padWidthMm, 0.45, "land width across the lead");
});

test("eight-lead and ten-lead VSSOP are not the same package", () => {
  // They share a name and a body and differ by 0.15 mm of pitch, which compounds
  // down the row: one entry covering both would put every pad on an eight-lead
  // part a step and a half out by the far end. Same rule as narrow against wide
  // SOIC, and the pin count is what selects between them.
  const eight = findPackageDefinition("VSSOP", 8);
  const ten = findPackageDefinition("VSSOP", 10);

  assert.equal(eight.ok, true);
  assert.equal(ten.ok, true);
  if (!eight.ok || !ten.ok) return;
  assert.equal(eight.definition.pitchMm, 0.65);
  assert.equal(ten.definition.pitchMm, 0.5);
  assert.notEqual(eight.definition.family, ten.definition.family);

  // And a pin count neither entry covers is still refused rather than rounded to
  // whichever is nearer.
  assert.equal(findPackageDefinition("VSSOP", 12).ok, false, "12-lead VSSOP is not characterised");
});

test("an MSOP does not take VSSOP geometry", () => {
  // TI called this same DGK outline `MSOP` before renaming it, and ADI still
  // ships a package of that name whose drawing nobody here has read. A family
  // name shared across vendors is not evidence of a shared lead span, so the
  // match is on `VSSOP` alone and an MSOP is refused.
  for (const [designator, pins] of [["MSOP-8", 8], ["10-lead MSOP", 10]] as const) {
    const lookup = findPackageDefinition(designator, pins);
    assert.equal(lookup.ok, false, `${designator} must not resolve to a VSSOP entry`);
  }
});

test("a thermally enhanced TSSOP does not borrow the TSSOP land pattern", () => {
  // The same rule wide-body SOIC pins, on the family that was added to the
  // designator vocabulary most recently. `HTSSOP` is TI's PowerPAD TSSOP:
  // DRV8825's is a 9.70 x 6.40 body with 28 leads, where MO-153 AA, which is
  // what the `TSSOP` entry was read from, is 4.4 mm wide and stops at 16.
  //
  // Two independent things keep them apart and this pins both. The `TSSOP` entry
  // matches on `\bTSSOP\b`, and the `H` in front is a word character, so there
  // is no boundary to match at; and the pin count is outside the range anyway.
  // Recognising the designator must never be the same act as characterising it.
  for (const [designator, pinCount] of [["HTSSOP (28)", 28], ["20-Pin HTSSOP", 20]] as const) {
    const lookup = findPackageDefinition(designator, pinCount);
    assert.equal(lookup.ok, false, `${designator} has no characterised land pattern`);
    if (lookup.ok) return;
    assert.match(lookup.failure.reason, /No IPC-7351B land pattern is characterised/);
    assert.match(lookup.failure.reason, /HTSSOP/, "the refusal names the package it saw");
  }
});

test("an outline code that cannot be read refuses a SOIC rather than defaulting to narrow", () => {
  // A live wrong-footprint defect, found by exporting every cached part and
  // reading the pad spans. ISO7841's drawing is titled `DWW0016A`; that prefix
  // is not in the outline-code map, so the coded family came back undefined and
  // the narrow/wide decision fell through to a prose test on `16-pin SOIC`,
  // which says nothing about the body. The part shipped at a 5.376 mm
  // centre-to-centre span. Its sibling ISO7741, whose `DW0016B` IS in the map,
  // ships at 9.301, and a 16-lead SOIC body is 7.5 mm wide, so those pads sat
  // underneath the package.
  //
  // An outline code we cannot read is evidence we cannot use, which is not the
  // same as no evidence at all.
  const unreadable = findPackageDefinition("16-pin SOIC", 16, "DWW0016A");
  assert.equal(unreadable.ok, false, "an uninterpretable code must not resolve to narrow body");
  if (unreadable.ok) return;
  assert.match(unreadable.failure.reason, /DWW0016A/, "the refusal names the code it could not read");

  // The code that IS in the map still decides, which is the behaviour this
  // guards rather than replaces.
  const readable = findPackageDefinition("16-pin SOIC", 16, "DW0016B");
  assert.equal(readable.ok, true);
  if (!readable.ok) return;
  assert.equal(readable.definition.family, "SOIC wide");
});

test("an unreadable outline code is harmless where the name settles the family", () => {
  // The scope that makes the rule above safe to add. An `8-Pin VSSOP` with an
  // unrecognised `DGK0008A` is not ambiguous: the pin count and the pitch choose
  // that family outright and no outline code is needed to tell two bodies apart.
  // Two parts ship on exactly this path, so a blanket refusal would have cost
  // them for nothing.
  const lookup = findPackageDefinition("8-Pin VSSOP", 8, "DGK0008A");

  assert.equal(lookup.ok, true, "an unreadable code costs nothing where the name is unambiguous");
  if (!lookup.ok) return;
  assert.equal(lookup.definition.family, "VSSOP-8");
});

test("LQFP-80 reproduces the land pattern TI prints for it", () => {
  // Ground truth is the vendor's own drawing: the MSP430F5529 datasheet prints
  // the PN0080A outline (JEDEC MS-026, its note 3) and, on the facing page, 80
  // lands of 1.5 x 0.3 on a 13.4 mm centre span, the same in both axes because
  // the body is square.
  const lookup = findPackageDefinition("LQFP (80)", 80);
  assert.equal(lookup.ok, true, "the first quad family characterised here");
  if (!lookup.ok) return;
  assert.equal(lookup.definition.family, "LQFP-80");
  assert.equal(lookup.definition.arrangement, "quad");

  const land = computeLandPattern(lookup.definition.lead, { densityLevel: "B" });
  assertClose(land.padCentreMm * 2, 13.4, "centre-to-centre span");
  assertClose(land.padLengthMm, 1.5, "land length along the lead");

  // Documented divergence, asserted so it cannot drift: IPC-7351B density B
  // gives a WIDER land than TI's printed 0.3 here, where on TSSOP it gives a
  // narrower one than TI's. Both are inside the 0.5 pitch with room to spare.
  assert.ok(land.padWidthMm > 0.3, "IPC density B is wider than TI's printed land on this family");
  assert.ok(land.padWidthMm < 0.5, "and still clears the pitch");
});

test("a quad designator is never resolved by a dual-row entry", () => {
  // The trap the quad guard exists for. `FLATPACK` is how a ceramic DUAL flat
  // pack is written and it is also the middle of `PLASTIC QUAD FLATPACK`, which
  // titles every TI LQFP and VQFN drawing, so a quad package could otherwise be
  // handed CFP lead dimensions. Restricting the candidate set to quad entries is
  // what makes that impossible rather than merely unlikely.
  for (const designator of [
    "48-lead PLASTIC QUAD FLATPACK",
    "64 Ld EP-TQFP",
    "24-Pin VQFN",
    "128 Pin Ceramic LQFP"
  ]) {
    const lookup = findPackageDefinition(designator, 48);
    if (lookup.ok) {
      assert.equal(lookup.definition.arrangement, "quad", `${designator} resolved to a dual entry`);
    } else {
      assert.match(lookup.failure.reason, /quad flat pack/);
    }
  }
});

test("a pin count outside the characterised range is refused", () => {
  const lookup = findPackageDefinition("SOIC", 48);

  assert.equal(lookup.ok, false, "48 pins is not a narrow-body SOIC");
  if (lookup.ok) return;
  assert.match(lookup.failure.reason, /8 to 16 pins/);
});

test("TSSOP reproduces the land pattern TI prints for it", () => {
  // Ground truth is the vendor's own drawing, not memory: the INA240 datasheet
  // prints 8 lands of 1.5 x 0.45 on a 5.8 mm centre span for PW0008A.
  const lookup = findPackageDefinition("8-pin TSSOP", 8);
  assert.equal(lookup.ok, true);
  if (!lookup.ok) return;

  const land = computeLandPattern(lookup.definition.lead, { densityLevel: "B" });
  const printedCentre = 5.8;
  const printedLength = 1.5;

  assertClose(land.zMaxMm, printedCentre + printedLength, "outer extent Zmax");
  assertClose(land.gMinMm, printedCentre - printedLength, "inner gap Gmin");
  assertClose(land.padCentreMm * 2, printedCentre, "centre-to-centre span");

  // Documented difference, asserted so it cannot drift unnoticed: IPC-7351B
  // density B uses a smaller side fillet than TI's house rule, so our lands come
  // out narrower than the 0.45 TI prints. This is a real divergence between two
  // valid rule sets, not an error.
  assert.ok(land.padWidthMm < 0.45, "IPC density B is narrower than TI's printed land");
  assert.ok(land.padWidthMm > 0.3, "but not by more than a tenth of a millimetre");
});

test("pitch is per family, not shared", () => {
  const soic = findPackageDefinition("SOIC", 8);
  const tssop = findPackageDefinition("TSSOP", 8);
  assert.equal(soic.ok && tssop.ok, true);
  if (!soic.ok || !tssop.ok) return;

  assert.equal(soic.definition.pitchMm, 1.27);
  assert.equal(tssop.definition.pitchMm, 0.65);
});

test("a ceramic flat pack refuses until the lead form is specified", () => {
  // The finding that made CFP different from every plastic family: read the TI
  // HKU0010A drawing and the part ships with STRAIGHT leads, 22.7 mm tip to tip
  // on a 7 mm body. The assembler trims and forms them, so the seated span is a
  // property of the board process. This is also why TI prints no land pattern
  // for it and why IPC-7351B has no CFP family.
  const lookup = findPackageDefinition("14-lead CFP", 14);
  assert.equal(lookup.ok, true, "CFP must be recognised as a family");
  if (!lookup.ok) return;

  assert.equal(lookup.definition.spanFromLeadForm, true, "its span comes from the lead form");
  assert.ok(
    Number.isNaN(lookup.definition.lead.span.minMm),
    "no span may be asserted for a package that has none until it is formed"
  );
  assert.throws(() => computeLandPattern(lookup.definition.lead), LandPatternError);
});

test("a specified lead form gives a ceramic flat pack a real land pattern", () => {
  const lookup = findPackageDefinition("10-pin CFP", 10);
  assert.equal(lookup.ok, true);
  if (!lookup.ok) return;

  // A conventional trim and form on the 10-pin part, toe to toe.
  const formedSpanMm = 10.2;
  const land = computeLandPattern({
    ...lookup.definition.lead,
    span: { minMm: formedSpanMm - 0.2, maxMm: formedSpanMm + 0.2 }
  });

  assert.ok(land.padCentreMm * 2 > formedSpanMm - 2, "lands track the span they were given");
  assert.ok(land.padCentreMm * 2 < formedSpanMm + 2);
  assert.ok(land.padWidthMm > 0.38, "land is at least as wide as the 0.38 mm lead");
  assert.ok(land.gMinMm > 0, "opposing lands do not cross the centre line");
});

test("wide-body SOIC reproduces the land pattern TI labels IPC-7351 nominal", () => {
  // Ground truth from the document: the ISO7741 datasheet prints 16 lands of
  // 2.0 x 0.6 on a 9.3 mm centre span for DW0016B and labels it "IPC-7351
  // NOMINAL". Wide body shares its name with narrow body and differs by 4.3 mm
  // of span, so getting this entry wrong misplaces every pad on the part.
  const lookup = findPackageDefinition("16-pin SOIC-WB wide", 16);
  assert.equal(lookup.ok, true, "wide body must now resolve, not refuse");
  if (!lookup.ok) return;
  assert.equal(lookup.definition.family, "SOIC wide");

  const land = computeLandPattern(lookup.definition.lead, { densityLevel: "B" });
  assertClose(land.padLengthMm, 2.0, "land length Y");
  assertClose(land.padWidthMm, 0.6, "land width X");
  assertClose(land.padCentreMm * 2, 9.3, "centre-to-centre span C");
});

test("wide and narrow SOIC never resolve to each other", () => {
  const narrow = findPackageDefinition("SOIC-8", 8);
  const wide = findPackageDefinition("SOIC (DW-16)", 16);
  assert.equal(narrow.ok && wide.ok, true);
  if (!narrow.ok || !wide.ok) return;

  assert.equal(narrow.definition.family, "SOIC narrow");
  assert.equal(wide.definition.family, "SOIC wide");
  // 4.3 mm apart. Confusing them is a scrapped board, not a rounding error.
  assert.ok(wide.definition.lead.span.minMm - narrow.definition.lead.span.minMm > 4);
});

test("a ceramic package is not handed a plastic family's geometry", () => {
  // Every characterised family except CFP is a plastic JEDEC outline read off a
  // plastic drawing. An ADC128S102QML-SP is sold as a `16-Lead Ceramic SOIC` and
  // a `16-lead ceramic flatpack`; matching the first on the word SOIC would give
  // a hermetic part MS-012 lead spans.
  //
  // Found by offering the datasheet's own package list to the user, which made
  // this reachable in one click.
  const lookup = findPackageDefinition("16-Lead Ceramic SOIC", 16);

  assert.equal(lookup.ok, false);
  assert.match(lookup.failure.reason, /ceramic/i);
  assert.match(lookup.failure.reason, /lead span/i);
});

test("but a ceramic FLAT PACK is exactly what CFP is", () => {
  const lookup = findPackageDefinition("16-lead ceramic flatpack", 16);

  assert.equal(lookup.ok, true);
  assert.equal(lookup.definition.family, "CFP");
});

test("VSSOP-10 reproduces the centre span TI prints, and diverges on length", () => {
  // Ground truth is the DGS0010A drawing in the ADS1115 datasheet, read off a
  // RENDERED page: 10 lands of 1.45 x 0.3 on a 4.4 mm centre span.
  const lookup = findPackageDefinition("VSSOP-10", 10);
  assert.equal(lookup.ok, true);
  if (!lookup.ok) return;

  const land = computeLandPattern(lookup.definition.lead, { densityLevel: "B" });

  assertClose(land.padCentreMm * 2, 4.4, "centre-to-centre span");

  // The documented divergence, asserted so it cannot drift unnoticed. IPC-7351B
  // density B lands are SHORTER than the example TI prints here, which is the
  // first family where the two disagree on length rather than width, and TI's own
  // note 6 on that page says "Publication IPC-7351 may have alternate designs".
  // Shorter lands on the correct centres are the conservative answer of the two.
  assert.ok(land.padLengthMm < 1.45, "IPC density B is shorter than TI's printed land");
  assert.ok(land.padLengthMm > 1.3, "but by about a tenth of a millimetre, not more");
});

test("a VSSOP-8 is not given the ten-lead pitch", () => {
  // TI's VSSOP-8 is the DGK, the same MO-187 body at 0.65 mm pitch. Taking the
  // ten-lead entry would step every pad 0.15 mm per position and compound down
  // the row, so this refused outright until the DGK0008A drawing was read.
  //
  // It now resolves to its OWN entry, which is the better answer to the same
  // question: what must never happen is an eight-lead part being given 0.5 mm.
  const lookup = findPackageDefinition("VSSOP-8", 8);

  assert.equal(lookup.ok, true, "characterised from the LM358 datasheet's DGK0008A drawing");
  if (!lookup.ok) return;
  assert.equal(lookup.definition.pitchMm, 0.65, "the eight-lead pitch, never the ten-lead 0.5");
  assert.notEqual(lookup.definition.lead.width.minMm, 0.17, "nor the ten-lead lead width");
});

test("ST's FLAT-16P is the same ceramic flat pack as TI's CFP", () => {
  // Admitted on the strength of the drawing rather than the name. RHFL4913's
  // Table 5 gives pitch 1.27 typ, lead width 0.38-0.48 and two L dimensions of
  // 6.35-7.36 either side of a 6.71-7.11 body, so tip to tip is about 19 to 22 mm
  // of STRAIGHT lead: the same family, the same numbers, a different vendor's
  // spelling. It was unreachable before because no entry matched the designator.
  for (const designator of ["FLAT-16P", "Flat-8", "FLAT16"]) {
    const lookup = findPackageDefinition(designator, 8);
    assert.equal(lookup.ok, true, `${designator} must resolve`);
    if (lookup.ok) assert.equal(lookup.definition.family, "CFP");
  }
});

test("but a QUAD flat pack is not, whatever it is called", () => {
  // `FLATPACK` is how a ceramic DUAL flat pack is written and it is also the
  // middle of `PLASTIC QUAD FLATPACK`, the title of every TI LQFP and VQFN
  // drawing. Four rows of plastic leads are not two rows of straight ceramic
  // ones, and this was refused only by luck before: the counts that reached it
  // happened to sit above CFP's 48 lead ceiling, so a 44 lead one went through.
  for (const designator of ["PLASTIC QUAD FLATPACK", "LQFP (80)", "VQFN (64)", "TQFP", "44-pin QFP"]) {
    const lookup = findPackageDefinition(designator, 44);
    assert.equal(lookup.ok, false, `${designator} must be refused`);
    if (!lookup.ok) assert.match(lookup.failure.reason, /quad flat pack|four rows/i);
  }
});

test("a ceramic flat pack still refuses without a formed lead span", () => {
  // The point of admitting FLAT-16P is not that it now guesses a span. It is that
  // the refusal becomes one the caller can answer.
  const lookup = findPackageDefinition("FLAT-16P", 16);
  assert.equal(lookup.ok, true);
  if (!lookup.ok) return;
  assert.equal(lookup.definition.spanFromLeadForm, true);
  assert.ok(Number.isNaN(lookup.definition.lead.span.minMm), "no span is asserted for it");
});

// ---------------------------------------------------------------------------
// The LQFP family, four bodies on one lead
//
// MS-026 keeps one lead form across a family of bodies that grow with the lead
// count. These lock in that each body is its OWN entry, that a count with no
// entry is refused rather than interpolated, and that a lead count glued to the
// family name still resolves.
// ---------------------------------------------------------------------------

test("each characterised LQFP body resolves to its own span", () => {
  // The spans are the drawings' D/E: 9, 12, 14, 16 and 22 mm nominal. If two
  // bodies ever resolved to one entry, the pads would be placed on the wrong
  // one's span, which is the failure the per-count entries exist to prevent.
  const spans = new Map<number, number>();
  for (const [designator, pinCount] of [
    ["LQFP48", 48], ["LQFP64", 64], ["LQFP (PN)", 80], ["LQFP100", 100], ["LQFP144", 144]
  ] as const) {
    const lookup = findPackageDefinition(designator, pinCount);
    assert.ok(lookup.ok, `${designator} must resolve`);
    assert.equal(lookup.definition.arrangement, "quad");
    assert.equal(lookup.definition.pitchMm, 0.5);
    spans.set(pinCount, lookup.definition.lead.span.minMm);
  }

  assert.deepEqual(
    [...spans.entries()].sort((a, b) => a[0] - b[0]),
    [[48, 8.8], [64, 11.8], [80, 13.8], [100, 15.8], [144, 21.8]],
    "every body keeps the span its own drawing prints"
  );
});

test("a lead count glued to the family name is still recognised as a quad", () => {
  // `\bLQFP\b` cannot match `LQFP64`, because the digit leaves no word boundary.
  // Unrecognised as quad, a glued designator fell through to the DUAL-row
  // families, which is the substitution the quad guard exists to prevent.
  const lookup = findPackageDefinition("LQFP64", 64);
  assert.ok(lookup.ok);
  assert.equal(lookup.definition.family, "LQFP-64");
  assert.equal(lookup.definition.arrangement, "quad");
});

test("an LQFP lead count with no characterised body is refused, not interpolated", () => {
  // 176 is a real LQFP and its body is 24 mm, which is not derivable from the
  // entries either side of it. Bodies grow with the count off different
  // drawings, so there is nothing to interpolate.
  const lookup = findPackageDefinition("LQFP176", 176);
  assert.equal(lookup.ok, false);
  if (!lookup.ok) assert.match(lookup.failure.reason, /quad flat pack|not 176/i);
});

test("a quad designator never takes a dual-row entry's geometry", () => {
  // The reason QUAD_FLAT_PACK restricts the candidate set rather than checking
  // the winner afterwards. A VQFN has no characterised entry and must refuse,
  // not fall through to CFP because `FLATPACK` appears inside its drawing title.
  const lookup = findPackageDefinition("VQFN48", 48);
  assert.equal(lookup.ok, false);
});

test("the LQFP land pattern lands on the leads it is built for", () => {
  // The whole point, checked as geometry rather than as numbers: every pad must
  // cover the foot it solders to, with the toe reaching past the lead tip and
  // the heel inside it, and neighbouring pads must not touch at 0.5 mm pitch.
  const lookup = findPackageDefinition("LQFP64", 64);
  assert.ok(lookup.ok);
  const land = computeLandPattern(lookup.definition.lead);

  const outerHalf = land.zMaxMm / 2;
  const innerHalf = land.gMinMm / 2;
  const leadTipMax = lookup.definition.lead.span.maxMm / 2;
  const leadTipMin = lookup.definition.lead.span.minMm / 2;
  const heelMin = leadTipMin - lookup.definition.lead.contact.maxMm;

  assert.ok(outerHalf > leadTipMax, "the toe must reach past the longest lead tip");
  assert.ok(innerHalf < heelMin, "the heel must reach inside the shortest foot");
  assert.ok(
    land.padWidthMm < lookup.definition.pitchMm,
    "neighbouring lands must not touch at the family pitch"
  );
});

test("a characterised family yields to the span printed on this part's own drawing", () => {
  // One family name covers several body widths. JEDEC MO-153 is "TSSOP" at both
  // a 4.4 mm and a 6.1 mm body, spans 6.2-6.6 and 8.0-8.4, and the pitch is 0.65
  // on both, so the pitch agreement check cannot tell them apart. The TSSOP
  // entry took 6.2-6.6 from one INA240 drawing, so before this a wide-body part
  // inherited a span 1.8 mm too small and the pads landed inside the leads.
  const wideBody = {
    pitchMm: 0.65,
    leadSpanMm: { minMm: 8.0, maxMm: 8.4 },
    leadWidthMm: { minMm: 0.19, maxMm: 0.3 }
  };
  const lookup = resolvePackageDefinition("TSSOP", 16, wideBody);
  assert.equal(lookup.ok, true);
  assert.ok(lookup.ok);

  assert.deepEqual(
    lookup.definition.lead.span,
    { minMm: 8.0, maxMm: 8.4 },
    "the drawing in front of us outranks the one the family was read from"
  );
  // The contact must NOT move: IPC's contact is the seated foot, no drawing
  // prints it, and it stays the family's hand calibration. See the printed-L
  // guard below.
  assert.deepEqual(lookup.definition.lead.contact, { minMm: 0.5, maxMm: 0.6 });
  assert.match(lookup.definition.source, /Lead span 8-8\.4 mm read off this part's own package drawing/);

  // And the pattern actually moves, or the override is cosmetic. `zMaxMm` is
  // the outer toe-to-toe extent, which is what a 1.8 mm wider span buys.
  const familyLookup = resolvePackageDefinition("TSSOP", 16, { pitchMm: 0.65 });
  assert.ok(familyLookup.ok);
  const narrow = computeLandPattern(familyLookup.definition.lead);
  const wide = computeLandPattern(lookup.definition.lead);
  assert.ok(
    wide.zMaxMm - narrow.zMaxMm > 1.5,
    `a 1.8 mm wider lead span must widen the lands: ${narrow.zMaxMm.toFixed(2)} -> ${wide.zMaxMm.toFixed(2)}`
  );
});

test("a drawing span is ignored when it is not usable", () => {
  // Same shape as the width guard: a zero, a negative or an inverted range is
  // not evidence, and falling back to the family is better than propagating it.
  for (const bad of [
    { minMm: 0, maxMm: 6.6 },
    { minMm: -1, maxMm: 6.6 },
    { minMm: 6.6, maxMm: 6.2 }
  ]) {
    const lookup = resolvePackageDefinition("TSSOP", 16, { pitchMm: 0.65, leadSpanMm: bad });
    assert.ok(lookup.ok);
    assert.deepEqual(lookup.definition.lead.span, { minMm: 6.2, maxMm: 6.6 }, `${JSON.stringify(bad)} must not be believed`);
  }
});

// --- land patterns derived from a part's OWN drawing -------------------------
//
// `packageFromDrawing` builds a definition when no characterised family covers
// the part. These pin how far that answer may sit from the hand-read entry for
// the same package, because the two must not silently diverge.

test("a drawing-derived land pattern agrees with the hand-characterised entry", () => {
  // The hand-read family constants from packages.ts, against the same drawing
  // read as four plain dimensions with a single nominal contact length.
  const cases = [
    {
      family: "SOIC narrow",
      hand: { span: { minMm: 5.8, maxMm: 6.2 }, contact: { minMm: 0.4, maxMm: 0.625 }, width: { minMm: 0.31, maxMm: 0.51 } },
      drawn: { span: { minMm: 5.8, maxMm: 6.19 }, contact: { minMm: 0.55, maxMm: 0.55 }, width: { minMm: 0.31, maxMm: 0.51 } }
    },
    {
      family: "TSSOP",
      hand: { span: { minMm: 6.2, maxMm: 6.6 }, contact: { minMm: 0.5, maxMm: 0.6 }, width: { minMm: 0.19, maxMm: 0.3 } },
      drawn: { span: { minMm: 6.2, maxMm: 6.6 }, contact: { minMm: 0.55, maxMm: 0.55 }, width: { minMm: 0.19, maxMm: 0.3 } }
    },
    {
      family: "VSSOP-8",
      hand: { span: { minMm: 4.75, maxMm: 5.05 }, contact: { minMm: 0.4, maxMm: 0.5 }, width: { minMm: 0.25, maxMm: 0.38 } },
      drawn: { span: { minMm: 4.75, maxMm: 5.05 }, contact: { minMm: 0.45, maxMm: 0.45 }, width: { minMm: 0.25, maxMm: 0.38 } }
    }
  ];

  for (const { family, hand, drawn } of cases) {
    const characterised = computeLandPattern({ form: "gullwing", ...hand });
    const derived = computeLandPattern({ form: "gullwing", ...drawn });

    // Pad WIDTH follows from the lead width alone, so it must match exactly.
    // This is the dimension that decides whether adjacent lands can bridge.
    assert.equal(
      derived.padWidthMm.toFixed(4),
      characterised.padWidthMm.toFixed(4),
      `${family}: land width must not depend on how the contact length was obtained`
    );

    // Length and span carry the contact tolerance a single nominal cannot, so
    // they are allowed to differ, and by how much is measured rather than
    // assumed. 0.1 mm is the observed worst case (SOIC, 0.079).
    assert.ok(
      Math.abs(derived.padLengthMm - characterised.padLengthMm) < 0.1,
      `${family}: land length drifted ${(derived.padLengthMm - characterised.padLengthMm).toFixed(3)} mm from the characterised entry`
    );
    assert.ok(
      Math.abs(derived.padCentreMm - characterised.padCentreMm) * 2 < 0.1,
      `${family}: centre span drifted from the characterised entry`
    );

    // The direction is systematic and worth stating: one nominal contact means
    // no contact tolerance, which shortens the land and widens the span. Both
    // reduce heel fillet slightly, so a drift the other way is a real change.
    assert.ok(derived.padLengthMm <= characterised.padLengthMm + 1e-9, `${family}: derived land should not be longer`);
  }
});

test("a drawing-derived pattern is refused unless the drawing stated everything", () => {
  // The guard list in packageFromDrawing, one case each. A family entry carries
  // a JEDEC outline behind it and can be trusted on thin evidence; this has no
  // such backing, so a single missing or implausible value means no footprint.
  const good = {
    leadSpanMm: { minMm: 6.2, maxMm: 6.6 }, leadContactMm: null,
    leadWidthMm: { minMm: 0.19, maxMm: 0.3 },
    leadLengthMm: 0.55,
    pitchMm: 0.65
  };
  assert.ok(resolvePackageDefinition("HTSSOP (28)", 28, good).ok, "a complete gull-wing drawing resolves");

  const refused: Array<[string, Record<string, unknown>, string]> = [
    ["no span", { ...good, leadSpanMm: null, leadContactMm: null }, "the span is the dimension the pattern is built from"],
    ["no width", { ...good, leadWidthMm: null }, "the width sets the land width"],
    ["no contact", { ...good, leadLengthMm: null }, "the contact length sets the heel"],
    ["no pitch", { ...good, pitchMm: null }, "the pitch places the pads"],
    ["lead wider than pitch", { ...good, leadWidthMm: { minMm: 0.7, maxMm: 0.8 } }, "leads would touch"],
    ["feet longer than the span", { ...good, leadLengthMm: 4 }, "the lands would overlap at the centre"],
    ["inverted span", { ...good, leadSpanMm: { minMm: 6.6, maxMm: 6.2 }, leadContactMm: null }, "a range must run the right way round"]
  ];
  for (const [label, drawn, why] of refused) {
    assert.equal(resolvePackageDefinition("HTSSOP (28)", 28, drawn).ok, false, `${label}: ${why}`);
  }
});

test("a no-lead package gets no drawing-derived pattern, whatever the drawing says", () => {
  // Still refused, and as of 2026-08-10 for a DIFFERENT reason than when this was
  // written, which is worth stating because the old reason has gone.
  //
  // The maths now exists: `computeLandPattern` lays out a no-lead terminal and is
  // pinned above to four published vendor patterns, exactly. What is missing is
  // the INPUTS. That rule needs the nominal body size, terminal length and
  // terminal width, and measured over the nine no-lead parts in the cache the
  // reader supplies terminal length for NONE of them, body size for two, and the
  // outline code for two. Zero parts have all three.
  //
  // So the refusal has moved from the standard to the reader, and wiring the two
  // together now would only let a no-lead package take dimensions read for a
  // gull-wing one: `leadSpanMm` is a lead span, and the no-lead rule needs the
  // BODY, which is a different number off a different part of the drawing.
  // Connecting them before the reader can tell them apart is how a footprint gets
  // built from the wrong dimension.
  const drawn = {
    leadSpanMm: { minMm: 3.9, maxMm: 4.1 }, leadContactMm: null,
    leadWidthMm: { minMm: 0.2, maxMm: 0.3 },
    leadLengthMm: 0.4,
    pitchMm: 0.5
  };
  for (const family of ["VQFN (RGY)", "16-lead LGA", "8-pin VSON", "WSON (DRB)", "20-lead LFCSP", "DSBGA (9)"]) {
    assert.equal(
      resolvePackageDefinition(family, 16, drawn).ok,
      false,
      `${family} has no published gull-wing fillet goals and must be refused`
    );
  }
});

test("a drawing's printed L is not IPC's contact length, and is not used as one", () => {
  // Measured 2026-08-05 against the real drawings. IPC-7351B's contact length is
  // the SEATED FOOT that lies flat on the land; a gull-wing drawing's L is the
  // whole lead including the vertical run. Same letter, different dimension.
  //
  //   LM358  D0008A   prints L 0.41-1.27   seated contact ~0.40-0.625
  //   INA240 PW0008A  prints L 0.50-0.75   seated contact ~0.50-0.60
  //
  // Feeding the printed range into the standard puts the land 0.649 mm from the
  // hand-calibrated entry on the SOIC. This test is the guard against anyone
  // "improving" packageFromDrawing by preferring the range, which reads like an
  // obvious upgrade and is not.
  const soic = { span: { minMm: 5.8, maxMm: 6.2 }, width: { minMm: 0.31, maxMm: 0.51 } };
  const calibrated = computeLandPattern({ form: "gullwing", ...soic, contact: { minMm: 0.4, maxMm: 0.625 } });
  const fromPrintedL = computeLandPattern({ form: "gullwing", ...soic, contact: { minMm: 0.41, maxMm: 1.27 } });

  assert.ok(
    Math.abs(fromPrintedL.padLengthMm - calibrated.padLengthMm) > 0.5,
    "the printed L range should be visibly wrong here; if this stops being true, re-examine the assumption"
  );

  // And the path that is actually wired takes the nominal, so it stays close.
  const fromNominal = computeLandPattern({ form: "gullwing", ...soic, contact: { minMm: 0.55, maxMm: 0.55 } });
  assert.ok(
    Math.abs(fromNominal.padLengthMm - calibrated.padLengthMm) < 0.1,
    "the nominal is the input packageFromDrawing uses, and it must stay within 0.1 mm"
  );
});

/**
 * The no-lead rule, against the land patterns the vendors publish.
 *
 * Each case is TWO hand reads off the same datasheet: the package drawing for
 * the inputs, and the `LAND PATTERN EXAMPLE` page for the expected result.
 * Neither came from this code's output. The four span two body sizes, three
 * families and two pitches, which is what makes them a check rather than a
 * restatement: a rule fitted to the 3 mm parts alone would pass three of these
 * and fail the fourth, and that is exactly how the RSS model was ruled out.
 *
 * TI prints the land as a CENTRE-to-centre span with a separate pad length, so
 * the expected span below is `2 * padCentreMm` and compares against that number.
 */
/** Two decimals, which is the precision the vendors print these to. */
const round = (value: number) => Math.round(value * 100) / 100;

const NO_LEAD_CASES = [
  {
    what: "DSD0008D WSON-8, UCC27524 pages 36 and 37",
    body: { minMm: 2.9, maxMm: 3.1 },
    terminalLength: { minMm: 0.3, maxMm: 0.5 },
    terminalWidth: { minMm: 0.25, maxMm: 0.37 },
    padLengthMm: 0.6,
    padWidthMm: 0.31,
    centreSpanMm: 2.8
  },
  {
    what: "DRB0008B VSON-8, OPA333 pages 34 and 35",
    body: { minMm: 2.9, maxMm: 3.1 },
    terminalLength: { minMm: 0.3, maxMm: 0.5 },
    terminalWidth: { minMm: 0.25, maxMm: 0.35 },
    padLengthMm: 0.6,
    padWidthMm: 0.3,
    centreSpanMm: 2.8
  },
  {
    what: "RGT0016C VQFN-16, PCF8574 pages 30 and 31",
    body: { minMm: 2.9, maxMm: 3.1 },
    terminalLength: { minMm: 0.3, maxMm: 0.5 },
    terminalWidth: { minMm: 0.18, maxMm: 0.3 },
    padLengthMm: 0.6,
    padWidthMm: 0.24,
    centreSpanMm: 2.8
  },
  {
    // The one that matters most: a 9 mm body with a WIDER tolerance than the
    // others. The standard's RSS model puts its toe 0.024 mm from where the 3 mm
    // parts put theirs; TI puts it in the same place, and so does this.
    what: "RGC0064B VQFN-64, MSP430F5529 pages 135 and 136",
    body: { minMm: 8.85, maxMm: 9.15 },
    terminalLength: { minMm: 0.3, maxMm: 0.5 },
    terminalWidth: { minMm: 0.18, maxMm: 0.3 },
    padLengthMm: 0.6,
    padWidthMm: 0.24,
    centreSpanMm: 8.8
  }
];

for (const problem of NO_LEAD_CASES) {
  test(`no-lead land reproduces the pattern published for ${problem.what}`, () => {
    const land = computeLandPattern({
      form: "nolead",
      span: problem.body,
      contact: problem.terminalLength,
      width: problem.terminalWidth
    });

    assert.equal(round(land.padLengthMm), problem.padLengthMm);
    assert.equal(round(land.padWidthMm), problem.padWidthMm);
    assert.equal(round(land.padCentreMm * 2), problem.centreSpanMm);
  });
}

test("a no-lead package refuses a density level the rule does not carry", () => {
  // The rule was read off four drawings that carry no density label. Producing
  // an "A" from it would be inventing the one thing the evidence does not say.
  const lead = {
    form: "nolead" as const,
    span: { minMm: 2.9, maxMm: 3.1 },
    contact: { minMm: 0.3, maxMm: 0.5 },
    width: { minMm: 0.18, maxMm: 0.3 }
  };
  assert.doesNotThrow(() => computeLandPattern(lead, { densityLevel: "B" }));
  assert.throws(() => computeLandPattern(lead, { densityLevel: "A" }), LandPatternError);
  assert.throws(() => computeLandPattern(lead, { densityLevel: "C" }), LandPatternError);
});

test("no-lead terminals that meet under the body are refused, not laid out", () => {
  assert.throws(
    () =>
      computeLandPattern({
        form: "nolead",
        span: { minMm: 1.0, maxMm: 1.0 },
        contact: { minMm: 0.6, maxMm: 0.6 },
        width: { minMm: 0.2, maxMm: 0.2 }
      }),
    LandPatternError
  );
});

test("a drawing-derived pattern reproduces the land pattern the vendor prints", () => {
  // The whole rendered-page path, pinned end to end. An ADS8688 is a 38-pin
  // TSSOP, a count the hand-entered TSSOP entry does not cover (8 to 16), so it
  // could not ship at all until its own drawing was read.
  //
  // The span and the printed L come from a model reading the RENDERED drawing on
  // page 65; the pitch and width from the deterministic reader on the same page.
  // Ground truth is the land pattern TI prints on page 66: (1.5) x (0.3) on a
  // (5.8) centre span. Nothing here came from this code's own output.
  const lookup = resolvePackageDefinition("TSSOP (38)", 38, {
    pitchMm: 0.5,
    leadWidthMm: { minMm: 0.17, maxMm: 0.23 },
    leadSpanMm: { minMm: 6.25, maxMm: 6.55 },
    leadContactMm: { minMm: 0.5, maxMm: 0.75 }
  });
  assert.equal(lookup.ok, true, "a 38-pin TSSOP must resolve from its own drawing");
  if (!lookup.ok) return;

  const land = computeLandPattern(lookup.definition.lead, { densityLevel: "B" });
  assertClose(land.padLengthMm, 1.5, "land length against TI page 66");
  assertClose(land.padWidthMm, 0.3, "land width against TI page 66");
  assertClose(land.padCentreMm * 2, 5.8, "centre-to-centre span against TI page 66");
});

test("the printed L range supplies the contact length when no single nominal was read", () => {
  // Only the rendered-page reader fills `leadContactMm`, and it fills it as a
  // min-max pair. Before this fallback every model-read drawing stopped here:
  // on 2026-08-10 the model filled the pair on 4 of 4 parts and the single
  // nominal on none, so not one of them could produce a footprint.
  const withPair = resolvePackageDefinition("TSSOP (38)", 38, {
    pitchMm: 0.5,
    leadWidthMm: { minMm: 0.17, maxMm: 0.23 },
    leadSpanMm: { minMm: 6.25, maxMm: 6.55 },
    leadContactMm: { minMm: 0.5, maxMm: 0.75 }
  });
  const withNeither = resolvePackageDefinition("TSSOP (38)", 38, {
    pitchMm: 0.5,
    leadWidthMm: { minMm: 0.17, maxMm: 0.23 },
    leadSpanMm: { minMm: 6.25, maxMm: 6.55 }
  });

  assert.equal(withPair.ok, true);
  assert.equal(withNeither.ok, false, "no contact length at all is still a refusal");
});

test("a lead nearly as wide as its pitch is refused, not laid out", () => {
  // An ADS1115's DYN0010A tags several max-over-min pairs and the width reader
  // took `10X 0.45/0.25`, which is not the lead width; the drawing's width is
  // `10X 0.30/0.18`. At 0.45 on a 0.5 pitch the leads would sit 0.05 mm apart.
  //
  // The part exported anyway, and its pads came out 0.44 mm longer and 0.22 mm
  // wider than the land pattern TI prints on page 55. A footprint that ships and
  // is wrong is worse than one that refuses, so the ratio is checked.
  const misread = resolvePackageDefinition("TSSOP (38)", 38, {
    pitchMm: 0.5,
    leadWidthMm: { minMm: 0.25, maxMm: 0.45 },
    leadSpanMm: { minMm: 6.25, maxMm: 6.55 },
    leadContactMm: { minMm: 0.5, maxMm: 0.75 }
  });
  assert.equal(misread.ok, false, "0.45 on a 0.5 pitch is not a lead width");

  // And an ordinary width on the same pitch is accepted, so the guard is about
  // the ratio rather than about the package. Asked of a TSSOP because a SOT is
  // now refused a drawing-derived pattern outright, for a different reason: see
  // the lead-form test below.
  const correct = resolvePackageDefinition("TSSOP (38)", 38, {
    pitchMm: 0.5,
    leadWidthMm: { minMm: 0.17, maxMm: 0.3 },
    leadSpanMm: { minMm: 6.25, maxMm: 6.55 },
    leadContactMm: { minMm: 0.5, maxMm: 0.75 }
  });
  assert.equal(correct.ok, true, "0.30 on a 0.5 pitch is an ordinary lead");
});

test("a SOT whose lead form is not gull-wing is caught by its own datasheet", () => {
  // `SOT` does not name a lead form. A SOT-23 is a gull-wing; an ADS1115's
  // SOT-10 is JEDEC MO-368, whose terminal is a flat tab under the body edge.
  //
  // Every input below was read off DYN0010A by hand on page 54 and every one is
  // correct. Correct numbers with the wrong lead form is the combination no
  // input can express and no family name detects, and it is why excluding SOT
  // from the gull-wing list was the wrong fix: it repaired this one part and
  // nothing else.
  //
  // What detects it is the land pattern TI prints on page 55.
  const evidence = {
    pitchMm: 0.5,
    leadWidthMm: { minMm: 0.18, maxMm: 0.3 },
    leadSpanMm: { minMm: 2.7, maxMm: 2.9 },
    leadContactMm: { minMm: 0.35, maxMm: 0.55 }
  };

  assert.equal(
    resolvePackageDefinition("SOT-10", 10, evidence).ok,
    true,
    "nothing about the family or the numbers is wrong, which is the point"
  );
  assert.equal(
    resolvePackageDefinition("SOT-10", 10, { ...evidence, vendorLandMm: [0.82, 0.3, 0.5, 2.53] }).ok,
    false,
    "the datasheet's own printed land pattern is what refuses it"
  );
});

test("a TSSOP still resolves from its own drawing, so the SOT rule is not a blanket refusal", () => {
  const lookup = resolvePackageDefinition("TSSOP (38)", 38, {
    pitchMm: 0.5,
    leadWidthMm: { minMm: 0.17, maxMm: 0.23 },
    leadSpanMm: { minMm: 6.25, maxMm: 6.55 },
    leadContactMm: { minMm: 0.5, maxMm: 0.75 }
  });
  assert.equal(lookup.ok, true);
});

test("a drawing-derived land the vendor's own page contradicts is refused", () => {
  // The general guard, tested where no family rule can be doing the work: SSOP
  // is on the drawing path and is not in the hand-entered table.
  //
  // The numbers are the ADS1115's, all four read off DYN0010A by hand and all
  // four correct. What is wrong is the LEAD FORM, which no input can express,
  // and the symptom is that the computed land misses the pattern TI prints on
  // page 55 (0.82 x 0.3 on a 2.53 centre span) by 0.44 mm.
  const evidence = {
    pitchMm: 0.5,
    leadWidthMm: { minMm: 0.18, maxMm: 0.3 },
    leadSpanMm: { minMm: 2.7, maxMm: 2.9 },
    leadContactMm: { minMm: 0.35, maxMm: 0.55 }
  };

  const unchecked = resolvePackageDefinition("SSOP (10)", 10, evidence);
  assert.equal(unchecked.ok, true, "without the page there is nothing to contradict it");

  const checked = resolvePackageDefinition("SSOP (10)", 10, {
    ...evidence,
    vendorLandMm: [0.82, 0.3, 0.5, 2.53]
  });
  assert.equal(checked.ok, false, "the printed land pattern must veto it");
});

test("a drawing-derived land that agrees with the printed one is kept", () => {
  // The guard has to be capable of saying yes, or it is just a refusal with
  // extra steps. The ADS8688's own numbers against its own page 66.
  const checked = resolvePackageDefinition("TSSOP (38)", 38, {
    pitchMm: 0.5,
    leadWidthMm: { minMm: 0.17, maxMm: 0.23 },
    leadSpanMm: { minMm: 6.25, maxMm: 6.55 },
    leadContactMm: { minMm: 0.5, maxMm: 0.75 },
    vendorLandMm: [1.5, 0.3, 0.5, 5.8]
  });

  assert.equal(checked.ok, true, "0.02 mm from the printed pattern is agreement");
});

test("a datasheet that prints no land pattern does not block a drawing-derived one", () => {
  // Most datasheets print nothing to compare against. Absence of evidence must
  // not become a refusal, or the guard would undo the whole drawing path.
  const checked = resolvePackageDefinition("TSSOP (38)", 38, {
    pitchMm: 0.5,
    leadWidthMm: { minMm: 0.17, maxMm: 0.23 },
    leadSpanMm: { minMm: 6.25, maxMm: 6.55 },
    leadContactMm: { minMm: 0.5, maxMm: 0.75 },
    vendorLandMm: []
  });

  assert.equal(checked.ok, true);
});


/**
 * No-lead packages, laid out from this part's OWN drawing.
 *
 * Sixteen parts in the hold-out parse completely and produce nothing because
 * their family is not in the hand-read table, and four of those are VQFN. The
 * fix is deliberately not a VQFN entry in that table, which would need another
 * one for VQFN-20 and another for DFN-6 forever. The drawing states the numbers
 * and the rule already exists; this route just stops refusing before it gets
 * there.
 *
 * The fixtures are the drawings the rule was recovered from, so these tests can
 * fail against reality rather than against themselves:
 *
 *   RGT0016C  VQFN 16  body 2.9-3.1  b 0.18-0.30  L 0.3-0.5  e 0.5
 *   RGC0064B  VQFN 64  body 8.85-9.15 b 0.18-0.30 L 0.3-0.5  e 0.5
 *
 * The rule: land span = nominal body + 0.4, pad length = nominal terminal + 0.2,
 * pad width = nominal terminal width.
 */
const RGT0016C = {
  pitchMm: 0.5,
  bodyLengthMm: 3.0,
  bodyWidthMm: 3.0,
  leadWidthMm: { minMm: 0.18, maxMm: 0.3 },
  leadContactMm: { minMm: 0.3, maxMm: 0.5 }
};

test("a VQFN is no longer laid out from an invented rule", () => {
  // Rewritten 2026-08-13. This asserted that the no-lead rule recovered from
  // four TI drawings laid the package out. That rule was retired: it is one
  // vendor's house rule applied to every vendor's parts, and the project's
  // rule is that nothing is invented. A no-lead package whose datasheet
  // prints its own footprint still builds from that; one that prints neither
  // now asks, which is the honest answer to a number nobody has.
  const lookup = resolvePackageDefinition("VQFN-16", 16, RGT0016C);
  assert.equal(lookup.ok, false, "no invented no-lead layout");
});

test("the same holds on a body three times the size", () => {
  // Rewritten 2026-08-13. This asserted that the no-lead rule recovered from
  // four TI drawings laid the package out. That rule was retired: it is one
  // vendor's house rule applied to every vendor's parts, and the project's
  // rule is that nothing is invented. A no-lead package whose datasheet
  // prints its own footprint still builds from that; one that prints neither
  // now asks, which is the honest answer to a number nobody has.
  const lookup = resolvePackageDefinition("VQFN (64)", 64, { ...RGT0016C, bodyLengthMm: 9.0, bodyWidthMm: 9.0 });
  assert.equal(lookup.ok, false, "no invented no-lead layout");
});

test("a DFN is refused too, whatever its row count", () => {
  // Rewritten 2026-08-13. This asserted that the no-lead rule recovered from
  // four TI drawings laid the package out. That rule was retired: it is one
  // vendor's house rule applied to every vendor's parts, and the project's
  // rule is that nothing is invented. A no-lead package whose datasheet
  // prints its own footprint still builds from that; one that prints neither
  // now asks, which is the honest answer to a number nobody has.
  const lookup = resolvePackageDefinition("DFN6", 6, { ...RGT0016C, bodyLengthMm: 2.0, bodyWidthMm: 2.0 });
  assert.equal(lookup.ok, false, "no invented no-lead layout");
});

test("a rectangular no-lead body is refused rather than laid out half wrong", () => {
  // One LandPattern describes ONE opposing pair of rows. On a square package the
  // other pair is the same pattern turned 90 degrees; on a rectangular one it is
  // not, so accepting this would put two of the four rows in the wrong place.
  const lookup = resolvePackageDefinition("VQFN-16", 16, { ...RGT0016C, bodyLengthMm: 4.0, bodyWidthMm: 3.0 });

  assert.equal(lookup.ok, false, "half a right answer is the failure this project refuses");
});

test("a no-lead package with no body dimension produces nothing", () => {
  // The body IS the span here. Without it there is no reference to lay against,
  // and guessing one would be inventing geometry.
  const lookup = resolvePackageDefinition("VQFN-16", 16, { ...RGT0016C, bodyLengthMm: null, bodyWidthMm: null });

  assert.equal(lookup.ok, false);
});

test("a terminal wider than its pitch is still refused", () => {
  // Rewritten 2026-08-13. This asserted that the no-lead rule recovered from
  // four TI drawings laid the package out. That rule was retired: it is one
  // vendor's house rule applied to every vendor's parts, and the project's
  // rule is that nothing is invented. A no-lead package whose datasheet
  // prints its own footprint still builds from that; one that prints neither
  // now asks, which is the honest answer to a number nobody has.
  const lookup = resolvePackageDefinition("VQFN-16", 16, {
    ...RGT0016C,
    leadWidthMm: { minMm: 0.4, maxMm: 0.45 }
  });
  assert.equal(lookup.ok, false, "no invented no-lead layout");
});


/**
 * A DUAL no-lead package on a rectangular body, which is the NORMAL case.
 *
 * The first version of this route required every no-lead body to be square,
 * which is right for a quad and wrong for a dual: a package with one pair of
 * rows has only one span to compute, and essentially every DFN and SON is
 * longer than it is wide. It refused correct packages for no reason.
 *
 * The span is taken from the geometry rather than from the field names, because
 * `bodyLengthMm` and `bodyWidthMm` are not reliably the long and the short one:
 * an INA226 prints "3.00 mm x 4.90 mm" where 4.90 is the lead span, and a
 * PCM1808 prints its width first. The rows must fit along the longer side, so
 * the shorter side is what they sit across.
 */
test("a rectangular DFN is refused like every other no-lead package", () => {
  // Rewritten 2026-08-13. This asserted that the no-lead rule recovered from
  // four TI drawings laid the package out. That rule was retired: it is one
  // vendor's house rule applied to every vendor's parts, and the project's
  // rule is that nothing is invented. A no-lead package whose datasheet
  // prints its own footprint still builds from that; one that prints neither
  // now asks, which is the honest answer to a number nobody has.
  const lookup = resolvePackageDefinition("DFN8", 8, {
    pitchMm: 0.5,
    bodyLengthMm: 3.0,
    bodyWidthMm: 2.0,
    leadWidthMm: { minMm: 0.2, maxMm: 0.3 },
    leadContactMm: { minMm: 0.3, maxMm: 0.5 }
  });
  assert.equal(lookup.ok, false, "no invented no-lead layout");
});

test("swapping the body labels does not revive it", () => {
  // Rewritten 2026-08-13. This asserted that the no-lead rule recovered from
  // four TI drawings laid the package out. That rule was retired: it is one
  // vendor's house rule applied to every vendor's parts, and the project's
  // rule is that nothing is invented. A no-lead package whose datasheet
  // prints its own footprint still builds from that; one that prints neither
  // now asks, which is the honest answer to a number nobody has.
  const lookup = resolvePackageDefinition("DFN8", 8, {
    pitchMm: 0.5,
    bodyLengthMm: 2.0,
    bodyWidthMm: 3.0,
    leadWidthMm: { minMm: 0.2, maxMm: 0.3 },
    leadContactMm: { minMm: 0.3, maxMm: 0.5 }
  });
  assert.equal(lookup.ok, false, "no invented no-lead layout");
});

test("a dual package whose row cannot fit along the body is refused", () => {
  // 8 terminals a side at 1.27 mm needs 8.89 mm of body and this one is 3 mm.
  // The dimensions describe something that is not this package.
  const lookup = resolvePackageDefinition("DFN16", 16, {
    pitchMm: 1.27,
    bodyLengthMm: 3.0,
    bodyWidthMm: 2.0,
    leadWidthMm: { minMm: 0.2, maxMm: 0.3 },
    leadContactMm: { minMm: 0.3, maxMm: 0.5 }
  });

  assert.equal(lookup.ok, false);
});

test("a rectangular QUAD is still refused, and for a reason the pin count cannot fix", () => {
  // Four rows need two spans AND the per-side counts. 20 terminals on a
  // 4.5 x 3.5 body is not 5 a side, and nothing here knows what it is.
  const lookup = resolvePackageDefinition("VQFN (20)", 20, {
    pitchMm: 0.5,
    bodyLengthMm: 4.5,
    bodyWidthMm: 3.5,
    leadWidthMm: { minMm: 0.18, maxMm: 0.3 },
    leadContactMm: { minMm: 0.3, maxMm: 0.5 }
  });

  assert.equal(lookup.ok, false);
});
