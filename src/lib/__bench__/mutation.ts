/**
 * Does the test suite actually notice when the product breaks?
 *
 * ## Why this exists
 *
 * A test count is not evidence. On 2026-08-16 this repository had 584 passing
 * tests while a TO-220 shipped a footprint with its three pins in two columns,
 * the dev server had been dead for weeks, and a check that examined zero fields
 * reported a pass. Every defect that has ever been caught here was caught by
 * something OUTSIDE the suite: a second implementation of the Altium format, a
 * pin table read off a PDF by hand, KiCad's own library files, the typechecker.
 *
 * The suite kept passing because it was largely written alongside the code it
 * tests, by the same author, in the same sitting, against hand-built fixtures.
 * That guarantees shared blind spots, and no amount of care fixes it: the fix is
 * to measure whether a test can fail at all.
 *
 * ## What this does
 *
 * Breaks the generator in specific, hand-chosen ways, one at a time, and reports
 * which breakages the suite notices. A mutation that SURVIVES is a defect this
 * product could ship today with a green board.
 *
 * Every mutation below is a real defect class, not a random character swap:
 * each one, if it reached a customer, produces a board that does not work. They
 * were chosen by reading the geometry code rather than generated, because the
 * question is "would we catch a plausible mistake", and a mutation nobody could
 * make by accident does not answer it.
 *
 * ## Reading the result
 *
 *   KILLED   the suite failed, which is the outcome we want
 *   SURVIVED the suite passed with broken geometry, which is a hole
 *
 * Usage:  npm run bench:mutation
 *         npm run bench:mutation -- --only M9
 *
 * Spends no money and touches no network. It edits files in place and restores
 * them in a `finally` AND from an exit/signal handler, because a `finally` does
 * not run when a timeout kills the process - see `inFlight`, which is there
 * because exactly that shipped a live mutation into the tree on 2026-08-20.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Mutation {
  id: string;
  /** The defect in the customer's terms, not the code's. */
  breaks: string;
  file: string;
  from: string;
  to: string;
}

const IPC = "src/lib/ipc7351.ts";
const EXPORTERS = "src/lib/exporters.ts";
const KICAD = "src/lib/emitters/kicad.ts";
const PCBLIB = "src/lib/emitters/altium/pcblib.ts";

