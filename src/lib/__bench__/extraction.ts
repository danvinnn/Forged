// Extraction coverage benchmark.
//
// The retrieval benchmark answers "can we FIND the datasheet". This answers the question that
// actually decides whether the product is usable: "once we have it, how much can we READ, and is
// the result good enough to export".
//
// Why this exists: every statement about extraction quality so far has been an impression formed
// from four datasheets. That is exactly the kind of claim that has already been wrong twice in this
// repo. The retrieval benchmark found a substring bug that had survived several passes, and a
// four-vendor spot check found confident wrong answers on ST and ADI. Measure, then decide.
//
// Usage:
//   npm run bench:extraction                     all cached parts
//   npm run bench:extraction -- --fetch          fetch anything not cached (network, slow)
//   npm run bench:extraction -- --category analog
//
// PDFs are cached under .bench-cache/ (gitignored). They are NOT committed: the corpus allowlist
// rule for test-data/ exists so no datasheet is ever committed to a public repo, and a cache of 30+
// vendor PDFs would drive straight through it.
//
// Deliberately a report, not a test. It needs the network on first run and would make CI flaky for
// reasons unrelated to whatever is being reviewed.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BENCH_CORPUS, type BenchCategory, type BenchPart } from "../retrieval/__bench__/corpus";
import { extractPartRecord } from "../datasheet";
import { resolveForExport, type Extracted, type PartRecord } from "../types";

// This is a report read by a human. Resolver events are useful in production and
// noise here, so quiet the logger unless the caller asked for detail.
if (!process.env.FORGE_LOG_LEVEL) process.env.FORGE_LOG_LEVEL = "warn";

const FETCH = process.argv.includes("--fetch");
const categoryFlag = process.argv.indexOf("--category");
const ONLY_CATEGORY = categoryFlag !== -1 ? (process.argv[categoryFlag + 1] as BenchCategory) : null;

const CACHE_DIR = join(process.cwd(), ".bench-cache");
const FETCH_DELAY_MS = 1500;

/** Fields worth scoring. Grouped so the report says WHICH kind of extraction is failing. */
const SCORED = {
  identity: ["partNumber", "manufacturer"],
  package: ["packageType", "pinCount", "pins"],
  geometry: ["dimensions.bodyLengthMm", "dimensions.bodyWidthMm", "dimensions.pitchMm"],
  radiation: ["radiation.tid", "radiation.see", "radiation.sel", "radiation.qmlClass"]
} as const;

type Group = keyof typeof SCORED;

function fieldAt(part: PartRecord, path: string): Extracted<unknown> {
  if (!path.includes(".")) return part[path as "partNumber"];
  const [group, key] = path.split(".") as ["dimensions" | "radiation", string];
  return (part[group] as Record<string, Extracted<unknown>>)[key];
}

interface Row {
  part: BenchPart;
  status: "ok" | "no-pdf" | "error";
  detail: string;
  /** Per-group counts of fields with a non-null value. */
  filled: Record<Group, number>;
  cited: number;
  scored: number;
  pins: number;
  exportable: boolean;
  blockedBy: string;
}

