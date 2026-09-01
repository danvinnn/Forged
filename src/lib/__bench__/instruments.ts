/**
 * DOES EACH INSTRUMENT ACTUALLY WORK? Break the thing it watches and look.
 *
 * ## Why this exists
 *
 * On 2026-08-29 four instruments were found that could not fire. `bench:browser`
 * looked for its question box with a selector matching no element. `bench:copper`
 * compared a pad number the emitter never emits. `replayRecords` hardcoded
 * `electricalType`, the exact field `bench:pintypes` measured. `bench:badinput`
 * built PDFs pdf.js could not open. All four had been green for weeks.
 *
 * A green instrument that cannot go red is worse than no instrument: every other
 * conclusion in this repository rests on one, and a false clean sheet spends
 * trust that was never earned. Four in one sitting is a shape, not bad luck.
 *
 * So this runs each bench twice - once as it is, once with a deliberate defect
 * injected at the point a real one would enter - and REFUSES the run if the
 * output does not change. `inject.ts` holds the seam; each `defect()` call site
 * carries a comment saying which real failure it stands for, because placement
 * is the whole claim.
 *
 * ## What it found on its first run, 2026-08-30
 *
 *   bench:copper   reported a land moved 0.9 mm on 14 of 80 footprints. PITCH
 *                  and SPAN examine only rows whose membership equals the widest
 *                  row, and a land that LEAVES its row shrinks that row below
 *                  the threshold - so both checks skipped the row holding the
 *                  defect. The likeliest emitter defect there is, and the
 *                  instrument written to catch it looked away from exactly that
 *                  case. Now 80 of 80.
 *   bench:guards   six of seven guards fired on nothing in any corpus. All six
 *                  work; the conditions are simply rare. That could not be known
 *                  before.
 *   bench:unchecked  three of its eight mutations had nothing to corrupt,
 *                  because `replayRecords` hardcoded `vendorLandPattern` and no
 *                  replayed part could ever confirm its pitch. The row read
 *                  `0 0 0` and looked like a pass.
 *
 * Free. Every bench below runs off disk with no network and no spend.
 */

import { spawnSync } from "node:child_process";

interface Instrument {
  /** The npm script, without the `bench:` prefix. */
  bench: string;
  /** `FORGE_INJECT` value. */
  inject: string;
  /** What real failure the injected defect stands for. */
  defect: string;
  /**
   * How to read the output. Returns the number the bench reports for the thing
   * being watched, so the run can insist the injected number is HIGHER.
   */
  read: (output: string) => number;
  /** Minutes, roughly, so a caller knows what they are starting. */
  slow?: boolean;
}

const count = (pattern: RegExp) => (output: string) => {
  const match = output.match(pattern);
  return match ? Number(match[1]) : Number.NaN;
};

/** Lines matching a pattern, for benches that list rather than total. */
const lines = (pattern: RegExp) => (output: string) =>
  output.split("\n").filter((line) => pattern.test(line)).length;

const INSTRUMENTS: Instrument[] = [
  {
    bench: "copper",
    inject: "copper.pads",
    defect: "one land moved 0.9 mm along x, the record untouched",
    // ORACLE included: `bench:copper` also compares the emitted span against the
    // hand-read drawing, and leaving that check out of the pattern made this
    // driver report a clean baseline for a bench that had a live finding.
    read: lines(/^\s+(PITCH|SIZE|SPAN|BUILD|ROW|EP|ORACLE)\s/)
  },
  {
    bench: "courtyard",
    inject: "courtyard.geometry",
    defect: "the courtyard halved after the build",
    read: lines(/courtyard \d/)
  },
  {
    bench: "joints",
    inject: "joints.geometry",
    defect: "every land shrunk to a fifth, so no lead sits on its copper",
    read: count(/(\d+) with a lead that misses its copper/)
  },
  {
    bench: "published",
    inject: "published.pads",
    defect: "every pad inflated by a third against somebody else's footprint",
    read: count(/(\d+) footprint\(s\) differ by more than/)
  },
  {
    bench: "altium",
    inject: "altium.file",
    defect: "every emitted Altium library truncated to a third, as a half-copied file is",
    // Both buckets, because a truncated compound file can present either way.
    read: (output) =>
      (count(/(\d+) file\(s\) the reader would not open/)(output) || 0) +
      (count(/(\d+) file\(s\) opened while logging a complaint/)(output) || 0),
    slow: true
  },
  {
    bench: "corpus",
    inject: "corpus.text",
    defect: "each document asked whether it names an unrelated part",
    read: lines(/^\s+WRONG PART\s/),
    slow: true
  },
  {
    bench: "repeatable",
    inject: "repeatable.record",
    defect: "the third of three identical passes fingerprints differently",
    // A CLEAN RUN PRINTS A SENTENCE, NOT A ZERO. The first version read only the
    // count and came back NaN on the clean pass, so a working instrument was
    // reported as one that cannot fire - this driver committing the exact sin it
    // exists to catch, on its own first run.
    read: (output) =>
      /byte-identical across runs/.test(output) ? 0 : count(/(\d+) document\(s\) do not reproduce/)(output),
    slow: true
  },
  {
    bench: "discards",
    inject: "discards.rejected",
    defect: "land dimensions gone from the record AND from the rejection list",
    read: count(/SILENTLY DISCARDED\s+(\d+)/),
    slow: true
  },
  {
    bench: "questions",
    inject: "questions.needs",
    defect: "land dimensions blanked, so the export asks for what the drawing prints",
    read: lines(/^\s+FALSE (DROPPED|UNREAD)\s/),
    slow: true
  },
  {
    bench: "dimensions",
    inject: "dimensions.record",
    defect: "every numeric reading moved by a third against the hand-read drawing",
    read: count(/WRONG\s+(\d+)\s+NOT READ/),
    slow: true
  },
  {
    bench: "confirm",
    inject: "confirm.part",
    defect: "a CONFIRMED pinout and land pattern made wrong after the product vouched for them",
    read: (output) =>
      (count(/CONFIRMED AND THE ORACLE DISAGREES\s+(\d+)/)(output) || 0) +
      (count(/CONFIRMED AND THE DRAWING DISAGREES\s+(\d+)/)(output) || 0),
    slow: true
  }
];

