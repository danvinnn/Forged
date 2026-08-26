import { loadBenchEnv } from "../../src/lib/__bench__/env";
loadBenchEnv();
import { DIMENSION_ORACLE } from "../../src/lib/__bench__/dimension-oracle";

// Would "a gullwing land span must exceed the body" ever be WRONG about a
// hand-read drawing? Every entry that carries both a printed footprint and a
// body is a test case, and the oracle is the answer key.
let checked = 0;
let holds = 0;
for (const [code, entry] of Object.entries(DIMENSION_ORACLE)) {
  const lands = [entry.land, ...(entry.landAlternatives ?? [])].filter((l) => l !== undefined);
  if (lands.length === 0) continue;
  const body = entry.bodyWidthMm;
  const bodyLen = entry.bodyLengthMm;
  if (!body) continue;
  for (const land of lands) {
    checked += 1;
    const ok = land!.spanMm > body.maxMm;
    if (ok) holds += 1;
    else
      console.log(
        `${code.padEnd(28)} ${String(entry.leadForm).padEnd(9)} span ${land!.spanMm}  bodyWidth ${body.minMm}-${body.maxMm}  bodyLength ${bodyLen?.minMm}-${bodyLen?.maxMm}`
      );
  }
}
console.log(`\n${holds}/${checked} printed land patterns have a centre span greater than the body width.`);
