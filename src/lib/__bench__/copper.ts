/**
 * Does the emitted COPPER match what it was built from?
 *
 * ## Why this is a different question from every other check here
 *
 * `bench:dimensions` asks whether the numbers we READ are right. `bench:replay`
 * asks whether a bundle comes out. `validateGeometry` asks whether the footprint
 * contradicts itself. Between them there is a gap, and it is the one that
 * matters most: nothing measures the pads BACK OUT and asks whether they sit
 * where the record said they should.
 *
 * That gap is where every wrong footprint this product has produced has lived.
 * A TO-220 came out as two opposing rows; a thermal pad came out rotated ninety
 * degrees from its own body; a rectangular quad came out square. Every one of
 * them passed self-consistency, because the arrangement was internally coherent
 * and simply not the one the datasheet described.
 *
 * ## What it asserts
 *
 * Only things that follow from the record, so it needs no oracle entry and runs
 * over every cached part:
 *
 *   PITCH    adjacent lands in a row sit exactly `pitchMm` apart
 *   SPAN     opposing rows sit `landSpanMm` apart, centre to centre
 *   SIZE     every land is the size the land pattern specified
 *   PAD      the exposed pad's long axis runs along the body's long axis
 *   EP SIZE  the exposed pad is the size the record read for it
 *
 * Where `DIMENSION_ORACLE` has a `land` entry it additionally compares the
 * emitted span and pad size against the hand-read drawing, which is the only
 * check in the project that closes the loop from a printed footprint to copper.
 *
 * Air-gap safe and free: cached answers off disk, no network, no spend.
 */

import { buildFootprintGeometry, FootprintUnavailableError } from "../exporters";
import { DIMENSION_ORACLE } from "./dimension-oracle";
import { declaredLeadCount, PACKAGE_FAMILY_PATTERN, sameOutlineCode } from "../packagevariants";
import { isStitched, replayRecords } from "./replay";
import { thermalPadNumber } from "../geometry";
import type { Pad } from "../geometry";
import type { ResolvedPart } from "../types";

/**
 * How far a land may sit from where the record put it.
 *
 * A tenth of the smallest feature anyone draws. This is not a manufacturing
 * tolerance: the generator is arithmetic over the record's own numbers, so
 * anything past rounding is a different answer rather than a looser one.
 */
const EPSILON_MM = 0.005;

interface Finding {
  part: string;
  check: string;
  detail: string;
}

const near = (a: number, b: number) => Math.abs(a - b) <= EPSILON_MM;

/**
 * Lands grouped into the rows they were placed in.
 *
 * Grouped by the coordinate they SHARE rather than by pin order, because pin
 * order is what a wrong arrangement gets wrong. A row is a set of lands with a
 * common centre on one axis; a two-sided package has two, a quad has four, and a
 * single row has one.
 */
function rows(pads: Pad[], axis: "x" | "y"): Map<number, Pad[]> {
  const byLine = new Map<number, Pad[]>();
  for (const pad of pads) {
    const coordinate = axis === "x" ? pad.centre.xMm : pad.centre.yMm;
    // Grouped by PROXIMITY, at the coordinate's full precision.
    //
    // This rounded to a hundredth to keep floating point from splitting one row
    // in two, and then kept the ROUNDED value as the row's position. A row at
    // +/- 1.9125 came out as +/- 1.91 and the span read 3.82 against a record
    // saying 3.825, which this bench duly reported as a defect in the product.
    // A measuring instrument may not round the thing it is measuring.
    const found = [...byLine.keys()].find((existing) => near(existing, coordinate));
    const line = found ?? coordinate;
    byLine.set(line, [...(byLine.get(line) ?? []), pad]);
  }
  return byLine;
}

/** Gaps between neighbouring lands along one row, smallest first. */
function gaps(pads: Pad[], axis: "x" | "y"): number[] {
  const coords = pads.map((pad) => (axis === "x" ? pad.centre.xMm : pad.centre.yMm)).sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 1; i < coords.length; i += 1) out.push(coords[i] - coords[i - 1]);
  return out;
}

