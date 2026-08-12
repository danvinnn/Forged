// Loads .env.local for the benchmarks.
//
// Next.js does this for the app, but the benches run under plain tsx and do not,
// so every model run had to be prefixed with the key on the command line. That
// is a small friction with a bad failure mode: forget it and the run silently
// reports the parser alone as though the model had been asked and declined.
//
// Only fills variables that are NOT already set, so an explicit value on the
// command line still wins.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Same order Next.js uses, most specific first. */
const FILES = [".env.local", ".env"];

export function loadBenchEnv(): void {
  for (const file of FILES) {
    const path = join(process.cwd(), file);
    if (!existsSync(path)) continue;
    for (const rawLine of readFileSync(path, "utf8").split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      if (process.env[key] !== undefined) continue;
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}
