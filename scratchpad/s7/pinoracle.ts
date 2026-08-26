import { loadBenchEnv } from "../../src/lib/__bench__/env";
loadBenchEnv();
import { buildCachedParts } from "../../src/lib/__bench__/oracle-match";
import { PINOUT_ORACLE } from "../../src/lib/__bench__/pinout-oracle";
import { BENCH_SETTINGS, shipOutcome } from "../../src/lib/__bench__/shipcheck";

async function main() {
  const built = await buildCachedParts();
  const named = new Set(Object.keys(PINOUT_ORACLE));
  const missing: string[] = [];
  let claiming = 0;
  for (const e of built ?? []) {
    const outcome = await shipOutcome(e.record, BENCH_SETTINGS);
    if (!outcome.shipsAnswered) continue;
    const pins = e.record.pins.value?.length ?? 0;
    const perPackage = (e.record.packagesInThisDocument ?? []).some((t) => (t.pins?.length ?? 0) > 0);
    if (pins === 0 && !perPackage) continue;
    claiming += 1;
    if (!named.has(e.part)) missing.push(e.part);
  }
  console.log(`${claiming - missing.length}/${claiming} shipping parts that claim a pinout have a hand-read pin table.`);
  console.log(`missing (${missing.length}): ${missing.join(", ")}`);
}
void main();
