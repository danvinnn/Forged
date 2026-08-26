import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promptFingerprint } from "../../src/lib/__bench__/modelcache";

// The same lookup `questions.ts` uses, probed directly so the HELD/DROPPED
// split is checked against a field the model demonstrably answered.
function modelAnswered(part: string, field: string): boolean {
  const dir = join(process.cwd(), ".model-cache");
  const current = promptFingerprint();
  const key = `dimensions.${field}`;
  for (const file of readdirSync(dir)) {
    if (!file.startsWith(`${part}-`) || !file.endsWith(".json")) continue;
    const entry = JSON.parse(readFileSync(join(dir, file), "utf8"));
    if (entry.prompt !== current) continue;
    const values = entry.result?.values ?? {};
    if (values[key]?.value !== undefined && values[key]?.value !== null) return true;
  }
  return false;
}

for (const [part, field] of [["AD8232", "pitchMm"], ["AD8232", "landSpanMm"], ["LIS3DH", "bodyLengthMm"], ["LIS3DH", "landPadWidthMm"]] as const) {
  console.log(`${part}.${field}: model answered = ${modelAnswered(part, field)}`);
}
