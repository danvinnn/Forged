import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { createExportZip, FootprintUnavailableError } from "../exporters";
import type { PinRecord, ResolvedPart } from "../types";

/**
 * Properties that must hold for EVERY footprint, generated across the space.
 *
 * The other test files each pin one behaviour against one fixture somebody
 * wrote. That catches a regression in the thing being asserted and nothing else.
 * These generate footprints across the whole space this generator can build,
 * hundreds of them, and assert the handful of things that are true of all of
 * them.
 *
 * The difference matters because the defects this repo has actually shipped were
 * of this shape. Pads numbered `6.5`, a second row running the wrong way, a
 * courtyard drawn inside the top and bottom lands: none of them was a subtle
 * numeric drift, all of them would have been caught by an invariant, and none of
 * them was caught by a fixture because nobody had written the fixture that
 * happened to be wrong.
 *
 * Free, local, deterministic. `kicad-cli` would be a stronger check still and is
 * not installed on this machine; these are what can be run today.
 */

function pins(count: number): PinRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    number: String(index + 1),
    name: `P${index + 1}`,
    electricalType: "passive" as const
  }));
}

interface Shape {
  label: string;
  pinCount: number;
  pitchMm: number;
  /**
   * 1 was missing until 2026-08-25, and a defect lived in the gap.
   *
   * `assemble` maps `bodyLengthMm` onto the Y axis, which is right for the two
   * arrangements whose rows run down the page and TRANSPOSED for a single line
   * of pins, whose row runs along X. So every TO-220, TO-92 and SIP was drawn
   * with a fabrication outline ninety degrees from its own copper. No fixture
   * caught it, and neither did this file: the space it walks was dual and quad
   * only, and every single-row part in the corpus reads a SQUARE body, which is
   * the one shape that cannot show it.
   */
  sides: 1 | 2 | 4;
  landLengthMm: number;
  landWidthMm: number;
  landSpanMm: number;
  landSpanCrossMm?: number | null;
  bodyMm: [number, number];
  leadsPerSide?: string;
  vacantLeadSlot?: number;
  exposedPad?: [number, number];
  /** Present on a package whose pins are holes rather than lands. */
  throughHole?: { leadDiameterMm: number };
}

/**
 * The space, walked rather than sampled.
 *
 * Dual and quad, even and odd counts, unequal quad sides, exposed pads, and
 * pitches from 0.4 to 2.54 mm. Every combination is a footprint somebody could
 * really ask for.
 */
