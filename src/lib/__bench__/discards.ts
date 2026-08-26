/**
 * What the code THREW AWAY, across every model answer ever cached.
 *
 * ## Why this exists
 *
 * On 2026-08-25 a user asked "why is the read refusing?". The answer was that
 * the model had read an LMP7704-SP perfectly, all fourteen pins, and had also
 * described the package's thermal pad and metal lid as two rows carrying
 * `number: null`. Those two rows made `normalizeModelPins` refuse the whole
 * table, so fourteen hand-checkable pins were discarded and the screen reported
 * "not enough was read".
 *
 * The same bug had been found and fixed on 2026-08-10 for a pad row whose
 * number is the STRING "PAD". The fatal return for the `null` spelling sits one
 * line above that fix and no test ever reached it.
 *
 * ## Why nothing caught it
 *
 * `bench:extraction` reads ONE cached response per part, the one matching the
 * current prompt hash. That part has eleven cached reads: ten clean and one
 * carrying the pad rows, across seven prompt versions. The corpus used a clean
 * one and could never have seen this, however many times it was re-run, because
 * it does not call the model.
 *
 * So this bench deliberately scans EVERY cached response regardless of prompt
 * version. That is the opposite of the rule for coverage measurements, which
 * must filter to the current prompt or they report a number mixed across
 * incompatible runs. The difference is that a discard rule is a property of the
 * SHAPE of an answer rather than of the question asked, so every answer ever
 * received is fair evidence about it.
 *
 * ## What it fails on
 *
 * A refusal is not a defect. Refusing is this product's safety net and most of
 * these are right. What is a defect is throwing away a table whose NUMBERED
 * ROWS are complete and gap-free, because that is a correct pinout being lost
 * over a row that was never a pin. That case exits non-zero; everything else is
 * reported and passes.
 *
 * ## Part two: every OTHER field
 *
 * The pin check above answers one question - was a usable pinout thrown away -
 * and pins are one field of thirty. Six of the six defects found on 2026-08-24
 * and 25 were the same shape in different fields: eight dimensions blanked over
 * a capital letter, a whole Altium export refused over a character the format
 * holds, a lead count discarded for being spelled `5-Lead SOT`.
 *
 * So the second half asks the general form of it. For every part, take every
 * field the model actually answered and ask where it went. There are exactly
 * three honest answers:
 *
 *   KEPT      the record carries a value for that field
 *   NAMED     the merge reports it in `rejected`, with the sentence it gives
 *   PRIOR     the record already held a value from the deterministic pass or
 *             from the user, which the model does not get to overwrite
 *
 * Anything else is a SILENT DISCARD: the model returned a number, the record
 * does not have it, and no part of the code says why. That is the exact
 * condition the target for this bench is written as - every discarded value is
 * explainable in one sentence - and it is decidable without a single judgement
 * call.
 *
 * Free. No network, no model, no spend.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isGapFreeSequence, normalizeModelPins } from "../extraction/merge";
import { extractionFields } from "../extraction/contracts";
import { loadBenchEnv } from "./env";
import { promptFingerprint } from "./modelcache";
import { buildCachedParts } from "./oracle-match";
import type { PartRecord } from "../types";

loadBenchEnv();

const CACHE = join(process.cwd(), ".model-cache");

interface Discard {
  part: string;
  reason: string;
  /** Rows that carry a plain integer number, which is what a pad is built from. */
  numbered: number;
  /** Those rows, taken alone, form a complete 1..N pinout. */
  numberedAreComplete: boolean;
  offending: string[];
}

function numberedRows(rows: unknown[]): Array<{ number: number; name: string }> {
  const out: Array<{ number: number; name: string }> = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const raw = typeof record.number === "number" ? String(record.number) : String(record.number ?? "").trim();
    if (!/^\d+$/.test(raw)) continue;
    out.push({ number: Number(raw), name: String(record.name ?? "") });
  }
  return out;
}

