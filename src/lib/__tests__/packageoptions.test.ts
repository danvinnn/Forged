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
    jedecOutline: nothing<string>(),
    packageVariants: [],
    pinCount: cited(8),
    pins: cited(pins(8)),
    dimensions: {
      bodyLengthMm: cited(4.9),
      bodyWidthMm: cited(3.9),
      bodyHeightMm: cited(1.75),
      // The part's OWN drawing, TI D0008A / JEDEC MS-012. These were absent when
      // a hand-typed family table supplied them from the string "SOIC-8"; the
      // table is gone, so the fixture states what a datasheet states.
      pitchMm: cited(1.27),
      leadLengthMm: nothing<number>(),
      leadCount: cited(8),
      leadWidthMm: cited({ minMm: 0.31, maxMm: 0.51 }),
      leadSpanMm: cited({ minMm: 5.8, maxMm: 6.2 }),
      leadSpanCrossMm: nothing<{ minMm: number; maxMm: number }>(),
      leadContactMm: cited({ minMm: 0.4, maxMm: 0.625 }),
      thermalPadLengthMm: nothing(),
      thermalPadWidthMm: nothing(),
      landPadLengthMm: nothing(),
      landPadWidthMm: nothing(),
      landSpanMm: nothing(),
      landSpanCrossMm: nothing(),
      leadSides: cited<2 | 4>(2),
      leadForm: cited<"gullwing" | "nolead" | "straight">("gullwing"),
      mounting: nothing<"smd" | "through-hole">(),
      leadDiameterMm: nothing<number>(),
      vacantLeadSlot: nothing(),
      leadsPerSide: nothing(),
      solderMaskExpansionMm: nothing(),
      solderMaskDefined: nothing(),
      thermalViaDiameterMm: nothing(),
      thermalViaPitchMm: nothing()
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

test("an uncharacterised family becomes a QUESTION, not a dead option", () => {
  // Was "reports that it cannot be built": QFN, SON, LGA, BGA, SOT, PDIP and
  // MiniSO had no characterised land pattern and the option was `unsupported`,
  // with the refusal described as ours. Since 2026-08-13 the exporter asks for
  // the land pattern instead of refusing, because the alternative is typing
  // invented lead dimensions into a family table, and the chooser reflects that
  // automatically. The user can now pick one of these and answer for it.
  const choice = packageOptions(
    record({ packageVariants: [variant("SOIC-8", "SOIC"), variant("VQFN-8", "VQFN")] })
  );

  assert.equal(choice.ok, true);
  if (!choice.ok) return;
  const qfn = choice.options.find((option) => option.designator === "VQFN-8");
  assert.equal(qfn?.status, "needs-input");
  assert.ok(qfn && qfn.needs.length > 0, "and it says what to supply");
  assert.ok(
    qfn.needs.every((need) => need.why.length > 0),
    "each with a reason the document cannot answer it"
  );
});

test("a flat pack reports that one number would unblock it, and names the number", () => {
  // The difference that matters most in the row: `unsupported` is a dead end for
  // the user, `needs-input` is one field away from a footprint. Collapsing them
  // into "no" would hide seven working paths across the corpus.
  const choice = packageOptions(
    record({
      packageType: cited("16-Pin CFP"),
      dimensions: { ...record().dimensions, leadForm: cited<"gullwing" | "nolead" | "straight">("straight") },
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

  assert.equal(packageOptions(part, { formedLeadSpanMm: 12.4 }).ok, true);
  const answered = packageOptions(part, { formedLeadSpanMm: 12.4 });
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
    jedecOutline: nothing<string>(),
    packageVariants: [variant("SOIC-8", "SOIC"), variant("TSSOP-8", "TSSOP")]
  });

  const choice = packageOptions(part);
  assert.equal(choice.ok, true);
  if (!choice.ok) return;
  // The TSSOP is judged on its own: it asks for its own land pattern rather than
  // being refused for conflicting with a code belonging to the SOIC drawing.
  //
  // It used to assert `ships`, which it did by taking a family table's TSSOP
  // lead dimensions. With the table gone, nothing has been read for this package
  // and saying so is the honest outcome.
  const tssop = choice.options.find((option) => option.designator === "TSSOP-8");
  assert.equal(tssop?.status, "needs-input");
  assert.ok(
    // The OTHER PACKAGE'S CODE, which is the thing that must not be carried
    // across. This matched a bare "outline" until 2026-08-18, and then caught the
    // body-size question's own words: those name the package outline DRAWING as
    // where a body size is dimensioned, which is a generic instruction about
    // where to look and not a claim about the SOIC's code. Narrowed to the claim
    // it was written to rule out.
    tssop!.needs.every((need) => !/DW0008A/i.test(need.why)),
    "and the reason is its own missing pattern, not the other package's code"
  );
});

// ---------------------------------------------------------------------------
// A different package is a different footprint, all the way down
// ---------------------------------------------------------------------------

test("a sibling package does not inherit the resolved package's printed land pattern", () => {
  // The defect this locks out, found 2026-08-14.
  //
  // `landPadLengthMm`, `landPadWidthMm` and `landSpanMm` are read off the
  // recommended-footprint drawing for ONE package, and since 2026-08-12 they ARE
  // the pads. Both places that switch package dropped a subset of the drawing
  // evidence and kept these three, so the chooser reported `ships` for a VSSOP-8
  // and would have built it out of the SOIC's copper. Nothing in the file would
  // have looked wrong.
  const part = record({
    packageType: cited("SOIC-8"),
    dimensions: {
      ...record().dimensions,
      pitchMm: cited(1.27),
      leadSides: cited<2 | 4>(2),
      landPadLengthMm: cited(1.95),
      landPadWidthMm: cited(0.6),
      landSpanMm: cited(4.95),
      landSpanCrossMm: nothing<number>(),
    },
    packageVariants: [
      { designator: "SOIC-8", family: "SOIC", leadCount: 8, inFrontMatter: true },
      { designator: "VSSOP-8", family: "VSSOP", leadCount: 8, inFrontMatter: true }
    ]
  });

  const choice = packageOptions(part);
  assert.ok(choice.ok);
  const by = new Map(choice.options.map((option) => [option.designator, option]));

  assert.equal(by.get("SOIC-8")!.status, "ships", "the package the drawing was read for still ships");
  assert.notEqual(
    by.get("VSSOP-8")!.status,
    "ships",
    "a package whose own drawing was never read cannot claim to ship"
  );
  assert.ok(
    by.get("VSSOP-8")!.needs.some((need) => need.field === "landPadLengthMm"),
    "and it asks for its own land pattern rather than borrowing one"
  );
});

test("an exposed pad belongs to the package that has one, not to its siblings", () => {
  const part = record({
    packageType: cited("VQFN-16"),
    exposedPad: true,
    dimensions: {
      ...record().dimensions,
      pitchMm: cited(0.5),
      leadSides: cited<2 | 4>(4),
      thermalPadLengthMm: cited(1.68),
      thermalPadWidthMm: cited(1.68),
      landPadLengthMm: cited(0.825),
      landPadWidthMm: cited(0.25),
      landSpanMm: cited(2.925),
      landSpanCrossMm: nothing<number>(),
    },
    pinCount: cited(16),
    pins: cited(pins(16)),
    packageVariants: [
      { designator: "VQFN-16", family: "VQFN", leadCount: 16, inFrontMatter: true },
      { designator: "TSSOP-16", family: "TSSOP", leadCount: 16, inFrontMatter: true }
    ]
  });

  const choice = packageOptions(part);
  assert.ok(choice.ok);
  const tssop = choice.options.find((option) => option.designator === "TSSOP-16")!;
  // Not "the TSSOP needs a thermal pad size": the TSSOP has no thermal pad. It
  // needs its own land pattern, which is a different question entirely.
  assert.ok(
    !tssop.needs.some((need) => need.field.startsWith("thermalPad")),
    "the TSSOP is not asked for the VQFN's exposed pad"
  );
});

// ---------------------------------------------------------------------------
// A number we could not place must not take the whole part down
// ---------------------------------------------------------------------------

test("one unplaceable per-package measurement is dropped, not fatal to the package", () => {
  // The merge stores a per-package value it could not locate on any page, with a
  // null citation, so the user can see what was read and could not be placed.
  // That is right on the RECORD and wrong the moment it is copied onto the part
  // being exported: `resolveForExport` refuses an untraceable geometry value, so
  // ONE unplaceable number would have refused the entire part rather than being
  // dropped and asked for.
  //
  // Found by reading the diff. No test failed, because nothing in the corpus
  // happened to have an uncited per-package value yet.
  const uncited = <T,>(value: T): Extracted<T> => ({ value, confidence: null, method: "vlm", citation: null });

  const part = record({
    packageType: nothing<string>(),
    pinCount: nothing<number>(),
    pins: nothing<PinRecord[]>(),
    packageVariants: [variant("VSSOP-8", "VSSOP")],
    packagesInThisDocument: [
      {
        packageType: "VSSOP-8",
        pins: pins(8),
        citation: { page: 4, snippet: "PIN CONFIGURATION", region: null },
        dimensions: {
          bodyLengthMm: cited(3.0),
          bodyWidthMm: cited(3.0),
          bodyHeightMm: cited(1.1),
          pitchMm: cited(0.65),
          leadSides: cited<2 | 4>(2),
          leadForm: cited<"gullwing" | "nolead" | "straight">("gullwing"),
          landPadLengthMm: cited(1.45),
          landPadWidthMm: cited(0.45),
          landSpanMm: cited(4.4),
          // The one nobody could place.
          leadSpanMm: uncited({ minMm: 4.8, maxMm: 5.0 })
        }
      }
    ]
  });

  const choice = packageOptions(part);
  assert.equal(choice.ok, true, "an unplaceable number is not a reason to refuse the reading");
  if (!choice.ok) return;
  assert.equal(
    choice.options[0].status,
    "ships",
    "everything that WAS placed is enough to build, so the part ships"
  );
});