function cachePath(partNumber: string): string {
  return join(CACHE_DIR, `${partNumber.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fetches through the real resolver chain, so the cache reflects what users would actually get. */
async function fetchToCache(part: BenchPart): Promise<boolean> {
  const { makeResolver } = await import("../retrieval/factory");
  const resolver = await makeResolver("commercial");
  if (!resolver) return false;

  try {
    const ref = await resolver.resolve(
      part.partNumber,
      part.manufacturer ? { manufacturer: part.manufacturer } : undefined
    );
    if (!ref) return false;
    writeFileSync(cachePath(part.partNumber), Buffer.from(ref.bytes));
    return true;
  } catch {
    return false;
  }
}

async function scoreRow(part: BenchPart): Promise<Row> {
  const empty: Record<Group, number> = { identity: 0, package: 0, geometry: 0, radiation: 0 };
  const path = cachePath(part.partNumber);

  if (!existsSync(path)) {
    return {
      part,
      status: "no-pdf",
      detail: FETCH ? "not resolvable" : "not cached (run with --fetch)",
      filled: empty,
      cited: 0,
      scored: 0,
      pins: 0,
      exportable: false,
      blockedBy: "no datasheet"
    };
  }

  const bytes = readFileSync(path);
  try {
    const { part: record } = await extractPartRecord(
      `${part.partNumber}.pdf`,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    );

    const filled: Record<Group, number> = { ...empty };
    let cited = 0;
    let scored = 0;

    for (const [group, paths] of Object.entries(SCORED) as Array<[Group, readonly string[]]>) {
      for (const fieldPath of paths) {
        scored++;
        const field = fieldAt(record, fieldPath);
        if (field.value !== null) {
          filled[group]++;
          if (field.citation) cited++;
        }
      }
    }

    const resolved = resolveForExport(record);
    return {
      part,
      status: "ok",
      detail: "",
      filled,
      cited,
      scored,
      pins: (record.pins.value ?? []).length,
      exportable: resolved.ok,
      blockedBy: resolved.ok
        ? ""
        : resolved.missing.length > 0
          ? `missing ${resolved.missing.join(",")}`
          : `untraceable ${resolved.untraceable?.join(",")}`
    };
  } catch (error) {
    return {
      part,
      status: "error",
      detail: error instanceof Error ? error.message.slice(0, 60) : "unknown",
      filled: empty,
      cited: 0,
      scored: 0,
      pins: 0,
      exportable: false,
      blockedBy: "parse error"
    };
  }
}

const pct = (n: number, d: number) => (d === 0 ? "  n/a" : `${String(Math.round((n / d) * 100)).padStart(3)}%`);

async function main() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

  const corpus = BENCH_CORPUS.filter((p) => !ONLY_CATEGORY || p.category === ONLY_CATEGORY);
  const cachedBefore = readdirSync(CACHE_DIR).filter((f) => f.endsWith(".pdf")).length;

  console.log(`\nExtraction coverage: ${corpus.length} parts${ONLY_CATEGORY ? ` (${ONLY_CATEGORY})` : ""}`);
  console.log(`Cache: ${CACHE_DIR} (${cachedBefore} PDFs)${FETCH ? ", fetching missing" : ""}\n`);

  if (FETCH) {
    let fetched = 0;
    for (const part of corpus) {
      if (existsSync(cachePath(part.partNumber))) continue;
      const ok = await fetchToCache(part);
      if (ok) fetched++;
      process.stdout.write(ok ? "." : "x");
      await sleep(FETCH_DELAY_MS);
    }
    console.log(`\n  fetched ${fetched} new PDFs\n`);
  }

  const rows: Row[] = [];
  for (const part of corpus) rows.push(await scoreRow(part));

  const withPdf = rows.filter((r) => r.status === "ok");

  // Per-category. The shape matters more than the total: strong identity extraction with zero pin
  // tables is a completely different problem from failing to read the document at all.
  const byCategory = new Map<BenchCategory, Row[]>();
  for (const row of rows) {
    const list = byCategory.get(row.part.category) ?? [];
    list.push(row);
    byCategory.set(row.part.category, list);
  }

  console.log("category              pdf    ident  pkg    geom   rad    cited  export");
  console.log("-".repeat(76));
  for (const [category, list] of byCategory) {
    const ok = list.filter((r) => r.status === "ok");
    const sum = (g: Group) => ok.reduce((acc, r) => acc + r.filled[g], 0);
    const den = (g: Group) => ok.length * SCORED[g].length;
    console.log(
      `${category.padEnd(22)}${String(`${ok.length}/${list.length}`).padEnd(7)}` +
        `${pct(sum("identity"), den("identity")).padEnd(7)}` +
        `${pct(sum("package"), den("package")).padEnd(7)}` +
        `${pct(sum("geometry"), den("geometry")).padEnd(7)}` +
        `${pct(sum("radiation"), den("radiation")).padEnd(7)}` +
        `${pct(ok.reduce((a, r) => a + r.cited, 0), ok.reduce((a, r) => a + r.scored, 0)).padEnd(7)}` +
        `${pct(ok.filter((r) => r.exportable).length, ok.length)}`
    );
  }

  const allOk = withPdf;
  const sumAll = (g: Group) => allOk.reduce((acc, r) => acc + r.filled[g], 0);
  const denAll = (g: Group) => allOk.length * SCORED[g].length;
  console.log("-".repeat(76));
  console.log(
    `${"TOTAL".padEnd(22)}${String(`${allOk.length}/${rows.length}`).padEnd(7)}` +
      `${pct(sumAll("identity"), denAll("identity")).padEnd(7)}` +
      `${pct(sumAll("package"), denAll("package")).padEnd(7)}` +
      `${pct(sumAll("geometry"), denAll("geometry")).padEnd(7)}` +
      `${pct(sumAll("radiation"), denAll("radiation")).padEnd(7)}` +
      `${pct(allOk.reduce((a, r) => a + r.cited, 0), allOk.reduce((a, r) => a + r.scored, 0)).padEnd(7)}` +
      `${pct(allOk.filter((r) => r.exportable).length, allOk.length)}\n`
  );

  // The number that decides whether the product is usable end to end.
  const exportable = allOk.filter((r) => r.exportable).length;
  console.log(
    `Export-ready: ${exportable}/${allOk.length} parsed parts (${pct(exportable, allOk.length).trim()}). ` +
      `${allOk.length}/${rows.length} of the corpus had a datasheet at all.\n`
  );

  // Why the rest are blocked, which is the actionable list.
  const blocked = allOk.filter((r) => !r.exportable);
  if (blocked.length > 0) {
    const reasons = new Map<string, number>();
    for (const row of blocked) reasons.set(row.blockedBy, (reasons.get(row.blockedBy) ?? 0) + 1);
    console.log("Blocked by:");
    for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(3)}  ${reason}`);
    }
    console.log("");
  }

  const errors = rows.filter((r) => r.status === "error");
  if (errors.length > 0) {
    console.log(`Parse errors (${errors.length}):`);
    for (const row of errors) console.log(`  ${row.part.partNumber.padEnd(18)} ${row.detail}`);
    console.log("");
  }

  if (!FETCH && rows.some((r) => r.status === "no-pdf")) {
    console.log("Some parts are not cached. Run with --fetch to populate the cache.\n");
  }
}

main();
