import { test } from "node:test";
import assert from "node:assert/strict";
import { shownRecord } from "../review";
import type { PartRecord } from "../types";

const read = <T,>(value: T, page: number) => ({
  value,
  confidence: 0.5,
  method: "vlm" as const,
  citation: { page, snippet: String(value), region: null }
});
const blank = { value: null, confidence: null, method: null, citation: null };

function record(): PartRecord {
  return {
    partNumber: read("OPA333", 1),
    packageType: blank,
    pins: { ...blank, value: null },
    pinCount: blank,
    dimensions: {
      bodyLengthMm: blank,
      bodyWidthMm: blank,
      pitchMm: blank,
      landPadLengthMm: blank
    },
    packageVariants: [],
    packagesInThisDocument: [
      {
        packageType: "SOT-23 (5)",
        outlineCode: "DBV0005A",
        citation: { page: 43, snippet: "", region: null },
        pins: [{ number: "1", name: "OUT", electricalType: "output" as const }],
        dimensions: {
          bodyLengthMm: read(2.9, 43),
          bodyWidthMm: read(1.6, 43),
          pitchMm: read(0.95, 43),
          landPadLengthMm: read(1.1, 44)
        }
      },
      {
        packageType: "SOIC (8)",
        outlineCode: "D0008A",
        citation: { page: 40, snippet: "", region: null },
        pins: [
          { number: "1", name: "NC", electricalType: "unspecified" as const },
          { number: "2", name: "IN", electricalType: "input" as const }
        ],
        dimensions: {
          bodyLengthMm: read(4.9, 40),
          bodyWidthMm: read(3.9, 40),
          pitchMm: read(1.27, 40),
          landPadLengthMm: read(1.55, 41)
        }
      }
    ]
  } as unknown as PartRecord;
}

test("the panel shows the chosen package's own dimensions, not the empty flat block", () => {
  // The defect this pins: OPA333's flat block is null in every field while its
  // five package entries carry seventeen cited dimensions each, and the screen
  // rendered "not read" for all of them beside a zip containing every one.
  const shown = shownRecord(record(), "SOT-23 (5) [DBV0005A]");
  assert.equal(shown.dimensions.bodyLengthMm.value, 2.9);
  assert.equal(shown.dimensions.pitchMm.value, 0.95);
  assert.equal(shown.dimensions.landPadLengthMm.value, 1.1);
  assert.equal(shown.dimensions.bodyLengthMm.citation?.page, 43);
});

test("choosing the other package shows that package's numbers", () => {
  const shown = shownRecord(record(), "SOIC (8) [D0008A]");
  assert.equal(shown.dimensions.bodyLengthMm.value, 4.9);
  assert.equal(shown.dimensions.pitchMm.value, 1.27);
  assert.equal(shown.pins.length, 2);
});

test("the pins come from the chosen package's own table", () => {
  assert.equal(shownRecord(record(), "SOT-23 (5) [DBV0005A]").pins.length, 1);
  assert.equal(shownRecord(record(), "SOT-23 (5) [DBV0005A]").pins[0].name, "OUT");
});

test("with no package chosen it falls back to the record itself", () => {
  const shown = shownRecord(record(), null);
  assert.equal(shown.dimensions.bodyLengthMm.value, null);
  assert.equal(shown.pins.length, 0);
});

test("a designator matching no table falls back rather than inventing", () => {
  const shown = shownRecord(record(), "TSSOP (14)");
  assert.equal(shown.dimensions.pitchMm.value, null);
});

test("a value the package states wins over the flat block", () => {
  // The other way round would show whichever package happened to be read last
  // under the name of the one on screen.
  const withFlat = record();
  (withFlat.dimensions as unknown as Record<string, unknown>).pitchMm = read(9.99, 2);
  assert.equal(shownRecord(withFlat, "SOIC (8) [D0008A]").dimensions.pitchMm.value, 1.27);
});
