/**
 * When the two extraction passes disagree about a pinout, which one is right?
 *
 * `combine` keeps pass 1's pin table only where the two passes cite DIFFERENT
 * pages. Where they cite the same page and disagree about the NAMES, pass 2 wins
 * silently. This measures how often that happens and what each pass said, so the
 * tie-break is chosen from the corpus rather than argued for.
 *
 * Free: reads the answer cache off disk, no network, no spend.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { modelCacheDir, promptFingerprint } from "./modelcache";

interface Pin {
  number?: unknown;
  name?: unknown;
}

/** Every cached answer for the CURRENT prompt, grouped by part. */
function answersByPart(): Map<string, Array<{ pins: Pin[]; page: unknown; file: string }>> {
  const dir = modelCacheDir();
  const current = promptFingerprint();
  const out = new Map<string, Array<{ pins: Pin[]; page: unknown; file: string }>>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json") && !name.startsWith("_"))) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    // The stored key is `prompt`, not `promptFingerprint`. Checked against a
    // real file rather than assumed: the first version of this guessed and
    // reported "0 parts have a cached pinout" for a cache holding thousands.
    if (entry.prompt !== current) continue;
    const result = (entry.result ?? {}) as Record<string, unknown>;
    const values = (result.values ?? {}) as Record<string, { value?: unknown; page?: unknown }>;
    const claimed = values.pins;
    if (!claimed || !Array.isArray(claimed.value) || claimed.value.length === 0) continue;
    const part = file.replace(/-[0-9a-f]{16}\.json$/, "");
    out.set(part, [...(out.get(part) ?? []), { pins: claimed.value as Pin[], page: claimed.page, file }]);
  }
  return out;
}

const names = (pins: Pin[]) => pins.map((pin) => String(pin.name ?? ""));
const distinct = (pins: Pin[]) => new Set(names(pins).map((name) => name.trim())).size;
/** Pins whose names collide, which is a netlist error unless the part really shares a net. */
const collisions = (pins: Pin[]) => pins.length - distinct(pins);

function main(): void {
  const byPart = answersByPart();
  const disagreed: string[] = [];
  let same = 0;
  let moreDistinctWins = 0;
  let ties = 0;

  console.log(`\nCached pinouts under the current prompt, by part. No network, no spend.\n`);
  for (const [part, answers] of [...byPart].sort()) {
    if (answers.length < 2) continue;
    const [a, b] = answers;
    if (names(a.pins).join("|") === names(b.pins).join("|")) {
      same += 1;
      continue;
    }
    const better = distinct(a.pins) === distinct(b.pins) ? null : distinct(a.pins) > distinct(b.pins) ? a : b;
    if (better) moreDistinctWins += 1;
    else ties += 1;
    disagreed.push(
      `  ${part.padEnd(22)} pages ${String(a.page).padEnd(4)}/${String(b.page).padEnd(4)} ` +
        `distinct ${distinct(a.pins)}/${distinct(b.pins)} of ${a.pins.length}/${b.pins.length} ` +
        `collisions ${collisions(a.pins)}/${collisions(b.pins)}`
    );
    // The names that differ, so a person can see WHICH reading is the better one.
    const changed = names(a.pins)
      .map((name, index) => (name === names(b.pins)[index] ? null : `${index + 1}: ${name} vs ${names(b.pins)[index]}`))
      .filter((line): line is string => line !== null);
    if (changed.length > 0) disagreed.push(`      ${changed.slice(0, 6).join("   ")}`);
  }

  console.log(`  ${byPart.size} part(s) have a cached pinout; ${same} agree across passes, ${disagreed.length > 0 ? "and:" : "none disagree."}\n`);
  for (const line of disagreed) console.log(line);
  console.log(
    `\n  Of the disagreements, ${moreDistinctWins} have one pass with strictly more distinct names ` +
      `and ${ties} are level on that measure.\n`
  );
}

if (process.argv[1]?.endsWith("passes.ts")) {
  main();
}