const MUTATIONS: Mutation[] = [
  // --- IPC-7351B land pattern arithmetic -----------------------------------
  {
    id: "M1",
    breaks: "courtyard is twice the size, so the placement tool spaces parts too far apart",
    file: IPC,
    from: "{ A: 0.5, B: 0.25, C: 0.12 }",
    to: "{ A: 0.5, B: 0.5, C: 0.12 }"
  },
  {
    id: "M2",
    breaks: "drilled hole is too small for the lead, so the part cannot be inserted",
    file: IPC,
    from: "{ A: 0.25, B: 0.2, C: 0.15 }",
    to: "{ A: 0.25, B: 0.05, C: 0.15 }"
  },
  {
    id: "M3",
    breaks: "annular ring is too thin, so through-hole pads lift off the board",
    file: IPC,
    from: "{ A: 0.5, B: 0.4, C: 0.25 }",
    to: "{ A: 0.5, B: 0.15, C: 0.25 }"
  },
  {
    id: "M4",
    breaks: "toe fillet is starved, so the solder joint has no visible fillet to inspect",
    file: IPC,
    from: "B: { toe: 0.35, heel: 0.35, side: 0.03 }",
    to: "B: { toe: 0.15, heel: 0.35, side: 0.03 }"
  },
  {
    id: "M5",
    breaks: "lands are far too wide across the lead, so neighbouring pins bridge",
    file: IPC,
    from: "B: { toe: 0.35, heel: 0.35, side: 0.03 }",
    to: "B: { toe: 0.35, heel: 0.35, side: 0.35 }"
  },
  {
    id: "M6",
    breaks: "opposing rows sit at twice their correct separation, so no lead touches its pad",
    file: IPC,
    from: "padCentreMm: (zMax + gMin) / 4,",
    to: "padCentreMm: (zMax + gMin) / 2,"
  },
  {
    id: "M7",
    breaks: "every land is twice as long, so opposing lands run into each other",
    file: IPC,
    from: "padLengthMm: (zMax - gMin) / 2,",
    to: "padLengthMm: zMax - gMin,"
  },
  {
    id: "M8",
    breaks: "paste coverage on a thermal pad is 95%, which floats the part on solder",
    file: IPC,
    from: "const TARGET_PASTE_COVERAGE = 0.65;",
    to: "const TARGET_PASTE_COVERAGE = 0.95;"
  },

  // --- Pad placement --------------------------------------------------------
  {
    id: "M9",
    breaks: "each side of a quad package starts at the centre instead of being centred on it",
    file: EXPORTERS,
    from: "    (index - (count - 1) / 2) * definition.pitchMm;",
    to: "    index * definition.pitchMm;"
  },
  {
    id: "M10",
    breaks: "a dual row is not centred on the origin, so the whole part is offset",
    file: EXPORTERS,
    from: "const step = (index: number) => -rowSpanMm / 2 + index * definition.pitchMm;",
    to: "const step = (index: number) => index * definition.pitchMm;"
  },
  {
    id: "M11",
    breaks: "the right-hand row is numbered the wrong way, so every pin on it is miswired",
    file: EXPORTERS,
    from: 'right.forEach((number, index) => push(number, land.padCentreMm, step(index), "x"));',
    to: 'right.forEach((number, index) => push(number, land.padCentreMm, -step(index), "x"));'
  },
  {
    id: "M12",
    breaks: "one side of a quad package runs backwards, so a quarter of the pins are miswired",
    file: EXPORTERS,
    from: 'right.forEach((number, index) => push(number, land.padCentreMm, -at(right, index), "x"));',
    to: 'right.forEach((number, index) => push(number, land.padCentreMm, at(right, index), "x"));'
  },
  {
    id: "M13",
    breaks: "a misread lead width wider than its own pitch is accepted instead of refused",
    file: EXPORTERS,
    from: "const MAX_LEAD_WIDTH_FRACTION_OF_PITCH = 0.75;",
    to: "const MAX_LEAD_WIDTH_FRACTION_OF_PITCH = 5;"
  },
  {
    id: "M14",
    breaks: "through-hole rows sit at twice the drawing's spacing, so the part does not fit",
    file: EXPORTERS,
    // Retargeted 2026-08-17. The line read `rowSpacingMm / 2` until single-row
    // packages landed and the span became 0 for a one-row part; this mutation
    // then matched nothing and reported NOT APPLIED, which is a hole in the
    // suite that still looks like a member of it. A mutation that cannot be
    // applied proves nothing and must be repaired the run it is reported, not
    // left as a permanent 19-of-20.
    from: "      padCentreMm: spanMm / 2,",
    to: "      padCentreMm: spanMm,"
  },

  // --- KiCad output ---------------------------------------------------------
  {
    id: "M15",
    breaks: "silkscreen is drawn far too thick for the convention",
    file: KICAD,
    from: "const SILK_WIDTH_MM = 0.12;",
    to: "const SILK_WIDTH_MM = 0.5;"
  },
  {
    id: "M16",
    breaks: "surface-mount pads get no solder paste, so nothing is soldered at reflow",
    file: KICAD,
    from: '(layers "F.Cu" "F.Paste" "F.Mask")',
    to: '(layers "F.Cu" "F.Mask")'
  },
  {
    // REWRITTEN 2026-08-16, because the first version was a bad mutation.
    //
    // It dropped `(roundrect_rratio 0.25)` from the through-hole pad line and
    // was described as losing the pin-1 marker. It does not: the shape token
    // stays `roundrect`, and KiCad's own default corner ratio is 0.25, so the
    // emitted pad is almost certainly identical. It SURVIVED, and reporting that
    // as a hole in the suite would have been a false alarm dressed as a finding.
    //
    // This is the defect that description actually names: every through-hole pad
    // round, so nothing on the assembled board says which end pin 1 is. The
    // silkscreen is under the part once it is fitted, which is why the pad shape
    // is the marker that matters.
    id: "M17",
    breaks: "through-hole pin 1 loses its square marker, so the part can be fitted backwards",
    file: EXPORTERS,
    from: 'shape: (number === 1 ? "roundrect" : "circle") as "roundrect" | "circle",',
    to: 'shape: "circle" as "roundrect" | "circle",'
  },
  {
    id: "M18",
    breaks: "courtyard line width is wrong for the convention",
    file: KICAD,
    from: "const COURTYARD_WIDTH_MM = 0.05;",
    to: "const COURTYARD_WIDTH_MM = 0.2;"
  },

  // --- Altium output --------------------------------------------------------
  {
    id: "M19",
    breaks: "through-hole pads land on the top layer only, so the hole connects nothing",
    file: PCBLIB,
    from: "  multiLayer: 74",
    to: "  multiLayer: 1"
  },
  {
    id: "M20",
    breaks: "through-hole barrels are unplated, so there is no connection through the board",
    file: PCBLIB,
    from: "  if (throughHole) main[60] = 1;",
    to: "  if (throughHole) main[60] = 0;"
  }
];

