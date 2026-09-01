import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmations, MAX_FLAGGED } from "../confirm";
import type { Corroboration, FootprintGeometry } from "../geometry";
import type { PinRecord, ResolvedPart } from "../types";

const AGREES: Corroboration = {
  from: "printed",
  against: "ipc7351b",
  agrees: true,
  because: "agrees",
  detail: "Taken from the printed footprint and matched by an IPC-7351B pattern computed from the outline."
};

const ALONE: Corroboration = {
  from: "ipc7351b",
  against: null,
  agrees: false,
  because: "no-printed-footprint",
  detail: "Computed from the package outline. No printed footprint was read to check it against."
};

const PINS: PinRecord[] = Array.from({ length: 8 }, (_, index) => ({
  number: String(index + 1),
  name: `P${index + 1}`,
  electricalType: "unspecified" as const
}));

function part(over: Partial<ResolvedPart> = {}): ResolvedPart {
  return {
    id: "x",
    partNumber: "LM358",
    manufacturer: "TI",
    packageType: "SOIC (D)",
    packageOutlineCode: "D0008A",
    jedecOutline: null,
    vendorLandPattern: { page: 55, valuesMm: [1.55, 0.6, 1.27, 5.4] },
    pinCount: 8,
    pins: PINS,
    exposedPad: false,
    notes: [],
    dimensions: {
      bodyLengthMm: 4.9,
      bodyWidthMm: 3.9,
      bodyHeightMm: 1.5,
      pitchMm: 1.27,
      leadLengthMm: null,
      leadCount: 8,
      leadWidthMm: { minMm: 0.31, maxMm: 0.51 },
      leadSpanMm: { minMm: 5.8, maxMm: 6.2 },
      leadSpanCrossMm: null,
      leadContactMm: { minMm: 0.4, maxMm: 1.27 },
      thermalPadLengthMm: null,
      thermalPadWidthMm: null,
      landPadLengthMm: 1.55,
      landPadWidthMm: 0.6,
      landSpanMm: 5.4,
      landSpanCrossMm: null,
      leadSides: 2,
      leadForm: "gullwing",
      mounting: "smd",
      leadDiameterMm: null,
      vacantLeadSlot: null,
      leadsPerSide: null,
      solderMaskExpansionMm: null,
      solderMaskDefined: null,
      thermalViaDiameterMm: null,
      thermalViaPitchMm: null
    },
    ...over
  } as ResolvedPart;
}

function geometry(corroboration: Corroboration): FootprintGeometry {
  return {
    name: "SOIC-8",
    description: "",
    partNumber: "LM358",
    pads: [],
    body: { halfWidthMm: 2.45, halfHeightMm: 1.95 },
    silkscreen: [],
    courtyard: { halfWidthMm: 3.2, halfHeightMm: 2.6 },
    provenance: {
      family: "SOIC",
      source: "",
      densityLevel: "B",
      padWidthMm: 0.6,
      padLengthMm: 1.55,
      centreToCentreMm: 5.4,
      pitchMm: 1.27,
      arrangement: "dual",
      corroboration,
      discards: []
    }
  } as unknown as FootprintGeometry;
}

test("a value with two agreeing sources is not put in front of the user", () => {
  const report = confirmations(part(), geometry(AGREES), null);
  const copper = report.items.find((item) => item.id === "land-pattern")!;
  assert.equal(copper.state, "confirmed");
  assert.ok(!report.flagged.includes(copper));
});

test("a value with only one source is flagged, not shipped silently", () => {
  const report = confirmations(part(), geometry(ALONE), null);
  const copper = report.items.find((item) => item.id === "land-pattern")!;
  assert.equal(copper.state, "flagged");
  assert.ok(copper.consequence, "a flagged item has to say what breaks if it is wrong");
});

test("there is no third state: every item is confirmed or flagged", () => {
  for (const corroboration of [AGREES, ALONE]) {
    const report = confirmations(part(), geometry(corroboration), null);
    assert.ok(report.items.length > 0);
    for (const item of report.items) {
      assert.ok(item.state === "confirmed" || item.state === "flagged", `${item.id} has a third state`);
    }
    assert.deepEqual(
      report.flagged,
      report.items.filter((item) => item.state === "flagged"),
      "the flagged list is exactly the flagged items"
    );
  }
});

test("no document means the netlist has no second source, and says so", () => {
  // Silence is not agreement. A caller that cannot supply the datasheet cannot
  // confirm the pin names, and must not report them as confirmed.
  const report = confirmations(part(), geometry(AGREES), null);
  const pinout = report.items.find((item) => item.id === "pinout")!;
  assert.equal(pinout.state, "flagged");
});

test("a pin table the mechanical drawing contradicts is flagged", () => {
  const mismatched = part({ pinCount: 8, dimensions: { ...part().dimensions, leadCount: 14 } });
  const pinCount = confirmations(mismatched, geometry(AGREES), null).items.find((item) => item.id === "pin-count")!;
  assert.equal(pinCount.state, "flagged");
  assert.match(pinCount.detail, /14/);
});

test("the pitch is confirmed by the printed footprint and by nothing else", () => {
  const withFootprint = confirmations(part(), geometry(AGREES), null).items.find((item) => item.id === "pitch")!;
  assert.equal(withFootprint.state, "confirmed");

  const without = confirmations(part({ vendorLandPattern: null }), geometry(AGREES), null).items.find(
    (item) => item.id === "pitch"
  )!;
  assert.equal(without.state, "flagged", "one reading of one drawing is one source");
});

