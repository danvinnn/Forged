import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { createExportZip } from "../../exporters";
import { type PinRecord, type ResolvedPart } from "../../types";

/**
 * The KiCad output, read back by something that did not write it.
 *
 * Until this existed, KiCad was the least verified thing shipped: Altium had two
 * independent readers checking it while KiCad had none, and its files were
 * checked only by our own regexes matching text our own code had produced. That
 * is not a check, it is a restatement.
 *
 * kiutils is not KiCad, so this cannot prove KiCad opens the file. It proves
 * that an independent reader recovers the same pins, pads, footprint link and
 * 3D model reference that were written.
 */

const ORACLE = join(fileURLToPath(new URL(".", import.meta.url)), "kicad-oracle.py");

interface SymbolResult {
  error?: string;
  kind: "symbol";
  symbolCount: number;
  symbols: Array<{
    name: string;
    properties: Record<string, string>;
    unitCount: number;
    pins: Array<{
      number: string;
      name: string;
      x: number;
      y: number;
      angle: number;
      length: number;
      electricalType: string;
    }>;
    graphicCount: number;
  }>;
}

interface FootprintResult {
  error?: string;
  kind: "footprint";
  name: string;
  description: string;
  pads: Array<{
    number: string;
    type: string;
    shape: string;
    x: number;
    y: number;
    sizeX: number;
    sizeY: number;
    layers: string[];
  }>;
  models: string[];
  graphicLayers: string[];
  graphicCount: number;
}

function readBack<T>(content: Buffer, fileName: string): T {
  const directory = mkdtempSync(join(tmpdir(), "forge-kicad-"));
  const path = join(directory, fileName);
  writeFileSync(path, content);

  let stdout: string;
  try {
    stdout = execFileSync("python3", [ORACLE, path], { encoding: "utf8" });
  } catch (error) {
    const detail = error instanceof Error && "stderr" in error ? String(error.stderr) : String(error);
    throw new Error(`The KiCad oracle did not complete. It needs python3 with kiutils (pip install kiutils).\n${detail}`);
  }

  const result = JSON.parse(stdout) as T & { error?: string };
  assert.equal(result.error, undefined, `kiutils failed to read the file: ${result.error}`);
  return result;
}

function soicPart(): ResolvedPart {
  const pins: PinRecord[] = Array.from({ length: 8 }, (_, index) => ({
    number: String(index + 1),
    name: `P${index + 1}`,
    electricalType: index === 3 ? ("power" as const) : ("passive" as const)
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
    notes: []
  };
}

async function exported(): Promise<{ symbol: Buffer; footprint: Buffer; names: string[] }> {
  const bundle = await createExportZip(soicPart(), "kicad");
  const zip = await JSZip.loadAsync(bundle.buffer);
  return {
    symbol: await zip.files["acme27524.kicad_sym"].async("nodebuffer"),
    footprint: await zip.files["acme27524.pretty/acme27524-8-pin-soic.kicad_mod"].async("nodebuffer"),
    names: Object.keys(zip.files)
  };
}

test("an independent reader recovers every symbol pin, in the right unit", async () => {
  // The unit matters. Pins emitted at the top level of a symbol rather than
  // inside a `<name>_1_1` sub-symbol read as a symbol with no units at all to
  // tools that are not KiCad, which is how this was caught.
  const { symbol } = await exported();
  const result = readBack<SymbolResult>(symbol, "acme27524.kicad_sym");

  assert.equal(result.symbolCount, 1);
  const parsed = result.symbols[0];
  assert.equal(parsed.unitCount, 1, "the symbol has a unit, the way KiCad writes one");
  assert.equal(parsed.pins.length, 8, "and every pin is inside it");
  assert.ok(parsed.graphicCount >= 1, "the body outline is there too");

  const byNumber = new Map(parsed.pins.map((pin) => [pin.number, pin]));
  const one = byNumber.get("1");
  const eight = byNumber.get("8");
  const four = byNumber.get("4");
  assert.ok(one && eight && four);

  assert.ok(one.x < 0 && eight.x > 0, "pin 1 left, pin 8 right");
  assert.equal(one.y, eight.y, "facing each other");
  assert.equal(one.angle, 0, "a left pin points right");
  assert.equal(eight.angle, 180, "a right pin points left");
  assert.equal(four.electricalType, "power_in", "a power pin survives as power");
});

test("the symbol names its footprint, and the bundle makes that name resolvable", async () => {
  const { symbol, names } = await exported();
  const parsed = readBack<SymbolResult>(symbol, "acme27524.kicad_sym").symbols[0];

  assert.equal(parsed.properties.Footprint, "acme27524:acme27524-8-pin-soic");
  assert.equal(parsed.properties.Reference, "U");
  assert.equal(parsed.properties.Value, "ACME27524");

  // The nickname in that reference is the one KiCad derives from the folder we
  // ship, so the link resolves without the user naming anything.
  assert.ok(
    names.some((name) => name.startsWith("acme27524.pretty/")),
    "the footprint is in the folder that produces the nickname"
  );
});

test("an independent reader recovers the land pattern from the footprint", async () => {
  const { footprint } = await exported();
  const result = readBack<FootprintResult>(footprint, "acme27524-8-pin-soic.kicad_mod");

  assert.equal(result.pads.length, 8);
  const byNumber = new Map(result.pads.map((pad) => [pad.number, pad]));
  const one = byNumber.get("1");
  const eight = byNumber.get("8");
  assert.ok(one && eight);

  assert.equal(one.type, "smd");
  assert.equal(one.shape, "roundrect");
  assert.ok(one.layers.includes("F.Cu"), "on the front copper layer");
  assert.ok(Math.abs(one.sizeX - 1.55) < 0.05, `land length ${one.sizeX} mm`);
  assert.ok(Math.abs(one.sizeY - 0.6) < 0.05, `land width ${one.sizeY} mm`);
  assert.ok(Math.abs(Math.abs(one.x) * 2 - 5.4) < 0.05, "centre-to-centre span");

  assert.ok(one.x < 0 && eight.x > 0, "pin 1 left, pin 8 right");
  assert.equal(one.y, eight.y, "and on the same row");
});

test("the footprint carries its courtyard, its body and its 3D model", async () => {
  const { footprint } = await exported();
  const result = readBack<FootprintResult>(footprint, "acme27524-8-pin-soic.kicad_mod");

  assert.ok(result.graphicLayers.includes("F.CrtYd"), "a courtyard is drawn");
  assert.ok(result.graphicLayers.includes("F.Fab"), "and a body outline");
  assert.ok(result.graphicLayers.includes("F.SilkS"), "and the pin-1 marker on silkscreen");

  assert.deepEqual(result.models, ["${KIPRJMOD}/acme27524.step"], "the 3D body is referenced");
  assert.match(result.description, /IPC-7351B density level B/, "the file still states what it was built to");
});
