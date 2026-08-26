import { loadBenchEnv } from "../../src/lib/__bench__/env";
loadBenchEnv();
import { buildCachedParts } from "../../src/lib/__bench__/oracle-match";
async function main() {
  const built = await buildCachedParts();
  for (const e of built ?? []) {
    if (e.part !== "UCC27524") continue;
    console.log(`=== ${e.part} packageType=${JSON.stringify(e.record.packageType.value)}`);
    for (const t of e.record.packagesInThisDocument ?? []) {
      console.log(`   "${t.packageType}" code=${t.outlineCode ?? "-"} dims=${t.dimensions ? Object.keys(t.dimensions).length : 0} pins=${t.pins?.length ?? 0}`);
    }
  }
}
void main();
