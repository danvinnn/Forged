import { loadBenchEnv } from "../../src/lib/__bench__/env";
loadBenchEnv();
import { buildCachedParts } from "../../src/lib/__bench__/oracle-match";
import { BENCH_SETTINGS, shipOutcome } from "../../src/lib/__bench__/shipcheck";
import { recordForPackage } from "../../src/lib/exporters";

const WANT = process.argv.slice(2);
async function main() {
  const built = await buildCachedParts();
  for (const e of built ?? []) {
    if (!WANT.includes(e.part)) continue;
    const outcome = await shipOutcome(e.record, BENCH_SETTINGS);
    const forPkg = outcome.shippedAs ? recordForPackage(e.record, outcome.shippedAs.designator) : e.record;
    const pins = forPkg.pins.value ?? [];
    const cite = forPkg.pins.citation;
    console.log(`\n${e.part}  ships as "${outcome.shippedAs?.designator}"  ${pins.length} pins  cited p${cite?.page ?? "-"}`);
    console.log(`   ${pins.map((p) => `${p.number}:${p.name}`).join("  ")}`);
  }
}
void main();
