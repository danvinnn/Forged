import { test } from "node:test";
import assert from "node:assert/strict";
import { collectReviewItems, REVIEW_CONFIDENCE } from "../review";
import { resolveForExport, type Citation, type Extracted, type PartRecord, type PinRecord } from "../types";

const CITED: Citation = { page: 2, snippet: "read from the rendered page", region: null };

function field<T>(over: Partial<Extracted<T>> = {}): Extracted<T> {
  return { value: null, confidence: null, method: null, citation: null, ...over } as Extracted<T>;
}

/** Only the parts of a record the review pass reads. */
function record(over: Record<string, unknown> = {}): PartRecord {
  const base = {
    partNumber: field<string>({ value: "LM139", confidence: 1, method: "deterministic" }),
    manufacturer: field<string>(),
    packageType: field<string>(),
    pinCount: field<number>(),
    pins: field<PinRecord[]>(),
    packageOutlineCode: field<string>(),
    jedecOutline: field<string>(),
    packageVariants: [],
    notes: [],
    dimensions: {
      bodyLengthMm: field<number>(),
      bodyWidthMm: field<number>(),
      bodyHeightMm: field<number>(),
      pitchMm: field<number>(),
      leadLengthMm: field<number>(),
      leadCount: field<number>(),
      leadWidthMm: field<{ minMm: number; maxMm: number }>(),
      leadSpanMm: field<{ minMm: number; maxMm: number }>(),
      leadSpanCrossMm: field<{ minMm: number; maxMm: number }>(),
      leadContactMm: field<{ minMm: number; maxMm: number }>(),
      thermalPadLengthMm: field<number>(),
      thermalPadWidthMm: field<number>(),
      landPadLengthMm: field<number>(),
      landPadWidthMm: field<number>(),
      landSpanMm: field<number>(),
      landSpanCrossMm: field<number>(),
      leadSides: field<2 | 4>(),
      leadForm: field<"gullwing" | "nolead" | "straight">(),
      mounting: field<"smd" | "through-hole">(),
      leadDiameterMm: field<number>(),
      vacantLeadSlot: field<number>(),
      leadsPerSide: field<string>(),
      solderMaskExpansionMm: field<number>(),
      solderMaskDefined: field<"solder-mask-defined" | "non-solder-mask-defined">(),
      thermalViaDiameterMm: field<number>(),
      thermalViaPitchMm: field<number>()
    },
    radiation: {
      tid: field<string>(),
      see: field<string>(),
      sel: field<string>(),
      qmlClass: field<string>()
    },
    ...over
  };
  return base as unknown as PartRecord;
}

const PINS: PinRecord[] = [
  { number: "1", name: "OUTPUT 2", electricalType: "output" },
  { number: "2", name: "OUTPUT 1", electricalType: "output" }
];

test("a value the deterministic reader produced is never put to a human", () => {
  const part = record({
    pinCount: field<number>({ value: 14, confidence: 1, method: "deterministic", citation: CITED })
  });
  assert.deepEqual(collectReviewItems(part), [], "code read it off the page; there is nothing to confirm");
});

test("a value read off a rendered page is offered for review but does not block", () => {
  const part = record({
    pins: field<PinRecord[]>({ value: PINS, confidence: 0.4, method: "vlm-drawing", citation: CITED })
  });
  const [item] = collectReviewItems(part);

  assert.equal(item.field, "pins");
  assert.equal(item.reason, "read-from-image");
  assert.equal(item.page, 2, "the reviewer is told which page to open");
  assert.equal(item.blocking, false, "it has a citation, so the export is not held up");
  assert.match(item.consequence, /netlist/, "prompted by what breaks, not by the score");
});

test("a value with no citation blocks the export and is listed first", () => {
  const part = record({
    // Cited, so reviewable but not blocking.
    "dimensions": {
      ...record().dimensions,
      pitchMm: field<number>({ value: 0.65, confidence: 0.5, method: "vlm", citation: CITED })
    },
    // Uncited: this is the one costing the user their export today.
    pins: field<PinRecord[]>({ value: PINS, confidence: null, method: "vlm", citation: null })
  });

  const items = collectReviewItems(part);
  assert.equal(items.length, 2);
  assert.equal(items[0].field, "pins", "what blocks the export comes first");
  assert.equal(items[0].reason, "unverifiable");
  assert.equal(items[0].blocking, true);
  assert.equal(items[1].blocking, false);
});

