import { test } from "node:test";
import assert from "node:assert/strict";
import { geometryViolations, validateGeometry, FootprintInvalidError } from "../confidence";
import type { FootprintGeometry, Pad } from "../geometry";
import type { PinRecord, ResolvedPart } from "../types";

/**
 * Every invariant here has to be able to FAIL, on a footprint this generator
 * could really produce. That is the same bar `confidence.test.ts` sets, and it
 * matters more here: these are a GATE, so one that cannot fire is a gate that is
 * always open while looking shut.
 *
 * The footprints below are built by hand rather than generated, deliberately.
 * The point is to drive each violation, and a generator working correctly will
 * not produce any of them.
 */

function pins(count: number): PinRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    number: String(index + 1),
    name: `P${index + 1}`,
    electricalType: "passive" as const
  }));
}

function part(count = 4, over: Partial<ResolvedPart> = {}): ResolvedPart {
  return {
    id: "g",
    partNumber: "ACME",
    manufacturer: "ACME",
    packageType: "SOIC-4",
    packageOutlineCode: null,
    jedecOutline: null,
    vendorLandPattern: null,
    exposedPad: false,
    pinCount: count,
    pins: pins(count),
    dimensions: {} as ResolvedPart["dimensions"],
    radiation: { tid: null, see: null, sel: null, qmlClass: null },
    sourceFileName: "g.pdf",
    notes: [],
    ...over
  } as ResolvedPart;
}

function land(number: string, xMm: number, yMm: number, over: Partial<Pad> = {}): Pad {
  return {
    number,
    centre: { xMm, yMm },
    widthMm: 1,
    heightMm: 0.5,
    shape: "roundrect",
    mounting: "smd",
    ...over
  } as Pad;
}

/** Four lands in two rows, well clear of each other and inside the courtyard. */
function sound(over: Partial<FootprintGeometry> = {}): FootprintGeometry {
  return {
    name: "acme-soic-4",
    description: "fixture",
    partNumber: "ACME",
    pads: [land("1", -2, -1), land("2", -2, 1), land("3", 2, 1), land("4", 2, -1)],
    body: { halfWidthMm: 1.5, halfHeightMm: 2 },
    courtyard: { halfWidthMm: 3, halfHeightMm: 2.5 },
    pin1Marker: { xMm: -2.6, yMm: -1 },
    thermalVias: [],
    provenance: {} as FootprintGeometry["provenance"],
    ...over
  };
}

test("a sound footprint reports nothing, so the failures below mean something", () => {
  assert.deepEqual(geometryViolations(sound(), part()), []);
});

test("a land for a pin the part does not have is caught", () => {
  const geometry = sound({ pads: [...sound().pads, land("9", 0, 0)] });
  assert.match(geometryViolations(geometry, part()).join("\n"), /land "9" belongs to no pin/);
});

test("a pin with no land is caught, which is a connection that silently does not exist", () => {
  const geometry = sound({ pads: sound().pads.slice(0, 3) });
  assert.match(geometryViolations(geometry, part()).join("\n"), /pin 4 has 0 lands/);
});

test("two lands that overlap are caught, because that is a short", () => {
  // The property a wrong pitch, a wrong span and a wrong side-count all produce.
  const geometry = sound({ pads: [land("1", 0, 0), land("2", 0.2, 0), land("3", 2, 1), land("4", 2, -1)] });
  assert.match(geometryViolations(geometry, part()).join("\n"), /lands 1 and 2 overlap/);
});

test("a courtyard that does not contain its own lands is caught", () => {
  // Worse than no courtyard: the board designer trusts it as the keep-out and
  // places the neighbouring part on top of a pad.
  const geometry = sound({ courtyard: { halfWidthMm: 1, halfHeightMm: 1 } });
  assert.match(geometryViolations(geometry, part()).join("\n"), /reaches outside the courtyard/);
});

test("paste that reaches past its own copper is caught", () => {
  const geometry = sound({
    pads: [
      land("1", -2, -1, { pasteApertures: [{ centre: { xMm: 0.9, yMm: 0 }, widthMm: 0.8, heightMm: 0.3 }] }),
      land("2", -2, 1),
      land("3", 2, 1),
      land("4", 2, -1)
    ]
  });
  assert.match(geometryViolations(geometry, part()).join("\n"), /paste aperture on land 1 reaches past/);
});

