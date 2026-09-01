/**
 * WHAT THE SYMBOL ACTUALLY CLAIMS ABOUT EACH PIN'S ELECTRICAL TYPE.
 *
 * `bench:symbol` found that nothing in the product vouches for this value: set
 * every pin on every part to `power` and not one check, gate or confirmation
 * changes its mind. Before deciding what to do about that, the exposure has to
 * be measured, because two very different situations produce the same finding.
 *
 * If the types are real readings, an unchecked one is a value shipping silently
 * and THE INVARIANT applies to it. If they are all `unspecified`, nothing is
 * being claimed at all and the problem is the opposite one: a symbol whose pins
 * carry no type gives the schematic tool nothing to run an electrical rule check
 * against, which is most of what a symbol is for.
 *
 * Free: cached model answers off disk, no network, no spend.
 */

import { loadBenchEnv } from "./env";
import { buildCachedParts } from "./oracle-match";
import { BENCH_SETTINGS, shipOutcome } from "./shipcheck";
import type { PinElectricalType } from "../types";

loadBenchEnv();

async function main(): Promise<void> {
  const built = await buildCachedParts();
  if (!built) {
    console.log("No extraction model configured, so no cached records can be rebuilt.");
    process.exitCode = 1;
    return;
  }
  const counts = new Map<PinElectricalType, number>();
  let pins = 0;
  let parts = 0;
  let allUnspecified = 0;
  let anyTyped = 0;
  // A PART TYPED HALF WAY is the case that decides whether the type can drive
  // anything. A symbol where some power pins are recognised and others are not
  // is worse than one where none are: two pins that do the same job are drawn
  // differently, and the difference means nothing.
  let fully = 0;
  let partly = 0;
  const partial: string[] = [];

  for (const entry of built) {
    const outcome = await shipOutcome(entry.record, BENCH_SETTINGS);
    const part = outcome.shippedPart;
    if (!part || part.pins.length === 0) continue;
    parts += 1;
    let typed = 0;
    for (const pin of part.pins) {
      pins += 1;
      counts.set(pin.electricalType, (counts.get(pin.electricalType) ?? 0) + 1);
      if (pin.electricalType !== "unspecified") typed += 1;
    }
    if (typed === 0) {
      allUnspecified += 1;
    } else {
      anyTyped += 1;
      if (typed === part.pins.length) fully += 1;
      else {
        partly += 1;
        if (partial.length < 10) partial.push(`${part.partNumber}: ${typed} of ${part.pins.length} pins typed`);
      }
    }
  }

  console.log(`\n${pins} pins on ${parts} parts.\n`);
  for (const [type, count] of [...counts].sort((left, right) => right[1] - left[1])) {
    console.log(`  ${type.padEnd(18)} ${String(count).padStart(6)}  ${((count / pins) * 100).toFixed(1)}%`);
  }
  console.log(`\n  parts with at least one typed pin   ${anyTyped}`);
  console.log(`  parts where every pin is unspecified ${allUnspecified}`);
  console.log(`\n  Of the parts that state ANY type, how complete is it?`);
  console.log(`    every pin typed   ${fully}`);
  console.log(`    only some typed   ${partly}   <- a symbol half of which the schematic tool can check\n`);
  for (const line of partial.slice(0, 10)) console.log(`      ${line}`);
  console.log("");
}

void main();
