import { test } from "node:test";
import assert from "node:assert/strict";
import { overlapOn, solderJoint } from "../solderjoint";
import type { FootprintGeometry, Pad } from "../geometry";
import type { ResolvedPart } from "../types";

function pad(over: Partial<Pad> = {}): Pad {
  return {
    number: "1",
    centre: { xMm: 2.7, yMm: 0 },
    widthMm: 1.55,
    heightMm: 0.6,
    shape: "roundrect",
    mounting: "smd",
    ...over
  };
}

/** TI's SOIC-8 land under a JEDEC MS-012 lead: the corpus's most common part. */
const SOIC = {
  outerEdge: { minMm: 2.9, maxMm: 3.1 },
  contact: { minMm: 0.4, maxMm: 1.27 },
  width: { minMm: 0.31, maxMm: 0.51 }
};

test("a lead entirely on its land overlaps fully", () => {
  const overlap = overlapOn(pad(), "x", { minMm: 2.9, maxMm: 2.9 }, { minMm: 0.5, maxMm: 0.5 }, SOIC.width);
  assert.equal(overlap.alongFoot, 1);
  assert.equal(overlap.acrossWidth, 1);
});

test("the overlap is taken at CONSISTENT tolerance corners, not at mixed extremes", () => {
  // The longest span pairs with the longest foot on the same part or not at all.
  // Mixing them puts the heel of a 6.2 mm lead at the position a 5.8 mm lead's
  // heel occupies, which is a part that does not exist, and reported eleven
  // correct SOIC-8s as having no copper under the heel.
  const overlap = overlapOn(pad(), "x", SOIC.outerEdge, SOIC.contact, SOIC.width);
  // Worst corner is the shortest span with the longest foot: the toe is at 2.90
  // and the land's inner edge at 1.925, so 0.975 of a 1.27 mm foot is on copper.
  assert.equal(Number(overlap.alongFoot.toFixed(3)), 0.768);
  assert.ok(overlap.alongFoot > 0.6, "the industry's standard SOIC land must not be a finding");
});

test("a land narrower than the NARROWEST permitted lead is a contradiction", () => {
  const overlap = overlapOn(pad({ heightMm: 0.25 }), "x", SOIC.outerEdge, SOIC.contact, { minMm: 0.5, maxMm: 0.5 });
  assert.equal(overlap.acrossWidth, 0.5);
});

test("a land narrower than the WIDEST permitted lead is not", () => {
  // Every QFN vendor lays out a land narrower than the terminal's upper
  // tolerance. Flagging it reports six correct TI packages.
  const overlap = overlapOn(pad({ heightMm: 0.31 }), "x", SOIC.outerEdge, SOIC.contact, { minMm: 0.26, maxMm: 0.36 });
  assert.equal(overlap.acrossWidth, 1);
});

test("a land pulled inboard of the lead leaves nothing under the foot", () => {
  const overlap = overlapOn(
    pad({ centre: { xMm: 1.0, yMm: 0 } }),
    "x",
    { minMm: 2.9, maxMm: 2.9 },
    { minMm: 0.5, maxMm: 0.5 },
    SOIC.width
  );
  assert.equal(overlap.alongFoot, 0);
});

function part(over: Record<string, unknown> = {}, dims: Record<string, unknown> = {}): ResolvedPart {
  return {
    partNumber: "X",
    packageType: "P",
    pinCount: 2,
    pins: [],
    exposedPad: false,
    notes: [],
    dimensions: {
      bodyLengthMm: 4.9,
      bodyWidthMm: 3.9,
      pitchMm: 1.27,
      leadWidthMm: { minMm: 0.31, maxMm: 0.51 },
      leadSpanMm: { minMm: 5.8, maxMm: 6.2 },
      leadSpanCrossMm: null,
      leadContactMm: { minMm: 0.4, maxMm: 1.27 },
      leadForm: "gullwing",
      ...dims
    },
    ...over
  } as unknown as ResolvedPart;
}

function footprint(pads: Pad[], arrangement = "dual"): FootprintGeometry {
  return { pads, provenance: { arrangement } } as unknown as FootprintGeometry;
}

const ROW = [pad({ number: "1" }), pad({ number: "2", centre: { xMm: -2.7, yMm: 0 } })];

