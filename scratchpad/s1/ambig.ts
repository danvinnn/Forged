import { loadBenchEnv } from "../../src/lib/__bench__/env";
loadBenchEnv();
import { buildCachedParts } from "../../src/lib/__bench__/oracle-match";
import { pinTableFor } from "../../src/lib/packagevariants";
async function main() {
  const built = await buildCachedParts();
  for (const e of built ?? []) {
    if (e.part !== "UCC27524") continue;
    for (const name of ["HVSSOP (DGN)", "VSSOP (DGN)", "HVSSOP (DGN) [DGN0008G]"]) {
      const hit = pinTableFor(e.record.packagesInThisDocument, name);
      console.log(`${name.padEnd(28)} -> ${hit ? `${hit.packageType} code=${hit.outlineCode ?? "-"}` : "null"}`);
    }
    console.log("variants:", e.record.packageVariants.map((v) => v.designator).join(" | "));
  }
}
void main();
