import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { emitAltiumSchLib } from "../altium";
import { AltiumEmitError } from "../altium/units";
import { type SymbolGeometry, type SymbolPin } from "../../geometry";

/**
 * Same discipline as the footprint library: the symbol is read back by
 * pyaltiumlib, not by our own code, and the test fails if the reader logged
 * anything at all.
 */

const ORACLE = join(fileURLToPath(new URL(".", import.meta.url)), "altium-oracle.py");

interface OracleRecord {
  kind: string;
  [key: string]: unknown;
}

interface OracleResult {
  error?: string;
  libHeader: string;
  libType: string;
  componentCount: number;
  parts: Array<{ name: string; description: string; designator: string | null; records: OracleRecord[] }>;
  diagnostics: string[];
  unsupportedRecords: number[];
}

function readBack(library: Buffer): OracleResult {
  const directory = mkdtempSync(join(tmpdir(), "forge-altium-"));
  const path = join(directory, "forge-test.SchLib");
  writeFileSync(path, library);

  let stdout: string;
  try {
    stdout = execFileSync("python3", [ORACLE, path], { encoding: "utf8" });
  } catch (error) {
    const detail = error instanceof Error && "stderr" in error ? String(error.stderr) : String(error);
    throw new Error(
      `The Altium oracle did not complete. It needs python3 with pyaltiumlib (pip install pyaltiumlib).\n${detail}`
    );
  }

  const result = JSON.parse(stdout) as OracleResult;
  assert.equal(result.error, undefined, `pyaltiumlib failed to read the library: ${result.error}`);
  return result;
}

/** An eight-pin symbol laid out the way the exporter lays one out. */
function symbolGeometry(): SymbolGeometry {
  const pitchMm = 2.54;
  const halfWidthMm = 7.62;
  const rows = 4;
  const halfHeightMm = ((rows + 1) * pitchMm) / 2;
  const lengthMm = 2.54;

  const pins: SymbolPin[] = [];
  const left = [1, 2, 3, 4];
  const right = [8, 7, 6, 5];
  for (const [side, numbers] of [
    ["left", left],
    ["right", right]
  ] as const) {
    numbers.forEach((number, row) => {
      pins.push({
        number: String(number),
        name: `P${number}`,
        anchor: {
          xMm: side === "left" ? -(halfWidthMm + lengthMm) : halfWidthMm + lengthMm,
          yMm: halfHeightMm - pitchMm * (row + 1)
        },
        side,
        lengthMm,
        electricalType: "passive" as const
      });
    });
  }

  return {
    name: "FORGE-SYM-8",
    partNumber: "FORGE-SYM-8",
    body: { halfWidthMm, halfHeightMm },
    bodyCentreYMm: 0,
    pins
  };
}

const UNIT_MM = 0.254;

test("pyaltiumlib identifies the file as a schematic binary library", () => {
  const result = readBack(emitAltiumSchLib(symbolGeometry()));

  assert.match(result.libHeader, /Schematic/);
  assert.match(result.libHeader, /Binary File/);
  assert.equal(result.libType, "Schematic");
  assert.equal(result.componentCount, 1);
  assert.equal(result.parts[0].name, "FORGE-SYM-8");
});

test("every pin comes back once, on the side and row it was given", () => {
  const geometry = symbolGeometry();
  const result = readBack(emitAltiumSchLib(geometry));
  const pins = result.parts[0].records.filter((record) => record.kind === "SchPin") as Array<
    OracleRecord & {
      designator: string;
      name: string;
      location: { x: number; y: number };
      length: number;
      flipped: boolean;
    }
  >;

  assert.equal(pins.length, 8, "every pin is written exactly once");
  const byNumber = new Map(pins.map((pin) => [pin.designator, pin]));
  assert.equal(byNumber.size, 8, "no two pins share a designator");

  // Pin 1 and pin 8 face each other; so do 4 and 5. Same property the KiCad
  // symbol is checked for, because it is a property of the geometry.
  const one = byNumber.get("1")!;
  const eight = byNumber.get("8")!;
  const four = byNumber.get("4")!;
  const five = byNumber.get("5")!;
  assert.ok(one.location.x < 0 && eight.location.x > 0, "pin 1 is on the left, pin 8 on the right");
  assert.equal(one.location.y, eight.location.y, "pin 1 and pin 8 share a row");
  assert.equal(four.location.y, five.location.y, "pin 4 and pin 5 share a row");
  assert.ok(four.location.y > one.location.y, "numbering runs down the left side");
  assert.ok(five.location.y > eight.location.y, "and back up the right side");

  assert.equal(one.name, "P1");
  assert.ok(one.flipped, "a left-hand pin extends to the left");
  assert.ok(!eight.flipped, "a right-hand pin extends to the right");
});

