/**
 * Does the lead sit on the land, on every footprint this product emits?
 *
 * The one question no other instrument here asks. `bench:copper` measures the
 * pads back out against the record; `bench:dimensions` measures the record
 * against the hand-read drawing; `validateGeometry` asks whether the footprint
 * contradicts itself. All three pass on a footprint whose leads miss their pads,
 * because none of them lays the two on top of each other.
 *
 * It found one on the first run. ADXL345 emits 0.25 mm lands under 0.50 mm
 * terminals: less than half the width, on a part shipping four files.
 * `bench:dimensions` had the reading marked WRONG against the hand-read drawing
 * the whole time, and nothing connected that to the copper, because
 * `bench:copper` compares the pads against the RECORD and the record is
 * consistently wrong. Two pages of one datasheet contradict each other and only
 * an overlay notices.
 *
 * ## The sweep runs every time
 *
 * The bar in `solderjoint.ts` is a number, and a number chosen by reasoning is
 * how nine invented constants got into this codebase. So this bench does not
 * merely apply it: it re-derives it, by injecting each defect shape this product
 * has actually shipped into every record and printing what each candidate bar
 * would flag. If the separation ever stops holding, the table says so on the
 * next run rather than in six months.
 *
 * Air-gap safe and free: cached answers off disk, no network, no spend.
 */

import { buildFootprintGeometry, FootprintUnavailableError } from "../exporters";
import { defect as injectDefect } from "./inject";
import { replayRecords } from "./replay";
import { solderJoint, type JointReport } from "../solderjoint";
import { BENCH_SETTINGS } from "./shipcheck";
import type { ResolvedPart } from "../types";

interface Row {
  part: string;
  packageType: string;
  form: string;
  source: string;
  report: JointReport;
}

const printed = (source: string) => source.includes("printed in this datasheet");
const clone = (part: ResolvedPart): ResolvedPart => JSON.parse(JSON.stringify(part)) as ResolvedPart;

/**
 * The defect shapes this product has actually shipped, as record mutations.
 *
 * Every one of these is a real failure from the project's history rather than an
 * imagined one: a decimal point on a span, the land's two axes exchanged, a
 * sibling package's pattern read off the wrong drawing, and inches taken for
 * millimetres. Injecting them is the only way to know whether a bar separates.
 */
const DEFECTS: Array<{ name: string; apply: (part: ResolvedPart) => ResolvedPart }> = [
  {
    name: "land span x0.1",
    apply: (part) => {
      const q = clone(part);
      if (q.dimensions.landSpanMm) q.dimensions.landSpanMm *= 0.1;
      return q;
    }
  },
  {
    name: "land axes swapped",
    apply: (part) => {
      const q = clone(part);
      const length = q.dimensions.landPadLengthMm;
      const width = q.dimensions.landPadWidthMm;
      if (length !== null && width !== null) {
        q.dimensions.landPadLengthMm = width;
        q.dimensions.landPadWidthMm = length;
      }
      return q;
    }
  },
  {
    name: "sibling package land",
    apply: (part) => {
      const q = clone(part);
      if (q.dimensions.landSpanMm) q.dimensions.landSpanMm *= 1.4;
      if (q.dimensions.landPadLengthMm) q.dimensions.landPadLengthMm *= 1.4;
      if (q.dimensions.landPadWidthMm) q.dimensions.landPadWidthMm *= 1.4;
      return q;
    }
  },
  {
    name: "land read in inches",
    apply: (part) => {
      const q = clone(part);
      if (q.dimensions.landSpanMm) q.dimensions.landSpanMm /= 25.4;
      if (q.dimensions.landPadLengthMm) q.dimensions.landPadLengthMm /= 25.4;
      if (q.dimensions.landPadWidthMm) q.dimensions.landPadWidthMm /= 25.4;
      return q;
    }
  },
  {
    name: "lead span x0.1",
    apply: (part) => {
      const q = clone(part);
      const span = q.dimensions.leadSpanMm;
      if (span) q.dimensions.leadSpanMm = { minMm: span.minMm * 0.1, maxMm: span.maxMm * 0.1 };
      return q;
    }
  }
];

function report(part: ResolvedPart): { report: JointReport; source: string } | null {
  try {
    const geometry = buildFootprintGeometry(part, "B", BENCH_SETTINGS.formedLeadSpanMm, undefined, BENCH_SETTINGS.formedLeadContactMm);
    const result = solderJoint(geometry, part, BENCH_SETTINGS.formedLeadSpanMm, BENCH_SETTINGS.formedLeadContactMm);
    if (result.unavailable !== null) return null;
    return { report: result, source: geometry.provenance.source };
  } catch {
    return null;
  }
}