test("a plated hole carrying paste is caught", () => {
  const geometry = sound({
    pads: [
      land("1", -2, -1, {
        mounting: "through-hole",
        drillMm: 0.8,
        pasteApertures: [{ centre: { xMm: 0, yMm: 0 }, widthMm: 0.2, heightMm: 0.2 }]
      }),
      land("2", -2, 1),
      land("3", 2, 1),
      land("4", 2, -1)
    ]
  });
  assert.match(geometryViolations(geometry, part()).join("\n"), /plated hole 1 carries paste/);
});

test("a pin-1 marker nearer another land is caught, because a rotated part is a wrong part", () => {
  const geometry = sound({ pin1Marker: { xMm: 2.6, yMm: 1 } });
  assert.match(geometryViolations(geometry, part()).join("\n"), /pin-1 marker sits closer to another land/);
});

test("a hole with no drill size is caught", () => {
  const geometry = sound({
    pads: [land("1", -2, -1, { mounting: "through-hole" }), land("2", -2, 1), land("3", 2, 1), land("4", 2, -1)]
  });
  assert.match(geometryViolations(geometry, part()).join("\n"), /plated hole 1 has no drill size/);
});

test("a non-finite dimension is caught, because KiCad will not open the file", () => {
  const geometry = sound({ pads: [land("1", Number.NaN, -1), land("2", -2, 1), land("3", 2, 1), land("4", 2, -1)] });
  assert.match(geometryViolations(geometry, part()).join("\n"), /non-finite x/);
});

test("validateGeometry throws, and names every violation rather than the first", () => {
  const geometry = sound({ pads: [land("1", 0, 0), land("2", 0.2, 0)] });
  assert.throws(
    () => validateGeometry(geometry, part()),
    (error: unknown) => {
      assert.ok(error instanceof FootprintInvalidError);
      assert.ok(error.violations.length > 1, "a reviewer gets the whole list, not the first line");
      assert.match(
        error.message,
        /misread or this is a defect in Forge/,
        "and it does not assert which of the two, because the geometry cannot tell"
      );
      return true;
    }
  );
});

test("a pin the table lists but the footprint never places is caught", () => {
  // The third door onto one defect. `mergeModelValues` guards the model path and
  // `partSchema` guards the export route, and both guard the INPUT, so each new
  // way of producing a record needs its own. The record panel lets a pin number
  // be edited inline, which is a third way.
  //
  // Measured with pin 8 renamed to 9 on a real 8-pin part: the footprint came
  // out with pads 1..8, the symbol with seven pins, and every check passed. The
  // pads satisfy the count exactly, so the one-land-per-pin check could not see
  // it; pin 9 does not exist on the board and pad 8 connects to nothing.
  //
  // Checked on the OUTPUT, where there is only one door: whatever produced the
  // record, the footprint and the symbol have to describe the same set of pins.
  // A four-pin part whose table says 1, 2, 3, 5. The pads are 1..4, exactly
  // what `pinCount` asks for, so every other check is satisfied.
  const record = part(4, {
    pins: [1, 2, 3, 5].map((number) => ({
      number: String(number),
      name: `P${number}`,
      electricalType: "passive" as const
    }))
  });

  const violations = geometryViolations(sound(), record);
  assert.ok(
    violations.some((violation) => /pin 5/.test(violation)),
    `the missing pin must be named; got ${JSON.stringify(violations)}`
  );
});

