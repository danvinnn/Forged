import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReadout } from "../readout";
import { answersFromSettings } from "../settings";
import { datasheetTextFromPages } from "../pdftext";
import type { Extracted, PartRecord, PinRecord } from "../types";

/**
 * THE SETTINGS HAVE TO REACH THE CHOOSER, not only the export.
 *
 * ## The defect
 *
 * The package chooser is built server side and it decides what the screen asks
 * for. `/api/export` has read the installation's settings since 2026-08-19;
 * `/api/parse` and `/api/lookup` sent `buildReadout` nothing, so the chooser
 * evaluated every package as if the user had answered no questions at all.
 *
 * Two of those settings ARE per-part questions, settled up front precisely so
 * they are never asked again: the formed lead span and the seated foot, both
 * properties of the assembler's forming die. A ceramic flat pack was therefore
 * shown two questions its own settings screen had already answered, and
 * answering them a second time changed nothing.
 *
 * Measured 2026-08-27 over the tuned corpus: RHF1201, RHF310A and UT54LVDS217,
 * two questions apiece. All three are ceramic flat packs, which is this
 * product's market.
 *
 * This is the same defect `shipcheck.ts` records fixing in the BENCH on
 * 2026-08-18, left standing in the product for nine days: "route one asked
 * LMP7704-SP and REF5025 for a formed lead span and foot that the user had
 * ALREADY answered on the settings screen".
 */

const cited = <T,>(value: T): Extracted<T> => ({
  value,
  confidence: 0.9,
  method: "deterministic",
  citation: { page: 1, snippet: "test", region: null }
});

const nothing = <T,>(): Extracted<T> => ({ value: null, confidence: null, method: null, citation: null });

const pins: PinRecord[] = Array.from({ length: 14 }, (_, index) => ({
  number: String(index + 1),
  name: `P${index + 1}`,
  electricalType: "unspecified" as const
}));

/** A ceramic flat pack: straight leads the assembler forms, so no seated foot. */
function flatpack(): PartRecord {
  return {
    id: "test",
    partNumber: cited("ACME7704"),
    manufacturer: cited("ACME"),
    packageType: cited("CFP (14)"),
    packageOutlineCode: nothing<string>(),
    jedecOutline: nothing<string>(),
    packageVariants: [{ designator: "CFP (14)", family: "CFP", leadCount: 14, inFrontMatter: true }],
    pinCount: cited(14),
    pins: cited(pins),
    dimensions: {
      bodyLengthMm: cited(9.4),
      bodyWidthMm: cited(6.6),
      bodyHeightMm: cited(2.33),
      pitchMm: cited(1.27),
      leadLengthMm: nothing<number>(),
      leadCount: cited(14),
      leadWidthMm: cited({ minMm: 0.38, maxMm: 0.51 }),
      leadSpanMm: nothing<{ minMm: number; maxMm: number }>(),
      leadSpanCrossMm: nothing<{ minMm: number; maxMm: number }>(),
      leadContactMm: nothing<{ minMm: number; maxMm: number }>(),
      thermalPadLengthMm: nothing(),
      thermalPadWidthMm: nothing(),
      landPadLengthMm: nothing(),
      landPadWidthMm: nothing(),
      landSpanMm: nothing(),
      landSpanCrossMm: nothing(),
      leadSides: cited<2 | 4>(2),
      leadForm: cited<"gullwing" | "nolead" | "straight">("straight"),
      mounting: nothing<"smd" | "through-hole">(),
      leadDiameterMm: nothing<number>(),
      holeDiameterMm: nothing<number>(),
      vacantLeadSlot: nothing(),
      leadsPerSide: nothing(),
      solderMaskExpansionMm: nothing(),
      solderMaskDefined: nothing(),
      thermalViaDiameterMm: nothing(),
      thermalViaPitchMm: nothing()
    },
    radiation: { tid: nothing(), see: nothing(), sel: nothing(), qmlClass: nothing() },
    sourceFileName: "ACME7704.pdf",
    notes: []
  } as unknown as PartRecord;
}

const doc = datasheetTextFromPages(["ACME7704 Data Sheet", "CFP (14) package outline."]);
const NO_BYTES = new ArrayBuffer(0);

/** Every question the chooser attaches to any offered package. */
function questions(choice: Awaited<ReturnType<typeof buildReadout>>["packageChoice"]): string[] {
  return choice.ok ? [...new Set(choice.options.flatMap((option) => option.needs.map((need) => need.field)))] : [];
}

test("without the settings, the chooser asks for the forming die", async () => {
  // The state this test exists to hold shut. Not an assertion that the behaviour
  // is desirable: it is what a caller who genuinely has no settings should see,
  // and it is what BOTH read routes used to send.
  const readout = await buildReadout(flatpack(), doc, NO_BYTES, []);
  const asked = questions(readout.packageChoice);
  assert.ok(asked.includes("formedLeadSpanMm"), "a straight lead has no span until the die is known");
  assert.ok(asked.includes("formedLeadContactMm"), "and no seated foot either");
});

test("with the settings, it does not ask again", async () => {
  const answers = answersFromSettings({ formedLeadSpanMm: 7.62, formedLeadContactMm: 1.4 });
  const readout = await buildReadout(flatpack(), doc, NO_BYTES, [], answers);
  const asked = questions(readout.packageChoice);
  assert.ok(!asked.includes("formedLeadSpanMm"), "the user answered this on the settings screen");
  assert.ok(!asked.includes("formedLeadContactMm"), "and this one too");
});

test("answersFromSettings carries exactly the two per-part settings", () => {
  // Density level is NOT among them: it is a property of the board, applied by
  // the generator, and never a question about a part.
  assert.deepEqual(answersFromSettings({}), {});
  assert.deepEqual(answersFromSettings({ densityLevel: "A" } as never), {});
  assert.deepEqual(answersFromSettings({ formedLeadSpanMm: 7.62 }), { formedLeadSpanMm: 7.62 });
});
