import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeModelValues } from "../merge";
import { buildPartRecord } from "../../datasheet";
import type { DatasheetText } from "../../pdftext";
import type { ExtractionResult } from "../contracts";

/**
 * THE INNER GAP READ AS THE CENTRE SPAN.
 *
 * A vendor's recommended-footprint drawing dimensions the distance between two
 * opposing rows of lands in one of three ways, and the model routinely reports
 * the INNER GAP where the field asks for the centre-to-centre span. Measured
 * over the tuned corpus on 2026-08-25 it was four of the twenty-one wrong
 * numbers, every one of them placing copper on a part that ships.
 *
 * A gull-wing lead's foot sits beyond the body edge, so the two land rows are
 * further apart than the body is wide. That is what separates the two readings,
 * and it holds on 22 of 22 hand-read gull-wing footprints in `DIMENSION_ORACLE`.
 */

const PAGE = "Recommended footprint. Lands 1.55 mm long, 0.60 mm wide, 3.85 mm between the inner edges.";

function doc(): DatasheetText {
  return {
    text: PAGE,
    pages: [{ page: 1, text: PAGE, start: 0, end: PAGE.length }],
    pageCount: 1,
    warnings: []
  } as unknown as DatasheetText;
}

function values(overrides: Record<string, { value: unknown; page: number | null }>): ExtractionResult {
  return {
    values: {
      "dimensions.landPadLengthMm": { value: 1.55, page: 1 },
      "dimensions.landPadWidthMm": { value: 0.6, page: 1 },
      "dimensions.bodyWidthMm": { value: 3.895, page: 1 },
      "dimensions.bodyLengthMm": { value: 4.9, page: 1 },
      "dimensions.leadForm": { value: "gullwing", page: 1 },
      ...overrides
    }
  } as unknown as ExtractionResult;
}

function merged(result: ExtractionResult) {
  const parsed = doc();
  const part = buildPartRecord(parsed, "ACME555.pdf");
  return mergeModelValues(part, parsed, result, "test-model", [1]);
}

test("a gull-wing span that does not clear the body is the inner gap, and is corrected", () => {
  const outcome = merged(values({ "dimensions.landSpanMm": { value: 3.85, page: 1 } }));

  assert.equal(
    outcome.part.dimensions.landSpanMm.value,
    5.4,
    "3.85 mm between the inner edges plus one 1.55 mm land is a 5.40 mm centre span"
  );
  assert.ok(
    outcome.part.notes.some((note) => /INNER GAP/.test(note) && /5\.4/.test(note)),
    "and the record says what was done and why, because a corrected number nobody can explain is worse than a wrong one"
  );
});

test("a span that already clears the body is left alone", () => {
  const outcome = merged(values({ "dimensions.landSpanMm": { value: 5.4, page: 1 } }));
  assert.equal(outcome.part.dimensions.landSpanMm.value, 5.4, "nothing to correct");
  assert.ok(
    !outcome.part.notes.some((note) => /INNER GAP/.test(note)),
    "and nothing is said about it"
  );
});

test("a NO-LEAD package is never corrected, because its lands belong under the body", () => {
  // The whole basis of the rule is that a gull-wing foot lands beyond the body
  // edge. A QFN's terminals are on the underside, so a span smaller than the
  // body is the correct answer there and correcting it would move copper off the
  // terminals. Eight of the thirty hand-read footprints are this shape.
  const outcome = merged(
    values({
      "dimensions.landSpanMm": { value: 3.8, page: 1 },
      "dimensions.leadForm": { value: "nolead", page: 1 }
    })
  );
  assert.equal(outcome.part.dimensions.landSpanMm.value, 3.8, "a no-lead span stands as read");
});

test("a correction that still would not clear the body is not made", () => {
  // If the sum does not resolve the contradiction then the reading is wrong in
  // some other way and this is not the fix. Leaving it alone hands it to the
  // checks that refuse, rather than replacing one wrong number with another.
  const outcome = merged(
    values({
      "dimensions.landSpanMm": { value: 1, page: 1 },
      "dimensions.landPadLengthMm": { value: 0.5, page: 1 }
    })
  );
  assert.equal(outcome.part.dimensions.landSpanMm.value, 1, "left for the checks that refuse");
});

test("the cross-axis span is corrected against the body's OTHER axis", () => {
  // `landSpanMm` separates the rows running parallel to the body's length and is
  // judged against the body's width; the cross span is the other way round. This
  // codebase has paid three times for an axis convention held in one module.
  const outcome = merged(
    values({
      "dimensions.landSpanMm": { value: 5.4, page: 1 },
      "dimensions.landSpanCrossMm": { value: 4.5, page: 1 }
    })
  );
  assert.equal(
    outcome.part.dimensions.landSpanCrossMm.value,
    6.05,
    "4.5 does not clear the 4.9 mm body length, so it is the gap: 4.5 + 1.55"
  );
});
