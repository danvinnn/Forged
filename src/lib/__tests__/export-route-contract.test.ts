import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../app/api/export/route";
import { extractedValue, resolveForExport, unknown, type PartRecord, type PinRecord } from "../types";

/**
 * The shape `/api/export` answers a refusal with, which the UI reads directly.
 *
 * The route makes a distinction the exporter hands it and the user depends on:
 * a refusal they can ANSWER carries `code: INPUT_REQUIRED` and a populated
 * `needs`, and a refusal they cannot carries `PACKAGE_NOT_CHARACTERISED` and an
 * empty one. The UI prompts on the first and only reports the second, so if the
 * two ever collapse into one the user is either asked for something no answer
 * exists for, or not asked for something one number away.
 *
 * `exporters-geometry.test.ts` already proves the exporter raises the right
 * distinction. This proves the route still carries it across the wire, which is
 * the half the UI actually sees.
 */

function citedValue<T>(value: T) {
  return extractedValue(value, 0.95, { page: 1, snippet: "fixture", region: null });
}

function pins(count: number): PinRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    number: String(index + 1),
    name: `P${index + 1}`,
    electricalType: "passive" as const
  }));
}

/** A record complete enough to reach the footprint step, in the given package. */
/**
 * A record complete enough to reach the footprint step.
 *
 * `leadForm` is a parameter because it is what decides which of the two
 * datasheet-derived paths applies, and one of the cases below is a flat pack.
 * It used to be inferred from the letters "CFP" in the designator by a family
 * table; the drawing shows it, so the drawing is where it comes from.
 */
function exportablePart(
  packageType: string,
  pinCount: number,
  leadForm: "gullwing" | "straight" = "gullwing"
): PartRecord {
  return {
    id: "fixture",
    partNumber: citedValue("ACME1234"),
    manufacturer: citedValue("ACME"),
    packageType: citedValue(packageType),
    packageOutlineCode: unknown<string>(),
    jedecOutline: unknown<string>(),
    packageVariants: [],
  vendorLandPattern: null,
  exposedPad: false,
    pinCount: citedValue(pinCount),
    pins: citedValue(pins(pinCount)),
    dimensions: {
      bodyLengthMm: citedValue(8.65),
      bodyWidthMm: citedValue(3.9),
      bodyHeightMm: citedValue(1.5),
      pitchMm: citedValue(1.27),
      leadLengthMm: citedValue(0.8),
      leadCount: citedValue(pinCount),
      leadWidthMm: citedValue({ minMm: 0.35, maxMm: 0.5 }),
      leadSpanMm: citedValue({ minMm: 5.8, maxMm: 6.2 }), leadContactMm: citedValue({ minMm: 0.4, maxMm: 0.625 }),
      thermalPadLengthMm: unknown<number>(),
      thermalPadWidthMm: unknown<number>(),
      landPadLengthMm: unknown<number>(),
      landPadWidthMm: unknown<number>(),
      landSpanMm: unknown<number>(),
      leadSides: citedValue<2 | 4>(2),
      leadForm: citedValue<"gullwing" | "nolead" | "straight">(leadForm),
      mounting: unknown<"smd" | "through-hole">(),
      leadDiameterMm: unknown<number>(),
      vacantLeadSlot: unknown<number>(),
      leadsPerSide: unknown<string>(),
      solderMaskExpansionMm: unknown<number>(),
      solderMaskDefined: unknown<"solder-mask-defined" | "non-solder-mask-defined">(),
      thermalViaDiameterMm: unknown<number>(),
      thermalViaPitchMm: unknown<number>()
    },
    radiation: {
      tid: unknown<string>(),
      see: unknown<string>(),
      sel: unknown<string>(),
      qmlClass: unknown<string>()
    },
    sourceFileName: "fixture.pdf",
    notes: []
  };
}

/**
 * `from` is the caller's address, and it varies per request on purpose.
 *
 * The route rate-limits per client, so a test that walks a field list from one
 * address hits the limiter partway through and reports a 429 as if it were the
 * route's answer about the field. Distinct addresses keep each assertion about
 * the thing it is asserting.
 */
let caller = 0;
function post(body: unknown): Request {
  caller += 1;
  return new Request("http://localhost/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": `10.0.0.${caller % 251}` },
    body: JSON.stringify(body)
  });
}

test("a refusal the user can answer arrives as INPUT_REQUIRED with the field named", async () => {
  const response = await POST(post({ part: exportablePart("14-lead CFP", 14, "straight"), format: "kicad" }));
  const payload = await response.json();

  assert.equal(response.status, 422);
  assert.equal(payload.code, "INPUT_REQUIRED");
  assert.ok(Array.isArray(payload.needs) && payload.needs.length > 0, "the UI prompts off this array");
  assert.equal(payload.needs[0].field, "formedLeadSpanMm");
  assert.equal(payload.needs[0].unit, "mm");
  assert.equal(payload.needs[0].scope, "install", "asked once per assembler, not once per part");
  assert.ok(payload.needs[0].label, "the prompt needs a label");
  assert.ok(payload.needs[0].why, "and a reason no datasheet carries it");
});