test("the pins attach to the body edge and stick out by their length", () => {
  const geometry = symbolGeometry();
  const result = readBack(emitAltiumSchLib(geometry));
  const pins = result.parts[0].records.filter((record) => record.kind === "SchPin") as Array<
    OracleRecord & { designator: string; location: { x: number; y: number }; length: number; flipped: boolean }
  >;

  for (const pin of pins) {
    const edgeMm = pin.location.x * UNIT_MM;
    assert.ok(
      Math.abs(Math.abs(edgeMm) - geometry.body.halfWidthMm) < 0.001,
      `pin ${pin.designator} attaches at ${edgeMm} mm, not the body edge`
    );
    // The far end, where a wire connects, is the geometry's anchor.
    const tipMm = edgeMm + (pin.flipped ? -1 : 1) * pin.length * UNIT_MM;
    const expected = geometry.pins.find((candidate) => candidate.number === pin.designator)!.anchor.xMm;
    assert.ok(Math.abs(tipMm - expected) < 0.001, `pin ${pin.designator} ends at ${tipMm} mm, expected ${expected}`);
  }
});

test("the body, designator and comment come back", () => {
  const geometry = symbolGeometry();
  const result = readBack(emitAltiumSchLib(geometry));
  const records = result.parts[0].records;

  const body = records.find((record) => record.kind === "SchRectangle") as
    | (OracleRecord & { location: { x: number; y: number }; corner: { x: number; y: number } })
    | undefined;
  assert.ok(body, "the symbol has a body outline");
  assert.ok(Math.abs(Math.abs(body.location.x * UNIT_MM) - geometry.body.halfWidthMm) < 0.001);
  assert.ok(Math.abs(Math.abs(body.corner.y * UNIT_MM) - geometry.body.halfHeightMm) < 0.001);

  assert.equal(result.parts[0].designator, "U?", "the designator is the one Altium annotates");
  const comment = records.find((record) => record.kind === "SchParameter") as
    | (OracleRecord & { text: string; name: string })
    | undefined;
  assert.ok(comment);
  assert.equal(comment.name, "Comment");
  assert.equal(comment.text, geometry.partNumber);
});

test("the reader finds nothing wrong with the file", () => {
  const result = readBack(emitAltiumSchLib(symbolGeometry()));
  assert.deepEqual(result.diagnostics, [], "pyaltiumlib complained about the generated symbol");
  assert.deepEqual(result.unsupportedRecords, [], "and this symbol uses only records it implements");
});

test("the footprint link is the only thing this reader cannot see", () => {
  // pyaltiumlib's symbol reader stops at record 44. Records 45, 46 and 48 are
  // the footprint link, and it reports them as unimplemented rather than wrong.
  // They are checked by the second oracle in altium-crosscheck.test.ts, which
  // does implement them. What matters here is that nothing else is unreadable
  // and that no record is malformed.
  const result = readBack(emitAltiumSchLib(symbolGeometry(), { footprintName: "forge-sym-8-soic" }));
  assert.deepEqual(result.diagnostics, [], "no record is malformed");
  assert.deepEqual(result.unsupportedRecords, [45, 46, 48], "and only the link is beyond this reader");
});

test("the symbol names its footprint, and pins no library file while doing it", () => {
  // Two assertions in one, and the second matters as much as the first. Altium
  // can pin the link to a named library file, and then it dangles as soon as the
  // file is renamed. Real Altium libraries name the model and no file, which is
  // what DATAFILECOUNT=0 with no MODELDATAFILEENTITY says.
  const library = emitAltiumSchLib(symbolGeometry(), { footprintName: "forge-sym-8-soic" });
  const text = library.toString("latin1");

  assert.match(text, /\|RECORD=45\|/, "an implementation record is present");
  assert.match(text, /\|MODELNAME=forge-sym-8-soic\|/);
  assert.match(text, /\|MODELTYPE=PCBLIB\|/);
  assert.match(text, /\|DATAFILECOUNT=0\|/);
  assert.match(text, /\|ISCURRENT=T/);
  assert.ok(!text.includes("MODELDATAFILEENTITY"), "no library file is pinned");

  // The containers Altium writes around it, including the empty pin map.
  for (const record of ["RECORD=44", "RECORD=46", "RECORD=48"]) {
    assert.ok(text.includes(record), `${record} container is present`);
  }
});

test("a symbol with no footprint named still writes the empty container Altium expects", () => {
  const text = emitAltiumSchLib(symbolGeometry()).toString("latin1");
  assert.ok(text.includes("RECORD=44"));
  assert.ok(!text.includes("RECORD=45"), "no implementation is invented when none was given");
});

test("the same symbol produces the same bytes twice", () => {
  assert.ok(emitAltiumSchLib(symbolGeometry()).equals(emitAltiumSchLib(symbolGeometry())));
});

test("an off-grid pin is refused rather than nudged onto the grid", () => {
  // Altium wires a pin only where it sits on the grid. Moving one quietly to
  // make the file valid produces a symbol that looks connected and is not.
  const geometry = symbolGeometry();
  const pins = geometry.pins.map((pin, index) =>
    index === 0 ? { ...pin, anchor: { ...pin.anchor, yMm: pin.anchor.yMm + 0.1 } } : pin
  );
  assert.throws(() => emitAltiumSchLib({ ...geometry, pins }), AltiumEmitError);
});

test("a symbol with no pins is refused", () => {
  assert.throws(() => emitAltiumSchLib({ ...symbolGeometry(), pins: [] }), AltiumEmitError);
});