/**
 * Does the footprint claim to BE the datasheet's printed pattern?
 *
 * The record can carry a printed land that the generator then declined to use:
 * `Discards` throws a proven figure away whole when its own bounds reject it,
 * and IPC-7351B computes the pattern instead. Comparing emitted copper against a
 * discarded reading would report the discard as a defect, which is the check
 * being wrong about which question it is asking.
 *
 * So the printed land is only asserted where the footprint says the lands ARE
 * the printed land. Where it says IPC, the correctness question is the one the
 * ORACLE answers, and this bench's job is the arrangement.
 */
export function usesPrintedLand(source: string): boolean {
  return source.includes("printed in this datasheet");
}

/**
 * The hand-read entry for this part's drawing, by code or by name.
 *
 * Two ways because the outline code is itself a model reading and often comes
 * back null. `sameOutlineCode` rather than equality so a decorated code
 * ("CASE 751-07" against "751-07") still matches, and so a DIFFERING trailing
 * character ("D0008A" against "D0014A") still does not.
 */
export function oracleFor(part: ResolvedPart) {
  const byPart = Object.values(DIMENSION_ORACLE).find(
    (entry) =>
      entry.parts.some((name) => name.toUpperCase() === part.partNumber.split("#")[0].toUpperCase()) &&
      // AND IT HAS TO BE ABOUT THE PACKAGE THAT SHIPPED.
      //
      // A part list says "this part reads this drawing", and it is wrong the
      // moment a multi-package datasheet resolves somewhere else. TXB0104 ships
      // a 14-pin SOIC whose copper matches its hand-read footprint exactly, and
      // the by-name route handed back a 14-terminal WQFN: 5.4 mm against 2.3,
      // reported as wrong copper on a footprint that is right.
      //
      // Same gate `entryDescribes` applies in `pinout-oracle.ts`, added there
      // after the identical mistake produced five false failures in one run. A
      // bench that scores the wrong package does not report a defect, it
      // manufactures one.
      describesPackage(entry.packageType, part.packageType)
  );
  if (byPart) return byPart;
  const code = part.packageOutlineCode;
  if (!code) return undefined;
  const key = Object.keys(DIMENSION_ORACLE).find((name) => sameOutlineCode(name, code));
  return key ? DIMENSION_ORACLE[key] : undefined;
}

/**
 * Is an entry's own package name about the designator a part shipped as?
 *
 * Compared on FAMILY and on stated lead count rather than on spelling, because
 * an entry writes `SOIC (14)` where a record writes `SOIC (D)`. Either being
 * silent is not a disagreement: a partial name is not evidence of a different
 * package.
 */
function describesPackage(entryName: string | undefined, designator: string): boolean {
  if (!entryName) return true;
  const family = (value: string) => {
    const found = [...value.toUpperCase().matchAll(new RegExp(PACKAGE_FAMILY_PATTERN, "gi"))].map((match) => match[0]);
    return found.length > 0 ? found[found.length - 1].toUpperCase() : null;
  };
  const mine = family(entryName);
  const theirs = family(designator);
  if (mine !== null && theirs !== null && mine !== theirs) return false;
  const myLeads = declaredLeadCount(entryName);
  const theirLeads = declaredLeadCount(designator);
  return myLeads === null || theirLeads === null || myLeads === theirLeads;
}

