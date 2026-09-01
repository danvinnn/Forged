/**
 * DO THE TWO FORMATS SAY THE SAME THING, AND DOES THE 3D SOLID MATCH THE RECORD?
 *
 * ## The gap this fills
 *
 * `ARCHITECTURE.md` and `emitters/altium.ts` both make the same promise: KiCad,
 * Altium and Cadence are PEERS, none derived from the others, each reading the
 * same format-neutral geometry. That promise is what makes "we support Altium"
 * true rather than a rename - and nothing has ever checked it. If the two
 * emitters disagree about where a pad sits, one of them is wrong and the whole
 * suite stays green: each is tested against the geometry it was handed, in its
 * own file, on its own hand-built fixture.
 *
 * The same is true of the solid. `bench:unchecked` corrupts every value that
 * places copper; nothing corrupts the three that build the 3D body, and nothing
 * reads the emitted STEP back to see whether the box is the size the record
 * says. A body is what a mechanical clearance check runs against, and a wrong
 * one PASSES a check it should fail.
 *
 * ## Read back by readers that did not write the files
 *
 * kiutils for KiCad, AltiumSharp for Altium. Both already exist for the unit
 * tests, on one hand-built fixture each; this runs them over every part the
 * cache can rebuild, and compares the two formats to EACH OTHER rather than each
 * to its own input.
 *
 * The STEP solid is parsed with a small reader here rather than an oracle: it is
 * our own Part 21 text and what is being asked of it is only "are these eight
 * points the box the record describes, seated on the board plane".
 *
 * Free: cached model answers off disk, no network, no spend. Needs python3 with
 * kiutils and the built AltiumSharp oracle, the same two the suite already
 * needs.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { loadBenchEnv } from "./env";
import { buildCachedParts } from "./oracle-match";
import { BENCH_SETTINGS, shipOutcome } from "./shipcheck";
import { buildStepModel, createExportZip } from "../exporters";
import type { ResolvedPart } from "../types";

loadBenchEnv();

const KICAD_ORACLE = join(fileURLToPath(new URL("../emitters/__tests__/", import.meta.url)), "kicad-oracle.py");
const ALTIUM_ORACLE = join(
  fileURLToPath(new URL("../../../", import.meta.url)),
  "tools/altium-oracle/bin/Release/net10.0/altium-oracle"
);

/** Altium coordinates come back in mils on the oracle's own scale. */
const MILS_PER_MM = 39.3700787;

interface KicadPad {
  number: string;
  x: number;
  y: number;
  sizeX: number;
  sizeY: number;
}
interface KicadFootprint {
  error?: string;
  pads: KicadPad[];
}
interface KicadSymbol {
  error?: string;
  symbols: Array<{ pins: Array<{ number: string; name: string; x: number; y: number }> }>;
}
interface AltiumPad {
  designator: string;
  x: number;
  y: number;
  sizeX: number;
  sizeY: number;
}
interface AltiumResult {
  error?: string;
  parts: Array<{
    pads?: AltiumPad[];
    pins?: Array<{ designator: string; name: string; x: number; y: number; length: number }>;
  }>;
}

function scratch(name: string, content: Buffer | string): string {
  const path = join(mkdtempSync(join(tmpdir(), "forge-emit-")), name);
  writeFileSync(path, content);
  return path;
}