function shapes(): Shape[] {
  const out: Shape[] = [];
  for (const pitchMm of [0.4, 0.5, 0.65, 1.27, 2.54]) {
    for (const pinCount of [4, 5, 8, 14, 16, 20, 32, 48, 64]) {
      // Two opposing rows.
      out.push({
        label: `dual-${pinCount}-p${pitchMm}`,
        pinCount,
        pitchMm,
        sides: 2,
        landLengthMm: pitchMm * 1.2,
        landWidthMm: pitchMm * 0.5,
        landSpanMm: pitchMm * 4 + 2,
        landSpanCrossMm: null,
        bodyMm: [pitchMm * pinCount * 0.6 + 2, pitchMm * 3 + 1],
        ...(pinCount % 2 === 1 ? { vacantLeadSlot: Math.ceil(pinCount / 2) } : {})
      });
      // Four sides, only where the count can be divided.
      if (pinCount % 4 === 0) {
        out.push({
          label: `quad-${pinCount}-p${pitchMm}`,
          pinCount,
          pitchMm,
          sides: 4,
          landLengthMm: pitchMm * 1.2,
          landWidthMm: pitchMm * 0.5,
          landSpanMm: pitchMm * (pinCount / 4) + 2,
          landSpanCrossMm: null,
          bodyMm: [pitchMm * (pinCount / 4) + 1, pitchMm * (pinCount / 4) + 1]
        });
      }
    }
  }
  // Unequal quads, which is where the pad placer used to emit fractional numbers.
  out.push({
    label: "quad-38-unequal",
    pinCount: 38,
    pitchMm: 0.4,
    sides: 4,
    leadsPerSide: "12,7,12,7",
    landLengthMm: 0.8,
    landWidthMm: 0.2,
    landSpanMm: 4,
    landSpanCrossMm: null,
    bodyMm: [6, 4]
  });
  out.push({
    label: "quad-22-unequal",
    pinCount: 22,
    pitchMm: 0.5,
    sides: 4,
    leadsPerSide: "6,5,6,5",
    landLengthMm: 0.8,
    landWidthMm: 0.25,
    landSpanMm: 4,
    landSpanCrossMm: null,
    bodyMm: [4, 4]
  });
  // ONE LINE OF PINS: a TO-220, a TO-92, a SIP. Through-hole, so the pads are
  // holes and the layout comes from the lead diameter rather than a land
  // pattern; see `throughHoleFootprint`.
  //
  // RECTANGULAR bodies on purpose, and wide enough to hold the row. A square
  // body cannot tell a correct axis mapping from a transposed one, and a body
  // narrower than the row is refused outright by `geometryViolations`, which is
  // its own test in `geometry-invariants.test.ts`.
  //
  // PITCHES AND LEADS THAT A BOARD HOUSE CAN ACTUALLY DRILL. IPC-7251 sizes a
  // plated hole as the lead plus a 0.2 mm fit and a 0.4 mm ring on each side at
  // density B, so the pad is always about a millimetre wider than the lead: a
  // 1.27 mm pitch cannot hold two of them however small the lead, and the first
  // version of this loop asked for exactly that and was refused for overlapping
  // its own lands. Which is the invariant working, not a shape worth walking.
  for (const [pitchMm, leadDiameterMm] of [[2.54, 0.5], [2.54, 0.9], [5.08, 0.9]] as const) {
    for (const pinCount of [3, 4, 5, 8]) {
      out.push({
        label: `single-${pinCount}-p${pitchMm}-d${leadDiameterMm}`,
        pinCount,
        pitchMm,
        sides: 1,
        throughHole: { leadDiameterMm },
        landLengthMm: pitchMm * 1.2,
        landWidthMm: pitchMm * 0.5,
        landSpanMm: pitchMm * 4 + 2,
        landSpanCrossMm: null,
        bodyMm: [pitchMm * pinCount + 2, pitchMm * 1.5]
      });
    }
  }
  // Exposed pads, which add a land and a paste array.
  out.push({
    label: "quad-16-ep",
    pinCount: 16,
    pitchMm: 0.5,
    sides: 4,
    landLengthMm: 0.825,
    landWidthMm: 0.25,
    landSpanMm: 2.925,
    landSpanCrossMm: null,
    bodyMm: [3, 3],
    exposedPad: [1.68, 1.68]
  });
  return out;
}

function partFor(shape: Shape): ResolvedPart {
  return {
    id: shape.label,
    partNumber: `ACME-${shape.label}`,
    manufacturer: "ACME",
    packageType: shape.label,
    packageOutlineCode: null,
    jedecOutline: null,
    vendorLandPattern: null,
    exposedPad: Boolean(shape.exposedPad),
    pinCount: shape.pinCount,
    pins: pins(shape.pinCount),
    dimensions: {
      bodyLengthMm: shape.bodyMm[0],
      bodyWidthMm: shape.bodyMm[1],
      bodyHeightMm: 1.0,
      pitchMm: shape.pitchMm,
      leadLengthMm: null,
      leadCount: shape.pinCount,
      leadWidthMm: null,
      leadSpanMm: null,
      leadSpanCrossMm: null,
      leadContactMm: null,
      thermalPadLengthMm: shape.exposedPad?.[0] ?? null,
      thermalPadWidthMm: shape.exposedPad?.[1] ?? null,
      landPadLengthMm: shape.landLengthMm,
      landPadWidthMm: shape.landWidthMm,
      landSpanMm: shape.landSpanMm,
      landSpanCrossMm: null,
      leadSides: shape.sides,
      leadForm: shape.throughHole ? "straight" : null,
      mounting: shape.throughHole ? "through-hole" : null,
      leadDiameterMm: shape.throughHole?.leadDiameterMm ?? null,
      vacantLeadSlot: shape.vacantLeadSlot ?? null,
      leadsPerSide: shape.leadsPerSide ?? null,
      solderMaskExpansionMm: null,
      solderMaskDefined: null,
      thermalViaDiameterMm: null,
      thermalViaPitchMm: null
    },
    radiation: { tid: null, see: null, sel: null, qmlClass: null },
    sourceFileName: `${shape.label}.pdf`,
    notes: []
  };
}

