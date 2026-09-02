// The RETRIEVAL hold-out runner, and the only number that predicts whether a stranger's part
// number will resolve.
//
// The corpus and the rule governing it live in `holdout-corpus.ts`. Read that header before
// touching anything here. The short version: nothing in it may be tuned against, and adding a
// vendor pattern because a hold-out part missed destroys the measurement.
//
// Usage:
//   npm run bench:retrieval-holdout
//
// Network, no money. Runs the real commercial chain, one part at a time, with the same politeness
// delay `bench:coverage --live` uses. Deliberately NOT a test: gating merges on a live network
// measurement makes CI flaky for reasons unrelated to the change under review.
//
// ## Read the result alongside a `bench:coverage --live` run from the same session
//
// Search availability swings both numbers together, and it swings hard: measured 2026-09-02, the
// tuned corpus ranged 69% to 95% across a single day, entirely on which engines were answering.
// A hold-out number taken while search is degraded says nothing about generalisation. The gap
// between the two corpora on the SAME day is the signal; either number alone is not.

import { RETRIEVAL_HOLDOUT, type HoldoutPart } from "./holdout-corpus";
import type { BenchCategory } from "./corpus";

// Same delay as the coverage bench. We are an uninvited client of a dozen vendor hosts.
const DELAY_MS = 750;

interface Row {
  part: HoldoutPart;
  resolved: boolean;
  detail: string;
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;
}

async function run(part: HoldoutPart): Promise<Row> {
  // Imported lazily, matching the air-gap discipline the rest of the layer follows: this file must
  // be safe to load without pulling the network subtree into the process.
  const { makeResolver } = await import("../factory");
  const resolver = await makeResolver("commercial");
  if (!resolver) return { part, resolved: false, detail: "no resolver (mode gate)" };

  try {
    const ref = await resolver.resolve(part.partNumber, { manufacturer: part.manufacturer });
    if (!ref) return { part, resolved: false, detail: "not found" };
    return { part, resolved: true, detail: `${ref.resolvedBy ?? "?"} -> ${ref.pdfUrl ?? ref.fileName}` };
  } catch (error) {
    // A thrown error is NOT a miss and the report must not blur them. A cluster of these means
    // search was refusing us, which reads as a coverage collapse and is not one.
    return { part, resolved: false, detail: `ERROR ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function main(): Promise<void> {
  console.log("\nForge RETRIEVAL hold-out");
  console.log("parts never fitted against, chosen before any was looked up");
  console.log(`corpus: ${RETRIEVAL_HOLDOUT.length} parts\n`);

  const rows: Row[] = [];
  for (const part of RETRIEVAL_HOLDOUT) {
    rows.push(await run(part));
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  const byCategory = new Map<BenchCategory, Row[]>();
  for (const row of rows) {
    const list = byCategory.get(row.part.category) ?? [];
    list.push(row);
    byCategory.set(row.part.category, list);
  }

  console.log("category              resolved  rate");
  console.log("-".repeat(44));
  for (const [category, list] of byCategory) {
    const hits = list.filter((r) => r.resolved).length;
    console.log(`${category.padEnd(22)}${String(`${hits}/${list.length}`).padEnd(10)}${pct(hits, list.length)}`);
  }
  const total = rows.filter((r) => r.resolved).length;
  console.log("-".repeat(44));
  console.log(`${"TOTAL".padEnd(22)}${String(`${total}/${rows.length}`).padEnd(10)}${pct(total, rows.length)}\n`);

  // Errors are the operationally interesting rows and are NOT misses. Separated so a degraded
  // search session cannot be misread as a generalisation failure.
  const errors = rows.filter((r) => r.detail.startsWith("ERROR"));
  if (errors.length > 0) {
    console.log(`Could not look (${errors.length}), these are NOT misses:`);
    for (const row of errors) console.log(`  ${row.part.partNumber.padEnd(20)} ${row.detail.slice(0, 90)}`);
    console.log("");
  }

  const misses = rows.filter((r) => !r.resolved && !r.detail.startsWith("ERROR"));
  if (misses.length > 0) {
    // Listed by CATEGORY and vendor only. Naming the class is the permitted use of this output;
    // going and fixing the individual part is exactly what the hold-out rule forbids.
    console.log(`Misses (${misses.length}), grouped for finding a CLASS, not for fixing parts:`);
    for (const [category, list] of byCategory) {
      const m = list.filter((r) => !r.resolved && !r.detail.startsWith("ERROR"));
      if (m.length > 0) {
        console.log(`  ${category}: ${m.map((r) => `${r.part.partNumber} (${r.part.manufacturer})`).join(", ")}`);
      }
    }
    console.log("");
  }

  console.log("Compare against a `bench:coverage --live` run from THIS session. The gap between the");
  console.log("two corpora is the signal; either number alone moves with search availability.\n");
}

main().catch((error) => {
  console.error("retrieval hold-out failed:", error);
  process.exit(1);
});
