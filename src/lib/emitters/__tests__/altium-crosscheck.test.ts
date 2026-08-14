import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { emitAltiumPcbLib, emitAltiumSchLib } from "../altium";
import { createExportZip } from "../../exporters";
import { type PinRecord, type ResolvedPart } from "../../types";

/**
 * The second oracle: AltiumSharp, read through `tools/altium-oracle`.
 *
 * pyaltiumlib is a good reader and an incomplete one. Its schematic reader stops
 * at record 44, so the footprint link is invisible to it, and a suite that only
 * asked pyaltiumlib would have gone quiet exactly where the newest code lives.
 *
 * This is not a formality. AltiumSharp caught a real defect that pyaltiumlib
 * passed with an empty log: the footprint data stream carried a trailing 0x00
 * terminator byte, which a strict reader takes for an unknown primitive id and
 * then fails on. Altium writes no such byte. That file looked perfect in CI and
 * would very likely have been refused by Altium without a word.
 */

const ORACLE = join(
  fileURLToPath(new URL("../../../../", import.meta.url)),
  "tools/altium-oracle/bin/Release/net10.0/altium-oracle"
);

interface CrossCheckPad {
  designator: string;
  layer: number;
  x: number;
  y: number;
  sizeX: number;
  sizeY: number;
  holeSize: number;
  shapeTop: number;
  rotation: number;
}

interface CrossCheckResult {
  error?: string;
  reader: string;
  libType: string;
  componentCount: number;
  parts: Array<{
    name: string;
    description: string;
    padCount?: number;
    trackCount?: number;
    arcCount?: number;
    textCount?: number;
    bodyCount?: number;
    pads?: CrossCheckPad[];
    bodies?: Array<{ modelId: string; modelName: string; embed: boolean; overallHeight: number }>;
    pinCount?: number;
    pins?: Array<{ designator: string; name: string; x: number; y: number; length: number; electricalType: number }>;
    implementations?: Array<{ modelName: string; modelType: string; isCurrent: boolean; dataFileCount: number }>;
  }>;
  models?: Array<{ id: string; name: string; embedded: boolean; checksum: number; stepBytes: number }>;
}

function crossCheck(library: Buffer, extension: ".PcbLib" | ".SchLib"): CrossCheckResult {
  if (!existsSync(ORACLE)) {
    // Not skipped. A check that quietly stops running is worse than one that
    // fails, and this one exists because the first reader was not enough.
    throw new Error(
      `The AltiumSharp cross-check has not been built. Run "npm run oracle:build" (it needs the .NET SDK; tools/altium-oracle/README.md says how to get one). Expected it at ${ORACLE}`
    );
  }

  const directory = mkdtempSync(join(tmpdir(), "forge-altium-x-"));
  const path = join(directory, `forge-test${extension}`);
  writeFileSync(path, library);

  let stdout: string;
  try {
    stdout = execFileSync(ORACLE, [path], { encoding: "utf8" });
  } catch (error) {
    const detail = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
    throw new Error(`AltiumSharp could not read the library:\n${detail}`);
  }

  const result = JSON.parse(stdout) as CrossCheckResult;
  assert.equal(result.error, undefined, `AltiumSharp rejected the library: ${result.error}`);
  assert.equal(result.reader, "AltiumSharp");
  return result;
}

interface RoundTripResult {
  error?: string;
  mode: string;
  identical: boolean;
  originalBytes: number;
  rewrittenBytes: number;
  byteIdentical: boolean;
  before: CrossCheckResult;
  after: CrossCheckResult;
}

/**
 * Read the library, write it back out through AltiumSharp, read the result.
 *
 * Reading proves a reader could make sense of the bytes. This proves the meaning
 * survives a full trip through an independent implementation, which is harder to
 * pass by accident: a field written somewhere the reader tolerates but does not
 * understand comes back missing on the second read, and a length or offset that
 * only happens to work for our own byte layout falls apart once a different
 * writer re-lays it out.
 *
 * Byte identity is neither expected nor asserted. AltiumSharp orders streams its
 * own way and the compound container carries its own bookkeeping.
 */
