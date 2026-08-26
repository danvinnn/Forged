import { loadBenchEnv } from "../../src/lib/__bench__/env";
loadBenchEnv();
import { buildCachedParts } from "../../src/lib/__bench__/oracle-match";
import { BENCH_SETTINGS, shipOutcome } from "../../src/lib/__bench__/shipcheck";
import { buildFootprintGeometry, recordForPackage } from "../../src/lib/exporters";
import { resolveForExport } from "../../src/lib/types";
import { densityOf } from "../../src/lib/settings";

async function main() {
  const want = process.argv.slice(2);
  const built = await buildCachedParts();
  for (const e of built ?? []) {
    if (!want.includes(e.part)) continue;
    const outcome = await shipOutcome(e.record, BENCH_SETTINGS);
    console.log(`\n=== ${e.part}  ships=${outcome.ships} answered=${outcome.shipsAnswered} as=${outcome.shippedAs?.designator} code=${outcome.shippedAs?.outlineCode}`);
    console.log(`    why=${outcome.why}`);
    const forPackage = outcome.shippedAs ? recordForPackage(e.record, outcome.shippedAs.designator) : e.record;
    const resolved = resolveForExport(forPackage);
    if (!resolved.ok) { console.log("    record does not resolve:", resolved.missing); continue; }
    try {
      const geo = buildFootprintGeometry(resolved.part, densityOf(BENCH_SETTINGS));
      console.log(`    pads ${geo.pads.length}, courtyard ${JSON.stringify(geo.courtyard ?? null).slice(0,80)}`);
      for (const p of geo.pads.slice(0, 6)) console.log(`      ${JSON.stringify(p)}`);
    } catch (error) {
      console.log(`    refused: ${(error as Error).message.slice(0, 200)}`);
    }
  }
}
void main();