test("supplying the value over the wire produces the bundle", async () => {
  const response = await POST(
    post({ part: exportablePart("14-lead CFP", 14, "straight"), format: "kicad", formedLeadSpanMm: 10.16 })
  );

  assert.equal(response.status, 200, "the same request that 422'd now succeeds");
  assert.equal(response.headers.get("Content-Type"), "application/zip");
  const bytes = await response.arrayBuffer();
  assert.ok(bytes.byteLength > 0);
});

test("a package with nothing read for it asks for the land pattern instead of dead-ending", async () => {
  // Inverted deliberately on 2026-08-13. This asserted an EMPTY needs array, on
  // the reasoning that a missing land pattern was our gap rather than the user's
  // input. Measurement changed the reasoning: every shipping part was being fed
  // by a hand-typed family table, and closing the gap that way means inventing
  // numbers about parts. Asking is the only honest option left.
  //
  // Rewritten again on 2026-08-14, when that table was deleted. It used to name a
  // package the table had never heard of; there is no table to have heard of
  // anything now, so the case is stated as what it always really was: a record
  // with no land pattern and no package drawing read.
  const blank = exportablePart("12-Pin BGA", 12);
  blank.dimensions.leadSpanMm = unknown();
  blank.dimensions.leadContactMm = unknown();
  blank.dimensions.leadWidthMm = unknown();

  const response = await POST(post({ part: blank, format: "kicad" }));
  const payload = await response.json();

  assert.equal(response.status, 422);
  // INPUT_REQUIRED, not PACKAGE_NOT_CHARACTERISED: the route already told those
  // two apart by whether `needs` was populated, so making the refusal answerable
  // moved it into the answerable bucket on its own.
  assert.equal(payload.code, "INPUT_REQUIRED");
  assert.ok(payload.needs.length > 0, "the UI has something to prompt for");
});

test("a land pattern the user supplies is validated before it becomes copper", async () => {
  // As strictly as formedLeadSpanMm, and for the same reason: these are emitted
  // as pads. A units mistake would be built faithfully.
  for (const bad of [0, -1, 500, "1.1"]) {
    const response = await POST(
      post({ part: exportablePart("12-Pin BGA", 12), format: "kicad", landPadLengthMm: bad })
    );
    assert.equal(response.status, 400, `landPadLengthMm ${JSON.stringify(bad)} must be rejected`);
  }
  for (const bad of [1, 3, 8, "2"]) {
    const response = await POST(
      post({ part: exportablePart("12-Pin BGA", 12), format: "kicad", leadSides: bad })
    );
    assert.equal(response.status, 400, `leadSides ${JSON.stringify(bad)} must be rejected`);
  }
});

test("a nonsense lead span is refused before it reaches the generator", async () => {
  for (const span of [0, -1, 500, "10.16"]) {
    const response = await POST(
      post({ part: exportablePart("14-lead CFP", 14, "straight"), format: "kicad", formedLeadSpanMm: span })
    );
    assert.equal(response.status, 400, `formedLeadSpanMm ${JSON.stringify(span)} must be rejected`);
  }
});

// ---------------------------------------------------------------------------
// Every question the generator can ask has an answer this route accepts
// ---------------------------------------------------------------------------

/**
 * The invariant: asking for a value the route rejects is worse than refusing.
 *
 * `leadsPerSide` and `vacantLeadSlot` were both in `RequiredInput["field"]` and
 * both absent from the route's accept-list, so a quad with unequal sides and a
 * five-lead SOT-23 each refused, named the value that would fix it, and then
 * dropped that value on the floor when it arrived. The user had no move.
 *
 * This walks the whole field union rather than the two that were broken, so the
 * next field added to an ask has to be plumbed before it can pass.
 */
const ASKABLE: Array<{ field: string; good: unknown; bad: unknown }> = [
  { field: "bodyLengthMm", good: 4.9, bad: 0 },
  { field: "bodyWidthMm", good: 3.9, bad: -1 },
  { field: "bodyHeightMm", good: 1.75, bad: 500 },
  { field: "leadDiameterMm", good: 0.5, bad: 0 },
  { field: "pitchMm", good: 2.54, bad: -2 },
  { field: "formedLeadSpanMm", good: 10.16, bad: -1 },
  { field: "landPadLengthMm", good: 1.5, bad: 0 },
  { field: "landPadWidthMm", good: 0.6, bad: 500 },
  { field: "landSpanMm", good: 5.4, bad: "1.2" },
  { field: "leadSides", good: 2, bad: 3 },
  { field: "leadsPerSide", good: "6,6,6,5", bad: "6,6,6" },
  { field: "thermalPadLengthMm", good: 2.1, bad: 0 },
  { field: "thermalPadWidthMm", good: 2.1, bad: -2 },
  { field: "vacantLeadSlot", good: 2, bad: 0 }
];

