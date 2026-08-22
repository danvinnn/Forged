/**
 * Which guards actually fire, and on what. Costs nothing.
 *
 * ## Why this exists
 *
 * Most checks in the footprint path do not refuse. They return null, and the
 * caller then tells the user "no land pattern could be read from this
 * datasheet". That sentence is true of a silent document and false of one whose
 * printed footprint a check rejected, and the two were indistinguishable to
 * everybody: the user, the bench, and anyone asking whether a given check still
 * earns its place.
 *
 * So no guard in this product has ever had to justify itself. A guard is not
 * free: it carries a test, a paragraph of comment claiming protection, and the
 * risk of throwing away the answer the document actually gave. This measures
 * what each one costs and what it catches.
 *
 * ## The rule it obeys
 *
 * TUNED CORPUS ONLY, and this is not a technicality. Deciding a guard's fate
 * from how often it fires on hold-out parts is tuning against the hold-out,
 * which is the one thing that corpus exists to prevent. The hold-out is counted
 * separately and reported below the line, as a CONSEQUENCE of a decision taken
 * on the tuned set, never as the evidence for it.
 *
 * Air-gap safe: reads local files, makes no request.
 */

import { buildFootprintGeometry, createExportZip, FootprintUnavailableError } from "../exporters";
import { replayRecords } from "./replay";
import { HOLDOUT_CORPUS } from "./holdout-corpus";
import { densityOf } from "../settings";
import { BENCH_CORPUS } from "../retrieval/__bench__/corpus";

const key = (partNumber: string) => partNumber.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
const TUNED = new Set(BENCH_CORPUS.map((part) => key(part.partNumber)));

/**
 * The hold-out part numbers, used ONLY to exclude those parts from the evidence.
 * No hold-out document is opened and no failure of one is diagnosed.
 *
 * Imported from `holdout-corpus.ts`, which is data and runs nothing. It used to
 * be scraped out of `holdout.ts` with a regex, because importing THAT file
 * starts a hold-out measurement as a side effect. The list then moved into its
 * own module on 2026-08-21 and the regex silently matched nothing, so every
 * hold-out part was reclassified as "neither corpus" and counted in a section
 * that says it is not evidence. A bench that reads another bench's source is one
 * refactor away from lying; the data module exists so it does not have to.
 */
const HOLDOUT = new Set(HOLDOUT_CORPUS.map((part) => key(part.partNumber)));

/**
 * Which guard a refusal names, collapsed to a stable id.
 *
 * Matched on the phrasing the discard writes, which is the only thing that
 * crosses the boundary. Keyed rather than free text so the count means
 * something.
 */
const GUARDS: Array<{ id: string; where: string; test: RegExp }> = [
  { id: "printed-outside-ipc-band", where: "printedLand -> withinIpcBand", test: /outside what IPC-7351B/ },
  { id: "printed-land-wider-than-pitch", where: "printedLand", test: /would touch its \nneighbour|would touch its neighbour/ },
  { id: "printed-rows-overlap", where: "printedLand", test: /puts the \ntwo rows into each other|puts the two rows into each other/ },
  { id: "lead-too-wide-for-pitch", where: "leadFromDrawing", test: /leaves almost no gap to its neighbour/ },
  { id: "computed-contradicts-printed", where: "contradictsPrintedLand", test: /disagrees with it/ },
  { id: "computed-inconsistent", where: "computeLandPattern", test: /could not be computed from the package drawing/ },
  { id: "package-name-vs-pin-count", where: "buildFootprintGeometry", test: /describe different packages/ }
];

interface Row {
  part: string;
  set: "tuned" | "holdout" | "other";
  outcome: "ships" | "asks" | "refused";
  guards: string[];
  /** True when the document PRINTED a full land pattern and a guard rejected it. */
  hadPrintedPattern: boolean;
  /** The refusal verbatim, so a pattern that matches nothing can be seen to. */
  raw: string;
}

