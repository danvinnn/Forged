/**
 * THE TWO FLOORS IN THE PINOUT'S SECOND SOURCE, SWEPT AGAINST BOTH OBJECTIVES.
 *
 * The 2026-08-27 sweep set these constants by one number: how many pinouts came
 * back corroborated, with the hand-read oracle checking that none of them was
 * wrong. That is half a measurement. An oracle can only tell you that a reading
 * you got RIGHT was confirmed; it cannot tell you what the check would have done
 * with a reading you got WRONG, because every record in the corpus that the
 * oracle covers is one the model read correctly.
 *
 * So the sweep could not see this, and `bench:symbol` could: swap two pin names
 * on ADG1211 and the check still said confirmed, because a stray pair of
 * collinear numbers on the page picked an offset out of a single match and then
 * agreed with itself. A self-confirming sequence is invisible to an oracle and
 * obvious to a mutation.
 *
 * This scores both at once:
 *
 *   KEEPS    pinouts corroborated, and how many the oracle vouches for
 *   FALSE    corroborated pinouts the oracle contradicts    (must be 0)
 *   SWAPPED  pinouts still corroborated after two names are exchanged
 *   SHIFTED  pinouts still corroborated after the numbering is rotated by one
 *
 * The last two are the ones being bought. A setting that keeps more pinouts and
 * confirms more corruptions has not bought anything.
 *
 * Free: cached model answers and cached PDFs off disk, no network, no spend.
 */

import { loadBenchEnv } from "./env";
import { buildCachedParts, documentFor } from "./oracle-match";
import { BENCH_SETTINGS, shipOutcome } from "./shipcheck";
import { checkPinNames, entryDescribes, pinoutEntriesFor } from "./pinout-oracle";
import { pinoutEvidence, type EvidenceLimits } from "../pinevidence";
import type { PinRecord } from "../types";

loadBenchEnv();

const SEQUENCE_FLOORS = [2, 3, 4];
const SUPPORT_FLOORS = [1, 2, 3, 4];

/** Corroborated means EVERY claimed pin agrees, which is what `confirmPinout` asks. */
function corroborated(doc: Parameters<typeof pinoutEvidence>[0], pins: readonly PinRecord[], pinCount: number, limits: EvidenceLimits): boolean {
  const evidence = pinoutEvidence(doc, pins, pinCount, limits);
  return evidence !== null && evidence.agreeing.length >= pins.length;
}

function swapTwo(pins: readonly PinRecord[]): PinRecord[] | null {
  if (pins.length < 2 || pins[0].name === pins[1].name) return null;
  const out = pins.map((pin) => ({ ...pin }));
  const first = out[0].name;
  out[0].name = out[1].name;
  out[1].name = first;
  return out;
}

function rotate(pins: readonly PinRecord[]): PinRecord[] | null {
  const names = pins.map((pin) => pin.name);
  if (new Set(names).size < 2) return null;
  return pins.map((pin, index) => ({ ...pin, name: names[(index + 1) % names.length] }));
}

async function main(): Promise<void> {
  const built = await buildCachedParts();
  if (!built) {
    console.log("No extraction model configured, so no cached records can be rebuilt.");
    process.exitCode = 1;
    return;
  }

  // Gathered once. The sweep re-runs only the reader.
  const cases: Array<{
    part: string;
    doc: NonNullable<Awaited<ReturnType<typeof documentFor>>>;
    pins: PinRecord[];
    pinCount: number;
    /** null where no pinout was hand-read for this package. */
    oracleAgrees: boolean | null;
  }> = [];
  for (const entry of built) {
    const outcome = await shipOutcome(entry.record, BENCH_SETTINGS);
    const part = outcome.shippedPart;
    if (!part || part.pins.length === 0) continue;
    const doc = await documentFor(entry.part);
    if (!doc) continue;
    const oracle = pinoutEntriesFor(entry.part).filter((candidate) => entryDescribes(candidate, part.packageType, part.pinCount));
    cases.push({
      part: entry.part,
      doc,
      pins: part.pins.map((pin) => ({ ...pin })),
      pinCount: part.pinCount,
      oracleAgrees: oracle.length === 0 ? null : oracle.some((candidate) => checkPinNames(candidate, part.pins).length === 0)
    });
  }

  console.log(`\n${cases.length} parts with a pinout and a cached document.\n`);
  console.log(
    `  ${"seq".padStart(4)} ${"support".padStart(8)} ${"KEEPS".padStart(6)} ${"oracle ok".padStart(10)} ${"FALSE".padStart(6)} ${"SWAPPED".padStart(8)} ${"SHIFTED".padStart(8)}`
  );
  for (const minSequenceEntries of SEQUENCE_FLOORS) {
    for (const minOffsetSupport of SUPPORT_FLOORS) {
      const limits: EvidenceLimits = { minSequenceEntries, minOffsetSupport };
      let keeps = 0;
      let oracleOk = 0;
      let wrong = 0;
      let swapped = 0;
      let shifted = 0;
      for (const item of cases) {
        if (corroborated(item.doc, item.pins, item.pinCount, limits)) {
          keeps += 1;
          if (item.oracleAgrees === true) oracleOk += 1;
          if (item.oracleAgrees === false) wrong += 1;
        }
        const swap = swapTwo(item.pins);
        if (swap && corroborated(item.doc, swap, item.pinCount, limits)) swapped += 1;
        const turn = rotate(item.pins);
        if (turn && corroborated(item.doc, turn, item.pinCount, limits)) shifted += 1;
      }
      console.log(
        `  ${String(minSequenceEntries).padStart(4)} ${String(minOffsetSupport).padStart(8)} ${String(keeps).padStart(6)} ${String(oracleOk).padStart(10)} ${String(wrong).padStart(6)} ${String(swapped).padStart(8)} ${String(shifted).padStart(8)}`
      );
    }
  }
  console.log("");
}

void main();
