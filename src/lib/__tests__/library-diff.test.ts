import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { createExportZip } from "../exporters";
import type { PinRecord, ResolvedPart } from "../types";

/**
 * Our output against a library somebody else maintains.
 *
 * Every other test in this repo checks that the generator agrees with itself or
 * with a rule written down beside it. This one checks it against a file the
 * ecosystem actually ships: KiCad's official
 * `Package_SO.pretty/SOIC-8_3.9x4.9mm_P1.27mm.kicad_mod`, retrieved 2026-08-14.
 *
 * The numbers below are transcribed from that file. They are not derived from
 * anything here, so this test can fail for the right reason: it fails when we
 * stop matching what a real library looks like.
 *
 * ## What it deliberately does NOT assert
 *
 * The reference is a per-PACKAGE footprint (`SOIC-8_3.9x4.9mm_P1.27mm`, value
 * property equal to that name, reference designator `REF**`). Ours is per-PART,
 * because a part is what a user brings us and a datasheet is what we read. Names
 * and designators are therefore expected to differ and are not compared.
 *
 * What IS compared is everything that ends up on a board: pad positions and
 * sizes, the silkscreen, the fabrication outline, the courtyard and the layer
 * attributes.
 */

// --- transcribed from the reference file --------------------------------------

/** Eight lands of 1.95 x 0.6 mm, at x = +/-2.475 on a 1.27 mm pitch. */
const REFERENCE_PADS: Record<string, [number, number]> = {
  "1": [-2.475, -1.905],
  "2": [-2.475, -0.635],
  "3": [-2.475, 0.635],
  "4": [-2.475, 1.905],
  "5": [2.475, 1.905],
  "6": [2.475, 0.635],
  "7": [2.475, -0.635],
  "8": [2.475, -1.905]
};
const REFERENCE_PAD_SIZE: [number, number] = [1.95, 0.6];

/** Six silkscreen segments: two full edges and four corner stubs. */
const REFERENCE_SILK: Array<[number, number, number, number]> = [
  [-2.06, -2.56, 2.06, -2.56],
  [-2.06, 2.56, 2.06, 2.56],
  [-2.06, -2.56, -2.06, -2.465],
  [-2.06, 2.465, -2.06, 2.56],
  [2.06, -2.56, 2.06, -2.465],
  [2.06, 2.465, 2.06, 2.56]
];

/** The fabrication outline, with the pin-1 corner cut. */
const REFERENCE_FAB: Array<[number, number]> = [
  [-0.975, -2.45],
  [1.95, -2.45],
  [1.95, 2.45],
  [-1.95, 2.45],
  [-1.95, -1.475]
];

/** The reference courtyard's bounding box. It draws a stepped outline; we draw the box. */
const REFERENCE_COURTYARD: [number, number] = [3.7, 2.7];

// --- our record for the same part ---------------------------------------------

function pins(count: number): PinRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    number: String(index + 1),
    name: `P${index + 1}`,
    electricalType: "passive" as const
  }));
}

/**
 * An LM358 in a SOIC-8, as a datasheet states it.
 *
 * The land pattern is the one the datasheet prints, which is the primary path
 * and the one that should land on the reference exactly. The body is the JEDEC
 * MS-012 3.9 x 4.9 mm the reference names in its own filename.
 */
function soic8(): ResolvedPart {
  return {
    id: "diff",
    partNumber: "LM358",
    manufacturer: "Texas Instruments",
    packageType: "SOIC-8",
    packageOutlineCode: "D0008A",
    jedecOutline: "MS-012 AA",
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
      landPadLengthMm: REFERENCE_PAD_SIZE[0],
      landPadWidthMm: REFERENCE_PAD_SIZE[1],
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
      thermalViaPitchMm: null
    },
    radiation: { tid: null, see: null, sel: null, qmlClass: null },
    sourceFileName: "lm358.pdf",
    sourceUrl: "https://www.ti.com/lit/ds/symlink/lm358.pdf",
    notes: []
  };
}