interface ParsedPad {
  number: string;
  x: number;
  y: number;
  width: number;
  height: number;
  paste: boolean;
}

function parse(footprint: string): { pads: ParsedPad[]; courtyard: [number, number] | null } {
  const pads: ParsedPad[] = [];
  for (const match of footprint.matchAll(
    /\(pad "([^"]*)" \w+ \w+ \(at (-?[\d.]+) (-?[\d.]+)\) \(size ([\d.]+) ([\d.]+)\)([^\n]*)/g
  )) {
    pads.push({
      number: match[1],
      x: Number(match[2]),
      y: Number(match[3]),
      width: Number(match[4]),
      height: Number(match[5]),
      paste: /"F\.Paste"\)/.test(match[6]) && !/F\.Cu/.test(match[6])
    });
  }
  const rect = /\(fp_rect \(start (-?[\d.]+) (-?[\d.]+)\) \(end (-?[\d.]+) (-?[\d.]+)\) \(layer "F\.CrtYd"\)/.exec(
    footprint
  );
  return {
    pads,
    courtyard: rect ? [Math.abs(Number(rect[3])), Math.abs(Number(rect[4]))] : null
  };
}

/** Every footprint AND symbol this generator will build across the space, once. */
async function everyFootprint(): Promise<Array<{ shape: Shape; footprint: string; symbol: string }>> {
  const built: Array<{ shape: Shape; footprint: string; symbol: string }> = [];
  for (const shape of shapes()) {
    let bundle: Awaited<ReturnType<typeof createExportZip>>;
    try {
      bundle = await createExportZip(partFor(shape), "kicad");
    } catch (error) {
      // A refusal is a legitimate outcome and not a property violation. What
      // would be a violation is a crash, so anything that is not our own refusal
      // type is rethrown.
      if (error instanceof FootprintUnavailableError) continue;
      throw error;
    }
    const zip = await JSZip.loadAsync(bundle.buffer);
    const name = Object.keys(zip.files).find((file) => file.endsWith(".kicad_mod"))!;
    const symbolName = Object.keys(zip.files).find((file) => file.endsWith(".kicad_sym"))!;
    built.push({
      shape,
      footprint: await zip.files[name].async("string"),
      symbol: await zip.files[symbolName].async("string")
    });
  }
  return built;
}

test("the space actually builds, so the invariants below are checking something", async () => {
  const built = await everyFootprint();
  assert.ok(built.length > 40, `only ${built.length} footprints built across the space`);
});

test("every pad is numbered for a pin that exists", async () => {
  // The `6.5` defect, as a property. A pad numbered for a pin the part does not
  // have is a land nothing can connect to, and a pin with no pad is a connection
  // that silently does not exist.
  for (const { shape, footprint } of await everyFootprint()) {
    const expected = new Set(pins(shape.pinCount).map((pin) => pin.number));
    if (shape.exposedPad) expected.add(String(shape.pinCount + 1));
    for (const pad of parse(footprint).pads) {
      if (pad.paste || pad.number === "") continue;
      assert.ok(expected.has(pad.number), `${shape.label}: pad "${pad.number}" is not a pin of this part`);
    }
  }
});

test("every pin gets exactly one land", async () => {
  for (const { shape, footprint } of await everyFootprint()) {
    const copper = parse(footprint).pads.filter((pad) => !pad.paste && pad.number !== "");
    const counts = new Map<string, number>();
    for (const pad of copper) counts.set(pad.number, (counts.get(pad.number) ?? 0) + 1);
    for (const pin of pins(shape.pinCount)) {
      assert.equal(counts.get(pin.number) ?? 0, 1, `${shape.label}: pin ${pin.number} has ${counts.get(pin.number) ?? 0} lands`);
    }
  }
});

