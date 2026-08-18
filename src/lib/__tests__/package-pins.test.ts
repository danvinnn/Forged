import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import {
  createExportZip,
  packageOptions,
  asPackage,
  FootprintUnavailableError,
  type SuppliedDimensions
} from "../exporters";
import { extractedValue, resolveForExport, unknown, type PartRecord, type PinRecord } from "../types";

/**
 * One package's pin table must never build another package's footprint.
 *
 * ## The defect
 *
 * A family datasheet describes several packages and the reading settles on one
 * of them, so the record carries ONE pin table. Every route that relabels the
 * part as a sibling kept it:
 *
 *   - `asPackage` blanked every dimension, precisely because they describe the
 *     wrong package, and carried the pins across unchanged
 *   - `/api/export` with a `packageType` override goes through that same function
 *   - the UI answered a package click with "the pinout was already read, so it
 *     was kept"
 *
 * The packages genuinely differ. Measured over the cached hold-out answers on
 * 2026-08-16: 21 of the 56 cached documents describe more than one package with
 * its own pin table, and TEN of them differ in LEAD COUNT. An ADS1256 is an SSOP-20 or an
 * SSOP-28; an LT1013 an 8, 14 or 16 lead part. Picking the other one produced a
 * footprint with the first package's pad count under the second's name, which is
 * a board nobody can build and which looks entirely ordinary in CAD.
 *
 * The lead count was on screen beside the button the whole time.
 */

function pins(count: number): PinRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    number: String(index + 1),
    name: `P${index + 1}`,
    electricalType: "passive" as const
  }));
}

const cited = <T,>(value: T) => extractedValue(value, 0.9, { page: 3, snippet: "fixture", region: null });

/**
 * A record read as the 20-pin package of a document that also describes a
 * 28-pin one, with a complete printed land pattern so nothing else can be the
 * reason a footprint is refused.
 */
function familyRecord(overrides: Partial<PartRecord> = {}): PartRecord {
  return {
    id: "family",
    partNumber: cited("ACME1256"),
    manufacturer: cited("ACME"),
    packageType: cited("SSOP-20"),
    packageOutlineCode: unknown<string>(),
    jedecOutline: unknown<string>(),
    packageVariants: [
      { designator: "SSOP-20", family: "SSOP", leadCount: 20, inFrontMatter: true },
      { designator: "SSOP-28", family: "SSOP", leadCount: 28, inFrontMatter: true }
    ],
    vendorLandPattern: null,
    exposedPad: false,
    pinCount: cited(20),
    pins: cited(pins(20)),
    dimensions: {
      bodyLengthMm: cited(7.2),
      bodyWidthMm: cited(5.3),
      bodyHeightMm: cited(1.75),
      pitchMm: cited(0.65),
      leadLengthMm: unknown<number>(),
      leadCount: cited(20),
      leadWidthMm: unknown(),
      leadSpanMm: unknown(),
      leadSpanCrossMm: unknown(),
      leadContactMm: unknown(),
      thermalPadLengthMm: unknown<number>(),
      thermalPadWidthMm: unknown<number>(),
      landPadLengthMm: cited(1.5),
      landPadWidthMm: cited(0.4),
      landSpanMm: cited(6.9),
      landSpanCrossMm: unknown<number>(),
      leadSides: cited<2 | 4>(2),
      leadForm: cited<"gullwing" | "nolead" | "straight">("gullwing"),
      mounting: unknown(),
      leadDiameterMm: unknown<number>(),
      vacantLeadSlot: unknown<number>(),
      leadsPerSide: unknown<string>(),
      solderMaskExpansionMm: unknown<number>(),
      solderMaskDefined: unknown(),
      thermalViaDiameterMm: unknown<number>(),
      thermalViaPitchMm: unknown<number>()
    },
    radiation: { tid: unknown<string>(), see: unknown<string>(), sel: unknown<string>(), qmlClass: unknown<string>() },
    sourceFileName: "acme1256.pdf",
    notes: [],
    ...overrides
  } as PartRecord;
}

/**
 * `supplied` matters here. `asPackage` blanks the land pattern along with every
 * other dimension, and rightly: it was read off the 20-pin package's drawing. So
 * a sibling always ASKS for its own pattern, and supplying one is what lets the
 * pad COUNT be observed, which is the thing under test.
 */