function describe(rows: unknown[]): string[] {
  return rows
    .filter((row) => {
      if (typeof row !== "object" || row === null) return true;
      const raw = (row as Record<string, unknown>).number;
      return !/^\d+$/.test(typeof raw === "number" ? String(raw) : String(raw ?? "").trim());
    })
    .map((row) => {
      if (typeof row !== "object" || row === null) return String(row);
      const record = row as Record<string, unknown>;
      return `${JSON.stringify(record.number ?? null)}:${JSON.stringify(record.name ?? null)}`;
    })
    .slice(0, 4);
}

function pinPass(): boolean {
  let files = 0;
  let withTable = 0;
  let accepted = 0;
  const discards: Discard[] = [];

  for (const file of readdirSync(CACHE)) {
    if (!file.endsWith(".json")) continue;
    files += 1;
    let entry: { label?: string; result?: { values?: Record<string, { value?: unknown }> } };
    try {
      entry = JSON.parse(readFileSync(join(CACHE, file), "utf8"));
    } catch {
      continue;
    }
    const rows = entry.result?.values?.pins?.value;
    if (!Array.isArray(rows)) continue;
    withTable += 1;

    // THE REAL GATE, imported. Not a copy of its rules.
    const normalized = normalizeModelPins(rows);
    if (normalized.ok && isGapFreeSequence(normalized.pins)) {
      accepted += 1;
      continue;
    }

    const numbered = numberedRows(rows);
    const values = numbered.map((row) => row.number).sort((left, right) => left - right);
    const complete =
      values.length > 0 &&
      new Set(values).size === values.length &&
      Math.max(...values) === values.length;

    discards.push({
      part: entry.label ?? file,
      reason: normalized.ok ? `rows do not number 1..${normalized.pins.length}` : normalized.reason,
      numbered: numbered.length,
      numberedAreComplete: complete,
      offending: describe(rows)
    });
  }

  console.log(`Scanned ${files} cached model answers, every prompt version. No network, no spend.\n`);
  console.log(`  carrying a pin table   ${withTable}`);
  console.log(`  accepted               ${accepted}`);
  console.log(`  DISCARDED              ${discards.length}\n`);

  const lost = discards.filter((entry) => entry.numberedAreComplete);
  const fair = discards.filter((entry) => !entry.numberedAreComplete);

  if (fair.length > 0) {
    console.log("Refused, and rightly: the numbered rows are not a complete pinout on their own.");
    for (const entry of dedupe(fair)) {
      console.log(`   ${entry.part.padEnd(18)} ${entry.numbered} numbered  ${entry.reason}`);
    }
    console.log("");
  }

  if (lost.length === 0) {
    console.log("Nothing with a COMPLETE numbered pinout was thrown away.");
    return true;
  }

  console.log("A COMPLETE PINOUT WAS THROWN AWAY. Every one of these is a defect:\n");
  for (const entry of dedupe(lost)) {
    console.log(`   ${entry.part}`);
    console.log(`     ${entry.numbered} numbered rows, 1..${entry.numbered}, complete and gap-free`);
    console.log(`     refused because: ${entry.reason}`);
    console.log(`     the rows that did it: ${entry.offending.join("  ")}`);
  }
  console.log("");
  console.log("A row that is not a numbered pin must not destroy the numbered pins.");
  return false;
}

/**
 * Every field this part's cached answers actually carry a value for, under the
 * prompt in force today.
 *
 * Filtered to the current fingerprint, unlike the pin pass above, and for the
 * opposite reason: this compares against a RECORD, and the record is built from
 * the current prompt's answers only. Mixing in an answer to an older question
 * would report a discard that the product never performed.
 *
 * Both passes of a run count. A field answered in pass 1 and not in pass 2 is
 * still a field the model returned, and asking where it went is exactly the
 * question here.
 */
