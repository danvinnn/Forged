/**
 * THE NUMBER: how much does a user have to check, per part?
 *
 * ## Why this is the only figure that matters now
 *
 * Every metric this project has published counts what we produced. READ counts
 * fields that came back non-null, SHIPS counts parts that export. Neither asks
 * the question the product is actually judged on, which is: when a user takes
 * these files, how many of the numbers in them do they have to go and verify
 * themselves?
 *
 * The answer used to be "all of them or none of them, and nobody knows which".
 * `confirm.ts` states the rule - no value ships silently unless two independent
 * sources agree on it - and this measures the consequence.
 *
 * Anthony's gate, 2026-08-27:
 *
 *     no part ever shows more than 5
 *     most parts show 0            target 80% of parts
 *     average under 1 per part
 *
 * ## And whether the rule can be trusted
 *
 * A confirmation is worth nothing if it confirms things that are wrong. So the
 * second half of this run takes every part with a hand-read pinout in
 * `PINOUT_ORACLE` and asks: of the pinouts this said were CONFIRMED, how many
 * carry a name the oracle disagrees with? That is the false-confirmation rate,
 * and it is the number that decides whether the mechanism ships at all.
 *
 * Free and offline: reads the model cache and the PDF cache, makes no request.
 */

import { loadBenchEnv } from "./env";
import { buildCachedParts, documentFor } from "./oracle-match";
import { BENCH_SETTINGS, shipOutcome } from "./shipcheck";
import { checkPinNames, entryDescribes, pinoutEntriesFor } from "./pinout-oracle";
import { oracleFor, usesPrintedLand } from "./copper";
import { isStitched } from "./replay";
import { thermalPadNumber } from "../geometry";
import { confirmations, MAX_FLAGGED, type Confirmation } from "../confirm";
import { buildFootprintGeometry } from "../exporters";
import { densityOf } from "../settings";

loadBenchEnv();

interface Row {
  part: string;
  designator: string;
  flagged: Confirmation[];
  items: Confirmation[];
  /** Oracle verdict on the pinout, where a hand-read one exists. */
  pinoutTruth: "agrees" | "DISAGREES" | null;
  pinoutState: Confirmation["state"];
  /** Oracle verdict on the COPPER, where a hand-read footprint exists. */
  copperTruth: "agrees" | "DISAGREES" | null;
  copperState: Confirmation["state"];
}

/**
 * HOW FAR the emitted copper may sit from the hand-read drawing, in mm.
 *
 * A drawing prints two decimal places, so anything past a hundredth is a
 * different number. The same bound `bench:copper` uses, for the same comparison.
 */
const EPSILON_MM = 0.005;

/**
 * Does the copper this bundle emits match the footprint a person read off the
 * page?
 *
 * The only ground truth the project has for the pads, and the second half of the
 * question `bench:confirm` exists to ask. A CONFIRMED land pattern that does not
 * match its own drawing is a false confirmation: wrong copper the product told
 * nobody to check, which is the one outcome that would make the whole mechanism
 * worse than nothing.
 *
 * Null where there is no hand-read footprint, or where the record was stitched
 * from several prompt versions and is therefore evidence about no run at all.
 *
 * Compared on the toe-to-toe span of the widest row, which is what
 * `bench:copper` compares and the dimension a misread decimal point distorts
 * first. Only the span: the oracle's pad sizes are already checked there, and a
 * second implementation of a comparison is a second answer to one question.
 */
function copperAgreesWithDrawing(
  part: import("../types").ResolvedPart,
  geometry: FootprintGeometryLike
): "agrees" | "DISAGREES" | null {
  const oracle = oracleFor(part);
  if (!oracle?.land || isStitched(part.partNumber)) return null;
  const padNumber = part.exposedPad ? thermalPadNumber(part.pinCount) : null;
  const lands = geometry.pads.filter((pad) => pad.number !== padNumber);
  if (lands.length < 2) return null;

  // The rows that share an x, and the widest of them: those are the two the
  // span separates.
  const byLine = new Map<number, number>();
  for (const pad of lands) {
    const line = [...byLine.keys()].find((existing) => Math.abs(existing - pad.centre.xMm) <= EPSILON_MM);
    byLine.set(line ?? pad.centre.xMm, (byLine.get(line ?? pad.centre.xMm) ?? 0) + 1);
  }
  const widest = Math.max(...byLine.values());
  const lines = [...byLine].filter(([, count]) => count === widest).map(([line]) => line);
  if (lines.length < 2) return null;
  const measured = Math.max(...lines) - Math.min(...lines);

  // A COMPUTED pattern is allowed to differ from the vendor's: IPC-7351B and a
  // vendor's own drawing legitimately do, and `bench:copper` says so at length.
  // It is judged against the tolerance the corroboration itself accepted, so
  // this asks exactly what the confirmation claimed and nothing more.
  const bound = usesPrintedLand(geometry.provenance.source) ? EPSILON_MM : 0.12;
  return Math.abs(measured - oracle.land.spanMm) <= bound ? "agrees" : "DISAGREES";
}