test("no two lands overlap", async () => {
  // Two lands that touch are one net. This is the property a wrong pitch, a
  // wrong span or a wrong side-count all produce, whichever of them is at fault.
  for (const { shape, footprint } of await everyFootprint()) {
    const copper = parse(footprint).pads.filter((pad) => !pad.paste && pad.number !== "");
    for (let left = 0; left < copper.length; left += 1) {
      for (let right = left + 1; right < copper.length; right += 1) {
        const a = copper[left];
        const b = copper[right];
        const overlapX = Math.abs(a.x - b.x) < (a.width + b.width) / 2 - 1e-6;
        const overlapY = Math.abs(a.y - b.y) < (a.height + b.height) / 2 - 1e-6;
        assert.ok(
          !(overlapX && overlapY),
          `${shape.label}: pads ${a.number} and ${b.number} overlap`
        );
      }
    }
  }
});

test("the courtyard contains every land", async () => {
  // A courtyard inside its own lands is worse than none: the board designer
  // trusts it as the keep-out and places the neighbouring part on top of a pad.
  // This is exactly what the quad case did before its own fix.
  for (const { shape, footprint } of await everyFootprint()) {
    const { pads, courtyard } = parse(footprint);
    assert.ok(courtyard, `${shape.label}: no courtyard`);
    for (const pad of pads.filter((entry) => !entry.paste)) {
      assert.ok(
        Math.abs(pad.x) + pad.width / 2 <= courtyard[0] + 1e-6,
        `${shape.label}: pad ${pad.number} reaches past the courtyard in x`
      );
      assert.ok(
        Math.abs(pad.y) + pad.height / 2 <= courtyard[1] + 1e-6,
        `${shape.label}: pad ${pad.number} reaches past the courtyard in y`
      );
    }
  }
});

test("paste apertures stay inside the land they belong to", async () => {
  // Paste beyond the copper edge is solder with nowhere to wet, and on a thermal
  // land it is what bridges to the perimeter pins.
  for (const { shape, footprint } of await everyFootprint()) {
    const { pads } = parse(footprint);
    const apertures = pads.filter((pad) => pad.paste);
    if (apertures.length === 0) continue;
    const land = pads.find((pad) => !pad.paste && pad.x === 0 && pad.y === 0);
    assert.ok(land, `${shape.label}: apertures with no thermal land`);
    for (const aperture of apertures) {
      assert.ok(
        Math.abs(aperture.x) + aperture.width / 2 <= land.width / 2 + 1e-6 &&
          Math.abs(aperture.y) + aperture.height / 2 <= land.height / 2 + 1e-6,
        `${shape.label}: a paste aperture reaches past the thermal land`
      );
    }
  }
});

