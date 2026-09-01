/**
 * A DELIBERATE DEFECT, put into an instrument to see whether it notices.
 *
 * ## Why this exists
 *
 * On 2026-08-29 four instruments were found that could not fire. `bench:browser`
 * looked for its question box with a selector matching no element in the markup.
 * `bench:copper`'s exposed-pad check compared a pad number the emitter never
 * emits. `replayRecords` hardcoded `electricalType: "unspecified"`, which is the
 * exact field `bench:pintypes` existed to measure. `bench:badinput` synthesised
 * PDFs that pdf.js could not open, so two of its three findings were its own.
 *
 * Every one of them had been green for weeks, and a green instrument that cannot
 * go red is worse than no instrument: it spends trust that has not been earned.
 * Four in one sitting is a shape, not bad luck, and the only way to know an
 * instrument works is to break the thing it watches and watch it complain.
 *
 * ## How it works
 *
 * A bench calls `defect("<stage>", value)` at the point a real defect of that
 * kind would enter its data - AFTER the value is produced, BEFORE the check that
 * is supposed to catch it. With `FORGE_INJECT` unset the call returns its
 * argument untouched and costs a string comparison, so the seam is inert in
 * every normal run. With `FORGE_INJECT=<stage>` it returns a corrupted value and
 * the bench should report a problem.
 *
 * `bench:instruments` drives that: every stage, run against the bench that owns
 * it, with the run refused if the output does not change.
 *
 * PLACEMENT IS THE WHOLE CLAIM. A hook in the wrong place proves an instrument
 * catches something it would never see. Each `defect()` call site carries a
 * comment saying which real failure it stands for.
 *
 * Bench-only. Nothing under `src/lib` outside `__bench__` imports this, and
 * nothing in the product does.
 */

/**
 * Which stage is being corrupted on this run, or null for a normal run.
 *
 * `FORGE_INJECT=stage:argument` names a stage and passes the argument through to
 * the corruption, which is how one stage covers a family of defects: a bench
 * with seven guards needs seven different wrong records, not one.
 */
const RAW = process.env.FORGE_INJECT?.trim() || null;
const ACTIVE = RAW === null ? null : RAW.split(":")[0];
const ARGUMENT = RAW === null ? null : (RAW.split(":").slice(1).join(":") || null);

/** Every stage a bench has wired, so `bench:instruments` can enumerate them. */
export const INJECTION_STAGES = [
  "copper.pads",
  "courtyard.geometry",
  "joints.geometry",
  "guards.part",
  "unchecked.part",
  "published.pads",
  "dimensions.record",
  "discards.rejected",
  "questions.needs",
  "symbol.symbol",
  "pintypes.pins",
  "emitters.kicad",
  "corpus.text",
  "passes.answers",
  "repeatable.record",
  "confirm.part",
  "sidesweep.part",
  "bodysweep.part",
  "pinsweep.evidence",
  "powerpins.symbol",
  "replay.part",
  "altium.file"
] as const;

export type InjectionStage = (typeof INJECTION_STAGES)[number];

export function injecting(stage: InjectionStage): boolean {
  return ACTIVE === stage;
}

/** True on any injected run, whichever stage. */
export function anyInjection(): string | null {
  return ACTIVE;
}

/**
 * Corrupt `value` if this run is injecting into `stage`, otherwise hand it back.
 *
 * The corruption is supplied by the caller because only the bench knows what a
 * real defect of its kind looks like in its own data. Corrupt BY A LOT: this
 * asks whether a check exists, not how sensitive it is.
 */
export function defect<T>(stage: InjectionStage, value: T, corrupt: (value: T, argument: string | null) => T): T {
  if (ACTIVE !== stage) return value;
  return corrupt(value, ARGUMENT);
}
