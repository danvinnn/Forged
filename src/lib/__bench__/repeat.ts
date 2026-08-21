/**
 * Does the same datasheet produce the same record twice?
 *
 * `temperature: 0` narrows a model's sampling and does not make it a function.
 * Production has no answer cache, so every parse re-asks, and an engineer who
 * re-runs a part they already reviewed may get a different library. That is a
 * trust problem independent of which of the two answers is right.
 *
 * Nothing in this project has ever measured it, because the bench cache means an
 * identical request never reaches the provider twice. This deliberately
 * bypasses that: a temp cache directory in `refresh` mode, so every call is live
 * and the real corpus cache is left untouched.
 *
 *   npm run bench:repeat -- --parts LM358,DRV8825 --runs 3
 */
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractPartRecord } from "../datasheet";
import { makeExtractionModel, runExtraction } from "../extraction";
import { cachingModel } from "./modelcache";
import { loadBenchEnv } from "./env";
import { getDeploymentMode } from "../retrieval/deployment";
import { modelBudgetMs, withDeadline, worthAsking, ModelDeadlineError } from "../extraction/budget";
import type { PartRecord } from "../types";

loadBenchEnv();
if (!process.env.FORGE_LOG_LEVEL) process.env.FORGE_LOG_LEVEL = "error";

const partsFlag = process.argv.indexOf("--parts");
const PARTS = partsFlag !== -1 ? (process.argv[partsFlag + 1] ?? "").split(",").filter(Boolean) : [];
const runsFlag = process.argv.indexOf("--runs");
const RUNS = runsFlag !== -1 ? Number(process.argv[runsFlag + 1]) : 3;

/** Matches `maxDuration` on `/api/parse` and `/api/lookup`. */
const ROUTE_BUDGET_MS = 150_000;

/** Everything a user would notice changing, flattened to comparable strings. */
function fingerprint(part: PartRecord): Map<string, string> {
  const out = new Map<string, string>();
  out.set("packageType", JSON.stringify(part.packageType.value));
  out.set("pinCount", JSON.stringify(part.pinCount.value));
  for (const pin of part.pins.value ?? []) out.set(`pin.${pin.number}`, pin.name);
  for (const [field, held] of Object.entries(part.dimensions)) {
    out.set(`dim.${field}`, JSON.stringify((held as { value: unknown }).value));
  }
  for (const entry of part.packagesInThisDocument ?? []) {
    out.set(`pkg.${entry.packageType}.pins`, String((entry.pins ?? []).length));
    for (const pin of entry.pins ?? []) out.set(`pkg.${entry.packageType}.pin.${pin.number}`, pin.name);
  }
  return out;
}

function differences(a: Map<string, string>, b: Map<string, string>): string[] {
  const keys = new Set([...a.keys(), ...b.keys()]);
  const out: string[] = [];
  for (const key of [...keys].sort()) {
    const left = a.get(key) ?? "(absent)";
    const right = b.get(key) ?? "(absent)";
    if (left !== right) out.push(`${key}: ${left} -> ${right}`);
  }
  return out;
}