async function bundle(): Promise<{ footprint: string; symbol: string }> {
  const zip = await JSZip.loadAsync((await createExportZip(soic8(), "kicad")).buffer);
  const names = Object.keys(zip.files);
  const footprint = names.find((name) => name.endsWith(".kicad_mod"))!;
  const symbol = names.find((name) => name.endsWith(".kicad_sym"))!;
  return {
    footprint: await zip.files[footprint].async("string"),
    symbol: await zip.files[symbol].async("string")
  };
}

const near = (actual: number, expected: number, what: string) =>
  assert.ok(
    Math.abs(actual - expected) < 0.001,
    `${what}: ours ${actual}, KiCad's ${expected}`
  );

// --- the diff ------------------------------------------------------------------

test("every pad lands where KiCad's own SOIC-8 puts it", async () => {
  const { footprint } = await bundle();
  const found = new Map<string, [number, number, number, number]>();
  for (const match of footprint.matchAll(
    /\(pad "([^"]+)" smd \w+ \(at (-?[\d.]+) (-?[\d.]+)\) \(size ([\d.]+) ([\d.]+)\)/g
  )) {
    found.set(match[1], [Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])]);
  }

  assert.equal(found.size, Object.keys(REFERENCE_PADS).length, "same number of lands");
  for (const [number, [x, y]] of Object.entries(REFERENCE_PADS)) {
    const ours = found.get(number);
    assert.ok(ours, `pad ${number} is missing`);
    near(ours[0], x, `pad ${number} x`);
    near(ours[1], y, `pad ${number} y`);
    near(ours[2], REFERENCE_PAD_SIZE[0], `pad ${number} width`);
    near(ours[3], REFERENCE_PAD_SIZE[1], `pad ${number} height`);
  }
});

test("the silkscreen is the same six segments, to the micron", async () => {
  const { footprint } = await bundle();
  const ours = [...footprint.matchAll(
    /\(fp_line \(start (-?[\d.]+) (-?[\d.]+)\) \(end (-?[\d.]+) (-?[\d.]+)\) \(layer "F\.SilkS"\)/g
  )].map((match) => [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])] as const);

  assert.equal(ours.length, REFERENCE_SILK.length, `segment count: ours ${ours.length}`);
  for (const expected of REFERENCE_SILK) {
    const match = ours.find((segment) =>
      segment.every((value, index) => Math.abs(value - expected[index]) < 0.001) ||
      // The reference writes some segments end-first; direction is not geometry.
      [segment[2], segment[3], segment[0], segment[1]].every(
        (value, index) => Math.abs(value - expected[index]) < 0.001
      )
    );
    assert.ok(match, `no segment matching ${expected.join(", ")}`);
  }
});

test("the fabrication outline has the same pin-1 chamfer", async () => {
  const { footprint } = await bundle();
  const poly = /\(fp_poly \(pts ([^)]*(?:\)[^)]*)*?)\) \(layer "F\.Fab"\)/.exec(footprint);
  assert.ok(poly, "a fabrication polygon is emitted");
  const points = [...poly[1].matchAll(/\(xy (-?[\d.]+) (-?[\d.]+)\)/g)].map(
    (match) => [Number(match[1]), Number(match[2])] as const
  );

  assert.equal(points.length, REFERENCE_FAB.length, "five points: a rectangle with one corner cut");
  REFERENCE_FAB.forEach((expected, index) => {
    near(points[index][0], expected[0], `fab point ${index} x`);
    near(points[index][1], expected[1], `fab point ${index} y`);
  });
});