function checkPart(
  part: ResolvedPart,
  pads: Pad[],
  source: string,
  declined: string[],
  stitched: string[]
): Finding[] {
  const findings: Finding[] = [];
  const record = (check: string, detail: string) => findings.push({ part: part.partNumber, check, detail });

  // THE LEAD LANDS ONLY. The exposed thermal pad is copper too, but it is not a
  // land: `landPadLengthMm` and `landPadWidthMm` describe one LEAD land, and the
  // pad is built from `thermalPadLengthMm`/`thermalPadWidthMm` by a different
  // path. Comparing the two produced this bench's only finding for a day -
  // "LTC6563 land 25 is 1.65 x 3.65, record says 0.7 x 0.25" - which is a
  // correctly built 3.65 x 1.65 thermal pad measured against the lead land's
  // size. One false finding in a report of one makes the report useless.
  //
  // Excluded by NUMBER rather than by size or position: `emitThermalPad` numbers
  // the pad `pinCount + 1` and `geometryViolations` requires exactly that, so it
  // is the one identification that cannot drift. `EP` is kept for records that
  // carry a vendor label.
  const padNumber = thermalPadNumber(part.pinCount);
  const lands = pads.filter(
    (pad) =>
      pad.number !== "EP" &&
      pad.mounting === "smd" &&
      !(part.exposedPad && pad.number === padNumber)
  );
  if (lands.length === 0) return findings;

  // WHICH AXIS THE ROWS RUN ALONG, decided from the copper rather than assumed.
  //
  // The first version of this assumed it and got it backwards: the placer puts a
  // two-sided package's rows at x = +/- span/2 with the pitch stepping along y,
  // and grouping the other way turns one land from each row into a "row" whose
  // "pitch" is the span. It reported 454 findings, every one of them the bench
  // being wrong about the product. An instrument states its own convention or it
  // measures itself.
  //
  // A ROW is a set of lands sharing a coordinate, and the real rows are the
  // BIGGEST such sets: an eight-land SOIC gives two groups of four grouped by x
  // and four groups of two grouped by y, and only the first pair are rows. A quad
  // ties on both axes, which is correct, because a quad has rows on both.
  const grouped = { x: rows(lands, "x"), y: rows(lands, "y") };
  const widest = Math.max(
    ...[...grouped.x.values()].map((group) => group.length),
    ...[...grouped.y.values()].map((group) => group.length)
  );

  const pitch = part.dimensions.pitchMm;
  for (const axis of ["x", "y"] as const) {
    const along = axis === "x" ? "y" : "x";
    for (const [line, inRow] of grouped[axis]) {
      if (inRow.length !== widest || inRow.length < 2) continue;
      if (pitch === null) continue;
      // NEIGHBOURING lands only. A vacant slot on a package that has one is a
      // real gap of two pitches, so a whole multiple is not a defect.
      for (const gap of gaps(inRow, along)) {
        const multiple = gap / pitch;
        if (Math.abs(multiple - Math.round(multiple)) > EPSILON_MM / pitch) {
          record(
            "PITCH",
            `row at ${axis}=${line}: neighbouring lands ${gap.toFixed(4)} mm apart, which is ` +
              `${multiple.toFixed(3)} pitches of ${pitch}`
          );
          break;
        }
      }
    }
  }

  // THE SPAN, measured between the rows rather than taken from the record.
  //
  // `landSpanMm` is the x spread and `landSpanCrossMm` the y spread, which is the
  // placer's own convention and is stated here because it is not deducible from
  // the field names.
  for (const [axis, expected] of [
    ["x", part.dimensions.landSpanMm],
    ["y", part.dimensions.landSpanCrossMm]
  ] as const) {
    if (expected === null || expected === undefined) continue;
    if (!usesPrintedLand(source)) continue;
    const lines = [...grouped[axis]].filter(([, group]) => group.length === widest).map(([line]) => line);
    if (lines.length < 2) continue;
    const measured = Math.max(...lines) - Math.min(...lines);
    if (!near(measured, expected)) {
      record("SPAN", `${axis} axis: rows ${measured.toFixed(4)} mm apart, record says ${expected}`);
    }
  }

  // THE LAND SIZE. `landPadLengthMm` is measured outward from the package
  // centre, so on the row axis it is the land's extent along that outward
  // direction; `landPadWidthMm` runs across the row.
  const padLength = part.dimensions.landPadLengthMm;
  const padWidth = part.dimensions.landPadWidthMm;
  if (padLength !== null && padWidth !== null && usesPrintedLand(source)) {
    for (const pad of lands) {
      const sizes = [pad.widthMm, pad.heightMm].sort((a, b) => a - b);
      const wanted = [padLength, padWidth].sort((a, b) => a - b);
      if (!near(sizes[0], wanted[0]) || !near(sizes[1], wanted[1])) {
        record(
          "SIZE",
          `land ${pad.number} is ${pad.widthMm} x ${pad.heightMm}, record says ${padLength} x ${padWidth}`
        );
        break;
      }
    }
  }

  // THE EXPOSED PAD'S AXIS. It shipped turned ninety degrees on 2026-08-16 and
  // still fitted between the lead rows, which is why nothing caught it.
  //
  // IDENTIFIED THE WAY THE EXCLUSION ABOVE IDENTIFIES IT, which is by number.
  // This looked for `pad.number === "EP"` and `emitThermalPad` numbers the pad
  // `pinCount + 1`, so it matched nothing: **the check written to stop a rotated
  // thermal pad shipping had never run, on any part, since the day it was
  // added.** The file's own comment ninety lines up says which number the
  // emitter uses, and this line disagreed with it.
  //
  // Found 2026-08-25 by forcing the condition true and getting zero findings.
  // A check that cannot fail is worse than no check: it reports a clean sheet
  // for something nobody is looking at.
  const thermalPad = pads.find((pad) => part.exposedPad && pad.number === padNumber);
  const ep = thermalPad ?? pads.find((pad) => pad.number === "EP");
  const epLength = part.dimensions.thermalPadLengthMm;
  const epWidth = part.dimensions.thermalPadWidthMm;
  const bodyLength = part.dimensions.bodyLengthMm;
  const bodyWidth = part.dimensions.bodyWidthMm;
  if (ep && epLength !== null && epWidth !== null && bodyLength !== null && bodyWidth !== null) {
    // The pad is on the underside of the body, so the two describe the same
    // object from the same side: whichever body axis is longer, the pad's longer
    // axis runs the same way. Equal bodies say nothing and are skipped.
    if (!near(bodyLength, bodyWidth) && !near(epLength, epWidth)) {
      const bodyLengthIsY = true; // `bodyLengthMm` runs along the rows, which the placer steps along y.
      const bodyLongAxisIsY = bodyLength > bodyWidth ? bodyLengthIsY : !bodyLengthIsY;
      const padLongAxisIsY = ep.heightMm > ep.widthMm;
      if (bodyLongAxisIsY !== padLongAxisIsY) {
        record(
          "PAD",
          `exposed pad is ${ep.widthMm} x ${ep.heightMm} under a body of ${bodyLength} x ${bodyWidth}: ` +
            `its long axis runs across the body's`
        );
      }
    }
  }

  // AND THE PAD'S SIZE, not just its axis.
  //
  // The axis check above has been here since the pad shipped rotated ninety
  // degrees, and it only ever asked which way round the pad is. Nothing asked
  // whether it is the size the record says. That is copper - on a QFN it is the
  // largest single piece of copper in the footprint and the one the part is
  // soldered by - built from two values that were READ, on a path of its own
  // that none of the land checks above touch.
  //
  // `thermalPadLengthMm` runs along the same axis as `bodyLengthMm`, which the
  // placer steps along Y, so it is the pad's HEIGHT and the width is its X. The
  // axis mapping is stated because this codebase has paid three times for a
  // convention held in one module.
  if (ep && epLength !== null && epWidth !== null) {
    if (!near(ep.heightMm, epLength) || !near(ep.widthMm, epWidth)) {
      record(
        "EP SIZE",
        `exposed pad emitted ${ep.widthMm} x ${ep.heightMm}, record says ${epWidth} x ${epLength} (width x length)`
      );
    }
  }

  // AND AGAINST THE HAND-READ DRAWING, where one exists. This is the only path
  // in the project that runs from a printed footprint all the way to copper.
  //
  // Matched by outline code OR by the entry's `parts` list, the same two ways
  // `oracleCovers` matches in `bench:extraction`. Keying on the code alone meant
  // this check was silently skipped for every record that carries no code, which
  // on the replay corpus is most of them: DRV8825's emitted span went unchecked
  // against its own hand-read drawing for exactly that reason.
  const oracle = oracleFor(part);
  // NOT ON A STITCHED RECORD. This check compares emitted copper against a
  // hand-read drawing, which is a claim about what the READER got, and a record
  // assembled from two prompt versions is not evidence about any run.
  //
  // It manufactured one on 2026-08-22: ADXL345 was reported as emitting 2.290
  // against a printed 2.195. Three cached answers read that part correctly and
  // one stale one read it wrong; the stale one was newest, so it won the field.
  // The live pipeline reads it correctly and `bench:dimensions`, which runs the
  // real pipeline against the current prompt, says so.
  if (oracle?.land && isStitched(part.partNumber)) {
    stitched.push(part.partNumber);
  } else if (oracle?.land) {
    const lines = [...grouped.x].filter(([, group]) => group.length === widest).map(([line]) => line);
    if (lines.length >= 2) {
      const measured = Math.max(...lines) - Math.min(...lines);
      if (!near(measured, oracle.land.spanMm)) {
        // A DEFECT only where the footprint claims to BE the printed pattern.
        //
        // Where the generator computed the pattern instead, a difference from the
        // vendor's drawing is not a defect: IPC-7351B and a vendor's own pattern
        // legitimately differ, and both DRV8825 (5.876 against 5.8) and ADXL345
        // (2.290 against 2.195) sit inside a tenth of a millimetre. Reporting
        // those as wrong copper would make this bench cry wolf on its two most
        // interesting rows.
        //
        // Still SAID, because each one means the datasheet printed a pattern and
        // the generator declined it. That is worth knowing and nothing else
        // reports it.
        if (usesPrintedLand(source)) {
          record(
            "ORACLE SPAN",
            `emitted ${measured.toFixed(4)} mm, drawing prints ${oracle.land.spanMm} (${oracle.land.source})`
          );
        } else {
          declined.push(
            `${part.partNumber.padEnd(18)} computed ${measured.toFixed(3)} mm, this datasheet prints ${oracle.land.spanMm} ` +
              `(${(measured - oracle.land.spanMm >= 0 ? "+" : "") + (measured - oracle.land.spanMm).toFixed(3)} mm)`
          );
        }
      }
    }
  }

  return findings;
}