type FootprintGeometryLike = ReturnType<typeof buildFootprintGeometry>;

function bar(count: number, width: number): string {
  return "#".repeat(Math.max(0, Math.min(width, count)));
}

async function main(): Promise<void> {
  const built = await buildCachedParts();
  if (!built) {
    console.log("No extraction model configured, so no cached records can be rebuilt.");
    process.exitCode = 1;
    return;
  }

  const rows: Row[] = [];
  const unshipped: string[] = [];

  for (const entry of built) {
    const outcome = await shipOutcome(entry.record, BENCH_SETTINGS);
    const part = outcome.shippedPart;
    if (!part) {
      unshipped.push(`${entry.part}: ${outcome.why}`);
      continue;
    }
    let geometry;
    try {
      geometry = buildFootprintGeometry(
        part,
        densityOf(BENCH_SETTINGS),
        BENCH_SETTINGS.formedLeadSpanMm,
        undefined,
        BENCH_SETTINGS.formedLeadContactMm
      );
    } catch {
      // A part the chooser shipped by answering questions cannot be rebuilt from
      // the bare record here. Reported rather than skipped silently: an
      // unmeasured part is not a passing one.
      unshipped.push(`${entry.part}: shipped only after answering, so its copper is not rebuilt here`);
      continue;
    }

    const doc = await documentFor(entry.part);
    const report = confirmations(part, geometry, doc);

    // THE ORACLE'S VERDICT ON THE SAME PINOUT, where one was hand-read.
    const oracle = pinoutEntriesFor(entry.part).filter((candidate) =>
      entryDescribes(candidate, part.packageType, part.pinCount)
    );
    const pinoutTruth =
      oracle.length === 0
        ? null
        : oracle.some((candidate) => checkPinNames(candidate, part.pins).length === 0)
          ? ("agrees" as const)
          : ("DISAGREES" as const);

    rows.push({
      part: entry.part,
      designator: part.packageType,
      flagged: report.flagged,
      items: report.items,
      pinoutTruth,
      pinoutState: report.items.find((item) => item.id === "pinout")!.state,
      copperTruth: copperAgreesWithDrawing(part, geometry),
      copperState: report.items.find((item) => item.id === "land-pattern")!.state
    });
  }

  rows.sort((left, right) => right.flagged.length - left.flagged.length || left.part.localeCompare(right.part));

  console.log(`\nFLAGGED VALUES PER PART, over ${rows.length} shipping parts\n`);
  const histogram = new Map<number, number>();
  for (const row of rows) histogram.set(row.flagged.length, (histogram.get(row.flagged.length) ?? 0) + 1);
  const highest = Math.max(...rows.map((row) => row.flagged.length), 0);
  for (let count = 0; count <= highest; count += 1) {
    const parts = histogram.get(count) ?? 0;
    const share = rows.length > 0 ? Math.round((parts / rows.length) * 100) : 0;
    console.log(`  ${count} flagged  ${String(parts).padStart(3)} parts  ${String(share).padStart(3)}%  ${bar(parts, 60)}`);
  }

  const total = rows.reduce((sum, row) => sum + row.flagged.length, 0);
  const clean = rows.filter((row) => row.flagged.length === 0).length;
  const over = rows.filter((row) => row.flagged.length > MAX_FLAGGED);
  const mean = rows.length > 0 ? total / rows.length : 0;
  console.log("");
  console.log(`  worst part        ${highest}                   gate: never above ${MAX_FLAGGED}   ${highest <= MAX_FLAGGED ? "MET" : "MISSED"}`);
  console.log(`  nothing to check  ${clean}/${rows.length} (${Math.round((clean / Math.max(1, rows.length)) * 100)}%)      gate: 80%              ${clean / Math.max(1, rows.length) >= 0.8 ? "MET" : "MISSED"}`);
  console.log(`  average per part  ${mean.toFixed(2)}                gate: under 1.00       ${mean < 1 ? "MET" : "MISSED"}`);
  if (over.length > 0) {
    console.log(`\n  ${over.length} part(s) over the budget and therefore REFUSED:`);
    for (const row of over) console.log(`    ${row.part} (${row.flagged.length})`);
  }

  console.log(`\nWHAT IS FLAGGED, by value\n`);
  const byId = new Map<string, { label: string; flagged: number; confirmed: number }>();
  for (const row of rows) {
    for (const item of row.items) {
      const seen = byId.get(item.id) ?? { label: item.label, flagged: 0, confirmed: 0 };
      if (item.state === "flagged") seen.flagged += 1;
      else seen.confirmed += 1;
      byId.set(item.id, seen);
    }
  }
  for (const [id, seen] of [...byId].sort((left, right) => right[1].flagged - left[1].flagged)) {
    const asked = seen.flagged + seen.confirmed;
    console.log(
      `  ${id.padEnd(14)} ${String(seen.flagged).padStart(3)} flagged of ${String(asked).padStart(3)}  ` +
        `${String(Math.round((seen.confirmed / Math.max(1, asked)) * 100)).padStart(3)}% confirmed  ${seen.label}`
    );
  }

  // THE WORK QUEUE. Flags grouped by the reason they were raised, because a
  // reason is a class and a class is what gets fixed. RULES.md rule 4.
  console.log(`\nWHY, grouped\n`);
  const byReason = new Map<string, string[]>();
  for (const row of rows) {
    for (const item of row.flagged) {
      const key = `${item.id}/${item.because ?? "unstated"}`;
      byReason.set(key, [...(byReason.get(key) ?? []), row.part]);
    }
  }
  for (const [key, parts] of [...byReason].sort((left, right) => right[1].length - left[1].length)) {
    console.log(`  ${String(parts.length).padStart(3)}  ${key.padEnd(36)} ${parts.slice(0, 8).join(" ")}${parts.length > 8 ? " ..." : ""}`);
  }

  // ## IS A CONFIRMATION WORTH ANYTHING?
  //
  // Against the hand-read pinouts, which are the only ground truth this project
  // has. A confirmed pinout the oracle disagrees with is a FALSE CONFIRMATION and
  // is the one outcome that would make the whole mechanism worse than nothing:
  // it is a wrong netlist that the product has told the user not to check.
  const judged = rows.filter((row) => row.pinoutTruth !== null);
  const falseConfirm = judged.filter((row) => row.pinoutState === "confirmed" && row.pinoutTruth === "DISAGREES");
  const falseFlag = judged.filter((row) => row.pinoutState === "flagged" && row.pinoutTruth === "agrees");
  console.log(`\nPINOUT CONFIRMATION against ${judged.length} hand-read pinouts\n`);
  console.log(`  confirmed and the oracle agrees      ${judged.filter((r) => r.pinoutState === "confirmed" && r.pinoutTruth === "agrees").length}`);
  console.log(`  CONFIRMED AND THE ORACLE DISAGREES   ${falseConfirm.length}   <- a wrong netlist we told nobody to check`);
  console.log(`  flagged and the oracle disagrees     ${judged.filter((r) => r.pinoutState === "flagged" && r.pinoutTruth === "DISAGREES").length}`);
  console.log(`  flagged though the oracle agrees     ${falseFlag.length}   <- a glance we did not have to ask for`);
  for (const row of falseConfirm) console.log(`    FALSE CONFIRMATION  ${row.part} (${row.designator})`);
  if (falseFlag.length > 0) {
    console.log(`  asked unnecessarily: ${falseFlag.map((row) => row.part).join(", ")}`);
  }

  // ## AND THE SAME QUESTION FOR THE COPPER.
  //
  // The pinout has an oracle and so do the pads, and until this ran only half
  // the mechanism had been validated against ground truth. A CONFIRMED land
  // pattern that does not match its own hand-read drawing is wrong copper the
  // product told nobody to check.
  const measured = rows.filter((row) => row.copperTruth !== null);
  const falseCopper = measured.filter((row) => row.copperState === "confirmed" && row.copperTruth === "DISAGREES");
  const falseCopperFlag = measured.filter((row) => row.copperState === "flagged" && row.copperTruth === "agrees");
  console.log(`\nCOPPER CONFIRMATION against ${measured.length} hand-read footprints\n`);
  console.log(`  confirmed and the drawing agrees     ${measured.filter((r) => r.copperState === "confirmed" && r.copperTruth === "agrees").length}`);
  console.log(`  CONFIRMED AND THE DRAWING DISAGREES  ${falseCopper.length}   <- wrong copper we told nobody to check`);
  console.log(`  flagged and the drawing disagrees    ${measured.filter((r) => r.copperState === "flagged" && r.copperTruth === "DISAGREES").length}`);
  console.log(`  flagged though the drawing agrees    ${falseCopperFlag.length}   <- a glance we did not have to ask for`);
  for (const row of falseCopper) console.log(`    FALSE CONFIRMATION  ${row.part} (${row.designator})`);

  console.log(`\nEVERY PART, worst first\n`);
  for (const row of rows) {
    console.log(`  ${String(row.flagged.length)}  ${row.part.padEnd(18)} ${row.designator.slice(0, 26).padEnd(27)} ${row.flagged.map((item) => item.id).join(" ")}`);
  }

  if (unshipped.length > 0) {
    console.log(`\nNOT MEASURED, because nothing shipped to measure (${unshipped.length})\n`);
    for (const line of unshipped) console.log(`  ${line}`);
  }
}

void main();