function pdfFor(part: string): ArrayBuffer | null {
  for (const dir of [".bench-cache", ".holdout-cache"]) {
    const path = join(process.cwd(), dir, `${part}.pdf`);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  return null;
}

async function main(): Promise<void> {
  if (PARTS.length === 0) {
    console.log("Name the parts: --parts LM358,DRV8825 [--runs 3]");
    return;
  }
  // A THROWAWAY CACHE DIRECTORY, so `refresh` cannot overwrite a real answer.
  process.env.FORGE_MODEL_CACHE_DIR = mkdtempSync(join(tmpdir(), "forge-repeat-"));
  const inner = await makeExtractionModel(getDeploymentMode());
  if (!inner) {
    console.log("No model configured, so nothing can be measured.");
    return;
  }
  let label = "";
  const model = cachingModel(inner, "refresh", () => label);

  console.log(`Re-parsing ${PARTS.length} part(s) ${RUNS} times each. Every call is live.\n`);
  let stable = 0;
  let unstable = 0;
  const allElapsed: number[] = [];

  for (const part of PARTS) {
    const pdf = pdfFor(part);
    if (!pdf) {
      console.log(`${part}: no cached PDF`);
      continue;
    }
    const prints: Array<Map<string, string>> = [];
    const elapsed: number[] = [];
    for (let run = 0; run < RUNS; run += 1) {
      label = `${part}__repeat${run}`;
      try {
        // WALL CLOCK, because the production routes give the whole model pass a
        // budget carved out of `maxDuration = 30` and abandon it on the deadline.
        // A change that improves what the model reads but pushes the pass past
        // that budget makes the product worse, not better, so stability can
        // never be read on its own.
        const startedAt = Date.now();
        const pacedBefore = model.stats.pacedMs;
        const { doc, part: deterministic } = await extractPartRecord(`${part}.pdf`, pdf);

        // THE ROUTE'S OWN DEADLINE, applied here so this measures the product.
        //
        // Until 2026-08-20 this called `runExtraction` bare, exactly as
        // `bench:extraction` and `bench:holdout` still do, and so did every
        // accuracy number this project has published. The routes wrap the pass
        // in `withDeadline` and DISCARD the whole outcome when it expires. A
        // bench that skips that is measuring a pipeline with unlimited time,
        // which is not the one users get.
        const localMs = Date.now() - startedAt - (model.stats.pacedMs - pacedBefore);
        const budgetMs = modelBudgetMs(ROUTE_BUDGET_MS, localMs);
        if (!worthAsking(budgetMs)) {
          throw new ModelDeadlineError(budgetMs);
        }
        const outcome = await withDeadline(
          runExtraction(deterministic, doc, pdf, model, `${part}.pdf`, part),
          // The limiter's sleeps are the bench's, not the product's, so they
          // must not eat the budget the product would have had.
          budgetMs + (model.stats.pacedMs - pacedBefore)
        );
        // NET OF PACING. See `CacheStats.pacedMs`: the limiter's sleeps belong to
        // the bench, not to the product, and counting them is how the extraction
        // bench came to report a 58.7s p50 that was mostly rate limiting.
        elapsed.push(Date.now() - startedAt - (model.stats.pacedMs - pacedBefore));
        prints.push(fingerprint(outcome?.part ?? deterministic));
      } catch (error) {
        console.log(`  ${part} run ${run + 1} FAILED: ${(error as Error).message.slice(0, 80)}`);
      }
    }
    allElapsed.push(...elapsed);
    if (prints.length < 2) {
      console.log(`${part}: fewer than two runs completed, so nothing is comparable.`);
      continue;
    }
    const drifted: string[] = [];
    for (let i = 1; i < prints.length; i += 1) drifted.push(...differences(prints[0], prints[i]));
    const unique = [...new Set(drifted)];
    if (unique.length === 0) {
      stable += 1;
      console.log(`${part.padEnd(18)} IDENTICAL across ${prints.length} runs (${prints[0].size} values)`);
    } else {
      unstable += 1;
      console.log(`${part.padEnd(18)} ${unique.length} value(s) DIFFERED across ${prints.length} runs:`);
      for (const line of unique.slice(0, 12)) console.log(`     ${line}`);
      if (unique.length > 12) console.log(`     ... and ${unique.length - 12} more`);
    }
  }

  console.log(`\nstable ${stable}   unstable ${unstable}`);
  if (allElapsed.length > 0) {
    const sorted = [...allElapsed].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.floor(sorted.length * q)];
    // ROUTE_BUDGET_MS - RESPONSE_MARGIN_MS, less the second or two of local
    // work measured across this corpus. See `budget.ts`.
    const BUDGET_MS = ROUTE_BUDGET_MS - 3_000;
    const over = sorted.filter((ms) => ms > BUDGET_MS).length;
    console.log(
      `wall clock per parse: p50 ${at(0.5)}ms  p90 ${at(0.9)}ms  max ${sorted[sorted.length - 1]}ms`
    );
    console.log(
      `  ${over}/${sorted.length} parse(s) exceeded the ~${BUDGET_MS / 1000}s the routes allow, ` +
        `and a route abandons the WHOLE pass on that deadline.`
    );
  }
  const spent = (model.stats.inputTokens / 1e6) * 0.3 + (model.stats.outputTokens / 1e6) * 2.5;
  console.log(
    `${model.stats.misses} live call(s), ${model.stats.inputTokens.toLocaleString()} in / ` +
      `${model.stats.outputTokens.toLocaleString()} out, roughly $${spent.toFixed(2)}.`
  );
  console.log("NOTE: a temp cache directory was used, so this spend is NOT in the main ledger.");
}

main();