/** The bar's own evidence, printed rather than asserted. */
function sweep(parts: ResolvedPart[]): void {
  const asBuilt: JointReport[] = [];
  const injected = new Map<string, JointReport[]>();
  for (const part of parts) {
    const base = report(part);
    if (base) asBuilt.push(base.report);
    for (const defect of DEFECTS) {
      const hit = report(defect.apply(part));
      if (hit) injected.set(defect.name, [...(injected.get(defect.name) ?? []), hit.report]);
    }
  }

  console.log("  The bar, re-derived. Each column is every record with one real defect shape injected.\n");
  const names = DEFECTS.map((defect) => defect.name);
  console.log(`    ${"bar".padEnd(6)} ${"as built".padStart(9)}  ${names.map((n) => n.slice(0, 12).padStart(13)).join("")}`);
  for (const bar of [0.95, 0.9, 0.8, 0.7, 0.6, 0.5, 0.3]) {
    const flags = (list: JointReport[]) =>
      `${list.filter((r) => r.worst.alongFoot < bar || r.worst.acrossWidth < 1).length}/${list.length}`;
    console.log(
      `    ${bar.toFixed(2).padEnd(6)} ${flags(asBuilt).padStart(9)}  ` +
        names.map((name) => flags(injected.get(name) ?? []).padStart(13)).join("")
    );
  }
  console.log(
    "\n    A bar separates when the left column falls and the right ones do not move.\n" +
      "    The width test has no bar: a land narrower than the narrowest permitted lead\n" +
      "    is a contradiction between two pages rather than a matter of degree.\n"
  );
}

function main(): void {
  const parts = [...replayRecords()];
  const rows: Row[] = [];
  const unavailable = new Map<string, number>();
  let built = 0;

  for (const part of parts) {
    let geometry;
    try {
      // THE ASSEMBLER'S ANSWERS, because a ceramic flat pack has no seated foot
      // on any drawing and this product's market is largely ceramic flat packs.
      // Without them the overlay declines exactly the packages it matters most
      // for, and the bench reports a clean sheet for parts nothing looked at.
      geometry = buildFootprintGeometry(
        part,
        "B",
        BENCH_SETTINGS.formedLeadSpanMm,
        undefined,
        BENCH_SETTINGS.formedLeadContactMm
      );
    } catch (error) {
      if (!(error instanceof FootprintUnavailableError)) {
        unavailable.set("failed to build", (unavailable.get("failed to build") ?? 0) + 1);
      }
      continue;
    }
    built += 1;
    // LANDS TOO SMALL FOR THE LEADS THAT SIT ON THEM, which is the ADXL345
    // defect this bench was written for. Shrunk after the build so the record's
    // lead sizes are untouched and only the copper is wrong.
    geometry = injectDefect("joints.geometry", geometry, (g) => ({
      ...g,
      pads: g.pads.map((pad) => ({ ...pad, widthMm: pad.widthMm * 0.2, heightMm: pad.heightMm * 0.2 }))
    }));
    const result = solderJoint(geometry, part, BENCH_SETTINGS.formedLeadSpanMm, BENCH_SETTINGS.formedLeadContactMm);
    if (result.unavailable !== null) {
      unavailable.set(result.unavailable, (unavailable.get(result.unavailable) ?? 0) + 1);
      continue;
    }
    rows.push({
      part: part.partNumber,
      packageType: part.packageType,
      form: part.dimensions.leadForm ?? "unknown",
      source: geometry.provenance.source,
      report: result
    });
  }

  console.log(`\nLaid the leads on the lands of ${built} built footprints. No network, no spend.\n`);
  sweep(parts);

  const bad = rows.filter((row) => row.report.findings.length > 0);
  console.log(`  ${rows.length} footprint(s) overlaid, ${bad.length} with a lead that misses its copper.\n`);

  for (const row of bad) {
    console.log(
      `  ${row.part.padEnd(18)} ${row.packageType.slice(0, 24).padEnd(24)} ${row.form.padEnd(9)} ` +
        `${printed(row.source) ? "printed" : "ipc"}   ${row.report.findings.length} land(s)`
    );
    // The worst land of each kind, named once. The same fact repeated for every
    // pin on a 100-pin part is not more information.
    for (const at of ["foot", "width"] as const) {
      const worst = row.report.findings
        .filter((finding) => finding.at === at)
        .sort((a, b) => a.fraction - b.fraction)[0];
      if (worst) console.log(`      ${at.padEnd(6)} pin ${worst.padNumber}: ${worst.detail}`);
    }
  }
  if (bad.length > 0) console.log("");

  const clean = rows.filter((row) => row.report.findings.length === 0);
  console.log("  Worst overlap on each clean footprint, as a fraction of the lead:\n");
  console.log(`    ${"part".padEnd(18)} ${"package".padEnd(24)} ${"src".padEnd(8)} ${"foot".padStart(6)} ${"width".padStart(6)}  skipped`);
  for (const row of clean.sort((a, b) => a.report.worst.alongFoot - b.report.worst.alongFoot)) {
    console.log(
      `    ${row.part.padEnd(18)} ${row.packageType.slice(0, 24).padEnd(24)} ` +
        `${(printed(row.source) ? "printed" : "ipc").padEnd(8)} ${row.report.worst.alongFoot.toFixed(3).padStart(6)} ` +
        `${row.report.worst.acrossWidth.toFixed(3).padStart(6)}  ${row.report.skipped || ""}`
    );
  }

  const skipped = rows.reduce((sum, row) => sum + row.report.skipped, 0);
  if (skipped > 0) {
    console.log(
      `\n  ${skipped} land(s) on ${rows.filter((r) => r.report.skipped > 0).length} footprint(s) were NOT overlaid: ` +
        `their axis states no span or body to place the lead's outer edge from.`
    );
  }

  console.log("\n  Not overlaid at all:");
  for (const [why, count] of [...unavailable].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(3)}  ${why}`);
  }
  console.log("");
}

if (process.argv[1]?.endsWith("joints.ts")) {
  main();
}