test("every dimension on the record survives the export gate", async () => {
  // `resolveForExport` projects Extracted<T> to T by hand, one line per
  // dimension. A field added to `packageDimensionsSchema` and forgotten here is
  // read from the datasheet, stored on the record, and then silently dropped on
  // the way to the generator, which is the exact shape this codebase keeps
  // repeating: the answer was collected and never consumed.
  //
  // Compares the schema's own key list against what the gate emits, so the list
  // cannot fall behind whatever is added next.
  const { packageDimensionsSchema, partSchema, resolveForExport } = await import("../types");
  const { datasheetTextFromPages } = await import("../pdftext");
  const { buildPartRecord } = await import("../datasheet");

  const doc = datasheetTextFromPages(["ACME555. ACME Semiconductor. 8-pin SOIC."]);
  const record = buildPartRecord(doc, "ACME555.pdf");

  // Enough to pass the gate: a part number, a pin count and a pin table.
  record.partNumber = { value: "ACME555", confidence: 1, method: "deterministic", citation: null };
  record.pinCount = { value: 1, confidence: 1, method: "deterministic", citation: null };
  record.pins = {
    value: [{ number: "1", name: "OUT", electricalType: "output" }],
    confidence: 1,
    method: "deterministic",
    citation: null
  };

  const resolved = resolveForExport(partSchema.parse(record), { requireTraceableGeometry: false });
  assert.equal(resolved.ok, true, "the fixture must pass the gate for this test to mean anything");
  if (!resolved.ok) return;

  const declared = Object.keys(packageDimensionsSchema.shape).sort();
  const carried = Object.keys(resolved.part.dimensions).sort();
  assert.deepEqual(
    carried,
    declared,
    "a dimension on the record is missing from resolveForExport and would never reach the generator"
  );
});

test("a quad whose lands cannot fit its span is refused by NAMING the span", async () => {
  // Two corpus parts tripped the output invariant with "lands 1 and 24 overlap,
  // which shorts them together". True, and the symptom rather than the cause.
  //
  // Derived, not tuned: a side's lands occupy (n-1) * pitch, each reaches half a
  // land width further along, and the perpendicular row's inner edge sits at
  // centreSpan/2 - padLength/2, so the corners collide exactly when
  //
  //     (n-1) * pitch + padWidth + padLength > centreSpan
  //
  // The placement arithmetic is correct. The span is what is wrong, and the
  // pitch and pin count corroborate each other while it does not, so the refusal
  // should say which number to check.
  const { createExportZip } = await import("../exporters");
  const { FootprintInvalidError } = await import("../confidence");

  const quad = (landSpanMm: number) =>
    ({
      id: "t",
      partNumber: "QUADTEST",
      manufacturer: "ACME",
      packageType: "VQFN (24)",
      packageOutlineCode: null,
      jedecOutline: null,
      vendorLandPattern: null,
      pinCount: 24,
      pins: Array.from({ length: 24 }, (_, i) => ({
        number: String(i + 1),
        name: `P${i + 1}`,
        electricalType: "bidirectional" as const
      })),
      exposedPad: false,
      dimensions: {
        bodyLengthMm: 5, bodyWidthMm: 5, bodyHeightMm: 1, pitchMm: 0.5, leadLengthMm: null,
        leadCount: 24, leadWidthMm: null, leadSpanMm: null, leadContactMm: null,
        thermalPadLengthMm: null, thermalPadWidthMm: null,
        landPadLengthMm: 0.9, landPadWidthMm: 0.28, landSpanMm,
        leadSides: 4, leadForm: "nolead", mounting: "smd", leadDiameterMm: null,
        vacantLeadSlot: null, leadsPerSide: null, solderMaskExpansionMm: null,
        solderMaskDefined: null, thermalViaDiameterMm: null, thermalViaPitchMm: null
      },
      radiation: { tid: null, see: null, sel: null, qmlClass: null },
      sourceFileName: "t.pdf",
      notes: []
    }) as never;

  // 6 a side at 0.5 mm needs 2.50 + 0.28 + 0.90 = 3.68 mm of span.
  const built = await createExportZip(quad(5.0), "kicad", {});
  assert.ok(built.buffer.byteLength > 0, "a span that fits still builds");

  await assert.rejects(
    () => createExportZip(quad(3.4), "kicad", {}),
    (error: unknown) => {
      assert.ok(error instanceof FootprintInvalidError);
      assert.match(error.message, /3\.68 mm of centre span/, "states what the geometry needs");
      assert.match(error.message, /3\.40 mm/, "and what was read");
      assert.match(error.message, /centre span is the value to check first/, "and which number to fix");
      return true;
    }
  );
});

