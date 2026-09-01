/**
 * CAN WE TELL A POWER PIN FROM ITS NAME, AND HOW OFTEN ARE WE TOLD OUTRIGHT?
 *
 * ## The question this answers
 *
 * Counted over the official KiCad library on 2026-08-29: 99.5% of its 208
 * operational-amplifier symbols and 99.8% of its 2841 microcontroller symbols
 * put their POWER pins on the top and bottom edges and their signal pins on the
 * left and right. Our generator puts every pin on the left or the right. That is
 * not a matter of taste - it is what an engineer expects to see, and KLC S4.3
 * states it - so the default is worth revisiting.
 *
 * Doing it needs one thing we may not have: which pins are the power pins.
 * `bench:pintypes` measures that the document states a type on 21 of 107 parts.
 * The remaining question is whether the NAME can be trusted where the document
 * is silent, and that is not a thing to reason about. It is a thing to score
 * against the parts where the document DID say.
 *
 * PRECISION is what matters here, not recall. A signal pin dragged to the power
 * rail is a symbol that lies about the part; a power pin left on the side is
 * merely the layout we already ship.
 *
 * Free: cached model answers off disk, no network, no spend.
 */

import { loadBenchEnv } from "./env";
import { buildCachedParts } from "./oracle-match";
import { BENCH_SETTINGS, shipOutcome } from "./shipcheck";

loadBenchEnv();

/**
 * Names that are a supply rail and nothing else.
 *
 * Deliberately short. Every entry is a name whose meaning is fixed across every
 * manufacturer in the corpus, with the A/D/P qualifiers those rails are printed
 * with. `EN`, `REF`, `BIAS` and `VREF` are absent on purpose: they name a pin
 * that carries a voltage without being a supply, and putting one on the power
 * rail would be an invention.
 */
const SUPPLY = /^(?:[AD]?(?:VCC|VDD|VSS|VEE|VBAT|VBUS|VDDA|VSSA|VDDIO|VSSIO)|GND|[ADP]GND|GNDA|V\+|V-|VS\+|VS-|\+VS|-VS)$/i;

function looksLikeSupply(name: string): boolean {
  return SUPPLY.test(name.trim().replace(/\s+/g, ""));
}

async function main(): Promise<void> {
  const built = await buildCachedParts();
  if (!built) {
    console.log("No extraction model configured, so no cached records can be rebuilt.");
    process.exitCode = 1;
    return;
  }

  let statedPins = 0;
  let statedParts = 0;
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  const wrong: string[] = [];
  const missed: string[] = [];
  let partsWithSupply = 0;
  let parts = 0;

  for (const entry of built) {
    const outcome = await shipOutcome(entry.record, BENCH_SETTINGS);
    const part = outcome.shippedPart;
    if (!part || part.pins.length === 0) continue;
    parts += 1;
    if (part.pins.some((pin) => looksLikeSupply(pin.name))) partsWithSupply += 1;

    const stated = part.pins.filter((pin) => pin.electricalType !== "unspecified");
    if (stated.length === 0) continue;
    statedParts += 1;
    for (const pin of stated) {
      statedPins += 1;
      const isPower = pin.electricalType === "power";
      const guess = looksLikeSupply(pin.name);
      if (guess && isPower) truePositive += 1;
      else if (guess && !isPower) {
        falsePositive += 1;
        if (wrong.length < 12) wrong.push(`${part.partNumber} pin ${pin.number} "${pin.name}" is ${pin.electricalType}`);
      } else if (!guess && isPower) {
        falseNegative += 1;
        if (missed.length < 12) missed.push(`${part.partNumber} pin ${pin.number} "${pin.name}"`);
      }
    }
  }

  const precision = truePositive + falsePositive === 0 ? 0 : truePositive / (truePositive + falsePositive);
  const recall = truePositive + falseNegative === 0 ? 0 : truePositive / (truePositive + falseNegative);

  console.log(`\nScored on ${statedPins} pins across ${statedParts} parts whose document states an electrical type.\n`);
  console.log(`  the name says supply and the document agrees   ${truePositive}`);
  console.log(`  the name says supply and the document does NOT ${falsePositive}   <- a signal pin moved to the power rail`);
  console.log(`  the document says power and the name does not  ${falseNegative}   <- left on the side, as today`);
  console.log(`\n  precision ${(precision * 100).toFixed(1)}%    recall ${(recall * 100).toFixed(1)}%\n`);
  if (wrong.length > 0) {
    console.log("  Called supply and is not:");
    for (const line of wrong) console.log(`    ${line}`);
  }
  if (missed.length > 0) {
    console.log("  Power and the name does not say so:");
    for (const line of missed) console.log(`    ${line}`);
  }
  console.log(`\n  Parts with at least one pin the name rule calls a supply: ${partsWithSupply} of ${parts}\n`);
}

void main();