test("the courtyard covers the same area", async () => {
  const { footprint } = await bundle();
  const rect = /\(fp_rect \(start (-?[\d.]+) (-?[\d.]+)\) \(end (-?[\d.]+) (-?[\d.]+)\) \(layer "F\.CrtYd"\)/.exec(footprint);
  assert.ok(rect, "a courtyard is emitted");
  near(Math.abs(Number(rect[3])), REFERENCE_COURTYARD[0], "courtyard half width");
  near(Math.abs(Number(rect[4])), REFERENCE_COURTYARD[1], "courtyard half height");
});

test("the footprint declares itself surface mount, as every reference footprint does", async () => {
  const { footprint } = await bundle();
  assert.match(footprint, /\(attr smd\)/, "without this KiCad treats it as through-hole");
  assert.match(footprint, /\(tags "/, "and it is findable in the footprint browser");
});

test("the symbol carries the properties a reference symbol carries", async () => {
  // Measured against `Amplifier_Operational/AD8021AR`, `Memory_EEPROM/24LC256`
  // and `Interface_CAN_LIN/MCP2551-I-SN`: all three carry the same seven.
  const { symbol } = await bundle();
  for (const property of ["Reference", "Value", "Footprint", "Datasheet", "Description", "ki_keywords", "ki_fp_filters"]) {
    assert.match(symbol, new RegExp(`\\(property "${property}"`), `the symbol is missing ${property}`);
  }
});

test("every symbol pin sits on the 100 mil grid", async () => {
  // KLC S4.1: "using a 100mil (2.54mm) grid, pin origin must lie on a grid node."
  // A pin half a step off cannot be wired without nudging the whole schematic,
  // and an 8-pin part came out at +/-3.81 and +/-1.27 until 2026-08-14.
  const { symbol } = await bundle();
  const anchors = [...symbol.matchAll(/\(pin \w+ line \(at (-?[\d.]+) (-?[\d.]+) \d+\)/g)];
  assert.equal(anchors.length, 8, "every pin is placed");
  for (const anchor of anchors) {
    for (const axis of [anchor[1], anchor[2]]) {
      const steps = Number(axis) / 2.54;
      assert.ok(
        Math.abs(steps - Math.round(steps)) < 1e-6,
        `pin anchor ${axis} mm is ${steps} grid steps, which is not a node`
      );
    }
  }
});

test("the symbol body encloses its pins, wherever the grid put them", async () => {
  // The other half of the grid fix. Moving the pins onto grid moves the body off
  // centre, and a body drawn about the origin regardless would leave the bottom
  // row of pins hanging outside the rectangle they attach to.
  const { symbol } = await bundle();
  const rect = /\(rectangle \(start (-?[\d.]+) (-?[\d.]+)\) \(end (-?[\d.]+) (-?[\d.]+)\)/.exec(symbol);
  assert.ok(rect, "the symbol has a body");
  const top = Math.max(Number(rect[2]), Number(rect[4]));
  const bottom = Math.min(Number(rect[2]), Number(rect[4]));

  for (const anchor of symbol.matchAll(/\(pin \w+ line \(at -?[\d.]+ (-?[\d.]+) \d+\)/g)) {
    const y = Number(anchor[1]);
    assert.ok(y < top && y > bottom, `a pin at y ${y} sits outside the body ${bottom}..${top}`);
  }
});

// ---------------------------------------------------------------------------
// Thermal paste, against the same library
// ---------------------------------------------------------------------------

/**
 * Coverage is the part that can be checked against practice. The grid is not.
 *
 * 33 exposed-pad footprints were parsed out of KiCad's official
 * `Package_DFN_QFN` library on 2026-08-14. Every one of them lands between 0.640
 * and 0.658 coverage, which is what makes 0.65 a measurement rather than a
 * choice.
 *
 * The SUBDIVISION does not survive the same test, and the attempt is recorded
 * because it nearly shipped. Six footprints were consistent with a maximum
 * aperture of 1.35 mm, which looked like a recovered constant. Solving the same
 * bound across all 33 gives "at least 2.06 and less than 0.48": no maximum
 * explains the library, because the counts are chosen per footprint by hand. A
 * constant fitted to the six would have been exactly the kind of rule `RULES.md`
 * rule 4 calls fitted to what was in front of you.
 *
 * So these assert coverage, which is sourced, and not the grid, which is ours.
 */
test("paste coverage matches the published libraries at every pad size", async () => {
  const { thermalPadLand } = await import("../ipc7351");
  for (const [length, width] of [
    [0.6, 1.2],
    [1.68, 1.68],
    [2.5, 2.5],
    [2.65, 3.65],
    [3.35, 3.35],
    [5.6, 5.6],
    [7.4, 7.4]
  ] as const) {
    const land = thermalPadLand(length, width);
    assert.ok(
      land.pasteCoverage > 0.64 && land.pasteCoverage < 0.66,
      `${length} x ${width}: coverage ${land.pasteCoverage.toFixed(3)} is outside what the reference library holds`
    );
    assert.ok(land.apertures.length >= 1, "and the paste is an array rather than one solid opening");
  }
});

test("the paste is never one solid opening over a large pad", async () => {
  // The defect this prevents is not cosmetic: a thermal land pasted 1:1 floats
  // the package on a bubble of solder, lifting the perimeter leads clean off
  // their lands. IPC-7093 is the source for both the subdivision and the band.
  const { thermalPadLand } = await import("../ipc7351");
  const land = thermalPadLand(5.6, 5.6);
  assert.ok(land.apertures.length > 1, "a 5.6 mm pad is subdivided");
  for (const aperture of land.apertures) {
    assert.ok(aperture.widthMm < 5.6, "no aperture spans the pad");
  }
});

test("the aperture bound is a setting, because no published rule fixes it", async () => {
  // See `DEFAULT_MAX_APERTURE_MM`. A customer whose stencil house works to a
  // different figure sets it, and coverage is held either way.
  const { thermalPadLand } = await import("../ipc7351");
  const coarse = thermalPadLand(5.6, 5.6, { maxApertureMm: 3.0 });
  const fine = thermalPadLand(5.6, 5.6, { maxApertureMm: 0.8 });

  assert.ok(fine.apertures.length > coarse.apertures.length, "a tighter bound subdivides further");
  for (const land of [coarse, fine]) {
    assert.ok(
      land.pasteCoverage > 0.64 && land.pasteCoverage < 0.66,
      "and the coverage, which IS sourced, does not move"
    );
  }
});

/**
 * The three line widths, transcribed from the same reference file.
 *
 * KLC F5.1/F5.2/F5.3 publish these and `SOIC-8_3.9x4.9mm_P1.27mm` uses exactly
 * them. Mutation testing on 2026-08-16 found that changing the courtyard width
 * from 0.05 to 0.2 left every test passing: this file compared WHERE the
 * courtyard is and never how it is drawn, so a footprint that fails KiCad's own
 * library checker would have shipped green.
 */
const REFERENCE_WIDTHS = { silk: 0.12, fab: 0.1, courtyard: 0.05 };

test("the drawn lines are the widths the reference uses", async () => {
  const { footprint } = await bundle();

  const widthOn = (layer: string): number[] =>
    [...footprint.matchAll(new RegExp(`\\(layer "${layer}"\\) \\(width ([\\d.]+)\\)`, "g"))].map((match) =>
      Number(match[1])
    );

  const silk = widthOn("F\\.SilkS");
  const courtyard = widthOn("F\\.CrtYd");
  const fab = widthOn("F\\.Fab");

  assert.ok(silk.length > 0, "silkscreen is drawn");
  assert.ok(courtyard.length > 0, "a courtyard is drawn");
  assert.ok(fab.length > 0, "a fabrication outline is drawn");

  for (const width of silk) near(width, REFERENCE_WIDTHS.silk, "silkscreen width");
  for (const width of courtyard) near(width, REFERENCE_WIDTHS.courtyard, "courtyard width");
  for (const width of fab) near(width, REFERENCE_WIDTHS.fab, "fabrication width");
});