function main(): void {
  const findings: Finding[] = [];
  /** Parts whose datasheet printed a pattern the generator did not use. Not defects. */
  const declined: string[] = [];
  /** Parts whose record mixed prompt versions, so the oracle comparison is not evidence. */
  const stitched: string[] = [];
  let built = 0;
  let printed = 0;
  let refused = 0;

  for (const part of replayRecords()) {
    let pads: Pad[];
    let source = "";
    try {
      const built = buildFootprintGeometry(part, "B");
      pads = built.pads;
      source = built.provenance.source;
    } catch (error) {
      // A refusal is not this bench's subject. It measures the copper that IS
      // emitted, and `bench:replay` already counts what is not.
      if (!(error instanceof FootprintUnavailableError)) {
        refused += 1;
        // NAMED, not counted. A footprint that fails to build for a reason that
        // is not a refusal is a defect, and a tally of them is a number nobody
        // can act on.
        findings.push({
          part: part.partNumber,
          check: "BUILD",
          detail: error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 240) : String(error)
        });
      }
      continue;
    }
    built += 1;
    if (usesPrintedLand(source)) printed += 1;
    findings.push(...checkPart(part, pads, source, declined, stitched));
  }

  console.log(`\nMeasured the emitted pads of ${built} footprints. No network, no spend.`);
  console.log(
    `  ${printed} built from the datasheet's own printed footprint, ${built - printed} computed from IPC-7351B.\n`
  );
  if (findings.length === 0) {
    console.log("  No disagreement between the copper and the record it was built from.\n");
  } else {
    for (const finding of findings) {
      console.log(`  ${finding.check.padEnd(11)} ${finding.part.padEnd(18)} ${finding.detail}`);
    }
    console.log(`\n  ${findings.length} finding(s). Every one is copper that does not match its own record.\n`);
  }
  if (refused > 0) console.log(`  ${refused} part(s) failed to build for a reason that was not a refusal.\n`);
  if (stitched.length > 0) {
    console.log(
      `  ${stitched.length} footprint(s) have a hand-read drawing but a record stitched from more than one\n` +
        `  prompt version, so their span was NOT compared against it. ` +
        `bench:dimensions checks these on the real pipeline.\n`
    );
  }
  if (declined.length > 0) {
    console.log(`  ${declined.length} footprint(s) were COMPUTED although this datasheet prints its own pattern:`);
    for (const line of declined) console.log(`    ${line}`);
    console.log("    Not defects. Each one is a printed pattern the generator's own bounds rejected.\n");
  }
}

if (process.argv[1]?.endsWith("copper.ts")) {
  main();
}
