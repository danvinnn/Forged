import { loadBenchEnv } from "../../src/lib/__bench__/env";
loadBenchEnv();
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promptFingerprint } from "../../src/lib/__bench__/modelcache";

// Does the pass that is WRONG give the same pin list to more than one package?
//
// LT1013's pass 1 hands byte-identical lists to "8-Lead Plastic SO" and
// "8-Lead PDIP", and the document's own note says those two differ. If that
// duplication separates the wrong readings from the right ones, it is a
// discriminator; if pass 1 duplicates lists all over the corpus, it is not.
const CACHE = join(process.cwd(), ".model-cache");
interface Table { packageType: string; outlineCode?: string; pins?: { number: string; name: string }[] }

function passesFor(part: string): Table[][] {
  const current = promptFingerprint();
  const out: Table[][] = [];
  for (const file of readdirSync(CACHE).sort()) {
    if (!file.startsWith(`${part}-`) || !file.endsWith(".json")) continue;
    let e: { prompt?: string; result?: { packagesInThisDocument?: Table[] } };
    try { e = JSON.parse(readFileSync(join(CACHE, file), "utf8")); } catch { continue; }
    if (e.prompt !== current) continue;
    const t = (e.result?.packagesInThisDocument ?? []).filter((x) => (x.pins ?? []).length > 0);
    if (t.length > 0) out.push(t);
  }
  return out;
}

const parts = new Set<string>();
for (const f of readdirSync(CACHE)) if (f.endsWith(".json") && f !== "_billed.json") parts.add(f.replace(/-[0-9a-f]{16}\.json$/, ""));

let dupPass1 = 0;
let dupPass2 = 0;
let totalPass1 = 0;
const examples: string[] = [];

for (const part of parts) {
  const passes = passesFor(part);
  if (passes.length === 0) continue;
  passes.forEach((tables, index) => {
    const seen = new Map<string, string[]>();
    for (const t of tables) {
      const list = JSON.stringify((t.pins ?? []).map((p) => [String(p.number), p.name]));
      seen.set(list, [...(seen.get(list) ?? []), t.packageType]);
    }
    if (index === 0) totalPass1 += tables.length;
    for (const [, names] of seen) {
      if (names.length < 2) continue;
      if (index === 0) dupPass1 += 1; else dupPass2 += 1;
      examples.push(`  pass ${index + 1}  ${part.padEnd(16)} one list on ${names.length}: ${names.join(" | ")}`);
    }
  });
}

for (const e of examples) console.log(e);
console.log(`\nOne pin list handed to SEVERAL packages within a single pass:`);
console.log(`  in pass 1   ${dupPass1} groups (of ${totalPass1} pass-1 tables)`);
console.log(`  in pass 2   ${dupPass2} groups`);
