import { loadBenchEnv } from "../../src/lib/__bench__/env";
loadBenchEnv();
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promptFingerprint } from "../../src/lib/__bench__/modelcache";
import { PINOUT_ORACLE, checkPinNames, entryDescribes } from "../../src/lib/__bench__/pinout-oracle";

// WHEN THE TWO PASSES DISAGREE ABOUT ONE PACKAGE'S PIN TABLE, WHICH IS RIGHT?
//
// `mergePackageEntries` prefers pass 1, on the stated ground that pass 1 sees the
// whole document. That rule has never been measured for PER-PACKAGE tables. The
// hand-read oracle can settle it.
const CACHE = join(process.cwd(), ".model-cache");
const key = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "");

interface Table { packageType: string; outlineCode?: string; pins: { number: string; name: string }[] }

function passesFor(part: string): Table[][] {
  const current = promptFingerprint();
  const out: Table[][] = [];
  for (const file of readdirSync(CACHE).sort()) {
    if (!file.startsWith(`${part}-`) || !file.endsWith(".json")) continue;
    let entry: { prompt?: string; storedAt?: string; result?: { packagesInThisDocument?: Table[] } };
    try { entry = JSON.parse(readFileSync(join(CACHE, file), "utf8")); } catch { continue; }
    if (entry.prompt !== current) continue;
    const tables = (entry.result?.packagesInThisDocument ?? []).filter((t) => (t.pins ?? []).length > 0);
    if (tables.length > 0) out.push(tables);
  }
  return out;
}

let pairs = 0;
let disagree = 0;
let pass1Right = 0;
let pass2Right = 0;
let neither = 0;

for (const part of Object.keys(PINOUT_ORACLE)) {
  const oracle = PINOUT_ORACLE[part];
  const passes = passesFor(part);
  if (passes.length < 2) continue;
  const [first, second] = passes;
  for (const a of first) {
    // PAIRED THE WAY THE MERGE PAIRS THEM: on the drawing code where both have
    // one, else on the caption. Matching captions alone misses exactly the case
    // that matters - the two passes name the same package differently, which is
    // the whole reason `mergePackageEntries` exists.
    const b =
      second.find((t) => a.outlineCode && t.outlineCode && key(t.outlineCode) === key(a.outlineCode)) ??
      second.find((t) => key(t.packageType) === key(a.packageType));
    if (!b) continue;
    pairs += 1;
    const sameList = JSON.stringify(a.pins.map((p) => [p.number, p.name])) === JSON.stringify(b.pins.map((p) => [p.number, p.name]));
    if (sameList) continue;
    // Only judgeable where the oracle describes THIS package.
    if (!entryDescribes(oracle, a.packageType, a.pins.length)) continue;
    disagree += 1;
    const aWrong = checkPinNames(oracle, a.pins).length;
    const bWrong = checkPinNames(oracle, b.pins).length;
    const verdict = aWrong === 0 && bWrong > 0 ? "PASS 1" : bWrong === 0 && aWrong > 0 ? "PASS 2" : "neither";
    if (verdict === "PASS 1") pass1Right += 1;
    else if (verdict === "PASS 2") pass2Right += 1;
    else neither += 1;
    console.log(`${part.padEnd(16)} "${a.packageType}" vs "${b.packageType}"  pass1 ${aWrong} wrong, pass2 ${bWrong} wrong  -> ${verdict}`);
  }
}

console.log(`\n${pairs} packages answered by BOTH passes. ${disagree} disagree and are judgeable.`);
console.log(`  pass 1 right, pass 2 wrong   ${pass1Right}`);
console.log(`  pass 2 right, pass 1 wrong   ${pass2Right}`);
console.log(`  neither fully right          ${neither}`);
