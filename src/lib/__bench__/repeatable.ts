/**
 * Does the same document produce the same record twice?
 *
 * An engineer reported on 2026-08-28 that identical reads of one PDF gave
 * different answers: a package list of 2 cards, then 4, then 5, with the real
 * flat pack missing from one run, and one part's mounting reading `smd` on one
 * pass and blank on another. For a tool that produces flight-hardware libraries,
 * a result that does not reproduce undermines every other number this project
 * quotes.
 *
 * This isolates OUR half. Every model answer is replayed from disk, so the model
 * is a constant and anything that moves is the pipeline. If this reports zero
 * drift, the variance is upstream in the model or in which pages get rendered,
 * and that is a different investigation with a different price.
 *
 * Free: cached answers off disk, no network, no spend.
 */

import { readdirSync, readFileSync } from "node:fs";
import { defect } from "./inject";
import { join } from "node:path";
import { extractPartRecord } from "../datasheet";
import { makeExtractionModel, runExtraction } from "../extraction";
import { cachingModel } from "./modelcache";
import { getDeploymentMode } from "../retrieval/deployment";
import { loadBenchEnv } from "./env";
import { withPrintedFootprint } from "../readout";
import { BENCH_SETTINGS, shipOutcome } from "./shipcheck";
import { buildFootprintGeometry } from "../exporters";
import { densityOf } from "../settings";
import type { PartRecord } from "../types";

loadBenchEnv();

const RUNS = Number(process.argv.find((a) => a.startsWith("--runs="))?.slice(7) ?? 3);

/** Everything about a record a user could see change. */
function fingerprint(record: PartRecord): string {
  const dims = record.dimensions as unknown as Record<string, { value: unknown }>;
  return JSON.stringify({
    packageType: record.packageType.value,
    outline: record.packageOutlineCode.value,
    pinCount: record.pinCount.value,
    pins: (record.pins.value ?? []).map((p) => `${p.number}=${p.name}:${p.electricalType}`),
    exposedPad: record.exposedPad,
    dimensions: Object.fromEntries(Object.keys(dims).map((k) => [k, dims[k]?.value ?? null])),
    packages: (record.packagesInThisDocument ?? []).map((t) => ({
      type: t.packageType,
      code: t.outlineCode ?? null,
      pins: (t.pins ?? []).length,
      landPage: t.vendorLandPattern?.page ?? null
    })),
    landPage: record.vendorLandPattern?.page ?? null
  });
}

/** And everything about the OUTPUT, which is what actually reaches a board. */
async function shipped(record: PartRecord): Promise<string> {
  const outcome = await shipOutcome(record, BENCH_SETTINGS);
  if (!outcome.shippedPart) return `no-ship: ${outcome.why.slice(0, 60)}`;
  try {
    const geometry = buildFootprintGeometry(
      outcome.shippedPart,
      densityOf(BENCH_SETTINGS),
      BENCH_SETTINGS.formedLeadSpanMm,
      undefined,
      BENCH_SETTINGS.formedLeadContactMm
    );
    return JSON.stringify({
      pkg: outcome.shippedPart.packageType,
      pads: geometry.pads.map((p) => `${p.number}@${p.centre.xMm.toFixed(4)},${p.centre.yMm.toFixed(4)}:${p.widthMm}x${p.heightMm}`),
      courtyard: geometry.courtyard,
      source: geometry.provenance.source
    });
  } catch (error) {
    return `build-failed: ${(error as Error).message.slice(0, 60)}`;
  }
}

async function main(): Promise<void> {
  const dirs = [".bench-cache", ".blind-cache"].map((d) => join(process.cwd(), d));
  const inner = await makeExtractionModel(getDeploymentMode());
  let checked = 0;
  const drifted: string[] = [];

  for (const dir of dirs) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".pdf")).sort();
    } catch {
      continue;
    }
    for (const file of files) {
      const name = file.replace(/\.pdf$/, "");
      const bytes = readFileSync(join(dir, file));
      const records: string[] = [];
      const outputs: string[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        // A FRESH BUFFER EACH RUN. Sharing one would hide a defect where
        // something downstream consumes or mutates the bytes.
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        try {
          const extracted = await extractPartRecord(file, buffer);
          let record = extracted.part;
          if (inner) {
            const model = cachingModel(inner, "offline", () => name);
            const outcome = await runExtraction(record, extracted.doc, buffer, model, file);
            if (outcome) record = outcome.part;
          }
          record = withPrintedFootprint(record, extracted.doc);
          // ONE RUN THAT DIFFERS, which is the only thing this bench reports.
          // Applied on the last pass only, so the first two agree and the third
          // does not - the exact shape a user saw on 2026-08-28.
          records.push(
            defect("repeatable.record", fingerprint(record), (print) =>
              run === RUNS - 1 ? `${print.slice(0, -1)},"injected":true}` : print
            )
          );
          outputs.push(await shipped(record));
        } catch (error) {
          records.push(`threw: ${(error as Error).message.slice(0, 60)}`);
          outputs.push("threw");
        }
      }
      if (records.length === 0) continue;
      checked += 1;
      const stableRecord = records.every((r) => r === records[0]);
      const stableOutput = outputs.every((o) => o === outputs[0]);
      if (stableRecord && stableOutput) continue;
      drifted.push(`  ${name.padEnd(22)} record ${stableRecord ? "stable" : "DRIFTS"}   output ${stableOutput ? "stable" : "DRIFTS"}`);
      if (!stableRecord) {
        const [a, b] = [JSON.parse(records[0]) as Record<string, unknown>, JSON.parse(records.find((r) => r !== records[0])!) as Record<string, unknown>];
        for (const key of Object.keys(a)) {
          if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
            console.log(`      ${key}: ${JSON.stringify(a[key]).slice(0, 90)}`);
            console.log(`      ${" ".repeat(key.length)}  ${JSON.stringify(b[key]).slice(0, 90)}`);
          }
        }
      }
    }
  }

  console.log(`\nRan ${RUNS} identical passes over ${checked} document(s), every model answer replayed from disk.\n`);
  if (drifted.length === 0) {
    console.log("  Every record and every footprint is byte-identical across runs.");
    console.log("  Any variance a user sees is upstream of this: the model, or which pages it asks to render.\n");
  } else {
    for (const line of drifted) console.log(line);
    console.log(`\n  ${drifted.length} document(s) do not reproduce. Every one is OUR code, not the model.\n`);
  }
}

if (process.argv[1]?.endsWith("repeatable.ts")) {
  void main();
}