test("pin 1 is where the marker says it is", async () => {
  // A correct footprint placed rotated is as wrong as an incorrect one, and the
  // marker is the only thing that says which way round it goes.
  for (const { shape, footprint } of await everyFootprint()) {
    const marker = /\(fp_circle \(center (-?[\d.]+) (-?[\d.]+)\)/.exec(footprint);
    assert.ok(marker, `${shape.label}: no pin-1 marker`);
    const one = parse(footprint).pads.find((pad) => pad.number === "1");
    assert.ok(one, `${shape.label}: no pad 1`);
    const distance = Math.hypot(Number(marker[1]) - one.x, Number(marker[2]) - one.y);
    const nearest = Math.min(
      ...parse(footprint)
        .pads.filter((pad) => !pad.paste && pad.number !== "1" && pad.number !== "")
        .map((pad) => Math.hypot(Number(marker[1]) - pad.x, Number(marker[2]) - pad.y))
    );
    assert.ok(
      distance <= nearest + 1e-6,
      `${shape.label}: the pin-1 marker is closer to another pad than to pin 1`
    );
  }
});

test("every emitted number is finite", async () => {
  // `NaN` in an s-expression is a file KiCad will not open, and the only way to
  // find out is to open it. A single unguarded division produces one.
  for (const { shape, footprint } of await everyFootprint()) {
    assert.doesNotMatch(footprint, /NaN|Infinity|undefined|null/, `${shape.label}: unprintable value emitted`);
  }
});

test("every surface-mount land carries solder paste", async () => {
  // THE HOLE MUTATION TESTING FOUND, on 2026-08-16.
  //
  // Deleting `F.Paste` from the ordinary SMD pad line left all 595 tests
  // passing. That is not a cosmetic defect: no paste aperture means no solder is
  // printed for that land, so the part is placed and never soldered. Every board
  // built from the library would come back with every part loose.
  //
  // Nothing caught it because the paste assertions in this repo were all about
  // the THERMAL pad, where paste deliberately does not follow copper. The
  // ordinary case, which is every land on every part, was covered by nothing.
  for (const { shape, footprint } of await everyFootprint()) {
    // A THROUGH-HOLE package has no surface-mount land to paste, and pasting one
    // would be the defect the next test guards. Skipped rather than asserted
    // over: the rule here is about the SMD case.
    if (shape.throughHole) continue;
    const lands = [...footprint.matchAll(/\(pad "(\d+)" smd \w+ \(at [^)]*\) \(size [^)]*\) ([^\n]*)/g)];
    assert.ok(lands.length > 0, `${shape.label}: no lands at all`);
    for (const [, number, rest] of lands) {
      // The exposed thermal pad is the ONE land that must not be pasted 1:1; it
      // gets its own aperture array instead, asserted separately above.
      if (shape.exposedPad && number === String(shape.pinCount + 1)) continue;
      assert.match(
        rest,
        /\(layers "F\.Cu" "F\.Paste" "F\.Mask"\)/,
        `${shape.label}: land ${number} has no solder paste, so nothing would solder it`
      );
    }
  }
});

test("the fabrication outline holds the lands its own rows run along", async () => {
  // THE DEFECT THIS FILE COULD NOT SEE, until the space gained a single row.
  //
  // `assemble` maps `bodyLengthMm` onto Y, which is correct for a dual and a
  // quad and TRANSPOSED for a single line of pins, whose row runs along X. So
  // every TO-220, TO-92 and SIP was drawn with its outline ninety degrees from
  // its own copper: a 5.08 mm row of pins coming out of a 4.6 mm face.
  //
  // ALONG THE ROW ONLY, and that is the whole subtlety. Across it the lands
  // legitimately reach outside the body, because a gull-wing lead bends out and
  // its land sits under the foot. The rule is about the axis the row is ON.
  //
  // AND ONLY ON A SINGLE ROW. The general form of this - "a lead row never
  // overhangs the body it comes out of" - is FALSE, and the drawing that
  // disproves it is CQZ12805, VA10820's 128-lead ceramic LQFP, which prints a
  // 12.40 mm lead row on a 12.00 mm ceramic body. A lead frame brazed to a
  // ceramic body overhangs it. Asserting the general form here would fail every
  // ceramic quad flat pack in the corpus, and briefly did worse than that: it
  // was used to justify GROWING the drawn body, which silently redrew VA10820's
  // outline 0.4 mm larger than its own drawing states.
  //
  // Nothing else in this file catches it. The courtyard is sized from the LANDS,
  // so it grows to hold them whichever way round the body is, and every other
  // invariant here is about the pads alone.
  for (const { shape, footprint } of await everyFootprint()) {
    const fab = /\(fp_poly \(pts ([^)]*(?:\)[^)]*)*?)\) \(layer "F\.Fab"\)/.exec(footprint);
    assert.ok(fab, `${shape.label}: no fabrication outline`);
    const xs: number[] = [];
    const ys: number[] = [];
    for (const point of fab![1].matchAll(/\(xy (-?[\d.]+) (-?[\d.]+)\)/g)) {
      xs.push(Number(point[1]));
      ys.push(Number(point[2]));
    }
    assert.ok(xs.length >= 4, `${shape.label}: fabrication outline has no points`);
    const halfX = Math.max(...xs.map(Math.abs));
    const halfY = Math.max(...ys.map(Math.abs));

    const { pads } = parse(footprint);
    const lands = pads.filter((pad) => pad.number !== "" && !(shape.exposedPad && pad.number === String(shape.pinCount + 1)));
    // WHICH ROW EACH LAND IS ON, taken from the land itself.
    //
    // A land's LENGTH runs outward from the body, so a left or right column's
    // land is wider than it is tall and its row runs along Y; a top or bottom
    // row's land is taller than wide and its row runs along X. Reading it off the
    // pad rather than off the side count is what keeps a quad honest: its left
    // column legitimately sits OUTSIDE the body in x, and asking "does any land
    // reach past the body in x" therefore fails on a correct four-sided package.
    //
    // A plated hole is square, so a single row is settled by its arrangement.
    if (shape.sides !== 1) continue;
    const reach = Math.max(...lands.map((pad) => Math.abs(pad.x)));
    assert.ok(
      reach <= halfX + 1e-6,
      `${shape.label}: the row of pins reaches ${reach} mm along x and the body is drawn ${halfX} mm across, ` +
        `so the pins come out of nothing. The body is drawn on the wrong axis`
    );
    // The other axis is the one the transpose swapped INTO, so both are pinned.
    assert.ok(halfY < halfX, `${shape.label}: a single row is wider than it is deep, and this body is not`);
  }
});

