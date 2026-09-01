/**
 * A SECOND blind corpus, fetched from the web and never opened.
 *
 * ## Why a second one
 *
 * `bench:holdout` is the honest number this project quotes, and it has done its
 * job: its parts have been read, argued with and, in three cases this week,
 * flagged by a new check. Every time a hold-out document is opened to settle a
 * question it becomes a little less blind, and the rule that it is never opened
 * to diagnose a failure is what has kept it worth anything.
 *
 * This corpus exists so that rule can keep being obeyed. It was assembled on
 * 2026-08-28 by fetching datasheets straight off vendor sites for parts that
 * appear in neither corpus, weighted towards the vendors the existing ones are
 * thinnest on: Frontgrade's ceramic rad-hard parts, Diodes, Nexperia, Renesas
 * and Microsemi, alongside TI devices in packages nothing here has seen.
 *
 * THE SAME RULE APPLIES TO IT. Nothing in `.blind-cache/` is tuned against, and
 * no document in it is opened to diagnose a failure. A finding here is reported
 * as a number and a class, never fixed by looking.
 *
 * ## What it measures
 *
 * The same three things the hold-out does, by the same definitions, from the
 * same shared `classify`:
 *
 *     READ     did we get a pinout out of the document at all
 *     SHIPS    does a bundle come out, unaided and then after questions
 *     FLAGGED  how many things does the user have to check, per part
 *
 *   npm run bench:blind -- --offline     free, replays whatever is cached
 *   npm run bench:blind -- --estimate    prints what a live run would cost
 *   npm run bench:blind                  live, and it spends money
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { extractPartRecord } from "../datasheet";
import { makeExtractionModel, runExtraction } from "../extraction";
import { modelBudgetMs, withDeadline } from "../extraction/budget";
import { getDeploymentMode } from "../retrieval/deployment";
import { cachingModel, ModelCacheMiss, preRunProjection, type CacheMode, type CachingModel } from "./modelcache";
import { classify } from "./readclassify";
import { withPrintedFootprint } from "../readout";
import { BENCH_SETTINGS, shipOutcome } from "./shipcheck";
import { confirmations } from "../confirm";
import { buildFootprintGeometry } from "../exporters";
import { densityOf } from "../settings";
import { loadBenchEnv } from "./env";
import { solderJoint } from "../solderjoint";
import type { DatasheetText } from "../pdftext";
import type { PartRecord } from "../types";

loadBenchEnv();

const CORPUS = join(process.cwd(), ".blind-cache");
const CACHE_MODE: CacheMode = process.argv.includes("--offline")
  ? "offline"
  : process.argv.includes("--estimate")
    ? "estimate"
    : process.argv.includes("--refresh")
      ? "refresh"
      : "use";

/** The same route budget the product works to, so a pass here is a pass there. */
const ROUTE_BUDGET_MS = 300_000;

let sharedModel: CachingModel | null | undefined;
let currentLabel = "";

async function benchModel(): Promise<CachingModel | null> {
  if (sharedModel !== undefined) return sharedModel;
  let inner = await makeExtractionModel(getDeploymentMode());
  if (!inner && (CACHE_MODE === "offline" || CACHE_MODE === "estimate")) {
    inner = {
      name: "gemini",
      isConfigured: () => true,
      extract: async () => {
        throw new Error("offline stub model must never be called");
      }
    };
  }
  sharedModel = inner ? cachingModel(inner, CACHE_MODE, () => currentLabel) : null;
  return sharedModel;
}