test("a clean two-sided footprint raises nothing", () => {
  const report = solderJoint(footprint(ROW), part());
  assert.equal(report.unavailable, null);
  assert.equal(report.overlaid, 2);
  assert.equal(report.findings.length, 0);
});

test("a no-lead terminal is placed from the BODY, not from leadSpanMm", () => {
  // A no-lead package has no tip-to-tip span. Where the model writes the body
  // into `leadSpanMm` anyway, using it would place the terminal in the wrong
  // place on the axis whose body dimension differs.
  const lands = [
    pad({ number: "1", centre: { xMm: 1.5, yMm: 0 }, widthMm: 0.6, heightMm: 0.24 }),
    pad({ number: "2", centre: { xMm: -1.5, yMm: 0 }, widthMm: 0.6, heightMm: 0.24 })
  ];
  const qfn = part({}, {
    leadForm: "nolead",
    bodyWidthMm: 3.4,
    bodyLengthMm: 3.4,
    leadSpanMm: { minMm: 99, maxMm: 99 },
    leadContactMm: { minMm: 0.4, maxMm: 0.4 },
    leadWidthMm: { minMm: 0.2, maxMm: 0.25 }
  });
  const report = solderJoint(footprint(lands, "quad"), qfn);
  // The terminal's outer edge is 3.4/2 = 1.7 and the land runs 1.2 to 1.8, so
  // the whole 0.4 mm foot from 1.3 to 1.7 is on copper. Reading the 99 mm span
  // instead would put the terminal 48 mm away.
  assert.equal(report.findings.length, 0);
  assert.equal(report.worst.alongFoot, 1);
});

test("a rectangular quad with no cross span does not assess its other axis", () => {
  // Assessing it against the first axis's span is what put ADXL345's top and
  // bottom lands a millimetre off terminals that are correctly placed.
  const lands = [
    pad({ number: "1", centre: { xMm: 2.7, yMm: 0 } }),
    pad({ number: "2", centre: { xMm: 0, yMm: 2.7 }, widthMm: 0.6, heightMm: 1.55 })
  ];
  const report = solderJoint(footprint(lands, "quad"), part({}, { bodyLengthMm: 9, bodyWidthMm: 4 }));
  assert.equal(report.overlaid, 1);
  assert.equal(report.skipped, 1);
  assert.equal(report.findings.length, 0);
});

test("a square quad uses its one span on both axes", () => {
  const lands = [
    pad({ number: "1", centre: { xMm: 2.7, yMm: 0 } }),
    pad({ number: "2", centre: { xMm: 0, yMm: 2.7 }, widthMm: 0.6, heightMm: 1.55 })
  ];
  const report = solderJoint(footprint(lands, "quad"), part({}, { bodyLengthMm: 4, bodyWidthMm: 4 }));
  assert.equal(report.overlaid, 2);
  assert.equal(report.skipped, 0);
});

test("a grid array has no lead to lay down and says so", () => {
  const report = solderJoint(footprint(ROW, "grid"), part());
  assert.match(report.unavailable ?? "", /grid array/);
  assert.equal(report.findings.length, 0);
});

test("a straight lead is overlaid only once the assembler has answered", () => {
  const flat = part({}, { leadForm: "straight", leadContactMm: null });
  assert.match(solderJoint(footprint(ROW), flat).unavailable ?? "", /seated foot/);
  const answered = solderJoint(footprint(ROW), flat, 6.0, 0.5);
  assert.equal(answered.unavailable, null);
  assert.equal(answered.findings.length, 0);
});

test("a land that misses its lead is named with both numbers", () => {
  const missed = [pad({ number: "7", centre: { xMm: 1.0, yMm: 0 } })];
  const report = solderJoint(footprint(missed), part());
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].at, "foot");
  assert.equal(report.findings[0].padNumber, "7");
  assert.match(report.findings[0].detail, /2\.900 mm from the centre line/);
});

test("an exposed thermal pad is not a lead land", () => {
  const withPad = [...ROW, pad({ number: "3", centre: { xMm: 0, yMm: 0 }, widthMm: 3, heightMm: 3 })];
  const report = solderJoint(footprint(withPad), part({ pinCount: 2, exposedPad: true }));
  assert.equal(report.overlaid, 2);
  assert.equal(report.findings.length, 0);
});