const root = process.cwd();
const onlyFlag = process.argv.indexOf("--only");
const ONLY = onlyFlag !== -1 ? process.argv[onlyFlag + 1] : null;

/** Runs the whole suite. Returns true when everything passed. */
function suitePasses(): boolean {
  try {
    execFileSync("npx", ["tsx", "--test", "src/lib/**/__tests__/*.test.ts"], {
      cwd: root,
      stdio: "pipe",
      encoding: "utf8"
    });
    return true;
  } catch {
    return false;
  }
}


/**
 * A WRITE-AHEAD JOURNAL, because a `finally` and a signal handler are both too
 * weak for what actually happens to this bench.
 *
 * The header used to claim that restoring in a `finally` made an interrupted run
 * safe. It does not. This bench runs the whole suite once per mutation and takes
 * long enough that being KILLED on a timeout is the ordinary outcome, and a
 * killed process runs no `finally`. Signal handlers were tried next and are also
 * not enough: SIGKILL cannot be caught, and a harness that kills a process tree
 * does not politely send SIGTERM first.
 *
 * It has bitten twice. On 2026-08-20 a ten-minute timeout left the gull-wing side
 * fillet ten times too large in `ipc7351.ts`; on 2026-08-21, while testing the
 * signal handler that was supposed to fix it, a kill left
 * `HOLE_ALLOWANCE` at 0.05 instead of 0.2 - the through-hole drill allowance.
 * **All tests passed both times**, which is what a mutation is FOR, so a green
 * suite can never be the thing that catches this.
 *
 * So the file's original contents are written to disk BEFORE it is mutated, and
 * recovery happens at STARTUP rather than at shutdown. That survives SIGKILL, a
 * killed process tree and a power cut, because it does not require this process
 * to run any code at all.
 */
const JOURNAL = join(root, ".mutation-journal.json");

/** Records what is about to be overwritten, before overwriting it. */
function beginMutation(path: string, original: string): void {
  writeFileSync(JOURNAL, JSON.stringify({ path, original }), "utf8");
}

/** Clears the journal once the file is safely back. */
function endMutation(): void {
  if (existsSync(JOURNAL)) rmSync(JOURNAL);
}

/**
 * Puts back whatever a previous run was holding when it died. Runs before this
 * one mutates anything, and shouts, because a silent recovery would hide the
 * fact that a mutation was loose in the tree.
 */
function recoverFromLastRun(): void {
  if (!existsSync(JOURNAL)) return;
  try {
    const held = JSON.parse(readFileSync(JOURNAL, "utf8")) as { path: string; original: string };
    if (typeof held.path === "string" && typeof held.original === "string") {
      const current = existsSync(held.path) ? readFileSync(held.path, "utf8") : null;
      if (current !== held.original) {
        writeFileSync(held.path, held.original);
        console.error(
          `\n  RECOVERED: a previous run was killed with ${held.path} mutated, and it has been put back.\n` +
            `  If anything was committed since that run, CHECK IT.\n`
        );
      }
    }
  } catch (error) {
    console.error(`  Could not read ${JOURNAL}: ${(error as Error).message}`);
    console.error(`  Restore the file by hand and delete the journal before re-running.`);
    process.exit(1);
  }
  endMutation();
}