function fieldsAnswered(part: string): Map<string, unknown> {
  const answered = new Map<string, unknown>();
  const current = promptFingerprint();
  for (const file of readdirSync(CACHE)) {
    if (!file.startsWith(`${part}-`) || !file.endsWith(".json")) continue;
    let entry: { prompt?: string; result?: { values?: Record<string, { value?: unknown }> } };
    try {
      entry = JSON.parse(readFileSync(join(CACHE, file), "utf8"));
    } catch {
      continue;
    }
    if (entry.prompt !== current) continue;
    for (const [field, held] of Object.entries(entry.result?.values ?? {})) {
      if (!(extractionFields as readonly string[]).includes(field)) continue;
      if (held?.value === null || held?.value === undefined) continue;
      if (!answered.has(field)) answered.set(field, held.value);
    }
  }
  return answered;
}

/** The record's value for a dotted field path, or undefined when it has none. */
function recordValue(record: PartRecord, field: string): unknown {
  const path = field.split(".");
  let cursor: unknown = record;
  for (const step of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[step];
  }
  if (cursor !== null && typeof cursor === "object" && "value" in (cursor as object)) {
    return (cursor as { value: unknown }).value;
  }
  return cursor;
}

/** Was the record's value put there by something other than this model pass? */
function heldByPrior(record: PartRecord, field: string): boolean {
  const path = field.split(".");
  let cursor: unknown = record;
  for (const step of path) {
    if (cursor === null || typeof cursor !== "object") return false;
    cursor = (cursor as Record<string, unknown>)[step];
  }
  if (cursor === null || typeof cursor !== "object" || !("method" in (cursor as object))) return false;
  const method = (cursor as { method: unknown }).method;
  return method !== null && method !== "vlm" && method !== "vlm-drawing";
}

interface Silent {
  part: string;
  field: string;
  value: string;
}

/**
 * The PER-PACKAGE measurements, which are the ones that actually build copper on
 * a family datasheet and which the flat pass above cannot see.
 *
 * `packagesInThisDocument` is not one of `extractionFields`; it arrives on its
 * own branch of `ExtractionResult` and is merged by `packageDimensions`, which
 * has no `rejected` channel at all. So every discard on this path is silent by
 * construction, which is exactly the condition this bench exists to refuse.
 *
 * Matched by the package's own caption, because that is the only identity an
 * entry carries before the merge has run.
 */
