import { test } from "node:test";
import assert from "node:assert/strict";
import { sameDesignatorName } from "../packagevariants";

/**
 * The same package spelled differently is not a different package.
 *
 * Reported 2026-08-25 from a screenshot. An LTC6563 was asking for eight
 * numbers, and the record already held every one of them, cited to page 33:
 * land length 0.70, land width 0.25, centre span 2.80, lead sides 4, pitch
 * 0.50, and all three body dimensions.
 *
 * `asPackage` blanks every dimension when the designator it is handed differs
 * from the record's, which is correct: those values were read off ONE package's
 * drawings and describe the wrong pages against another. It compared with
 * `===`. The model had returned `24-lead QFN` and the chooser offered
 * `24-Lead QFN`, so one capital letter discarded the entire geometry and the
 * product asked the user for what it had just read.
 *
 * Measured on the tuned corpus: SHIPS UNAIDED 42/57 to 44/57.
 */

test("case and punctuation do not make a different package", () => {
  assert.ok(sameDesignatorName("24-Lead QFN", "24-lead QFN"), "the reported case");
  assert.ok(sameDesignatorName("SOIC-8", "SOIC 8"));
  assert.ok(sameDesignatorName("VQFN (RGE)", "VQFNRGE"), "the rule pinTableFor already used");
  assert.ok(sameDesignatorName("  TSSOP-20  ", "tssop20"));
});

test("a fuller description of the same package is the same package", () => {
  // The model names the package from whatever the page gave it, and the length
  // varies between reads. The same LTC6563 came back as `24-lead QFN` on one
  // pass and `24-Lead Plastic Side Solderable QFN (3mm x 5mm)` on the next,
  // while the harvested designator stayed `24-Lead QFN`. Both reads discarded
  // the same eight values.
  assert.ok(sameDesignatorName("24-Lead QFN", "24-Lead Plastic Side Solderable QFN (3mm x 5mm)"));
  assert.ok(sameDesignatorName("24-Lead QFN", "24 Lead QFN Package"));
  assert.ok(sameDesignatorName("8-Lead SOIC", "8-Lead SOIC (D)"), "a code on one side only");
  assert.ok(sameDesignatorName("16-Lead TSSOP", "16-Lead TSSOP (PW)"));
});

test("a caption listing several packages is not any one of them", () => {
  // A pin table's caption routinely names every package sharing an assignment.
  // That is a statement about the PINOUT, and matching it to a specific package
  // would keep one package's measured dimensions under another's name.
  assert.ok(!sameDesignatorName("16-lead PDIP/SOIC_N/TSSOP", "16-Lead SOIC"));
});

test("a name that states no lead count is left alone", () => {
  // Two names stating no count cannot be told apart this way, so they are not
  // merged on family agreement alone. KNOWN LIMIT, and deliberately conservative:
  // `14-Pin CFP` and `14-Lead Ceramic Flat Pack CFP` also stay separate, because
  // the second names two families and nothing here can tell a list of
  // alternatives from a description of one thing. Refusing costs exactly what
  // the old `===` cost, so it is not a regression, just an unfixed case.
  assert.ok(!sameDesignatorName("SOT-23", "SOT-23 Wide"));
  assert.ok(!sameDesignatorName("14-Pin CFP", "14-Lead Ceramic Flat Pack CFP"));
});

test("a disagreeing drawing code is still a real disagreement", () => {
  // This is the line the normalisation must not cross. Two packages whose
  // CODES differ are two packages, and merging them would put one drawing's
  // dimensions under the other's name.
  assert.ok(!sameDesignatorName("SOIC (D)", "SOIC (DW)"));
  assert.ok(!sameDesignatorName("HVSSOP (DGN)", "HVSSOP (DGS)"));
  assert.ok(!sameDesignatorName("24-Lead QFN", "20-Lead QFN"), "a lead count is not spelling");
  assert.ok(!sameDesignatorName("SOIC", "SOT"));
});

test("a package keeps its dimensions when it is named back to itself", async () => {
  // The end of the chain, through the real function: a record relabelled with
  // its own designator differently spelled must come back untouched.
  const { asPackage } = await import("../exporters");
  const record = {
    packageType: "24-lead QFN",
    packagesInThisDocument: [],
    dimensions: { pitchMm: 0.5, bodyLengthMm: 5, landPadLengthMm: 0.7 },
    pins: [{ number: "1", name: "A", electricalType: "unspecified" }]
  } as never;

  const same = asPackage(record, "24-Lead QFN") as unknown as { dimensions: Record<string, unknown> };
  assert.equal(same.dimensions.pitchMm, 0.5, "pitch survives a re-spelling");
  assert.equal(same.dimensions.bodyLengthMm, 5);
  assert.equal(same.dimensions.landPadLengthMm, 0.7);

  const other = asPackage(record, "20-Lead QFN") as unknown as { dimensions: Record<string, unknown> };
  assert.equal(other.dimensions.pitchMm, null, "a genuinely different package still drops them");
});
