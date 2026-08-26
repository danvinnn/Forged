import { loadBenchEnv } from "../../src/lib/__bench__/env";
loadBenchEnv();
import { buildCachedParts } from "../../src/lib/__bench__/oracle-match";
import { packageOptions } from "../../src/lib/exporters";
import { BENCH_SETTINGS } from "../../src/lib/__bench__/shipcheck";

async function main() {
  const built = await buildCachedParts();
  let offered = 0;
  let ships = 0;
  for (const e of built ?? []) {
    const choice = packageOptions(e.record, {
      formedLeadSpanMm: BENCH_SETTINGS.formedLeadSpanMm,
      formedLeadContactMm: BENCH_SETTINGS.formedLeadContactMm
    });
    if (!choice.ok) continue;
    offered += choice.options.length;
    ships += choice.options.filter((o) => o.status === "ships").length;
    if (["LT1013", "RHFL4913A", "UCC27524"].includes(e.part)) {
      console.log(`\n${e.part}:`);
      for (const o of choice.options) console.log(`   ${o.status.padEnd(12)} ${o.designator}`);
    }
  }
  console.log(`\nTOTAL offered ${offered}, of which ships ${ships}`);
}
void main();
