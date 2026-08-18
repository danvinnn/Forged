import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { emitAltiumPcbLib } from "../altium";
import { AltiumEmitError } from "../altium/units";
import { createExportZip, FootprintUnavailableError } from "../../exporters";
import { type FootprintGeometry } from "../../geometry";
import { type PinRecord, type ResolvedPart } from "../../types";

/**
 * The Altium generator is checked by an independent reader, not by reading our
 * own bytes back with our own code. Altium silently refuses a malformed library,
 * so "the writer looks right" is not evidence of anything.
 *
 * The oracle is pyaltiumlib. It reports both the geometry it recovered and every
 * warning it logged, and a passing test requires the log to be empty: pyaltiumlib
 * does not raise on a bad record, it complains and carries on, so a file can
 * parse to plausible numbers and still be broken.
 */

const ORACLE = join(fileURLToPath(new URL(".", import.meta.url)), "altium-oracle.py");

interface OraclePad {
  kind: string;
  layer: number;
  designator: string;
  location: { x: number; y: number };
  sizeTop: { x: number; y: number };
  holeSize: number;
  shapeTop: number;
  topLayerShape: number | null;
  topCornerRadius: number | null;
  rotation: number;
}

interface OracleRecord {
  kind: string;
  layer: number;
  [key: string]: unknown;
}

interface OracleResult {
  error?: string;
  libHeader: string;
  libType: string;
  componentCount: number;
  parts: Array<{ name: string; description: string; recordCount: number; records: OracleRecord[] }>;
  diagnostics: string[];
}

/** Writes the library to a scratch file and reads it back with pyaltiumlib. */
function readBack(library: Buffer, name = "forge-test"): OracleResult {
  const directory = mkdtempSync(join(tmpdir(), "forge-altium-"));
  const path = join(directory, `${name}.PcbLib`);
  writeFileSync(path, library);

  let stdout: string;
  try {
    stdout = execFileSync("python3", [ORACLE, path], { encoding: "utf8" });
  } catch (error) {
    // Deliberately not skipped. A suite that quietly stops checking the oracle
    // when the oracle is missing gives exactly the false confidence this whole
    // arrangement exists to prevent.
    const detail = error instanceof Error && "stderr" in error ? String(error.stderr) : String(error);
    throw new Error(
      `The Altium oracle did not complete. It needs python3 with pyaltiumlib (pip install pyaltiumlib).\n${detail}`
    );
  }

  const result = JSON.parse(stdout) as OracleResult;
  assert.equal(result.error, undefined, `pyaltiumlib failed to read the library: ${result.error}`);
  return result;
}