async function padNumbers(
  record: PartRecord,
  designator: string,
  supplied?: SuppliedDimensions
): Promise<string[]> {
  const resolved = resolveForExport(record);
  assert.ok(resolved.ok, "the fixture resolves");
  if (!resolved.ok) return [];
  const bundle = await createExportZip(asPackage(resolved.part, designator), "kicad", { supplied });
  const zip = await JSZip.loadAsync(bundle.buffer);
  const name = Object.keys(zip.files).find((file) => file.endsWith(".kicad_mod"))!;
  const text = await zip.files[name].async("string");
  return [...text.matchAll(/\(pad "(\d+)"/g)].map((match) => match[1]);
}

test("the package that WAS read still builds, from its own pins", async () => {
  // The control. Without it a fix that refuses everything would pass the rest.
  const numbers = await padNumbers(familyRecord(), "SSOP-20");
  assert.equal(numbers.length, 20, "twenty lands for a twenty pin package");
});

test("a sibling with a different lead count does not build from the record's pins", async () => {
  await assert.rejects(
    () => padNumbers(familyRecord(), "SSOP-28"),
    (error: unknown) => {
      assert.ok(error instanceof FootprintUnavailableError, `unexpected: ${error}`);
      // Terminal, not a question: no number the user can type turns one
      // package's pinout into another's.
      assert.equal(error.needs.length, 0);
      assert.match(error.reason, /28/, "the refusal names the count the package declares");
      assert.match(error.reason, /20/, "and the count actually read");
      return true;
    }
  );
});

test("with the document's own table for that package, the sibling builds from IT", async () => {
  // This is what `pinTablesByPackage` was read for, and until 2026-08-16 nothing
  // consumed it: the model returned one table per package on 22 of 56 hold-out
  // documents and every one was discarded.
  const record = familyRecord({
    pinTablesByPackage: [
      { packageType: "SSOP-20", pins: pins(20) },
      { packageType: "SSOP-28", pins: pins(28) }
    ]
  });

  const numbers = await padNumbers(record, "SSOP-28", {
    // Everything `asPackage` blanks, because all of it described the 20-pin
    // package. Supplying it is exactly what the chooser asks the user for.
    landPadLengthMm: 1.5,
    landPadWidthMm: 0.4,
    landSpanMm: 6.9,
    pitchMm: 0.65,
    leadSides: 2,
    bodyLengthMm: 10.2,
    bodyWidthMm: 5.3,
    bodyHeightMm: 1.75
  });
  assert.equal(numbers.length, 28, "twenty-eight lands, from the twenty-eight pin table");
  assert.ok(numbers.includes("28"), "including the pins the first reading never had");
});

test("the chooser reports the sibling honestly rather than offering a wrong build", async () => {
  const choice = packageOptions(familyRecord());
  assert.equal(choice.ok, true);
  if (!choice.ok) return;

  const twenty = choice.options.find((option) => option.designator === "SSOP-20");
  const twentyEight = choice.options.find((option) => option.designator === "SSOP-28");

  assert.equal(twenty?.status, "ships", "the package that was read builds");
  // Not `ships`, which is what it claimed before: it would have built twenty
  // pads and called them an SSOP-28.
  assert.equal(twentyEight?.status, "unsupported");
  assert.match(twentyEight?.reason ?? "", /different packages/);
});

test("and it ships once the document's own table for it is on the record", async () => {
  const choice = packageOptions(
    familyRecord({
      pinTablesByPackage: [
        { packageType: "SSOP-20", pins: pins(20) },
        { packageType: "SSOP-28", pins: pins(28) }
      ]
    })
  );
  assert.equal(choice.ok, true);
  if (!choice.ok) return;
  // The land pattern still belongs to the 20-pin package, so this asks for its
  // own rather than shipping. What matters is that it is a QUESTION again
  // instead of a refusal, and that nothing built twenty pads.
  const twentyEight = choice.options.find((option) => option.designator === "SSOP-28");
  assert.notEqual(twentyEight?.status, "unsupported");
});

test("a package whose name declares no lead count is left alone", async () => {
  // The guard must not refuse correct parts. `SOT-23`, `TO-220`, `TO-92`,
  // `SOT-563` and `SOD-123` all declare no count, and a part legitimately read
  // in one of them has to keep working.
  const record = familyRecord({
    packageType: cited("SOT-23"),
    pinCount: cited(5),
    pins: cited(pins(5)),
    packageVariants: [{ designator: "SOT-23", family: "SOT", leadCount: null, inFrontMatter: true }],
    dimensions: { ...familyRecord().dimensions, vacantLeadSlot: cited(3) }
  });
  const numbers = await padNumbers(record, "SOT-23", {
    landPadLengthMm: 1.0,
    landPadWidthMm: 0.4,
    landSpanMm: 2.6,
    pitchMm: 0.95,
    leadSides: 2,
    vacantLeadSlot: 3,
    bodyLengthMm: 2.9,
    bodyWidthMm: 1.6,
    bodyHeightMm: 1.1
  });
  assert.equal(numbers.length, 5, "an unnumbered designator is no obstacle");
});

test("the per-package tables survive the export route's schema", async () => {
  // The half that was nearly missed. `/api/export` validates the posted record
  // with `partSchema`, zod strips keys the schema does not declare, and this
  // field lives on the TypeScript type. Without a schema entry it would be
  // dropped on precisely the route that relabels a part as a sibling, so
  // `asPackage` would find the right table everywhere except where it matters.
  const { partSchema } = await import("../types");
  const record = familyRecord({
    pinTablesByPackage: [
      { packageType: "SSOP-20", pins: pins(20) },
      { packageType: "SSOP-28", pins: pins(28) }
    ]
  });

  const parsed = partSchema.safeParse(JSON.parse(JSON.stringify(record)));
  assert.ok(parsed.success, `the record must validate: ${parsed.success ? "" : parsed.error.message}`);
  if (!parsed.success) return;
  assert.equal(parsed.data.pinTablesByPackage?.length, 2, "and both tables survive");
  assert.equal(parsed.data.pinTablesByPackage?.[1].pins.length, 28);
});

// ---------------------------------------------------------------------------
// A pinout per package is a pinout
// ---------------------------------------------------------------------------

/**
 * The deadlock this ends, measured 2026-08-16.
 *
 * A family datasheet whose part number does not name a package gets `pins` null,
 * correctly: the model is told not to pick among several pinouts because
 * guessing one becomes a footprint. It returns them all, labelled.
 *
 * `resolveForExport` then refused the record for having no pins, `packageOptions`
 * returned `ok: false`, and the user was told the reading was missing pins for a
 * document whose pinouts were on the record. TWELVE of the fifty-one hold-out
 * parts with a reading were in exactly that state; only four genuinely had no
 * pinout at all.
 */
test("a record with no single pinout still offers a chooser, one option per package", () => {
  const record = familyRecord({
    pinCount: unknown<number>(),
    pins: unknown<PinRecord[]>(),
    pinTablesByPackage: [
      { packageType: "SSOP-20", pins: pins(20), citation: { page: 4, snippet: "20-row pin table", region: null } },
      { packageType: "SSOP-28", pins: pins(28), citation: { page: 5, snippet: "28-row pin table", region: null } }
    ]
  });

  const choice = packageOptions(record);
  assert.equal(choice.ok, true, "the chooser is offered rather than the record refused");
  if (!choice.ok) return;
  assert.equal(choice.options.length, 2);
  assert.ok(
    choice.options.every((option) => option.status !== "unsupported"),
    "and each package is usable, because its own pinout is on the record"
  );
});

test("an unlocated table is not evidence and does not unblock anything", () => {
  // A table that matched no page in the document keeps a null citation.
  // `resolveForExport` refuses it exactly as it refuses any uncited value, which
  // is what stops this from being a way to smuggle an unverifiable pinout into a
  // footprint.
  const record = familyRecord({
    pinCount: unknown<number>(),
    pins: unknown<PinRecord[]>(),
    pinTablesByPackage: [
      { packageType: "SSOP-20", pins: pins(20), citation: null },
      { packageType: "SSOP-28", pins: pins(28), citation: null }
    ]
  });

  const choice = packageOptions(record);
  assert.equal(choice.ok, true);
  if (!choice.ok) return;
  assert.ok(
    choice.options.every((option) => option.status === "unsupported"),
    "an uncited pin table cannot build a footprint"
  );
});

test("a designator is matched to its table through the document's own punctuation", () => {
  // Both sides render the SAME printed designator and differ only in how they
  // punctuate it: a TCA9548A's variants read `VQFN (RGE)` where its tables read
  // `VQFNRGE`. Matching on the lead count alone found two of twelve parts.
  const record = familyRecord({
    packageVariants: [
      { designator: "VQFN (RGE)", family: "VQFN", leadCount: null, inFrontMatter: true },
      { designator: "TSSOP (PW)", family: "TSSOP", leadCount: null, inFrontMatter: true }
    ],
    pinCount: unknown<number>(),
    pins: unknown<PinRecord[]>(),
    pinTablesByPackage: [
      { packageType: "VQFNRGE", pins: pins(24), citation: { page: 6, snippet: "t", region: null } },
      { packageType: "TSSOPPW", pins: pins(24), citation: { page: 7, snippet: "t", region: null } }
    ]
  });

  const choice = packageOptions(record);
  assert.equal(choice.ok, true);
  if (!choice.ok) return;
  assert.ok(
    choice.options.every((option) => option.status !== "unsupported"),
    "neither designator declares a lead count, and both still find their table"
  );
});

// ---------------------------------------------------------------------------
// The same defect in the case the lead-count guard above CANNOT reach.
//
// That guard compares a declared lead count against the pin table, so it is
// blind whenever the two packages have the SAME number of leads. Measured
// 2026-08-17 on the real MAX232 datasheet: asked for `SOIC (D)`, the reader
// returned outline drawing DW0016A and its dimensions, because the document
// prints outlines for NS0016A and DW0016A and none at all for the narrow D.
// Both are 16 lead, nothing fired, and it shipped a 9.3 mm land span where a
// narrow SOIC-16 is nearer 6 mm. Ordinary-looking copper that no board accepts.
// ---------------------------------------------------------------------------

/** The 20-pin fixture, relabelled with an outline code from another package. */
function drawnAs(outlineCode: string, packageName = "SSOP-20 (DW)"): PartRecord {
  return familyRecord({
    packageType: cited(packageName),
    packageOutlineCode: cited(outlineCode)
  });
}

test("dimensions read off another package's outline drawing do not build a footprint", async () => {
  await assert.rejects(
    () => padNumbers(drawnAs("D0020A", "SSOP-20 (DW)"), "SSOP-20 (DW)"),
    (error: unknown) => {
      assert.ok(error instanceof FootprintUnavailableError, `unexpected: ${error}`);
      // Terminal. No number the user types makes one drawing describe another
      // package, so this must not present as an answerable question.
      assert.equal(error.needs.length, 0);
      assert.match(error.reason, /D0020A/, "the refusal names the drawing that was measured");
      assert.match(error.reason, /DW/, "and the package that was asked for");
      return true;
    }
  );
});

test("an outline code that agrees with the package name builds normally", async () => {
  // The control, and the one that matters most: five of the six multi-package
  // parts measured on 2026-08-17 agree, and a guard that refused them too would
  // cost more than the defect it prevents.
  const numbers = await padNumbers(drawnAs("DW0020A", "SSOP-20 (DW)"), "SSOP-20 (DW)");
  assert.equal(numbers.length, 20);
});

test("a package name or outline code that carries no designator is not judged", async () => {
  // The guard may only fire where it can PROVE a disagreement. A JEDEC
  // registration (`MS-012`) is not a vendor outline code, and a bare family name
  // states no package code, so neither can settle which drawing was measured.
  const noCode = await padNumbers(drawnAs("MS-013", "SSOP-20 (DW)"), "SSOP-20 (DW)");
  assert.equal(noCode.length, 20, "a JEDEC number is not read as a package designator");

  const noToken = await padNumbers(drawnAs("D0020A", "SSOP-20"), "SSOP-20");
  assert.equal(noToken.length, 20, "a name stating only a family is not judged against a code");
});