async function main() {
  const rows: Row[] = [];

  // RECORDS FROM `replayRecords`, not from a second reader of the same cache.
  //
  // This file carried its own copy of `cachedAnswers` and `partFrom`, and the two
  // had drifted: the copy dropped `jedecOutline` and the whole radiation block,
  // so this bench judged guards against a record the generator never sees, and it
  // missed the readdir-order fix that made the other reader reproducible. Two
  // readers of one cache drift, and the one that drifts is the one making the
  // correctness claim. `replay.ts` says exactly this about why it was split out.
  for (const part of replayRecords()) {
    const label = part.id;
    const k = key(label);
    const set: Row["set"] = TUNED.has(k) ? "tuned" : HOLDOUT.has(k) ? "holdout" : "other";
    const hadPrintedPattern =
      part.dimensions.landPadLengthMm !== null &&
      part.dimensions.landPadWidthMm !== null &&
      part.dimensions.landSpanMm !== null;

    // WHAT WAS THROWN AWAY, asked FIRST and independently of what happens next.
    //
    // Until 2026-08-21 this bench read guards out of the REFUSAL MESSAGE alone,
    // so it could only see a guard whose firing ended the build. Two whole
    // outcomes were invisible:
    //
    //   ships  DRV8825's printed footprint is rejected on every run, IPC-7351B
    //          computes a pattern instead, and the export succeeds. Reported as
    //          "never fires".
    //   asks   the export can refuse for an unrelated missing field, and that
    //          refusal's message says nothing about the discard that preceded it.
    //
    // `provenance.discards` now carries them out of the successful path, and
    // asking here rather than inside either branch covers both.
    let discarded = "";
    try {
      discarded = buildFootprintGeometry(part, densityOf({})).provenance.discards.join("; ");
    } catch (error) {
      discarded = error instanceof Error ? error.message : String(error);
    }
    const fromDiscards = GUARDS.filter((guard) => guard.test.test(discarded)).map((guard) => guard.id);

    try {
      await createExportZip(part, "kicad");
      rows.push({ part: label, set, outcome: "ships", guards: fromDiscards, hadPrintedPattern, raw: discarded });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const guards = [
        ...new Set([...fromDiscards, ...GUARDS.filter((guard) => guard.test.test(message)).map((guard) => guard.id)])
      ];
      const outcome: Row["outcome"] =
        error instanceof FootprintUnavailableError && error.needs.length > 0 ? "asks" : "refused";
      rows.push({ part: label, set, outcome, guards, hadPrintedPattern, raw: message });
    }
  }

  const report = (set: Row["set"], heading: string) => {
    const scoped = rows.filter((row) => row.set === set);
    if (scoped.length === 0) return;
    console.log(`\n${heading}  (${scoped.length} parts with a cached reading)\n`);

    const fired = new Map<string, string[]>();
    for (const row of scoped) {
      for (const guard of row.guards) fired.set(guard, [...(fired.get(guard) ?? []), row.part]);
    }

    for (const guard of GUARDS) {
      const hits = fired.get(guard.id) ?? [];
      // A guard that costs a part is one that fired on a document which HAD a
      // complete printed pattern: something was thrown away, not merely absent.
      const costly = hits.filter((part) => scoped.find((row) => row.part === part)?.hadPrintedPattern);
      const verdict = hits.length === 0 ? "never fires" : `${costly.length} of ${hits.length} threw away a printed pattern`;
      console.log(`  ${String(hits.length).padStart(3)}  ${guard.id.padEnd(30)} ${verdict}`);
      if (hits.length > 0) console.log(`       ${guard.where}: ${hits.slice(0, 8).join(", ")}${hits.length > 8 ? ", ..." : ""}`);
    }

    const ships = scoped.filter((row) => row.outcome === "ships").length;
    console.log(`\n  SHIPS ${ships}/${scoped.length}`);
  };

  // The raw refusals, so a guard reported as "never fires" can be checked
  // against what the generator actually said rather than against my patterns.
  if (process.argv.includes("--why")) {
    console.log("\nRAW REFUSALS, tuned corpus:\n");
    for (const row of rows.filter((r) => r.set === "tuned" && r.outcome !== "ships")) {
      console.log(`  ${row.part}  [printed pattern on record: ${row.hadPrintedPattern}]`);
      console.log(`    ${row.raw.replace(/\s+/g, " ").slice(0, 220)}\n`);
    }
  }

  report("tuned", "TUNED CORPUS. This is the evidence a guard is judged on.");
  report(
    "holdout",
    "HOLD-OUT, reported only as a consequence. Never the basis for a decision, per RULES.md."
  );
  report("other", "Cached parts in neither corpus.");
  console.log();
}

if (process.argv[1]?.endsWith("guards.ts")) {
  void main();
}