function roundTrip(library: Buffer, extension: ".PcbLib" | ".SchLib"): RoundTripResult {
  if (!existsSync(ORACLE)) {
    throw new Error(
      `The AltiumSharp cross-check has not been built. Run "npm run oracle:build" (it needs the .NET SDK; tools/altium-oracle/README.md says how to get one). Expected it at ${ORACLE}`
    );
  }

  const directory = mkdtempSync(join(tmpdir(), "forge-altium-rt-"));
  const path = join(directory, `forge-test${extension}`);
  writeFileSync(path, library);

  let stdout: string;
  try {
    stdout = execFileSync(ORACLE, ["--roundtrip", path], { encoding: "utf8" });
  } catch (error) {
    const detail = error instanceof Error && "stdout" in error ? String(error.stdout) : String(error);
    throw new Error(`AltiumSharp could not round-trip the library:\n${detail}`);
  }

  const result = JSON.parse(stdout) as RoundTripResult;
  assert.equal(result.error, undefined, `AltiumSharp rejected the library: ${result.error}`);
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
      pitchMm: null,
      leadLengthMm: null,
      leadCount: 8,
      leadWidthMm: null, leadSpanMm: null, leadContactMm: null,
      thermalPadLengthMm: null, thermalPadWidthMm: null,
      landPadLengthMm: null,
      landPadWidthMm: null,
      landSpanMm: null,
      leadSides: null,
      leadForm: null,
      vacantLeadSlot: null,
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

async function exportedLibraries(): Promise<{ footprint: Buffer; symbol: Buffer }> {
  const bundle = await createExportZip(soicPart(), "altium");
  const zip = await JSZip.loadAsync(bundle.buffer);
  return {
    footprint: await zip.files["acme27524.PcbLib"].async("nodebuffer"),
    symbol: await zip.files["acme27524.SchLib"].async("nodebuffer")
  };
}

test("AltiumSharp reads the exported footprint library end to end", async () => {
  const { footprint } = await exportedLibraries();
  const result = crossCheck(footprint, ".PcbLib");

  assert.equal(result.libType, "PCB");
  assert.equal(result.componentCount, 1);

  const part = result.parts[0];
  assert.equal(part.padCount, 8, "eight lands");
  assert.equal(part.trackCount, 8, "body outline and courtyard, four segments each");
  assert.equal(part.arcCount, 1, "the pin-1 marker");
  assert.equal(part.textCount, 1, "the designator");
});

test("the second reader agrees with the first about where the copper is", async () => {
  // Two independent implementations recovering the same numbers from the same
  // bytes is the strongest statement available short of opening Altium.
  const { footprint } = await exportedLibraries();
  const pads = crossCheck(footprint, ".PcbLib").parts[0].pads ?? [];
  const mm = (mils: number) => mils * 0.0254;
  const byNumber = new Map(pads.map((pad) => [pad.designator, pad]));

  const one = byNumber.get("1");
  const eight = byNumber.get("8");
  assert.ok(one && eight);

  assert.equal(one.layer, 1, "top copper");
  assert.equal(one.holeSize, 0, "surface mount");
  assert.equal(one.shapeTop, 9, "rounded rectangle");
  assert.equal(one.rotation, 0);
  assert.ok(Math.abs(mm(one.sizeX) - 1.55) < 0.05, `land length ${mm(one.sizeX)} mm`);
  assert.ok(Math.abs(mm(one.sizeY) - 0.6) < 0.05, `land width ${mm(one.sizeY)} mm`);
  assert.ok(Math.abs(Math.abs(mm(one.x)) * 2 - 5.4) < 0.05, "centre-to-centre span");

  // Counterclockwise, checked again through a different reader.
  assert.ok(one.x < 0 && eight.x > 0, "pin 1 left, pin 8 right");
  assert.equal(one.y, eight.y, "and on the same row");
});

test("AltiumSharp sees the footprint link that pyaltiumlib cannot", async () => {
  // The whole reason this oracle exists. pyaltiumlib stops at record 44 and
  // reports the link as an unsupported record; this reader implements it.
  const { symbol } = await exportedLibraries();
  const result = crossCheck(symbol, ".SchLib");

  assert.equal(result.libType, "Schematic");
  const part = result.parts[0];
  assert.equal(part.pinCount, 8);

  const implementations = part.implementations ?? [];
  assert.equal(implementations.length, 1, "the symbol names exactly one model");
  assert.equal(implementations[0].modelName, "acme27524-soic-narrow", "and it is the footprint we shipped");
  assert.equal(implementations[0].modelType, "PCBLIB");
  assert.equal(implementations[0].isCurrent, true);
  assert.equal(
    implementations[0].dataFileCount,
    0,
    "no library file is pinned, so the link survives the file being renamed"
  );
});

test("the second reader agrees with the first about the symbol pins", async () => {
  const { symbol } = await exportedLibraries();
  const pins = crossCheck(symbol, ".SchLib").parts[0].pins ?? [];
  assert.equal(pins.length, 8);

  const byNumber = new Map(pins.map((pin) => [pin.designator, pin]));
  const one = byNumber.get("1");
  const eight = byNumber.get("8");
  const four = byNumber.get("4");
  assert.ok(one && eight && four);

  assert.ok(one.x < 0 && eight.x > 0, "pin 1 left, pin 8 right");
  assert.equal(one.y, eight.y, "facing each other");
  assert.equal(one.name, "P1");
  assert.equal(four.electricalType, 7, "a power pin survives as Power, not as Passive");
});

test("the 3D body is embedded in the footprint library, not shipped beside it", async () => {
  // The difference between one file you drop in and three files you assemble.
  const { footprint } = await exportedLibraries();
  const result = crossCheck(footprint, ".PcbLib");
  const part = result.parts[0];

  assert.equal(part.bodyCount, 1, "the footprint carries a body");
  const body = part.bodies?.[0];
  const model = result.models?.[0];
  assert.ok(body && model, "and the library carries the model it refers to");

  // The two halves have to agree or the body points at nothing.
  assert.equal(body.modelId, model.id, "the body names the model that is actually stored");
  assert.equal(body.embed, true);
  assert.equal(model.embedded, true);
  assert.ok(model.stepBytes > 0, "the STEP payload survived compression and came back out");
  assert.match(model.name, /\.step$/);

  // Height comes from the solid itself rather than being declared separately.
  const heightMm = body.overallHeight * 0.0254;
  assert.ok(Math.abs(heightMm - 1.75) < 0.01, `body height read back as ${heightMm} mm`);
});

test("a footprint with no model given carries no body and no model store", () => {
  const geometry = {
    name: "forge-no-body",
    description: "One pad",
    partNumber: "FORGE-1",
    pads: [
      {
        number: "1",
        centre: { xMm: 0, yMm: 0 },
        widthMm: 1.55,
        heightMm: 0.6,
        shape: "roundrect" as const,
        mounting: "smd" as const
      }
    ],
    body: { halfWidthMm: 1.95, halfHeightMm: 2.45 },
    courtyard: { halfWidthMm: 3.2, halfHeightMm: 2.7 },
    pin1Marker: { xMm: -2.7, yMm: -2.2 },
    thermalVias: [],
    provenance: {
      family: "test",
      source: "test",
      densityLevel: "B" as const,
      padWidthMm: 0.6,
      padLengthMm: 1.55,
      centreToCentreMm: 5.4,
      pitchMm: 1.27
    }
  };

  const result = crossCheck(emitAltiumPcbLib(geometry), ".PcbLib");
  assert.equal(result.parts[0].bodyCount, 0, "nothing is invented when no model was given");
  assert.deepEqual(result.models, []);
});

test("a footprint written without a terminator byte is what a strict reader requires", () => {
  // The regression this locks: Altium's own footprint streams end the instant
  // the last record ends. A trailing zero reads as an unknown primitive id, and
  // AltiumSharp rejects the entire library over it while pyaltiumlib shrugs.
  const geometry = {
    name: "forge-terminator-check",
    description: "One pad",
    partNumber: "FORGE-1",
    pads: [
      {
        number: "1",
        centre: { xMm: 0, yMm: 0 },
        widthMm: 1.55,
        heightMm: 0.6,
        shape: "roundrect" as const,
        mounting: "smd" as const
      }
    ],
    body: { halfWidthMm: 1.95, halfHeightMm: 2.45 },
    courtyard: { halfWidthMm: 3.2, halfHeightMm: 2.7 },
    pin1Marker: { xMm: -2.7, yMm: -2.2 },
    thermalVias: [],
    provenance: {
      family: "test",
      source: "test",
      densityLevel: "B" as const,
      padWidthMm: 0.6,
      padLengthMm: 1.55,
      centreToCentreMm: 5.4,
      pitchMm: 1.27
    }
  };

  const result = crossCheck(emitAltiumPcbLib(geometry), ".PcbLib");
  assert.equal(result.parts[0].padCount, 1);
});

test("the footprint library survives being written back out by another implementation", async () => {
  const { footprint } = await exportedLibraries();
  const result = roundTrip(footprint, ".PcbLib");

  assert.equal(result.identical, true, "everything the reader can see came back unchanged");

  // Named explicitly so a silently emptied library cannot pass by comparing
  // equal to another empty one.
  const before = result.before.parts[0];
  const after = result.after.parts[0];
  assert.equal(before.padCount, 8);
  assert.equal(after.padCount, 8);
  assert.equal(after.bodyCount, 1);
  assert.equal(result.after.models?.length, 1, "the embedded STEP model was rewritten too");
});

test("the symbol library survives being written back out by another implementation", async () => {
  const { symbol } = await exportedLibraries();
  const result = roundTrip(symbol, ".SchLib");

  assert.equal(result.identical, true);
  assert.equal(result.before.parts[0].pinCount, 8);
  assert.equal(result.after.parts[0].pinCount, 8);
  assert.equal(
    result.after.parts[0].implementations?.[0].modelName,
    "acme27524-soic-narrow",
    "the footprint link is still there on the far side"
  );
});

test("a symbol with no footprint named carries no implementation", () => {
  const geometry = {
    name: "FORGE-SYM",
    partNumber: "FORGE-SYM",
    body: { halfWidthMm: 7.62, halfHeightMm: 6.35 },
    pins: [
      {
        number: "1",
        name: "A",
        anchor: { xMm: -10.16, yMm: 3.81 },
        side: "left" as const,
        lengthMm: 2.54,
        electricalType: "passive" as const
      }
    ]
  };

  const result = crossCheck(emitAltiumSchLib(geometry), ".SchLib");
  assert.deepEqual(result.parts[0].implementations, [], "none is invented when none was given");
});
