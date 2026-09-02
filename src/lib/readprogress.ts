/**
 * WHAT THE BAR IS ALLOWED TO SAY WHILE A READ IS RUNNING.
 *
 * ## The defect this replaces
 *
 * The first version of this screen rendered four stage rows with `index === 2`
 * hardcoded as the active one and every timestamp printed as an em dash, over a
 * fill pinned at `inset: 0 42% 0 0`. It said the same thing at one second and at
 * two minutes. That is an instrument that cannot fail: it could not have shown a
 * stalled read, a fast read or a slow one differently, so a user watching it
 * learned nothing and, worse, learned to distrust it.
 *
 * ## Three properties, and they are the whole design
 *
 * 1. **MONOTONIC.** The fill only ever increases. A bar that steps back reads as
 *    a fault even when nothing is wrong.
 * 2. **NEVER FULL BEFORE IT IS DONE.** The schedule below is a typical shape,
 *    not a measurement of this run, so the fill approaches a ceiling and creeps
 *    at it rather than arriving. A read that takes three minutes keeps moving and
 *    never claims to have finished. Only the response landing sets it to 1.
 * 3. **THE LAST STAGE CANNOT COMPLETE ON A TIMER.** Stages one to three advance
 *    on elapsed time; the fourth is closed by the fetch resolving, which is a
 *    real event. So the one transition that means "this worked" is never guessed.
 *
 * ## Where the schedule comes from, stated plainly
 *
 * It is a DISPLAY estimate of the shape of the pipeline, not a reading of it.
 * The route runs one model call of about ninety seconds and the four stages are
 * the four things it does, in order. Nothing in the response reports which one is
 * running, so the split between them is proportioned, and this file is the only
 * place that proportion exists.
 *
 * It is kept out of the record for exactly that reason: no value here reaches an
 * emitted library, a citation or a confirmation. It moves a bar.
 *
 * TODO(merge): `/api/parse` and `/api/lookup` know precisely when each stage
 * begins. When they stream that, `progressAt` takes the real boundaries and the
 * estimate becomes the fallback for a route that has not sent one yet.
 */

import type { Intent } from "./intent";

export interface ReadStage {
  name: string;
  /** Typical seconds for this stage. Display only; see the note above. */
  seconds: number;
  note: string;
}

/**
 * The fill stops here until the read actually returns.
 *
 * A bar sitting at 100% while the request is still open is the single most
 * common way a progress indicator lies, and it is the one users notice.
 */
const CEILING = 0.94;

/** How fast the last six percent is spent once a read runs past its typical time. */
const OVERRUN_TAU_MS = 45_000;

/**
 * The hard stop, and it is not decoration.
 *
 * The creep is `1 - (1 - CEILING) * exp(-over / tau)`, which is below 1 for
 * every real number and NOT below 1 in floating point: `exp` underflows to zero
 * once `over` passes about thirty minutes, and the expression evaluates to
 * exactly 1. A read that hung would then have shown a full bar, which is the one
 * thing this file exists to prevent, on the one run where it matters most.
 *
 * Found by the test asserting it, not by reading the arithmetic.
 */
const MAX_WHILE_RUNNING = 0.999;

/**
 * Fast at the start of a stage, slowing as it approaches the next boundary.
 *
 * Chosen so a stage always shows movement in its first second: a bar that does
 * nothing for ten seconds is indistinguishable from a bar that is broken, which
 * is the state this file exists to leave behind.
 */
function ease(fraction: number): number {
  const clamped = Math.min(Math.max(fraction, 0), 1);
  return 1 - (1 - clamped) * (1 - clamped);
}

export function stagesFor(intent: Intent): ReadStage[] {
  const third =
    intent === "spice"
      ? { name: "Specification table, read again", note: "Aimed only at the pages that carry parameters." }
      : intent === "cad"
        ? { name: "Package outline drawing, read again", note: "Aimed only at the pin table and the outline." }
        : { name: "Outline drawing, then the specification table", note: "Both page sets in the one aimed pass." };
  return [
    {
      name: "Whole document to the model",
      seconds: 10,
      note: "Every page seen once, so nothing is chosen before it is looked at."
    },
    {
      name: "Pages located and rendered",
      seconds: 12,
      note: "The pages that answer this intent, rendered at full resolution."
    },
    { name: third.name, seconds: 48, note: third.note },
    {
      name: "Two readings cross-checked",
      seconds: 20,
      note: "Nothing ships unless two independent readings agree on it."
    }
  ];
}

export interface ReadProgress {
  /** 0 to 1. Increases with elapsed time, and only reaches 1 when `done`. */
  fraction: number;
  /** Index of the stage now running, or `stages.length` once done. */
  index: number;
  /** Elapsed at which each stage started, in seconds, or null if it has not. */
  startedAt: Array<number | null>;
  /** True once the run is past its typical total and the fill is creeping. */
  overrun: boolean;
}

/**
 * Where the bar and the stage list should be, given how long the read has run.
 *
 * `done` is the fetch having resolved. It is the ONLY thing that fills the bar
 * and the only thing that closes the last stage: everything else here is an
 * estimate and is not allowed to claim a result.
 */
export function progressAt(elapsedMs: number, stages: ReadStage[], done: boolean): ReadProgress {
  const total = stages.reduce((sum, stage) => sum + stage.seconds, 0);
  const startedAt: Array<number | null> = stages.map(() => null);
  let cumulative = 0;

  if (done) {
    // Every stage has a start, the last one included, because the run got past
    // all of them. A completed read that printed dashes for its own history
    // would be the em-dash defect wearing a green tick.
    for (let i = 0; i < stages.length; i += 1) {
      startedAt[i] = cumulative;
      cumulative += stages[i].seconds;
    }
    return { fraction: 1, index: stages.length, startedAt, overrun: false };
  }

  const elapsed = Math.max(elapsedMs, 0) / 1000;
  cumulative = 0;
  for (let i = 0; i < stages.length; i += 1) {
    const stage = stages[i];
    if (elapsed >= cumulative) startedAt[i] = cumulative;
    // The last stage never closes on the clock: only the response closes it, so
    // a run past its typical time stays in "cross-checked" rather than pretending
    // to have moved somewhere there is nowhere to move to.
    const last = i === stages.length - 1;
    if (elapsed < cumulative + stage.seconds || last) {
      const local = ease((elapsed - cumulative) / stage.seconds);
      const reached = Math.min(cumulative + stage.seconds * local, total);
      const base = CEILING * (reached / total);
      if (!last || elapsed <= total) {
        return { fraction: base, index: i, startedAt, overrun: false };
      }
      // Past the typical total. Continue from exactly where the schedule left
      // off, spending what is left of the ceiling asymptotically: always moving,
      // never arriving.
      const over = elapsed - total;
      const crept = 1 - (1 - CEILING) * Math.exp(-(over * 1000) / OVERRUN_TAU_MS);
      return {
        fraction: Math.min(crept, MAX_WHILE_RUNNING),
        index: i,
        startedAt,
        overrun: true
      };
    }
    cumulative += stage.seconds;
  }

  return { fraction: CEILING, index: stages.length - 1, startedAt, overrun: true };
}

/** `m:ss` from seconds, for the column that says when each stage began. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
