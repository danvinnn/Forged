import { test } from "node:test";
import assert from "node:assert/strict";
import { confidenceChecks, summariseChecks, type ConfidenceCheck } from "../confidence";
import type { PinRecord, ResolvedPart } from "../types";

/**
 * Every check has to be able to FAIL on a record somebody could really produce.
 *
 * That is the bar this file enforces, and it is not rhetorical. A check that
 * cannot fail is worse than no check: it adds a green tick to a review panel and
 * teaches the reviewer that green ticks mean something. Each test below drives
 * one check to `fail` with a record that is wrong in exactly one way, and the
 * sweep at the end proves none was left unreachable.
 */

function pins(count: number): PinRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    number: String(index + 1),
    name: `P${index + 1}`,
    electricalType: "passive" as const
  }));
}

/** A record that passes everything it has the evidence for. */
function sound(overrides: Partial<ResolvedPart["dimensions"]> = {}, part: Partial<ResolvedPart> = {}): ResolvedPart {
  return {
    id: "c",
    partNumber: "ACME1",
    manufacturer: "ACME",
    packageType: "SOIC-8",
    packageOutlineCode: null,
    jedecOutline: null,
    vendorLandPattern: null,
    exposedPad: false,
    pinCount: 8,
    pins: pins(8),
    dimensions: {
      bodyLengthMm: 4.9,
      bodyWidthMm: 3.9,
      bodyHeightMm: 1.75,
      pitchMm: 1.27,
      leadLengthMm: null,
      leadCount: 8,
      leadWidthMm: { minMm: 0.31, maxMm: 0.51 },
      leadSpanMm: { minMm: 5.8, maxMm: 6.2 },
      leadContactMm: { minMm: 0.4, maxMm: 0.625 },
      thermalPadLengthMm: null,
      thermalPadWidthMm: null,
      landPadLengthMm: 1.95,
      landPadWidthMm: 0.6,
      landSpanMm: 4.95,
      leadSides: 2,
      leadForm: "gullwing",
      mounting: null,
      leadDiameterMm: null,
      vacantLeadSlot: null,
      leadsPerSide: null,
      solderMaskExpansionMm: null,
      solderMaskDefined: null,
      thermalViaDiameterMm: null,
      thermalViaPitchMm: null,
      ...overrides
    },
    radiation: { tid: null, see: null, sel: null, qmlClass: null },
    sourceFileName: "acme1.pdf",
    notes: [],
    ...part
  };
}

const find = (checks: ConfidenceCheck[], id: string) => checks.find((check) => check.id === id)!;

test("a sound record passes every check it has the evidence for", () => {
  const checks = confidenceChecks(sound());
  for (const check of checks) {
    assert.notEqual(check.state, "fail", `${check.id} failed on a sound record: ${check.detail}`);
  }
  assert.ok(checks.some((check) => check.state === "pass"), "and some of them actually ran");
});

test("a pin table shorter than the pin count is caught", () => {
  const checks = confidenceChecks(sound({}, { pins: pins(6) }));
  const check = find(checks, "pins-match-count");
  assert.equal(check.state, "fail");
  assert.match(check.detail, /6 numbered pins/);
  assert.ok(check.consequence, "a failure says what breaks");
});

test("a hole in the pin numbering is caught", () => {
  const holed = pins(8).filter((pin) => pin.number !== "5");
  const checks = confidenceChecks(sound({}, { pins: holed, pinCount: 7 }));
  const check = find(checks, "pin-numbers-complete");
  assert.equal(check.state, "fail");
  assert.match(check.detail, /pin 5/);
});

test("a duplicated pin number is caught", () => {
  const duplicated = [...pins(7), { number: "7", name: "AGAIN", electricalType: "passive" as const }];
  const checks = confidenceChecks(sound({}, { pins: duplicated, pinCount: 8 }));
  assert.equal(find(checks, "pin-numbers-complete").state, "fail");
});

test("per-side counts that do not add up are caught", () => {
  const checks = confidenceChecks(sound({ leadsPerSide: "3,3,3,3" }));
  const check = find(checks, "sides-add-up");
  assert.equal(check.state, "fail");
  assert.match(check.detail, /adds to 12/);
});

test("lands that would overlap at the centre are caught", () => {
  // A misread decimal point is the realistic way here: 4.95 read as 0.95.
  const checks = confidenceChecks(sound({ landSpanMm: 0.95 }));
  const check = find(checks, "lands-clear-centre");
  assert.equal(check.state, "fail");
  assert.match(check.consequence ?? "", /shorted/);
});

test("a land wider than its pitch is caught", () => {
  const checks = confidenceChecks(sound({ landPadWidthMm: 1.4 }));
  assert.equal(find(checks, "lands-fit-pitch").state, "fail");
});

test("a lead span that ends inside the body is caught", () => {
  // The realistic misread: a body dimension taken as the lead span.
  const checks = confidenceChecks(sound({ leadSpanMm: { minMm: 2.8, maxMm: 3.2 } }));
  const check = find(checks, "span-covers-body");
  assert.equal(check.state, "fail");
  assert.match(check.detail, /inside the 3.9 mm body/);
});