test("an UNEQUAL quad is not refused just because its long side is long", async () => {
  // The case that caught the first version of the corner check. A 12,7,12,7
  // part has corners where a twelve-land side meets a seven-land side, and they
  // are clear precisely because the short side is short.
  //
  // Overlap needs the two lands to intersect on BOTH axes and each axis is
  // bounded by a different side, so the SHORTER of each adjacent pair binds.
  // Using the longest side for both refused a legitimate footprint.
  const { createExportZip } = await import("../exporters");

  const unequal = {
    id: "t", partNumber: "UNEQUAL38", manufacturer: "ACME", packageType: "VQFN (38)",
    packageOutlineCode: null, jedecOutline: null, vendorLandPattern: null,
    pinCount: 38,
    pins: Array.from({ length: 38 }, (_, i) => ({
      number: String(i + 1), name: `P${i + 1}`, electricalType: "bidirectional" as const
    })),
    exposedPad: false,
    dimensions: {
      bodyLengthMm: 6, bodyWidthMm: 4, bodyHeightMm: 1, pitchMm: 0.4, leadLengthMm: null,
      leadCount: 38, leadWidthMm: null, leadSpanMm: null, leadContactMm: null,
      thermalPadLengthMm: null, thermalPadWidthMm: null,
      landPadLengthMm: 0.8, landPadWidthMm: 0.2, landSpanMm: 4,
      leadSides: 4, leadForm: "nolead", mounting: "smd", leadDiameterMm: null,
      vacantLeadSlot: null, leadsPerSide: "12,7,12,7", solderMaskExpansionMm: null,
      solderMaskDefined: null, thermalViaDiameterMm: null, thermalViaPitchMm: null
    },
    radiation: { tid: null, see: null, sel: null, qmlClass: null },
    sourceFileName: "t.pdf", notes: []
  } as never;

  const bundle = await createExportZip(unequal, "kicad", {});
  assert.ok(bundle.buffer.byteLength > 0, "the short side keeps the corners clear");
});