test("a confident model read is not raised, but one at the threshold is", () => {
  const confident = record({
    pinCount: field<number>({ value: 14, confidence: 0.9, method: "vlm", citation: CITED })
  });
  assert.deepEqual(collectReviewItems(confident), [], "a strong cited read does not need a person");

  const borderline = record({
    pinCount: field<number>({ value: 14, confidence: REVIEW_CONFIDENCE, method: "vlm", citation: CITED })
  });
  assert.equal(collectReviewItems(borderline).length, 1, "at the threshold, ask");
});

test("fields that place no copper are not worth interrupting for", () => {
  // A radiation rating is real data that nothing in the generated output depends
  // on. The interruption budget belongs to values that move pads.
  const part = record({
    radiation: {
      ...record().radiation,
      tid: field<string>({ value: "100krad(Si)", confidence: 0.4, method: "vlm-drawing", citation: CITED })
    }
  });
  assert.deepEqual(collectReviewItems(part), []);
});

test("values are summarised for a human, not dumped as JSON", () => {
  const many: PinRecord[] = Array.from({ length: 14 }, (_, i) => ({
    number: String(i + 1),
    name: `P${i + 1}`,
    electricalType: "passive" as const
  }));
  const part = record({
    pins: field<PinRecord[]>({ value: many, confidence: 0.4, method: "vlm-drawing", citation: CITED }),
    dimensions: {
      ...record().dimensions,
      leadSpanMm: field({ value: { minMm: 6.2, maxMm: 6.6 }, confidence: 0.4, method: "vlm-drawing", citation: CITED })
    }
  });

  const items = collectReviewItems(part);
  const pins = items.find((item) => item.field === "pins");
  const span = items.find((item) => item.field === "dimensions.leadSpanMm");

  assert.match(pins!.display, /^14 pins: 1=P1, 2=P2, 3=P3, 4=P4, \.\.\./, "a preview, not all fourteen");
  assert.equal(span!.display, "6.2 to 6.6 mm");
  assert.ok(!pins!.display.includes("{"), "never raw JSON");
});

test("a zero-width range reads as one number, because that is what it means", () => {
  const part = record({
    dimensions: {
      ...record().dimensions,
      leadSpanMm: field({ value: { minMm: 2.8, maxMm: 2.8 }, confidence: 0.4, method: "vlm-drawing", citation: CITED })
    }
  });
  assert.equal(collectReviewItems(part)[0].display, "2.8 mm");
});

test("confirming an unverifiable value is what unblocks the export", () => {
  // The whole point of the panel, end to end. Before this existed, a value the
  // model had read but could not cite was dropped at the export gate and the
  // user was told the field was MISSING, for a value that was sitting in the
  // record. Confirming it against the cited page is the cheapest possible fix
  // and it is the only one that produces a record someone can sign.
  const untraceable = record({
    packageType: field<string>({ value: "SOIC-8", confidence: 1, method: "deterministic", citation: CITED }),
    pinCount: field<number>({ value: 2, confidence: 1, method: "deterministic", citation: CITED }),
    pins: field<PinRecord[]>({ value: PINS, confidence: null, method: "vlm", citation: null })
  });

  const before = resolveForExport(untraceable);
  assert.equal(before.ok, false, "an uncited model value cannot be exported");
  assert.ok(
    !before.ok && before.untraceable?.includes("pins"),
    "and it is refused for being untraceable, not for being absent"
  );

  const item = collectReviewItems(untraceable).find((entry) => entry.field === "pins");
  assert.ok(item?.blocking, "the panel must present it as the thing blocking the export");

  // Exactly what handleConfirmReview does: keep the value and the citation,
  // record that a person checked it.
  const confirmed = {
    ...untraceable,
    pins: { ...untraceable.pins, confidence: 1, method: "user-confirmed" as const }
  } as PartRecord;

  assert.equal(resolveForExport(confirmed).ok, true, "one confirmation, and it ships");
  assert.deepEqual(collectReviewItems(confirmed), [], "and it stops being asked about");
});

test("confirming keeps the citation, because the page is still where the evidence is", () => {
  const part = record({
    pins: field<PinRecord[]>({ value: PINS, confidence: 0.4, method: "vlm-drawing", citation: CITED })
  });
  const confirmed = {
    ...part,
    pins: { ...part.pins, confidence: 1, method: "user-confirmed" as const }
  } as PartRecord;

  assert.equal(confirmed.pins.citation?.page, 2, "a reviewer must still be able to go and look");
  assert.equal(confirmed.pins.method, "user-confirmed", "distinct from a value someone simply typed");
});