test("a span whose minimum dips below a nominal body is NOT a failure", () => {
  // Measured on 66 real records: comparing the span's MINIMUM against the body
  // failed four correct readings. A drawing prints the span as a range and the
  // body as a nominal, so a 4.0 mm body with a 3.9 to 4.1 mm span is exactly
  // what a correct reading looks like. A check that fires on those teaches the
  // reviewer to ignore it.
  const checks = confidenceChecks(sound({ bodyWidthMm: 4.0, leadSpanMm: { minMm: 3.9, maxMm: 4.1 } }));
  assert.equal(find(checks, "span-covers-body").state, "pass");
});

test("the IPC band is not applied to a package the standard's gull-wing goals do not describe", () => {
  // Same measurement: six of the eleven failures were QFN and DFN parts, two of
  // them adrift by 0.01 mm. A no-lead terminal ends at the body edge and has no
  // lead to span anything, so the gull-wing model produces a band that a correct
  // printed pattern sits outside of. This is the mistake `ipc7351.ts` refuses to
  // make in the generator, and the check has to refuse it too.
  const checks = confidenceChecks(sound({ leadForm: "nolead", landSpanMm: 2.2, landPadLengthMm: 0.8 }));
  assert.equal(find(checks, "printed-in-band").state, "unavailable");
});

test("an exposed pad bigger than its own body is caught", () => {
  const checks = confidenceChecks(sound({ thermalPadLengthMm: 5.2, thermalPadWidthMm: 4.1 }));
  assert.equal(find(checks, "thermal-pad-fits").state, "fail");
});

test("a printed footprint outside the IPC band is caught", () => {
  // The ADS1115 shape of defect: correct lead dimensions, and a printed pattern
  // that cannot belong to them.
  const checks = confidenceChecks(sound({ landSpanMm: 2.2, landPadLengthMm: 0.8 }));
  const check = find(checks, "printed-in-band");
  assert.equal(check.state, "fail");
  assert.match(check.detail, /outside the/);
});

test("a check with nothing to work on says so rather than passing", () => {
  // "Unavailable" is not a soft pass. A record that carries no printed footprint
  // has not been checked against one, and a reviewer is entitled to know which.
  const checks = confidenceChecks(sound({ landPadLengthMm: null, landPadWidthMm: null, landSpanMm: null }));
  assert.equal(find(checks, "lands-clear-centre").state, "unavailable");
  assert.equal(find(checks, "printed-in-band").state, "unavailable");
  assert.match(summariseChecks(checks), /could not run/);
});

test("every check is reachable in all three states", () => {
  // The sweep. A check that can never fail is a green tick that means nothing,
  // and a check that can never pass is noise; both would slip past the tests
  // above, which each look at one id.
  const ids = confidenceChecks(sound()).map((check) => check.id);
  const seen = new Map<string, Set<string>>(ids.map((id) => [id, new Set<string>()]));

  const records: ResolvedPart[] = [
    sound(),
    sound({}, { pins: pins(6) }),
    sound({}, { pins: [...pins(7), { number: "7", name: "X", electricalType: "passive" }], pinCount: 8 }),
    sound({ leadsPerSide: "3,3,3,3" }),
    sound({ leadsPerSide: "2,2,2,2" }),
    sound({ landSpanMm: 0.95 }),
    sound({ landPadWidthMm: 1.4 }),
    sound({ leadSpanMm: { minMm: 2.8, maxMm: 3.2 } }),
    sound({ thermalPadLengthMm: 5.2, thermalPadWidthMm: 4.1 }),
    sound({ thermalPadLengthMm: 2.0, thermalPadWidthMm: 1.8 }),
    sound({ landSpanMm: 2.2, landPadLengthMm: 0.8 }),
    sound({
      landPadLengthMm: null,
      landPadWidthMm: null,
      landSpanMm: null,
      leadSpanMm: null,
      leadWidthMm: null,
      leadContactMm: null,
      pitchMm: null,
      bodyLengthMm: null,
      bodyWidthMm: null,
      leadsPerSide: null
    }),
    sound({}, { pins: [], pinCount: 8 })
  ];

  for (const record of records) {
    for (const check of confidenceChecks(record)) seen.get(check.id)!.add(check.state);
  }

  // PASS and FAIL for every check, without exception. A check that cannot fail
  // is a green tick that means nothing; one that cannot pass is noise.
  for (const [id, states] of seen) {
    for (const state of ["pass", "fail"]) {
      assert.ok(states.has(state), `check "${id}" was never seen in state "${state}"`);
    }
  }

  // UNAVAILABLE only for the checks that depend on evidence a document may not
  // carry. `pins-match-count` is not one of them: `resolveForExport` guarantees
  // both a pin table and a count before anything gets this far, so a record that
  // reaches here always has the two to compare. Asserting it could be
  // unavailable would be asserting a state that cannot happen.
  const optional = [
    "pin-numbers-complete",
    "sides-add-up",
    "lands-clear-centre",
    "lands-fit-pitch",
    "span-covers-body",
    "thermal-pad-fits",
    "printed-in-band"
  ];
  for (const id of optional) {
    assert.ok(seen.get(id)!.has("unavailable"), `check "${id}" never reported that it could not run`);
  }
});

test("the summary names the checks that failed, and does not average them", () => {
  const checks = confidenceChecks(sound({ landSpanMm: 0.95 }));
  const summary = summariseChecks(checks);
  assert.match(summary, /FAILED/);
  assert.match(summary, /lands-clear-centre/, "a reviewer needs to know WHICH one");
  assert.doesNotMatch(summary, /\d+%/, "a percentage would hide exactly that");
});