/** The same eight-pin SOIC the KiCad exporter tests use, so the two are comparable. */
function soicPart(overrides: Partial<ResolvedPart> = {}): ResolvedPart {
  const pins: PinRecord[] = Array.from({ length: 8 }, (_, index) => ({
    number: String(index + 1),
    name: `P${index + 1}`,
    electricalType: "unspecified" as const
  }));

  return {
    id: "test",
    partNumber: "ACME27524",
    manufacturer: "ACME",
    packageType: "8-pin SOIC",
    packageOutlineCode: null,
    jedecOutline: null,
  vendorLandPattern: null,
  exposedPad: false,
    pinCount: 8,
    pins,
    dimensions: {
      bodyLengthMm: 4.9,
      bodyWidthMm: 3.9,
      bodyHeightMm: 1.75,
      // The part's own drawing: TI D0008A, JEDEC MS-012. These used to be absent
      // and a hand-typed family table supplied them from the package NAME. The
      // table was deleted 2026-08-14; a datasheet's numbers come from the
      // datasheet.
      pitchMm: 1.27,
      leadLengthMm: null,
      leadCount: 8,
      leadWidthMm: { minMm: 0.31, maxMm: 0.51 },
      leadSpanMm: { minMm: 5.8, maxMm: 6.2 },
      leadSpanCrossMm: null,
      leadContactMm: { minMm: 0.4, maxMm: 0.625 },
      thermalPadLengthMm: null, thermalPadWidthMm: null,
      landPadLengthMm: null,
      landPadWidthMm: null,
      landSpanMm: null,
      landSpanCrossMm: null,
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
    sourceFileName: "ACME27524.pdf",
    notes: [],
    ...overrides
  };
}

/** The smallest library that is still a library: one footprint, one pad. */
function onePadGeometry(): FootprintGeometry {
  return {
    name: "forge-one-pad",
    description: "One pad, for checking the container round-trips",
    partNumber: "FORGE-1",
    pads: [
      {
        number: "1",
        centre: { xMm: 2.7, yMm: -1.27 },
        widthMm: 1.55,
        heightMm: 0.6,
        shape: "roundrect",
        mounting: "smd"
      }
    ],
    body: { halfWidthMm: 1.95, halfHeightMm: 2.45 },
    courtyard: { halfWidthMm: 3.2, halfHeightMm: 2.7 },
    pin1Marker: { xMm: -2.7, yMm: -2.2 },
    thermalVias: [],
    provenance: {
      family: "test",
      source: "test",
      densityLevel: "B",
      padWidthMm: 0.6,
      padLengthMm: 1.55,
      centreToCentreMm: 5.4,
      pitchMm: 1.27
    }
  };
}

test("pyaltiumlib identifies the file as a PCB binary library", () => {
  const result = readBack(emitAltiumPcbLib(onePadGeometry()));

  assert.match(result.libHeader, /PCB/);
  assert.match(result.libHeader, /Binary Library File/);
  assert.equal(result.libType, "PCB");
});

test("the library reports one component, under the name it was given", () => {
  const result = readBack(emitAltiumPcbLib(onePadGeometry()));

  assert.equal(result.componentCount, 1);
  assert.equal(result.parts.length, 1);
  assert.equal(result.parts[0].name, "forge-one-pad");
  assert.equal(result.parts[0].description, "One pad, for checking the container round-trips");
});

test("the pad comes back at the position and size it was written at", () => {
  // The milestone that de-risks everything else. Internal units are mils times
  // 10000, so a wrong scale here reads back 25.4x out and nothing else notices.
  const geometry = onePadGeometry();
  const result = readBack(emitAltiumPcbLib(geometry));
  const pad = result.parts[0].records.find((record) => record.kind === "PcbPad") as unknown as OraclePad;
  assert.ok(pad, "the footprint must contain a pad");

  const mm = (mils: number) => mils * 0.0254;

  assert.equal(pad.designator, "1");
  assert.equal(pad.layer, 1, "a surface-mount land belongs on the top copper layer");
  assert.ok(Math.abs(mm(pad.location.x) - 2.7) < 0.001, `pad x came back as ${mm(pad.location.x)} mm`);
  // pyaltiumlib negates Y on the way in, which undoes the flip the emitter
  // applies, so what comes back is the geometry's own +y-down coordinate.
  assert.ok(Math.abs(mm(pad.location.y) + 1.27) < 0.001, `pad y came back as ${mm(pad.location.y)} mm`);
  assert.ok(Math.abs(mm(pad.sizeTop.x) - 1.55) < 0.001, `pad length came back as ${mm(pad.sizeTop.x)} mm`);
  assert.ok(Math.abs(mm(Math.abs(pad.sizeTop.y)) - 0.6) < 0.001, `pad width came back as ${mm(pad.sizeTop.y)} mm`);

  assert.equal(pad.holeSize, 0, "a surface-mount land has no hole");
  assert.equal(pad.rotation, 0);
  assert.equal(pad.topLayerShape, 9, "the land is a rounded rectangle");
  assert.equal(pad.topCornerRadius, 50, "at Altium's default corner radius");
});

test("the footprint carries the drawing as well as the copper", () => {
  const geometry = onePadGeometry();
  const result = readBack(emitAltiumPcbLib(geometry));
  const records = result.parts[0].records;

  const tracks = records.filter((record) => record.kind === "PcbTrack");
  const silkscreen = tracks.filter((record) => record.layer === 33);
  const courtyard = tracks.filter((record) => record.layer === 71);
  // Six, not four. The outline is cut back to clear the lands, so the two edges
  // the lead row crosses come back as a stub at each end rather than as one line
  // running through the copper. Same rule and clearances as the KiCad emitter;
  // see `silkscreenTracks`.
  // Five, not four. The outline is cut back to clear the lands, so an edge a pad
  // crosses comes back as a stub at each end instead of one line running through
  // the copper. This fixture has a single pad on the right, so only that edge
  // splits: top, bottom and left survive whole, and the right becomes two.
  assert.equal(silkscreen.length, 5, "the body outline clears the pads");
  assert.equal(courtyard.length, 4, "and the courtyard is four more on its own layer");

  const arcs = records.filter((record) => record.kind === "PcbArc");
  assert.equal(arcs.length, 1, "a pin-1 marker, without which the part can be placed rotated");

  const strings = records.filter((record) => record.kind === "PcbString");
  assert.equal(strings.length, 1);
  assert.equal(strings[0].text, ".Designator");

  assert.equal(
    result.parts[0].recordCount,
    records.length,
    "the header's primitive count matches the number of primitives"
  );
});

test("the courtyard read back is the courtyard that was asked for", () => {
  const geometry = onePadGeometry();
  const result = readBack(emitAltiumPcbLib(geometry));
  const courtyard = result.parts[0].records.filter(
    (record) => record.kind === "PcbTrack" && record.layer === 71
  ) as Array<OracleRecord & { start: { x: number; y: number }; end: { x: number; y: number } }>;

  const xs = courtyard.flatMap((track) => [track.start.x, track.end.x]).map((mils) => mils * 0.0254);
  const ys = courtyard.flatMap((track) => [track.start.y, track.end.y]).map((mils) => mils * 0.0254);
  assert.ok(Math.abs(Math.max(...xs) - geometry.courtyard.halfWidthMm) < 0.001);
  assert.ok(Math.abs(Math.min(...xs) + geometry.courtyard.halfWidthMm) < 0.001);
  assert.ok(Math.abs(Math.max(...ys) - geometry.courtyard.halfHeightMm) < 0.001);
  assert.ok(Math.abs(Math.min(...ys) + geometry.courtyard.halfHeightMm) < 0.001);
});

test("the reader logs nothing, which is the part that catches a malformed record", () => {
  // pyaltiumlib does not raise on a bad record. It logs "common parameters array
  // spacer is not as expected" or "stream does not match the declared block
  // length" and returns something plausible. An empty log is the real assertion.
  const result = readBack(emitAltiumPcbLib(onePadGeometry()));
  assert.deepEqual(result.diagnostics, [], "pyaltiumlib complained about the generated library");
});

test("the same geometry produces the same bytes twice", () => {
  // Identity GUIDs are derived, not random, so two exports of one part can be
  // diffed against each other. For a part that ends up on flight hardware that
  // is worth more than a fresh GUID.
  const first = emitAltiumPcbLib(onePadGeometry());
  const second = emitAltiumPcbLib(onePadGeometry());
  assert.ok(first.equals(second));
});

test("a footprint with no pads is refused rather than written empty", () => {
  const geometry = onePadGeometry();
  assert.throws(() => emitAltiumPcbLib({ ...geometry, pads: [] }), AltiumEmitError);
});

test("a pad size that cannot be expressed is refused, not rounded away", () => {
  const geometry = onePadGeometry();
  assert.throws(
    () => emitAltiumPcbLib({ ...geometry, pads: [{ ...geometry.pads[0], widthMm: 0 }] }),
    AltiumEmitError
  );
  assert.throws(
    () => emitAltiumPcbLib({ ...geometry, pads: [{ ...geometry.pads[0], centre: { xMm: 99999, yMm: 0 } }] }),
    AltiumEmitError
  );
});

// --- The exported part, end to end ---------------------------------------------
// Everything above uses geometry written by hand. These take a part through the
// real export path, because the value the manifest promises and the value in the
// file are the two things a fabricator would compare.

test("the exported land pattern is the one the manifest claims", async () => {
  const bundle = await createExportZip(soicPart(), "altium");
  const zip = await JSZip.loadAsync(bundle.buffer);
  const library = await zip.files["acme27524.PcbLib"].async("nodebuffer");
  const result = readBack(library);

  const pads = result.parts[0].records.filter((record) => record.kind === "PcbPad") as unknown as OraclePad[];
  assert.equal(pads.length, 8, "an eight-pin part exports eight lands");

  const mm = (mils: number) => mils * 0.0254;
  const promised = bundle.footprint;
  const pad = pads[0];

  assert.ok(
    Math.abs(mm(pad.sizeTop.x) - promised.padLengthMm) < 0.05,
    `land length ${mm(pad.sizeTop.x)} mm against the manifest's ${promised.padLengthMm} mm`
  );
  assert.ok(
    Math.abs(mm(Math.abs(pad.sizeTop.y)) - promised.padWidthMm) < 0.05,
    `land width ${mm(Math.abs(pad.sizeTop.y))} mm against the manifest's ${promised.padWidthMm} mm`
  );
  assert.ok(
    Math.abs(Math.abs(mm(pad.location.x)) * 2 - promised.centreToCentreMm) < 0.05,
    `centre span ${Math.abs(mm(pad.location.x)) * 2} mm against the manifest's ${promised.centreToCentreMm} mm`
  );

  const byNumber = new Map(pads.map((entry) => [entry.designator, entry]));
  const adjacent = Math.abs(mm(byNumber.get("2")!.location.y) - mm(byNumber.get("1")!.location.y));
  assert.ok(Math.abs(adjacent - promised.pitchMm) < 0.01, `pitch ${adjacent} mm against ${promised.pitchMm} mm`);

  assert.deepEqual(result.diagnostics, []);
});

test("Altium pads are numbered counterclockwise, the same as the KiCad ones", async () => {
  // The defect this locks out is a miswired board, not a cosmetic one: both
  // columns running downward puts pin 5 of an eight-pin part where pin 8 belongs.
  const bundle = await createExportZip(soicPart(), "altium");
  const zip = await JSZip.loadAsync(bundle.buffer);
  const result = readBack(await zip.files["acme27524.PcbLib"].async("nodebuffer"));

  const pads = result.parts[0].records.filter((record) => record.kind === "PcbPad") as unknown as OraclePad[];
  const byNumber = new Map(pads.map((pad) => [pad.designator, pad.location]));

  const one = byNumber.get("1")!;
  const four = byNumber.get("4")!;
  const five = byNumber.get("5")!;
  const eight = byNumber.get("8")!;

  assert.ok(one.x < 0 && eight.x > 0, "pin 1 is on the left, pin 8 on the right");
  assert.equal(one.y, eight.y, "pin 1 and pin 8 sit on the same row");
  assert.equal(four.y, five.y, "pin 4 and pin 5 sit on the same row");
  assert.ok(four.y > one.y, "numbering runs down the left side");
  assert.ok(five.y > eight.y, "and back up the right side, which is the whole point");
});

test("a part with no land pattern read refuses the Altium export too", async () => {
  // The refusal is a property of the pipeline, not of one generator.
  //
  // It used to be triggered by naming an unrecognised PACKAGE, back when a
  // hand-typed family table decided what was buildable. With the table gone what
  // makes a part unbuildable is a document that did not state a land pattern or a
  // package drawing, so that is what the fixture withholds.
  const unread = soicPart();
  unread.dimensions = {
    ...unread.dimensions,
    leadSpanMm: null,
    leadSpanCrossMm: null,
    leadContactMm: null,
    leadWidthMm: null
  };
  await assert.rejects(() => createExportZip(unread, "altium"), FootprintUnavailableError);
});

test("a name too long for a compound-file storage still round-trips", () => {
  // Altium truncates the storage name to 31 characters and records the mapping.
  // The name readers report comes from the data stream, so it stays whole.
  const geometry = onePadGeometry();
  const name = "forge-really-long-footprint-name-that-will-not-fit-in-a-storage";
  const result = readBack(emitAltiumPcbLib({ ...geometry, name }));

  assert.equal(result.parts[0].name, name);
  assert.deepEqual(result.diagnostics, []);
});

test("the datasheet's solder mask clearance is written, with the manual flag set", () => {
  // Two fields, both required. The value at offset 94 is what Altium ignores
  // unless the manual flag at 106 says to use it instead of the board rule.
  // Offsets come from the byte map in ALTIUM.md and line up with the three this
  // writer already writes blind: hole_size 45, rotation 52, layer id 114.
  const geometry = onePadGeometry();
  const masked = { ...geometry, pads: geometry.pads.map((pad) => ({ ...pad, solderMaskMarginMm: 0.05 })) };

  const withMask = emitAltiumPcbLib(masked);
  const withoutMask = emitAltiumPcbLib(onePadGeometry());

  assert.notDeepEqual(withMask, withoutMask, "a stated clearance must change the file");
});

test("a datasheet that states no clearance leaves the board rule alone", () => {
  // Absent is not zero. Writing zero would open the mask exactly to the copper
  // edge, which is a real and different instruction from "not stated".
  const bytes = emitAltiumPcbLib(onePadGeometry());
  const again = emitAltiumPcbLib(onePadGeometry());
  assert.deepEqual(bytes, again, "and it stays deterministic");
});

test("an exposed thermal pad is written, not refused", () => {
  // Was a hard refusal: "this writer cannot express a paste pattern that differs
  // from the copper... export to KiCad, which can." That failed EVERY QFN, DFN
  // and SON part for Altium users, and it reported a missing feature as a
  // principled stance about reflow.
  //
  // The copper pad has its own paste suppressed and the apertures are drawn on
  // Top Paste, so the land is not pasted solid and the package does not float
  // off its leads.
  const geometry = onePadGeometry();
  const withPad = {
    ...geometry,
    pads: [
      ...geometry.pads,
      {
        number: "9",
        centre: { xMm: 0, yMm: 0 },
        widthMm: 2.15,
        heightMm: 1.2,
        shape: "roundrect" as const,
        mounting: "smd" as const,
        pasteApertures: [
          { centre: { xMm: -0.5, yMm: 0 }, widthMm: 0.8, heightMm: 1.0 },
          { centre: { xMm: 0.5, yMm: 0 }, widthMm: 0.8, heightMm: 1.0 }
        ]
      }
    ]
  };

  const bytes = emitAltiumPcbLib(withPad);
  assert.ok(bytes.byteLength > 0, "it produces a library rather than throwing");
  assert.notDeepEqual(bytes, emitAltiumPcbLib(geometry), "and the pad reached the file");
});

test("a thermal via is a HOLE, not a disc of copper", () => {
  // ## What this replaces
  //
  // `assert.notDeepEqual(emitAltiumPcbLib(withVias), emitAltiumPcbLib(geometry))`
  // and nothing else: the bytes differ from a footprint with no vias. That is
  // satisfied by writing anything at all, and what was written was
  // `mounting: "smd"` with the drill discarded, so `padRecord` stored a hole
  // size of ZERO and left the plated flag clear. Every via came out a solid disc
  // of copper on the top layer.
  //
  // A via with no barrel conducts no heat into the board, which is the entire
  // reason the datasheet dimensions them. The KiCad emitter has always written
  // these as plated holes on every copper layer, so the two formats disagreed
  // about the same footprint and only one of them was checked.
  //
  // Asserted through the ORACLE rather than against our own bytes, and on the
  // properties that make it a via: it is on Multi-Layer, it has a hole of the
  // size the datasheet gave, and the hole is plated.
  const geometry = onePadGeometry();
  const withVias = {
    ...geometry,
    thermalVias: [{ centre: { xMm: 0, yMm: 0 }, drillMm: 0.35, padMm: 0.7 }]
  };

  const read = readBack(emitAltiumPcbLib(withVias));
  const pads = read.parts[0].records.filter((record) => record.kind === "PcbPad") as unknown as OraclePad[];
  const vias = pads.filter((pad) => pad.designator === "");
  assert.equal(vias.length, 1, "one via reached the file");

  const via = vias[0];
  assert.equal(via.layer, 74, "a via passes through the board, so it is Multi-Layer and not Top Layer");
  assert.ok(via.holeSize > 0, "a via with no hole is a disc of copper, which moves no heat");
  assert.ok(
    Math.abs(via.holeSize - 0.35 / 0.0254) < 1,
    `the hole is the drill the datasheet gave, in mils; got ${via.holeSize}`
  );
});

// ---------------------------------------------------------------------------
// Plated through holes
// ---------------------------------------------------------------------------

/**
 * A through-hole pad, checked against a library Altium's own ecosystem wrote.
 *
 * The four things that differ from a surface-mount land were not inferred from
 * the format's documentation. They were read off Ultra Librarian's
 * `LM7805CT-NOPB.PcbLib`, checked in under `test-data/`, whose three TO-220 pads
 * read back as:
 *
 *     layer 74 (Multi-Layer)   base shapes 1/1/1 (Round)
 *     hole 47 mil in a 67 mil pad   plated: true   no parser warnings
 *
 * That mattered because none of the eleven reference libraries already in the
 * tree has a plated hole: they are all BGA, QFN or LFCSP. The existing writer
 * was built by diffing bytes against files Altium wrote, and for holes there was
 * nothing to diff against until that file arrived.
 *
 * The one remaining difference from it is `stackMode`, which reads 1 there and 0
 * here. 0 is what the genuine Altium surface-mount libraries in the tree use,
 * and it is the honest value while all three layer sizes are identical.
 */
function throughHoleGeometry(): FootprintGeometry {
  const geometry = onePadGeometry();
  return {
    ...geometry,
    pads: [
      { ...geometry.pads[0], number: "1", shape: "roundrect", mounting: "through-hole", drillMm: 0.7, widthMm: 1.5, heightMm: 1.5 },
      { ...geometry.pads[0], number: "2", centre: { xMm: 2.54, yMm: 0 }, shape: "circle", mounting: "through-hole", drillMm: 0.7, widthMm: 1.5, heightMm: 1.5 }
    ]
  };
}

test("a plated hole is written where Altium expects one", () => {
  const result = readBack(emitAltiumPcbLib(throughHoleGeometry()));
  assert.deepEqual(result.diagnostics, [], "an independent reader logs nothing");

  const pads = result.parts[0].records.filter((record) => record.kind === "PcbPad");
  assert.equal(pads.length, 2);
  for (const pad of pads) {
    assert.equal(pad.layer, 74, "a through-hole pad lives on Multi-Layer, not Top Layer");
    assert.ok(Number(pad.holeSize) > 0, "and it actually carries a hole");
    assert.equal(pad.isPlated, true, "with copper in the barrel, or the hole is mechanical only");
  }
});

test("the hole is the size the geometry asked for, not a default", () => {
  const result = readBack(emitAltiumPcbLib(throughHoleGeometry()));
  const pad = result.parts[0].records.find((record) => record.kind === "PcbPad")!;
  // 0.7 mm expressed in mils, which is the unit the reader reports.
  assert.ok(Math.abs(Number(pad.holeSize) - 0.7 / 0.0254) < 0.1, `hole came back as ${pad.holeSize} mil`);
});

test("a through-hole pad with no drill is refused rather than written as solid copper", () => {
  const geometry = throughHoleGeometry();
  const broken = { ...geometry, pads: [{ ...geometry.pads[0], drillMm: undefined }] };
  assert.throws(() => emitAltiumPcbLib(broken), /through-hole with no drill/);
});