/**
 * The seven guards, each driven by a record built to trip it.
 *
 * Separate from the table above because they are not one instrument being
 * checked but seven pieces of PRODUCT code, six of which fire on nothing in any
 * corpus. "Rare" and "dead" look identical from the outside and only this tells
 * them apart.
 */
const GUARD_DEFECTS: Array<{ inject: string; guard: string }> = [
  { inject: "wider-than-pitch", guard: "printed-land-wider-than-pitch" },
  { inject: "rows-overlap", guard: "printed-rows-overlap" },
  { inject: "lead-too-wide", guard: "lead-too-wide-for-pitch" },
  { inject: "contradicts-printed", guard: "computed-contradicts-printed" },
  { inject: "inconsistent", guard: "computed-inconsistent" },
  { inject: "name-vs-pin-count", guard: "package-name-vs-pin-count" }
];

function run(bench: string, inject: string | null): string {
  const result = spawnSync("npm", ["run", "--silent", `bench:${bench}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: inject === null ? process.env : { ...process.env, FORGE_INJECT: inject }
  });
  // pdf.js writes font warnings to stderr on nearly every document.
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function main(): void {
  const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
  const quick = process.argv.includes("--quick");
  const chosen = INSTRUMENTS.filter(
    (one) => (!only || one.bench === only) && (!quick || !one.slow)
  );

  console.log(`\nBreaking what each instrument watches, and checking it complains. No network, no spend.\n`);
  console.log(`  ${"bench".padEnd(12)} ${"clean".padStart(7)} ${"injected".padStart(9)}   verdict`);

  const broken: string[] = [];
  for (const one of chosen) {
    const clean = one.read(run(one.bench, null));
    const dirty = one.read(run(one.bench, one.inject));
    const works = Number.isFinite(clean) && Number.isFinite(dirty) && dirty > clean;
    if (!works) broken.push(`${one.bench}: ${one.defect}`);
    console.log(
      `  ${one.bench.padEnd(12)} ${String(clean).padStart(7)} ${String(dirty).padStart(9)}   ` +
        (works ? "fires" : "DID NOT NOTICE") + `   (${one.defect})`
    );
  }

  if (!only && !quick) {
    console.log(`\n  The seven land-pattern guards, each given a record built to trip it.\n`);
    const baseline = run("guards", null);
    const fires = (output: string, guard: string) =>
      new RegExp(`^\\s+([1-9]\\d*)\\s+${guard}\\s`, "m").test(output);
    for (const entry of GUARD_DEFECTS) {
      const output = run("guards", `guards.part:${entry.inject}`);
      const works = fires(output, entry.guard);
      if (!works) broken.push(`guard ${entry.guard} did not fire on a record built to trip it`);
      console.log(`  ${entry.guard.padEnd(32)} ${works ? "fires" : "DEAD"}`);
    }
    // The seventh fires on real records, so it needs no injection - but it is
    // printed beside the others, because a guard missing from the list reads as
    // a guard nobody checked.
    const live = fires(baseline, "printed-outside-ipc-band");
    console.log(`  ${"printed-outside-ipc-band".padEnd(32)} ${live ? "fires on real data" : "DEAD"}`);
    if (!live) broken.push("printed-outside-ipc-band stopped firing on real data");
  }

  console.log("");
  if (broken.length === 0) {
    console.log("  Every instrument above went red when the thing it watches was broken.\n");
    return;
  }
  for (const line of broken) console.log(`  CANNOT FIRE  ${line}`);
  console.log(`\n  ${broken.length} instrument(s) report a clean sheet for something nobody is looking at.\n`);
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith("instruments.ts")) {
  main();
}