async function main(): Promise<void> {
  if (!existsSync(CORPUS)) {
    console.log(`\nNo corpus at ${CORPUS}. Nothing to measure.\n`);
    return;
  }
  const files = readdirSync(CORPUS).filter((name) => name.endsWith(".pdf")).sort();
  console.log(`\n${files.length} datasheets in the blind corpus, none of them ever opened.\n`);

  const model = await benchModel();
  // PRINTED IN `--estimate` TOO, which is the mode whose whole purpose is to
  // show the bill before it is run up. The hold-out prints this only when it can
  // actually spend, and copying that verbatim made `--estimate` print nothing at
  // all: the one mode that exists to answer "what will this cost" answered
  // silence.
  if (model) console.log(preRunProjection({ parts: files.length, callsPerPart: 2, modelName: model.name }));
  if (CACHE_MODE === "estimate") return;

  const reasons = new Map<string, string[]>();
  const shipRefusals = new Map<string, string[]>();
  const flagged: number[] = [];
  const flagReasons = new Map<string, string[]>();
  const jointFindings: string[] = [];
  const shipped: Array<{ part: string; designator: string; questions: number }> = [];
  let read = 0;
  let ships = 0;
  let uncached = 0;

  for (const file of files) {
    const name = file.replace(/\.pdf$/, "");
    const bytes = readFileSync(join(CORPUS, file));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    let record: PartRecord;
    let doc: DatasheetText | null = null;
    try {
      const extracted = await extractPartRecord(file, buffer);
      record = extracted.part;
      doc = extracted.doc;
      if (model) {
        currentLabel = name;
        try {
          const pacedBefore = model.stats.pacedMs;
          const startedAt = Date.now();
          const outcome = await withDeadline(
            runExtraction(record, extracted.doc, buffer, model, file),
            modelBudgetMs(ROUTE_BUDGET_MS, Date.now() - startedAt) + (model.stats.pacedMs - pacedBefore)
          );
          if (outcome) record = outcome.part;
        } catch (error) {
          if (error instanceof ModelCacheMiss) uncached += 1;
          // A model failure must not cost the deterministic row, exactly as in
          // the parse route.
        }
      }
    } catch (error) {
      const why = `parse threw: ${(error as Error).message.slice(0, 50)}`;
      reasons.set(why, [...(reasons.get(why) ?? []), name]);
      continue;
    }

    const reason = classify(record, doc ?? undefined);
    reasons.set(reason, [...(reasons.get(reason) ?? []), name]);
    if (!reason.startsWith("read")) continue;
    read += 1;

    // THE PRINTED FOOTPRINT'S PAGE, located exactly as the product locates it.
    //
    // `buildReadout` calls this before anything downstream sees the record, so
    // `/api/parse` and `/api/lookup` both hand `shipOutcome` a record that knows
    // which page prints its pads. This bench called `shipOutcome` on the raw
    // record and therefore measured a DIFFERENT record from the one a user gets:
    // `confirmPitch` looks for the pitch among the printed pattern's own
    // numbers, and with no pattern located it can only ever report
    // `no-printed-footprint`. Measured 2026-08-28 on the blind corpus: 30 of 30
    // shipping parts carried that flag and 0 of 34 had a located pattern.
    //
    // Same two-definitions drift as `forge-ships-two-definitions`, in the
    // instrument this time. `oracle-match.ts` had it right and these did not.
    if (doc) record = withPrintedFootprint(record, doc);

    const outcome = await shipOutcome(record, BENCH_SETTINGS);
    if (!outcome.ships) {
      shipRefusals.set(outcome.why, [...(shipRefusals.get(outcome.why) ?? []), name]);
      continue;
    }
    ships += 1;
    if (!outcome.shippedPart) continue;
    shipped.push({
      part: name,
      designator: outcome.shippedPart.packageType,
      questions: outcome.asked
    });
    try {
      const geometry = buildFootprintGeometry(
        outcome.shippedPart,
        densityOf(BENCH_SETTINGS),
        BENCH_SETTINGS.formedLeadSpanMm,
        undefined,
        BENCH_SETTINGS.formedLeadContactMm
      );
      const report = confirmations(
        outcome.shippedPart,
        geometry,
        doc,
        BENCH_SETTINGS.formedLeadSpanMm,
        BENCH_SETTINGS.formedLeadContactMm
      );
      flagged.push(report.flagged.length);
      for (const item of report.flagged) {
        const key = `${item.id}/${item.because ?? "unstated"}`;
        flagReasons.set(key, [...(flagReasons.get(key) ?? []), name]);
      }
      // AND THE NEW CHECK, on documents nobody has ever looked at. This is the
      // only place its false-positive rate can be measured honestly.
      const joint = solderJoint(
        geometry,
        outcome.shippedPart,
        BENCH_SETTINGS.formedLeadSpanMm,
        BENCH_SETTINGS.formedLeadContactMm
      );
      if (joint.findings.length > 0) {
        const worst = [...joint.findings].sort((left, right) => left.fraction - right.fraction)[0];
        jointFindings.push(`${name} (${outcome.shippedPart.packageType}): pin ${worst.padNumber}, ${worst.detail}`);
      }
    } catch {
      // A bundle that only exists once a question is answered has no confirmation
      // report to count, and counting it as zero would flatter the number.
    }
  }

  const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
  console.log(`\nREAD   ${read}/${files.length} (${pct(read, files.length)}%)`);
  console.log(`SHIPS  ${ships}/${files.length} (${pct(ships, files.length)}%) of all, ${pct(ships, read)}% of those read`);
  if (uncached > 0) console.log(`\n  ${uncached} part(s) had no cached answer and the run was offline.`);

  if (flagged.length > 0) {
    const mean = flagged.reduce((sum, count) => sum + count, 0) / flagged.length;
    const worst = Math.max(...flagged);
    console.log(`\nFLAGGED per shipping part: average ${mean.toFixed(2)}, worst ${worst}, ` +
      `${flagged.filter((count) => count === 0).length}/${flagged.length} with nothing to check`);
  }

  console.log("\nWHY A PART DID NOT READ\n");
  for (const [why, parts] of [...reasons].sort((left, right) => right[1].length - left[1].length)) {
    console.log(`  ${String(parts.length).padStart(3)}  ${why.padEnd(46)} ${parts.slice(0, 6).join(" ")}`);
  }

  if (shipRefusals.size > 0) {
    console.log("\nWHY A READ PART DID NOT SHIP\n");
    for (const [why, parts] of [...shipRefusals].sort((left, right) => right[1].length - left[1].length)) {
      console.log(`  ${String(parts.length).padStart(3)}  ${why.slice(0, 90)}`);
      console.log(`       ${parts.join(" ")}`);
    }
  }

  if (flagReasons.size > 0) {
    console.log("\nWHAT THE USER IS ASKED TO CHECK\n");
    for (const [key, parts] of [...flagReasons].sort((left, right) => right[1].length - left[1].length)) {
      console.log(`  ${String(parts.length).padStart(3)}  ${key.padEnd(44)} ${parts.slice(0, 6).join(" ")}`);
    }
  }

  console.log(`\nLEAD-ON-LAND: ${jointFindings.length} of ${shipped.length} shipping footprints have a lead off its copper\n`);
  for (const finding of jointFindings) console.log(`  ${finding}`);

  console.log("\nEVERY SHIPPING PART\n");
  for (const entry of shipped) {
    console.log(`  ${entry.part.padEnd(22)} ${entry.designator.slice(0, 34).padEnd(34)} ${entry.questions} question(s)`);
  }
  if (model) {
    const { hits, misses, failed, inputTokens, outputTokens } = model.stats;
    console.log(
      `\n  model: ${hits} answers off disk, ${misses} live call(s), ${failed} failed, ` +
        `${inputTokens} in / ${outputTokens} out tokens this run`
    );
  }
  console.log("");
}

if (process.argv[1]?.endsWith("blind.ts")) {
  void main();
}