test("a single-row through-hole package builds one line of pins", async () => {
  // TO-220, TO-92 and SIP were permanently unbuildable until 2026-08-17, and not
  // because they were hard to read. `leadSides` was typed `2 | 4`, so a single
  // line of pins could not be REPRESENTED: the schema rejected a 1 and the
  // prompt told the model to answer null. Null was then the exact state that
  // once fell through to two rows and shipped a 3-lead regulator as two columns
  // 5 mm apart.
  //
  // Same shape as the `leadForm` gap and the flat pack's missing foot: the
  // product could not express the true answer, so it never got one.
  const { createExportZip } = await import("../exporters");
  const JSZip = (await import("jszip")).default;

  const to220 = {
    id: "t", partNumber: "L7805", manufacturer: "ST", packageType: "TO-220 (3)",
    packageOutlineCode: null, jedecOutline: null, vendorLandPattern: null, pinCount: 3,
    pins: [
      { number: "1", name: "IN", electricalType: "power_in" as const },
      { number: "2", name: "GND", electricalType: "power_in" as const },
      { number: "3", name: "OUT", electricalType: "power_out" as const }
    ],
    exposedPad: false,
    dimensions: {
      bodyLengthMm: 10, bodyWidthMm: 4.6, bodyHeightMm: 15, pitchMm: 2.54, leadLengthMm: null,
      leadCount: 3, leadWidthMm: null, leadSpanMm: null, leadContactMm: null,
      thermalPadLengthMm: null, thermalPadWidthMm: null,
      landPadLengthMm: null, landPadWidthMm: null, landSpanMm: null,
      leadSides: 1, leadForm: "straight", mounting: "through-hole", leadDiameterMm: 0.9,
      vacantLeadSlot: null, leadsPerSide: null, solderMaskExpansionMm: null,
      solderMaskDefined: null, thermalViaDiameterMm: null, thermalViaPitchMm: null
    },
    radiation: { tid: null, see: null, sel: null, qmlClass: null },
    sourceFileName: "l7805.pdf", notes: []
  } as never;

  const bundle = await createExportZip(to220, "kicad", {});
  const zip = await JSZip.loadAsync(bundle.buffer);
  const mod = await zip.files[Object.keys(zip.files).find((f) => f.endsWith(".kicad_mod"))!].async("string");

  const pads = [...mod.matchAll(/\(pad "(\d)" thru_hole \w+ \(at (-?[\d.]+) (-?[\d.]+)\)/g)].map((m) => ({
    pin: m[1],
    x: Number(m[2]),
    y: Number(m[3])
  }));

  assert.equal(pads.length, 3, "three pins, three holes");
  // ONE LINE. The defect this replaces put pin 3 in a second column.
  assert.deepEqual([...new Set(pads.map((p) => p.y))], [0], "every pin sits on one line");
  assert.deepEqual(
    pads.map((p) => p.x),
    [-2.54, 0, 2.54],
    "spaced at the pitch, pin 1 first, centred on the origin"
  );
});

test("a through-hole package whose row count was never read still refuses", async () => {
  // Widening the type must not turn null into a default. Null means nobody read
  // it, and that is the state the two-row bug came from.
  const { createExportZip } = await import("../exporters");
  const { FootprintUnavailableError } = await import("../exporters");

  const unread = {
    id: "t", partNumber: "MYSTERY", manufacturer: "ACME", packageType: "TO-something",
    packageOutlineCode: null, jedecOutline: null, vendorLandPattern: null, pinCount: 3,
    pins: [
      { number: "1", name: "A", electricalType: "passive" as const },
      { number: "2", name: "B", electricalType: "passive" as const },
      { number: "3", name: "C", electricalType: "passive" as const }
    ],
    exposedPad: false,
    dimensions: {
      bodyLengthMm: 10, bodyWidthMm: 4.6, bodyHeightMm: 15, pitchMm: 2.54, leadLengthMm: null,
      leadCount: 3, leadWidthMm: null, leadSpanMm: null, leadContactMm: null,
      thermalPadLengthMm: null, thermalPadWidthMm: null,
      landPadLengthMm: null, landPadWidthMm: null, landSpanMm: null,
      leadSides: null, leadForm: "straight", mounting: "through-hole", leadDiameterMm: 0.9,
      vacantLeadSlot: null, leadsPerSide: null, solderMaskExpansionMm: null,
      solderMaskDefined: null, thermalViaDiameterMm: null, thermalViaPitchMm: null
    },
    radiation: { tid: null, see: null, sel: null, qmlClass: null },
    sourceFileName: "m.pdf", notes: []
  } as never;

  await assert.rejects(
    () => createExportZip(unread, "kicad", {}),
    (error: unknown) => {
      assert.ok(error instanceof FootprintUnavailableError);
      assert.deepEqual(error.needs.map((n) => n.field), ["leadSides"]);
      return true;
    }
  );
});

test("every field the generator builds copper from is reviewable", async () => {
  // `mounting` and `leadDiameterMm` were absent from the review panel until
  // 2026-08-17, so a wrong reading on either was invisible to the person
  // signing the record. One decides holes versus lands; the other is the sole
  // input to the hole size.
  //
  // Checked as a SET rather than for those two fields, so the next
  // copper-placing field cannot be added and quietly left unreviewable.
  const { REVIEWABLE_FIELDS } = await import("../review");

  const placesCopper = [
    "pins",
    "pinCount",
    "packageType",
    "dimensions.pitchMm",
    "dimensions.leadSpanMm",
    "dimensions.leadWidthMm",
    "dimensions.leadContactMm",
    "dimensions.leadSides",
    "dimensions.leadForm",
    "dimensions.mounting",
    "dimensions.leadDiameterMm",
    "dimensions.landPadLengthMm",
    "dimensions.landPadWidthMm",
    "dimensions.landSpanMm",
    "dimensions.thermalPadLengthMm",
    "dimensions.thermalPadWidthMm"
  ];

  for (const field of placesCopper) {
    assert.ok(
      REVIEWABLE_FIELDS.includes(field),
      `${field} places copper and is never shown to a reviewer`
    );
  }
});
