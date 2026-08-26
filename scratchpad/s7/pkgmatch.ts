import { loadBenchEnv } from "../../src/lib/__bench__/env";
loadBenchEnv();
import { buildCachedParts } from "../../src/lib/__bench__/oracle-match";
import { PINOUT_ORACLE } from "../../src/lib/__bench__/pinout-oracle";
import { BENCH_SETTINGS, shipOutcome } from "../../src/lib/__bench__/shipcheck";
import { recordForPackage } from "../../src/lib/exporters";

// Does the oracle entry describe the package the part actually shipped as? An
// entry is keyed by PART and its `packageType` is documentation, so a part that
// settles on a different package is being scored against a pinout that is not
// its own - the exact defect that produced six false WRONGs on TSZ121.
const WANT = ["AD590","INA240","LM139AQML-SP","LT1013","OPA2277","OPA333","RHFL4913","SN74LVC1G08","STM32F103C8","STM32F407VG"];
async function main() {
  const built = await buildCachedParts();
  for (const e of built ?? []) {
    if (!WANT.includes(e.part)) continue;
    const outcome = await shipOutcome(e.record, BENCH_SETTINGS);
    const designator = outcome.shippedAs?.designator ?? null;
    const rec = designator ? recordForPackage(e.record, designator) : e.record;
    const pins = rec.pins.value ?? [];
    const entry = PINOUT_ORACLE[e.part];
    console.log(
      `${e.part.padEnd(18)} ships "${String(designator).padEnd(26)}" ${String(pins.length).padStart(3)} pins   ` +
        `oracle says "${entry.packageType ?? "(unstated)"}" ${Object.keys(entry.pins).length} pins`
    );
  }
}
void main();
