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
  // FILLET_GOALS carries gull-wing only. A QFN, DFN, SON, LGA or BGA has its own
  // published goal table, and handing it gull-wing goals to widen coverage is
  // the exact failure ipc7351.ts refuses to commit.
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