test("an exposed pad is asked about only when the package has one", () => {
  assert.equal(
    confirmations(part(), geometry(AGREES), null).items.find((item) => item.id === "thermal-pad"),
    undefined
  );
  const padded = part({
    exposedPad: true,
    dimensions: { ...part().dimensions, thermalPadLengthMm: 2.4, thermalPadWidthMm: 3.1 }
  });
  const pad = confirmations(padded, geometry(AGREES), null).items.find((item) => item.id === "thermal-pad");
  assert.ok(pad, "a soldered, mandatory feature is always accounted for");
});

test("the budget is a hard number and the report states when it is exceeded", () => {
  // Everything unread at once. `MAX_FLAGGED` is the point past which the product
  // has stopped saving anyone time, so the chooser refuses rather than handing
  // back a form; see `optionFor`.
  const blind = part({
    vendorLandPattern: null,
    pins: [],
    dimensions: {
      ...part().dimensions,
      leadCount: null,
      pitchMm: null,
      bodyLengthMm: null,
      bodyWidthMm: null
    },
    packageType: "Unknown package",
    exposedPad: true
  });
  const report = confirmations(blind, geometry(ALONE), null);
  assert.ok(report.flagged.length > MAX_FLAGGED, "this record has nothing corroborated");
  assert.equal(report.overBudget, true);
});

test("a lead off its copper flags the land pattern, whatever the band says", () => {
  // Two pages of one datasheet contradicting each other outranks agreement with
  // IPC-7351B: the band constrains the toe-to-toe extent alone, so a pattern can
  // sit inside it with its lands in the wrong place.
  const narrow = part({
    dimensions: { ...part().dimensions, landPadWidthMm: 0.25 }
  });
  const withLands = {
    ...geometry(AGREES),
    pads: [
      { number: "1", centre: { xMm: 2.7, yMm: 0 }, widthMm: 1.55, heightMm: 0.25, shape: "roundrect", mounting: "smd" },
      { number: "2", centre: { xMm: -2.7, yMm: 0 }, widthMm: 1.55, heightMm: 0.25, shape: "roundrect", mounting: "smd" }
    ]
  } as unknown as FootprintGeometry;
  const item = confirmations(narrow, withLands, null).items.find((entry) => entry.id === "land-pattern")!;
  assert.equal(item.state, "flagged");
  assert.equal(item.because, "lead-wider-than-land");
  assert.match(item.detail, /still overhangs its copper/);
});

test("a clean overlay does NOT confirm the land pattern on its own", () => {
  // STM32F103C8 is why. Its UFQFPN48 lands sit on a 6.55 mm span where the
  // datasheet prints 6.75, and every terminal is still entirely on its copper,
  // so the overlay is happy about a footprint 0.1 mm out on every pad. Proving
  // the joint forms is not proving the pattern was read.
  const clean = {
    ...geometry(ALONE),
    pads: [
      { number: "1", centre: { xMm: 2.7, yMm: 0 }, widthMm: 1.55, heightMm: 0.6, shape: "roundrect", mounting: "smd" },
      { number: "2", centre: { xMm: -2.7, yMm: 0 }, widthMm: 1.55, heightMm: 0.6, shape: "roundrect", mounting: "smd" }
    ]
  } as unknown as FootprintGeometry;
  const item = confirmations(part(), clean, null).items.find((entry) => entry.id === "land-pattern")!;
  assert.equal(item.state, "flagged");
  assert.equal(item.because, "no-printed-footprint");
});

test("the package name is a second source for how the leads are arranged", () => {
  // `bench:unchecked` swapped 2 sides for 4 on 86 footprints the product vouched
  // for, and 59 stayed CONFIRMED. Nothing read the side count off anything but
  // the drawing it was counted on.
  const soic = confirmations(part(), geometry(AGREES), null).items.find((item) => item.id === "arrangement")!;
  assert.equal(soic.state, "confirmed");

  const swapped = part({ dimensions: { ...part().dimensions, leadSides: 4 } });
  const wrong = confirmations(swapped, geometry(AGREES), null).items.find((item) => item.id === "arrangement")!;
  assert.equal(wrong.state, "flagged", "a SOIC is not a quad, and the name says so");
  assert.match(wrong.detail, /SOIC/);
});

test("a grid array is not asked about lead sides it does not have", () => {
  // An LGA or a BGA has no sides, `declaredLeadSides` says so, and the layout
  // comes from the designators. A flag there is a question about a number
  // nothing uses.
  const grid = part({
    pins: ["A1", "A2", "B1", "B2"].map((number) => ({ number, name: number, electricalType: "unspecified" as const })),
    pinCount: 4
  });
  const item = confirmations(grid, geometry(AGREES), null).items.find((entry) => entry.id === "arrangement");
  assert.equal(item, undefined);
});

test("a body the printed footprint contradicts is flagged, not confirmed", () => {
  // The pairing this replaces reads two callouts off ONE drawing and is
  // one-sided: shrink the body and its own lead span still reaches past it.
  // `bench:unchecked` left 56 shrunken bodies confirmed. The bound is swept in
  // `bench:bodysweep`.
  const shrunk = part({
    dimensions: { ...part().dimensions, bodyWidthMm: 1.5, bodyLengthMm: 1.9 }
  });
  const item = confirmations(shrunk, geometry(AGREES), null).items.find((entry) => entry.id === "body")!;
  assert.equal(item.state, "flagged");
  assert.equal(item.because, "printed-footprint-disagrees");

  // And a real body, with the same printed footprint, is untouched.
  const ok = confirmations(part(), geometry(AGREES), null).items.find((entry) => entry.id === "body")!;
  assert.equal(ok.state, "confirmed");
});