function perPackageAnswered(part: string): Array<{ packageType: string; field: string; value: unknown }> {
  const out: Array<{ packageType: string; field: string; value: unknown }> = [];
  const seen = new Set<string>();
  const current = promptFingerprint();
  for (const file of readdirSync(CACHE)) {
    if (!file.startsWith(`${part}-`) || !file.endsWith(".json")) continue;
    let entry: {
      prompt?: string;
      result?: {
        packagesInThisDocument?: Array<{ packageType?: string; dimensions?: Record<string, { value?: unknown }> }>;
      };
    };
    try {
      entry = JSON.parse(readFileSync(join(CACHE, file), "utf8"));
    } catch {
      continue;
    }
    if (entry.prompt !== current) continue;
    for (const table of entry.result?.packagesInThisDocument ?? []) {
      const packageType = String(table.packageType ?? "").trim();
      if (!packageType) continue;
      for (const [field, held] of Object.entries(table.dimensions ?? {})) {
        if (!field.startsWith("dimensions.")) continue;
        if (!(extractionFields as readonly string[]).includes(field)) continue;
        if (held?.value === null || held?.value === undefined) continue;
        const key = `${packageType}|${field}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ packageType, field, value: held.value });
      }
    }
  }
  return out;
}

/** Same caption, compared the way the record's own lookups compare them. */
function sameCaption(left: string, right: string): boolean {
  const key = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return key(left) === key(right);
}

async function fieldPass(): Promise<boolean> {
  const built = await buildCachedParts();
  if (!built) {
    console.log("\nNo model configured, so no records can be rebuilt and no field discard can be judged.");
    return true;
  }

  let answered = 0;
  let kept = 0;
  let prior = 0;
  let uncited = 0;
  const named = new Map<string, number>();
  const silent: Silent[] = [];

  for (const entry of built) {
    // THE PER-PACKAGE TABLE FIRST, because it is the path with no reason
    // channel and so the one where a discard can only be found by looking.
    for (const held of perPackageAnswered(entry.part)) {
      answered += 1;
      const table = (entry.record.packagesInThisDocument ?? []).find((offered) =>
        sameCaption(offered.packageType, held.packageType)
      );
      const field = held.field.slice("dimensions.".length);
      const stored = table?.dimensions?.[field as keyof NonNullable<typeof table.dimensions>] as
        | { value?: unknown }
        | undefined;
      if (stored && stored.value !== null && stored.value !== undefined) {
        kept += 1;
        continue;
      }
      silent.push({
        part: entry.part,
        field: `${held.packageType} ${held.field}`,
        value: JSON.stringify(held.value).slice(0, 60)
      });
    }

    for (const [field, value] of fieldsAnswered(entry.part)) {
      answered += 1;
      const onRecord = recordValue(entry.record, field);
      if (onRecord !== null && onRecord !== undefined) {
        if (heldByPrior(entry.record, field)) prior += 1;
        else kept += 1;
        // KEPT, and then refused at the export gate. Counted separately because
        // it is the largest lossy class and the one most easily mistaken for a
        // failure to read: the value is on the record and `isUntraceable` will
        // not let it out. That rule has a one-sentence reason - a number nobody
        // can locate on a page is not evidence for a QML sign-off - so it is
        // reported rather than failed.
        if (entry.uncited.includes(field as (typeof extractionFields)[number])) uncited += 1;
        continue;
      }
      const reason = entry.rejected.find((refusal) => refusal.field === field)?.reason;
      if (reason) {
        named.set(reason, (named.get(reason) ?? 0) + 1);
        continue;
      }
      silent.push({ part: entry.part, field, value: JSON.stringify(value).slice(0, 60) });
    }
  }

  console.log(
    `\n\nEvery field the model answered, flat block and per-package table, across ${built.length} parts.\n`
  );
  console.log(`  answered by the model  ${answered}`);
  console.log(`  KEPT on the record     ${kept}`);
  console.log(`  PRIOR value won        ${prior}   deterministic or user, which the model does not overwrite`);
  console.log(`      of those, UNCITED  ${uncited}   kept but refused at the export gate as untraceable`);
  console.log(`  NAMED as refused       ${[...named.values()].reduce((sum, count) => sum + count, 0)}`);
  for (const [reason, count] of [...named].sort((a, b) => b[1] - a[1])) {
    console.log(`      ${String(count).padStart(3)}  ${reason}`);
  }
  console.log(`  SILENTLY DISCARDED     ${silent.length}`);

  if (silent.length === 0) {
    console.log("\nEvery value the model returned is either on the record or refused by name.");
    return true;
  }

  console.log("\nA VALUE WAS THROWN AWAY AND NOTHING SAYS WHY. Every one of these is a defect:\n");
  for (const entry of silent) {
    console.log(`   ${entry.part.padEnd(18)} ${entry.field.padEnd(30)} ${entry.value}`);
  }
  console.log("");
  console.log("A discard the code cannot name is indistinguishable from a document that was silent.");
  return false;
}

async function main(): Promise<void> {
  const pins = pinPass();
  const fields = await fieldPass();
  if (!pins || !fields) process.exit(1);
}

function dedupe(entries: Discard[]): Discard[] {
  const seen = new Map<string, Discard>();
  for (const entry of entries) if (!seen.has(entry.part + entry.reason)) seen.set(entry.part + entry.reason, entry);
  return [...seen.values()];
}

void main();
