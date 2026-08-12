import { test } from "node:test";
import assert from "node:assert/strict";
import { packageOptions } from "../exporters";
import type { Extracted, PartRecord, PinRecord } from "../types";

// The package chooser used to offer packages that produced nothing when pressed.
// Measured over the 45 cached datasheets on 2026-08-09: 95 offered designators,
// 21 that shipped, 7 that shipped after one number, and 67 that did nothing.
// These tests are about the three claims the chooser now makes, and about the
// one claim it must NOT make.

const cited = <T,>(value: T): Extracted<T> => ({
  value,
  confidence: 0.9,
  method: "deterministic",
  citation: { page: 1, snippet: "test", region: null }
});

const nothing = <T,>(): Extracted<T> => ({ value: null, confidence: null, method: null, citation: null });

function pins(count: number): PinRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    number: String(index + 1),
    name: `P${index + 1}`,
    electricalType: "unspecified" as const
  }));
}

function record(overrides: Partial<PartRecord> = {}): PartRecord {
  return {
    id: "test",
    partNumber: cited("ACME358"),
    manufacturer: cited("ACME"),
    packageType: cited("SOIC-8"),
    packageOutlineCode: nothing<string>(),
    packageVariants: [],
    pinCount: cited(8),
    pins: cited(pins(8)),
    dimensions: {
      bodyLengthMm: cited(4.9),
      bodyWidthMm: cited(3.9),
      bodyHeightMm: cited(1.75),
      pitchMm: nothing<number>(),
      leadLengthMm: nothing<number>(),
      leadCount: cited(8),
      leadWidthMm: nothing(),
      leadSpanMm: nothing(),
      leadContactMm: nothing(),
      thermalPadLengthMm: nothing(),
      thermalPadWidthMm: nothing()
    },
    radiation: { tid: nothing(), see: nothing(), sel: nothing(), qmlClass: nothing() },
    sourceFileName: "ACME358.pdf",
    notes: [],
    ...overrides
  } as PartRecord;
}

const variant = (designator: string, family: string, leadCount: number | null = 8) => ({
  designator,
  family,
  leadCount,
  inFrontMatter: true
});

test("a characterised package reports that it ships", () => {
  const choice = packageOptions(
    record({ packageVariants: [variant("SOIC-8", "SOIC")] })
  );

  assert.equal(choice.ok, true);
  if (!choice.ok) return;
  assert.equal(choice.options[0].status, "ships");
  assert.deepEqual(choice.options[0].needs, []);
  assert.equal(choice.options[0].reason, null);
});

test("an uncharacterised family reports that it cannot be built, and says why", () => {
  // The larger half of the 67: QFN, SON, LGA, BGA, SOT, PDIP and MiniSO have no
  // characterised land pattern here. The refusal is OURS, and the reason has to
  // travel with the option or the user is left to guess whose gap it is.
  const choice = packageOptions(
    record({ packageVariants: [variant("SOIC-8", "SOIC"), variant("VQFN-8", "VQFN")] })
  );

  assert.equal(choice.ok, true);
  if (!choice.ok) return;
  const qfn = choice.options.find((option) => option.designator === "VQFN-8");
  assert.equal(qfn?.status, "unsupported");
  assert.ok(qfn && qfn.reason && qfn.reason.length > 0, "an unbuildable package must explain itself");
});

test("a flat pack reports that one number would unblock it, and names the number", () => {
  // The difference that matters most in the row: `unsupported` is a dead end for
  // the user, `needs-input` is one field away from a footprint. Collapsing them
  // into "no" would hide seven working paths across the corpus.
  const choice = packageOptions(
    record({
      packageType: cited("16-Pin CFP"),
      pinCount: cited(16),
      pins: cited(pins(16)),
      packageVariants: [variant("16-Pin CFP", "CFP", 16)]
    })
  );

  assert.equal(choice.ok, true);
  if (!choice.ok) return;
  assert.equal(choice.options[0].status, "needs-input");
  assert.equal(choice.options[0].needs[0]?.field, "formedLeadSpanMm");
});

test("supplying the number turns that same package into one that ships", () => {
  const variants = [variant("16-Pin CFP", "CFP", 16)];
  const part = record({
    packageType: cited("16-Pin CFP"),
    pinCount: cited(16),
    pins: cited(pins(16)),
    packageVariants: variants
  });

  assert.equal(packageOptions(part, 12.4).ok, true);
  const answered = packageOptions(part, 12.4);
  if (!answered.ok) return;
  assert.equal(answered.options[0].status, "ships");
});

test("an unreadable record yields no chooser at all, and names the missing fields once", () => {
  // 37 of the 67 dead options were one problem counted many times: the record had
  // no pin table, which blocks every package equally. Reporting it against each
  // option in turn presents one problem as several and implies a different choice
  // might avoid it.
  const choice = packageOptions(
    record({
      pinCount: nothing<number>(),
      pins: nothing<PinRecord[]>(),
      packageVariants: [variant("SOIC-8", "SOIC"), variant("PDIP-8", "PDIP"), variant("VSSOP-8", "VSSOP")]
    })
  );

  assert.equal(choice.ok, false);
  if (choice.ok) return;
  assert.deepEqual(choice.blockedBy, ["pinCount", "pins"]);
});

test("the chooser reports every package the document names, including the ones we cannot build", () => {
  // The tempting fix was to drop the dead entries, on the reasoning that we
  // should only offer packages the datasheet supports. The measurement says
  // otherwise: NONE of the 67 were the datasheet's fault. They were families we
  // have not characterised and records we did not finish reading. Hiding them
  // would hide our own two gaps behind a story about the document, and the count
  // of what we cannot build would stop being visible anywhere.
  const variants = [variant("SOIC-8", "SOIC"), variant("VQFN-8", "VQFN"), variant("PDIP-8", "PDIP")];
  const choice = packageOptions(record({ packageVariants: variants }));

  assert.equal(choice.ok, true);
  if (!choice.ok) return;
  assert.equal(choice.options.length, 3, "no package the document names may be silently dropped");
  assert.deepEqual(
    choice.options.map((option) => option.designator),
    ["SOIC-8", "VQFN-8", "PDIP-8"],
    "and they stay in document order"
  );
});

test("drawing evidence is not carried onto a package it was never checked against", () => {
  // The outline code was read off the ONE drawing confirmed to match the
  // extracted designator. Against a different package it describes the wrong part
  // of the document, and a wide-body code applied to a narrow-body choice is 4.3
  // mm of lead span in the wrong place.
  const part = record({
    packageType: cited("SOIC-8"),
    packageOutlineCode: cited("DW0008A"),
    packageVariants: [variant("SOIC-8", "SOIC"), variant("TSSOP-8", "TSSOP")]
  });

  const choice = packageOptions(part);
  assert.equal(choice.ok, true);
  if (!choice.ok) return;
  // The TSSOP must be judged on its own, not refused for conflicting with a code
  // belonging to the SOIC drawing.
  const tssop = choice.options.find((option) => option.designator === "TSSOP-8");
  assert.equal(tssop?.status, "ships");
});