function readKicad<T>(name: string, content: string): T {
  const stdout = execFileSync("python3", [KICAD_ORACLE, scratch(name, content)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout) as T;
}

function readAltium(name: string, content: Buffer): AltiumResult {
  const stdout = execFileSync(ALTIUM_ORACLE, [scratch(name, content)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout) as AltiumResult;
}

/** The eight corner points of the solid, from the Part 21 text we emit. */
function stepBox(content: string): { x: [number, number]; y: [number, number]; z: [number, number] } | null {
  const points: Array<[number, number, number]> = [];
  for (const match of content.matchAll(/CARTESIAN_POINT\('',\(([-\d.E+]+),([-\d.E+]+),([-\d.E+]+)\)\)/g)) {
    points.push([Number(match[1]), Number(match[2]), Number(match[3])]);
  }
  if (points.length === 0) return null;
  const span = (at: 0 | 1 | 2): [number, number] => [
    Math.min(...points.map((point) => point[at])),
    Math.max(...points.map((point) => point[at]))
  ];
  return { x: span(0), y: span(1), z: span(2) };
}

const TOLERANCE_MM = 0.002;

/** Every numbered land, and then the paste apertures as a set. */
function comparePads(part: ResolvedPart, footprint: KicadFootprint, pcb: AltiumResult): string[] {
  const padDisagreements: string[] = [];
  // THE COPPER, pad by pad, in millimetres on both sides.
  //
  // NUMBERED LANDS ONLY, matched by designator. A paste aperture carries no
  // designator in either format - both emitters write several of them over one
  // thermal land - so keying on the empty string collapsed all of them onto
  // one entry and reported two hundred disagreements between a pad and an
  // unrelated aperture. They are compared as a set below instead.
  const numbered = (designator: string) => designator.trim().length > 0;
  const altiumPads = new Map((pcb.parts[0]?.pads ?? []).filter((pad) => numbered(pad.designator)).map((pad) => [pad.designator, pad]));
  for (const pad of footprint.pads.filter((pad) => numbered(pad.number))) {
    const other = altiumPads.get(pad.number);
    if (!other) {
      padDisagreements.push(`${part.partNumber}: KiCad places pad ${pad.number} and the Altium library has no such pad`);
      continue;
    }
    // Altium's y counts UP from the origin and KiCad's counts DOWN.
    const pairs: Array<[string, number, number]> = [
      ["x", pad.x, other.x / MILS_PER_MM],
      ["y", pad.y, -other.y / MILS_PER_MM],
      ["width", pad.sizeX, other.sizeX / MILS_PER_MM],
      ["height", pad.sizeY, other.sizeY / MILS_PER_MM]
    ];
    for (const [axis, mine, theirs] of pairs) {
      if (Math.abs(mine - theirs) <= TOLERANCE_MM) continue;
      padDisagreements.push(
        `${part.partNumber}: pad ${pad.number} ${axis} is ${mine.toFixed(4)} in KiCad and ${theirs.toFixed(4)} in Altium`
      );
    }
  }
  for (const designator of altiumPads.keys()) {
    if (footprint.pads.some((pad) => pad.number === designator)) continue;
    padDisagreements.push(`${part.partNumber}: the Altium library places pad ${designator} and KiCad has no such pad`);
  }
  // The apertures, as a set: same count, and each one within the same
  // tolerance as a numbered land.
  //
  // Compared numerically rather than by string. Altium stores coordinates on
  // an integer 1/10000 mil grid, so a land at 0.9125 mm comes back as 0.913
  // and a string comparison called three correct footprints a disagreement.
  const mineApertures = footprint.pads
    .filter((pad) => !numbered(pad.number))
    .map((pad) => [pad.x, pad.y, pad.sizeX, pad.sizeY] as const);
  const theirApertures = (pcb.parts[0]?.pads ?? [])
    .filter((pad) => !numbered(pad.designator))
    .map((pad) => [pad.x / MILS_PER_MM, -pad.y / MILS_PER_MM, pad.sizeX / MILS_PER_MM, pad.sizeY / MILS_PER_MM] as const);
  if (mineApertures.length !== theirApertures.length) {
    padDisagreements.push(
      `${part.partNumber}: KiCad writes ${mineApertures.length} paste apertures and Altium writes ${theirApertures.length}`
    );
  } else {
    const unmatched = theirApertures.slice();
    for (const mine of mineApertures) {
      const at = unmatched.findIndex((theirs) => mine.every((value, index) => Math.abs(value - theirs[index]) <= TOLERANCE_MM));
      if (at === -1) {
        padDisagreements.push(
          `${part.partNumber}: KiCad writes a paste aperture at ${mine[0].toFixed(3)},${mine[1].toFixed(3)} that Altium does not`
        );
        break;
      }
      unmatched.splice(at, 1);
    }
  }

  return padDisagreements;
}

/** Every symbol pin, by number, name and the end a wire connects to. */
function comparePins(part: ResolvedPart, symbol: KicadSymbol, sch: AltiumResult): string[] {
  const pinDisagreements: string[] = [];
  // THE SCHEMATIC, pin by pin. A name that differs between the two formats is
  // a net that differs between two people reviewing the same design.
  const altiumPins = new Map((sch.parts[0]?.pins ?? []).map((pin) => [pin.designator, pin]));
  for (const pin of symbol.symbols[0]?.pins ?? []) {
    const other = altiumPins.get(pin.number);
    if (!other) {
      pinDisagreements.push(`${part.partNumber}: KiCad draws pin ${pin.number} and the Altium symbol has no such pin`);
      continue;
    }
    if (other.name !== pin.name) {
      pinDisagreements.push(`${part.partNumber}: pin ${pin.number} is "${pin.name}" in KiCad and "${other.name}" in Altium`);
    }
    // ALTIUM STORES THE END THAT TOUCHES THE BODY; KiCad stores the far end,
    // which is the one a wire connects to. `schlib.ts` walks back along the
    // pin to convert, and so does this. Comparing the two stored numbers
    // directly reported all 1623 pins as disagreeing by exactly one stub.
    const bodyEndMm = other.x / MILS_PER_MM;
    const stubMm = other.length / MILS_PER_MM;
    const anchorXMm = bodyEndMm < 0 ? bodyEndMm - stubMm : bodyEndMm + stubMm;
    const pairs: Array<[string, number, number]> = [
      ["x", pin.x, anchorXMm],
      ["y", pin.y, other.y / MILS_PER_MM]
    ];
    for (const [axis, mine, theirs] of pairs) {
      if (Math.abs(mine - theirs) <= 0.02) continue;
      pinDisagreements.push(
        `${part.partNumber}: pin ${pin.number} ${axis} is ${mine.toFixed(3)} in KiCad and ${theirs.toFixed(3)} in Altium`
      );
    }
  }

  return pinDisagreements;
}

/** The solid's box against the record it claims to be. */
function compareSolid(part: ResolvedPart, content: string): string[] {
  const problems: string[] = [];
  const box = stepBox(content);
  const { bodyLengthMm, bodyWidthMm, bodyHeightMm } = part.dimensions;
  if (!box) {
    problems.push(`${part.partNumber}: the STEP file carries no points`);
    return problems;
  }
  if (bodyLengthMm === null || bodyWidthMm === null || bodyHeightMm === null) return problems;
  const checks: Array<[string, number, number]> = [
    ["length", box.x[1] - box.x[0], bodyLengthMm],
    ["width", box.y[1] - box.y[0], bodyWidthMm],
    ["height", box.z[1] - box.z[0], bodyHeightMm],
    // A part sits ON the board, not half inside it.
    ["seat", box.z[0], 0]
  ];
  for (const [what, solid, record] of checks) {
    if (Math.abs(solid - record) <= TOLERANCE_MM) continue;
    problems.push(`${part.partNumber}: the solid's ${what} is ${solid.toFixed(3)} and the record reads ${record.toFixed(3)}`);
  }
  return problems;
}

/**
 * Break each of the three comparisons on a real part and check it complains.
 *
 * Returns the checks that stayed silent, which is the only outcome that matters.
 */
function selfTest(
  part: ResolvedPart,
  footprint: KicadFootprint,
  symbol: KicadSymbol,
  pcb: AltiumResult,
  sch: AltiumResult
): string[] {
  const quiet: string[] = [];

  const movedPad = { ...footprint, pads: footprint.pads.map((pad, index) => (index === 0 ? { ...pad, x: pad.x + 1 } : pad)) };
  if (comparePads(part, movedPad, pcb).length === 0) quiet.push("a land moved by 1 mm was not reported");

  const renamed = {
    ...symbol,
    symbols: symbol.symbols.map((entry, index) =>
      index === 0 ? { ...entry, pins: entry.pins.map((pin, at) => (at === 0 ? { ...pin, name: `${pin.name}_X` } : pin)) } : entry
    )
  };
  if (comparePins(part, renamed, sch).length === 0) quiet.push("a renamed symbol pin was not reported");

  const inflated: ResolvedPart = {
    ...part,
    dimensions: {
      ...part.dimensions,
      bodyLengthMm: part.dimensions.bodyLengthMm === null ? null : part.dimensions.bodyLengthMm + 1
    }
  };
  if (part.dimensions.bodyLengthMm !== null && compareSolid(inflated, buildStepModel(part, new Date(0)).content).length === 0) {
    quiet.push("a solid 1 mm longer than its record was not reported");
  }

  return quiet;
}

async function main(): Promise<void> {
  if (!existsSync(ALTIUM_ORACLE)) {
    console.log(`The AltiumSharp reader is not built. Run "npm run oracle:build". Expected it at ${ALTIUM_ORACLE}`);
    process.exitCode = 1;
    return;
  }
  const built = await buildCachedParts();
  if (!built) {
    console.log("No extraction model configured, so no cached records can be rebuilt.");
    process.exitCode = 1;
    return;
  }

  // THE INSTRUMENT PROVES ITSELF FIRST.
  //
  // This bench reports "every pad matches" and that sentence is worth nothing
  // unless the comparison can say otherwise. This project shipped a copper check
  // for weeks that matched a pad number the emitter never emits, and it read
  // clean every time. So the first comparable part is run twice: once with a
  // land moved, a pin renamed and the solid's body inflated, and once as it is.
  // If the corrupted run comes back clean the bench refuses to report anything.
  let selfTested = false;

  const padDisagreements: string[] = [];
  const pinDisagreements: string[] = [];
  const solidProblems: string[] = [];
  let compared = 0;
  let solids = 0;
  let noSolid = 0;

  for (const entry of built) {
    const outcome = await shipOutcome(entry.record, BENCH_SETTINGS);
    const part: ResolvedPart | null = outcome.shippedPart;
    if (!part) continue;

    let kicadZip;
    let altiumZip;
    try {
      kicadZip = await JSZip.loadAsync((await createExportZip(part, "kicad", { generatedAt: new Date(0) })).buffer);
      altiumZip = await JSZip.loadAsync((await createExportZip(part, "altium", { generatedAt: new Date(0) })).buffer);
    } catch {
      continue;
    }

    const modFile = Object.keys(kicadZip.files).find((name) => name.endsWith(".kicad_mod"));
    const symFile = Object.keys(kicadZip.files).find((name) => name.endsWith(".kicad_sym"));
    const pcbFile = Object.keys(altiumZip.files).find((name) => name.endsWith(".PcbLib"));
    const schFile = Object.keys(altiumZip.files).find((name) => name.endsWith(".SchLib"));
    if (!modFile || !symFile || !pcbFile || !schFile) continue;

    if (!selfTested) {
      selfTested = true;
      const control = readKicad<KicadFootprint>("f.kicad_mod", await kicadZip.files[modFile].async("string"));
      const controlSymbol = readKicad<KicadSymbol>("s.kicad_sym", await kicadZip.files[symFile].async("string"));
      const controlPcb = readAltium("f.PcbLib", await altiumZip.files[pcbFile].async("nodebuffer"));
      const controlSch = readAltium("s.SchLib", await altiumZip.files[schFile].async("nodebuffer"));
      const failures = selfTest(part, control, controlSymbol, controlPcb, controlSch);
      if (failures.length > 0) {
        console.log(`\nTHIS BENCH CANNOT SEE THE THING IT EXISTS TO CHECK, so it reports nothing:\n`);
        for (const failure of failures) console.log(`  ${failure}`);
        console.log("");
        process.exitCode = 1;
        return;
      }
      console.log(`\nSelf-test on ${part.partNumber}: a moved land, a renamed pin and an inflated body were all reported.`);
    }

    const footprint = readKicad<KicadFootprint>("f.kicad_mod", await kicadZip.files[modFile].async("string"));
    const symbol = readKicad<KicadSymbol>("s.kicad_sym", await kicadZip.files[symFile].async("string"));
    const pcb = readAltium("f.PcbLib", await altiumZip.files[pcbFile].async("nodebuffer"));
    const sch = readAltium("s.SchLib", await altiumZip.files[schFile].async("nodebuffer"));
    if (footprint.error || symbol.error || pcb.error || sch.error) {
      padDisagreements.push(`${part.partNumber}: a reader refused the file (${footprint.error ?? pcb.error ?? symbol.error ?? sch.error})`);
      continue;
    }
    compared += 1;

    padDisagreements.push(...comparePads(part, footprint, pcb));
    pinDisagreements.push(...comparePins(part, symbol, sch));

    // THE SOLID, against the record it claims to be.
    let step;
    try {
      step = buildStepModel(part, new Date(0));
    } catch {
      noSolid += 1;
      step = null;
    }
    if (step) {
      solids += 1;
      solidProblems.push(...compareSolid(part, step.content));
    }
  }

  const report = (title: string, lines: string[], clean: string) => {
    console.log(`\n${title}\n`);
    if (lines.length === 0) {
      console.log(`  ${clean}`);
      return;
    }
    for (const line of lines.slice(0, 20)) console.log(`  ${line}`);
    if (lines.length > 20) console.log(`  ... and ${lines.length - 20} more`);
  };

  console.log(`\n${compared} parts built in BOTH formats and read back by kiutils and AltiumSharp.`);
  report("THE COPPER: does the Altium library place the same pads as the KiCad one?", padDisagreements, "Every pad matches, in position and in size.");
  report("THE SCHEMATIC: does the Altium symbol draw the same pins?", pinDisagreements, "Every pin matches, in number, name and position.");
  report(
    `THE SOLID: is the box the size the record says? (${solids} built, ${noSolid} refused for want of a body dimension)`,
    solidProblems,
    "Every solid is the record's own body, seated on the board plane."
  );
  console.log("");
}

void main();
