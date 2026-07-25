// Coverage benchmark runner.
//
// Two modes, because they answer different questions and have very different costs:
//
//   static (default)  Asks: which corpus parts does the manufacturer registry CLAIM? No network,
//                     deterministic, safe in CI. This is the number that moves when we add a vendor
//                     pattern, so it is the one to watch while developing.
//
//   live (--live)     Asks: which corpus parts do we actually RESOLVE, end to end, through the real
//                     chain? Hits vendor sites and search engines, so it is slow, rate-limited by
//                     politeness, and its result depends on where it runs. Run it from the target
//                     host, because the interesting question (how often search is blocked) has a
//                     different answer on a laptop than in a datacenter.
//
// Usage:
//   npm run bench:coverage
//   npm run bench:coverage -- --live
//   npm run bench:coverage -- --live --category radhard-major
//
// Deliberately NOT a test. It is a report, and gating merges on a live network measurement would
// make CI flaky for reasons that have nothing to do with the change under review.

import { BENCH_CORPUS, corpusByCategory, type BenchCategory, type BenchPart } from "./corpus";
import { buildCandidateUrls } from "../resolvers/manufacturer";

const LIVE = process.argv.includes("--live");
const categoryArg = (() => {
  const i = process.argv.indexOf("--category");
  return i >= 0 ? (process.argv[i + 1] as BenchCategory | undefined) : undefined;
})();

// Politeness delay between live lookups. We are an uninvited client of ti.com and st.com, and
// hammering them from one IP is both rude and the fastest way to get the pattern resolver blocked.
const LIVE_DELAY_MS = 750;

interface Row {
  part: BenchPart;
  resolved: boolean;
  detail: string;
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;
}

// Static: does any vendor pattern produce a candidate for this part?
function staticRow(part: BenchPart): Row {
  const { claimed, speculative } = buildCandidateUrls(part.partNumber, part.manufacturer);
  if (claimed.length > 0) {
    return { part, resolved: true, detail: `claimed (${claimed.length} candidates)` };
  }
  if (speculative.length > 0) {
    return { part, resolved: false, detail: `speculative only (${speculative.length})` };
  }
  return { part, resolved: false, detail: "no candidates" };
}

async function liveRow(part: BenchPart): Promise<Row> {
  // Imported lazily so the static path never pulls the network subtree into the process, matching
  // the air-gap discipline the rest of the layer follows.
  const { makeResolver } = await import("../factory");
  const resolver = await makeResolver("commercial");
  if (!resolver) return { part, resolved: false, detail: "no resolver (mode gate)" };

  try {
    const ref = await resolver.resolve(part.partNumber, part.manufacturer ? { manufacturer: part.manufacturer } : undefined);
    if (!ref) return { part, resolved: false, detail: "not found" };
    return { part, resolved: true, detail: `${ref.resolvedBy ?? "?"} -> ${ref.pdfUrl ?? ref.fileName}` };
  } catch (error) {
    // A thrown error is NOT the same as a miss, and the report must not blur them: "we could not
    // check" and "this part has no datasheet" lead to completely different follow-up work.
    return { part, resolved: false, detail: `ERROR ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function main(): Promise<void> {
  const parts = categoryArg ? BENCH_CORPUS.filter((p) => p.category === categoryArg) : BENCH_CORPUS;

  if (parts.length === 0) {
    console.error(`No parts for category "${categoryArg}". Known categories:`);
    for (const key of corpusByCategory().keys()) console.error(`  ${key}`);
    process.exit(1);
  }

  console.log(`\nForge Layer 1 coverage benchmark`);
  console.log(`mode: ${LIVE ? "LIVE (network)" : "static (no network)"}`);
  console.log(`corpus: ${parts.length} parts\n`);

  const rows: Row[] = [];
  for (const part of parts) {
    if (LIVE) {
      rows.push(await liveRow(part));
      await new Promise((r) => setTimeout(r, LIVE_DELAY_MS));
    } else {
      rows.push(staticRow(part));
    }
  }

  // Per-category breakdown. Coverage is not one number: "62% overall" hides that we are excellent
  // at analog and at zero for connectors, and those imply completely different next moves.
  const byCategory = new Map<BenchCategory, Row[]>();
  for (const row of rows) {
    const list = byCategory.get(row.part.category) ?? [];
    list.push(row);
    byCategory.set(row.part.category, list);
  }

  console.log("category              covered   rate");
  console.log("-".repeat(44));
  for (const [category, list] of byCategory) {
    const hits = list.filter((r) => r.resolved).length;
    console.log(`${category.padEnd(22)}${String(`${hits}/${list.length}`).padEnd(10)}${pct(hits, list.length)}`);
  }

  const totalHits = rows.filter((r) => r.resolved).length;
  console.log("-".repeat(44));
  console.log(`${"TOTAL".padEnd(22)}${String(`${totalHits}/${rows.length}`).padEnd(10)}${pct(totalHits, rows.length)}\n`);

  // Surprises in both directions. An unexpected HIT matters as much as an unexpected miss: it
  // usually means a pattern generalizes further than we assumed, which is free coverage we did not
  // know we had.
  const surprises = rows.filter((r) => (r.part.expect === "hit") !== r.resolved);
  if (surprises.length > 0) {
    console.log(`Surprises (${surprises.length}), expectation vs result:`);
    for (const row of surprises) {
      const direction = row.resolved ? "UNEXPECTED HIT " : "UNEXPECTED MISS";
      console.log(`  ${direction}  ${row.part.partNumber.padEnd(18)} ${row.detail}`);
    }
    console.log("");
  }

  if (LIVE) {
    const errors = rows.filter((r) => r.detail.startsWith("ERROR"));
    if (errors.length > 0) {
      // Errors are the operationally interesting rows. A cluster of them usually means search
      // backends are blocked from this host, which reads as a coverage problem but is not one.
      console.log(`Errors (${errors.length}), these are NOT misses:`);
      for (const row of errors) console.log(`  ${row.part.partNumber.padEnd(18)} ${row.detail}`);
      console.log("");
    }
  }

  console.log("Misses by category, for deciding what to add next:");
  for (const [category, list] of byCategory) {
    const misses = list.filter((r) => !r.resolved).map((r) => r.part.partNumber);
    if (misses.length > 0) console.log(`  ${category}: ${misses.join(", ")}`);
  }
  console.log("");
}

main().catch((error) => {
  console.error("benchmark failed:", error);
  process.exit(1);
});