// Still worth having for the polite cases: a Ctrl-C or a plain SIGTERM restores
// immediately rather than leaving the next run to do it. The journal is what
// makes the guarantee; these only make it faster.
function restoreNow(): void {
  if (!existsSync(JOURNAL)) return;
  try {
    const held = JSON.parse(readFileSync(JOURNAL, "utf8")) as { path: string; original: string };
    writeFileSync(held.path, held.original);
    endMutation();
    console.error(`\n  restored ${held.path} after an interrupted run`);
  } catch {
    // The journal survives, and the next run recovers from it.
  }
}
process.on("exit", restoreNow);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    restoreNow();
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}


function main(): void {
  const chosen = ONLY ? MUTATIONS.filter((m) => m.id === ONLY) : MUTATIONS;

  // THE BASELINE, FIRST. Without this the whole run is worthless.
  //
  // A mutation is "killed" when the suite fails. If the suite ALREADY fails, every
  // mutation is killed and the report reads 20/20, which is the most reassuring
  // possible output and means nothing at all.
  //
  // That is not hypothetical: the first run of this file reported exactly that.
  // The tree had a failing test in it, added while the run was in progress, and
  // the perfect score was an artifact of a red baseline. A tool built to stop a
  // green board being mistaken for a working product had the same defect it was
  // written to find.
  //
  // So the baseline is checked and a red one is a hard stop, not a warning.
  // BEFORE THE BASELINE, and the ordering is the whole point.
  //
  // Put after it, recovery never runs in the case it exists for: a leftover
  // mutation fails the baseline, the bench exits reporting a red suite, and the
  // corruption stays in the tree with a misleading explanation on top of it.
  // That is worse than the original bug, and it is what this file did for about
  // twenty minutes on 2026-08-21.
  recoverFromLastRun();

  console.log("Checking the baseline passes before mutating anything...");
  if (!suitePasses()) {
    console.error(
      "\nSTOPPED: the test suite does not pass on the UNMODIFIED tree.\n" +
        "Every mutation would be reported as killed and the run would mean nothing.\n" +
        "Fix the suite, then re-run. Do not edit the tree while this is running either:\n" +
        "a file changed mid-run poisons every mutation after it."
    );
    process.exitCode = 1;
    return;
  }
  console.log("Baseline is green.\n");
  const survived: Mutation[] = [];
  const killed: Mutation[] = [];
  const notApplied: Mutation[] = [];

  console.log(`\nMutation testing: ${chosen.length} hand-chosen defects\n`);

  for (const mutation of chosen) {
    const path = join(root, mutation.file);
    const original = readFileSync(path, "utf8");

    // A mutation that does not apply is a BUG IN THIS FILE, reported rather
    // than skipped quietly. A silently-skipped mutation reads as a pass.
    const occurrences = original.split(mutation.from).length - 1;
    if (occurrences !== 1) {
      notApplied.push(mutation);
      console.log(`  ${mutation.id.padEnd(4)} NOT APPLIED  (matched ${occurrences} times, expected 1)`);
      continue;
    }

    try {
      beginMutation(path, original);
      writeFileSync(path, original.replace(mutation.from, mutation.to));
      const passed = suitePasses();
      if (passed) {
        survived.push(mutation);
        console.log(`  ${mutation.id.padEnd(4)} SURVIVED     ${mutation.breaks}`);
      } else {
        killed.push(mutation);
        console.log(`  ${mutation.id.padEnd(4)} killed`);
      }
    } finally {
      writeFileSync(path, original);
      endMutation();
    }
  }

  console.log(
    `\nKILLED ${killed.length}/${chosen.length}   SURVIVED ${survived.length}` +
      (notApplied.length > 0 ? `   NOT APPLIED ${notApplied.length}` : "")
  );

  if (survived.length > 0) {
    console.log("\nWhat this product could ship today with a green board:");
    for (const mutation of survived) console.log(`  ${mutation.id}  ${mutation.breaks}`);
  }
  if (notApplied.length > 0) {
    console.log("\nThese mutations no longer match the source and need rewriting:");
    for (const mutation of notApplied) console.log(`  ${mutation.id}  ${mutation.file}`);
  }
}

main();
