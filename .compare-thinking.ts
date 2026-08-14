// Compares two thinking budgets on the SAME parts and the SAME prompt.
//
// Reads the bench model cache rather than re-running anything, so it costs
// nothing and can be re-run while measurements are still landing.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = process.env.FORGE_MODEL_CACHE_DIR || ".model-cache";
const A = process.argv[2];
const B = process.argv[3];

type Entry = { label: string; model: string; in: number; out: number; fields: string[]; notes: string[] };
const entries: Entry[] = [];
for (const file of readdirSync(DIR).filter((n) => n.endsWith(".json"))) {
  const e = JSON.parse(readFileSync(join(DIR, file), "utf8"));
  if (!e?.usage) continue;
  entries.push({
    label: e.label,
    model: e.model,
    in: e.usage.inputTokens,
    out: e.usage.outputTokens,
    fields: Object.keys(e.result?.values ?? {}),
    notes: e.result?.notes ?? []
  });
}

function side(model: string) {
  const rows = entries.filter((e) => e.model === model);
  const byPart = new Map<string, Set<string>>();
  let tin = 0, tout = 0;
  for (const r of rows) {
    tin += r.in;
    tout += r.out;
    const set = byPart.get(r.label) ?? new Set<string>();
    for (const f of r.fields) set.add(f);
    byPart.set(r.label, set);
  }
  return { rows, byPart, tin, tout };
}

const a = side(A);
const b = side(B);
const IN = 0.3 / 1e6, OUT = 2.5 / 1e6;

for (const [name, s] of [[A, a], [B, b]] as const) {
  const fields = [...s.byPart.values()].reduce((n, set) => n + set.size, 0);
  console.log(
    `${name.padEnd(38)} ${String(s.rows.length).padStart(3)} calls  ` +
      `${String(s.tin).padStart(8)} in / ${String(s.tout).padStart(7)} out  ` +
      `$${(s.tin * IN + s.tout * OUT).toFixed(4)}  ` +
      `${fields} fields over ${s.byPart.size} parts`
  );
}

if (a.rows.length > 0 && b.rows.length > 0) {
  console.log(`\noutput tokens: ${Math.round((1 - b.tout / a.tout) * 100)}% fewer with ${B}`);
  console.log(`cost:          ${Math.round((1 - (b.tin * IN + b.tout * OUT) / (a.tin * IN + a.tout * OUT)) * 100)}% cheaper\n`);
}

// Per part, which fields each side got. This is the number that decides it: a
// cheaper run that reads less is not cheaper, it is worse.
const parts = [...a.byPart.keys()].filter((k) => b.byPart.has(k)).sort();
console.log("part              A fields  B fields   only A                     only B");
for (const part of parts) {
  const fa = a.byPart.get(part) ?? new Set<string>();
  const fb = b.byPart.get(part) ?? new Set<string>();
  const onlyA = [...fa].filter((f) => !fb.has(f));
  const onlyB = [...fb].filter((f) => !fa.has(f));
  const flag = onlyA.length > 0 ? " <-- LOST" : "";
  console.log(
    `${part.padEnd(17)} ${String(fa.size).padStart(6)} ${String(fb.size).padStart(9)}   ` +
      `${onlyA.join(",").slice(0, 25).padEnd(26)} ${onlyB.join(",").slice(0, 25)}${flag}`
  );
}