/**
 * Every field the exporter ACTUALLY asks for, collected by asking it.
 *
 * The hand-written list below says what a good answer looks like for each field.
 * This says which fields exist, and it is gathered by driving the real generator
 * over records that are incomplete in different ways rather than by someone
 * remembering to add a line.
 *
 * That distinction is not theoretical. The through-hole path was written on
 * 2026-08-15 asking for a lead diameter under `landPadWidthMm` and a pitch under
 * `landPadLengthMm`. Both are real accepted fields, so the hand-written list
 * passed while the questions were unanswerable: supplying either filled a land
 * dimension and left the asked-for value missing, so the same question came back
 * forever. A list that is COLLECTED cannot miss that.
 */
async function askedFields(): Promise<Set<string>> {
  const { createExportZip, FootprintUnavailableError } = await import("../exporters");
  const fields = new Set<string>();

  const strip = (part: PartRecord, drop: string[]): PartRecord => {
    const next = JSON.parse(JSON.stringify(part)) as PartRecord;
    for (const field of drop) {
      (next.dimensions as unknown as Record<string, unknown>)[field] = unknown<number>();
    }
    return next;
  };

  const cases: PartRecord[] = [
    // Surface mount with no printed footprint and no drawing.
    strip(exportablePart("8-pin SOIC", 8), ["leadSpanMm", "leadContactMm", "leadWidthMm"]),
    // Nothing at all, including the body the 3D solid is built from.
    strip(exportablePart("8-pin SOIC", 8), [
      "leadSpanMm",
      "leadContactMm",
      "leadWidthMm",
      "bodyLengthMm",
      "bodyWidthMm",
      "bodyHeightMm",
      "leadSides"
    ]),
    // Untrimmed leads: the one question no datasheet answers.
    exportablePart("14-lead CFP", 14, "straight"),
    // An exposed pad whose size was not read.
    { ...exportablePart("8-pin SOIC", 8), exposedPad: true },
    // A quad whose sides do not divide.
    (() => {
      const part = exportablePart("QFN-38", 38);
      part.dimensions.leadSides = citedValue<2 | 4>(4);
      return part;
    })(),
    // Through-hole with nothing read.
    (() => {
      const part = strip(exportablePart("DIP-8", 8), ["leadSpanMm", "leadContactMm", "leadWidthMm", "pitchMm"]);
      part.dimensions.mounting = citedValue<"smd" | "through-hole">("through-hole");
      return part;
    })()
  ];

  for (const part of cases) {
    const resolved = resolveForExport(part);
    if (!resolved.ok) continue;
    try {
      await createExportZip(resolved.part, "kicad");
    } catch (error) {
      if (error instanceof FootprintUnavailableError) {
        for (const need of error.needs) fields.add(need.field);
      }
    }
  }
  return fields;
}

test("every field the generator actually asks for is in the accept-list", async () => {
  const asked = await askedFields();
  assert.ok(asked.size >= 6, `the fixtures should provoke several questions, got ${[...asked].join(", ")}`);
  const accepted = new Set(ASKABLE.map((entry) => entry.field));
  for (const field of asked) {
    assert.ok(accepted.has(field), `the exporter asks for "${field}" and nothing below tests that the route takes it`);
  }
});

test("every field the generator can ask for is accepted by the route", async () => {
  for (const entry of ASKABLE) {
    const response = await POST(
      post({ part: exportablePart("8-pin SOIC", 8), format: "kicad", [entry.field]: entry.good })
    );
    assert.notEqual(
      response.status,
      400,
      `${entry.field} is asked for by the exporter and must be accepted here`
    );
  }
});

test("and validated, because every one of them becomes geometry", async () => {
  for (const entry of ASKABLE) {
    const response = await POST(
      post({ part: exportablePart("8-pin SOIC", 8), format: "kicad", [entry.field]: entry.bad })
    );
    assert.equal(response.status, 400, `${entry.field} accepted ${JSON.stringify(entry.bad)}`);
  }
});

test("the export note says what the lands actually are, not what they usually are", async () => {
  // This header read "generated from the IPC-7351B land pattern" on every
  // export, including the common case where the lands are the vendor's own
  // printed footprint and IPC-7351B supplied only the courtyard margin. Those
  // are different claims to anyone signing off a board.
  const printed = exportablePart("8-pin SOIC", 8);
  printed.dimensions.landPadLengthMm = citedValue(1.95);
  printed.dimensions.landPadWidthMm = citedValue(0.6);
  printed.dimensions.landSpanMm = citedValue(4.95);
  printed.dimensions.leadSides = citedValue<2 | 4>(2);

  const response = await POST(post({ part: printed, format: "kicad" }));
  assert.equal(response.status, 200);
  const note = decodeURIComponent(response.headers.get("X-Forge-Export-Note") ?? "");
  assert.match(note, /printed in this datasheet/i, `note claimed: ${note}`);
  assert.doesNotMatch(note, /generated from the IPC-7351B land pattern/);
});
