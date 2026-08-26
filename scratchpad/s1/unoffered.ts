import { loadBenchEnv } from "../../src/lib/__bench__/env";
loadBenchEnv();
import { buildCachedParts } from "../../src/lib/__bench__/oracle-match";
import { packageOptions } from "../../src/lib/exporters";
import { pinTableFor } from "../../src/lib/packagevariants";
import { BENCH_SETTINGS } from "../../src/lib/__bench__/shipcheck";

async function main() {
  const built = await buildCachedParts();
  let parts = 0;
  let missed = 0;
  for (const e of built ?? []) {
    const tables = (e.record.packagesInThisDocument ?? []).filter((t) => t.pins && t.pins.length > 0);
    if (tables.length === 0) continue;
    const choice = packageOptions(e.record, {
      formedLeadSpanMm: BENCH_SETTINGS.formedLeadSpanMm,
      formedLeadContactMm: BENCH_SETTINGS.formedLeadContactMm
    });
    if (!choice.ok) continue;
    const reached = new Set<string>();
    for (const o of choice.options) {
      const hit = pinTableFor(tables, o.designator);
      if (hit) reached.add(hit.packageType + "|" + (hit.outlineCode ?? ""));
    }
    const unreached = tables.filter((t) => !reached.has(t.packageType + "|" + (t.outlineCode ?? "")));
    if (unreached.length === 0) continue;
    parts += 1;
    missed += unreached.length;
    console.log(`${e.part.padEnd(16)} offers ${choice.options.length}, describes ${tables.length}, NOT OFFERED: ${unreached.map((t) => t.packageType).join(", ")}`);
  }
  console.log(`\n${parts} parts describe a package with a complete pin table that the chooser never offers. ${missed} packages in total.`);
}
void main();