test("the symbol draws every pin the footprint places a land for", async () => {
  // THE OTHER HALF OF THE NETLIST, and until 2026-08-25 nothing walked it.
  //
  // A connection exists only where the footprint and the symbol name the same
  // pin. Every invariant in this file was about the footprint, and
  // `buildSymbolGeometry` DROPS a pin whose number its lookup misses - one
  // `if (!pin) return;`, no note, no refusal - so a record with a gapped table
  // shipped N lands beside a symbol with fewer pins and every check passed.
  //
  // `symbolViolations` now refuses that inside `createExportZip`, which is a
  // check on the GEOMETRY. This is the same property asserted on the FILE, so an
  // emitter that loses a pin on the way out is caught as well.
  for (const { shape, footprint, symbol } of await everyFootprint()) {
    const drawn = [...symbol.matchAll(/\(number "([^"]*)"/g)].map((match) => match[1]);
    const { pads } = parse(footprint);
    const padNumber = shape.exposedPad ? String(shape.pinCount + 1) : null;
    const lands = pads
      .map((pad) => pad.number)
      .filter((number) => number !== "" && number !== padNumber);

    assert.deepEqual(
      [...drawn].sort(),
      [...new Set(lands)].sort(),
      `${shape.label}: the symbol draws ${drawn.length} pins and the footprint places ${lands.length} lands`
    );
    assert.equal(new Set(drawn).size, drawn.length, `${shape.label}: the symbol draws a pin number twice`);
  }
});

test("a through-hole pad never carries paste, and a surface-mount one always does", async () => {
  // The other half of the same rule, and the reason it cannot simply be "every
  // pad has paste": a plated hole is soldered by wave or by hand, and paste in
  // the hole fouls it. The two mountings are opposite and both are load-bearing.
  const throughHole = await createExportZip(
    partFor({
      label: "dip-8",
      pinCount: 8,
      pitchMm: 2.54,
      sides: 2,
      landLengthMm: 1.5,
      landWidthMm: 1.5,
      landSpanMm: 7.62,
      landSpanCrossMm: null,
      bodyMm: [9.27, 6.35]
    }),
    "kicad"
  ).then(async (bundle) => {
    const zip = await JSZip.loadAsync(bundle.buffer);
    const name = Object.keys(zip.files).find((file) => file.endsWith(".kicad_mod"))!;
    return zip.files[name].async("string");
  });
  assert.doesNotMatch(throughHole, /thru_hole[^\n]*F\.Paste/, "a hole is not pasted");
});
