/**
 * The read bar, broken on purpose before it is trusted.
 *
 * The version this replaces could not have failed: a fill pinned at a constant
 * width and a stage list with the active index hardcoded to 2. It said the same
 * thing at one second and at two minutes, which is the shape RULES.md calls an
 * instrument that cannot fail.
 *
 * So every property the bar claims is asserted here, and each assertion is one
 * the old code would have failed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { clock, progressAt, stagesFor } from "../readprogress";
import type { Intent } from "../intent";

const INTENTS: Intent[] = ["cad", "spice", "both"];

function total(intent: Intent): number {
  return stagesFor(intent).reduce((sum, stage) => sum + stage.seconds, 0);
}

test("every intent gets four stages and a positive schedule", () => {
  for (const intent of INTENTS) {
    const stages = stagesFor(intent);
    assert.equal(stages.length, 4, intent);
    for (const stage of stages) {
      assert.ok(stage.seconds > 0, `${intent}: ${stage.name} has no duration`);
      assert.ok(stage.name.length > 0 && stage.note.length > 0, `${intent}: ${stage.name} says nothing`);
    }
  }
});

test("the third stage names what this intent is actually reading", () => {
  // A footprint and a macromodel are aimed at different pages. A bar that named
  // the same third stage for both would be describing a read that did not happen.
  const cad = stagesFor("cad")[2].name;
  const spice = stagesFor("spice")[2].name;
  assert.notEqual(cad, spice);
  assert.match(cad, /outline/i);
  assert.match(spice, /specification/i);
});

test("the fill only ever increases, over the whole run and well past it", () => {
  for (const intent of INTENTS) {
    const stages = stagesFor(intent);
    let previous = -1;
    for (let ms = 0; ms <= 400_000; ms += 250) {
      const at = progressAt(ms, stages, false);
      assert.ok(
        at.fraction >= previous,
        `${intent}: fill went backwards at ${ms}ms, ${at.fraction} after ${previous}`
      );
      previous = at.fraction;
    }
  }
});

test("the fill moves inside every stage, not just between them", () => {
  // "Only ever increases" is satisfied by a bar that never moves at all, which
  // is exactly the defect being replaced. This is the assertion that fails on a
  // constant, so it is the one that earns the rest.
  for (const intent of INTENTS) {
    const stages = stagesFor(intent);
    let cumulative = 0;
    for (const stage of stages) {
      const start = progressAt(cumulative * 1000, stages, false).fraction;
      const end = progressAt((cumulative + stage.seconds - 1) * 1000, stages, false).fraction;
      assert.ok(end > start + 0.01, `${intent}: ${stage.name} showed no movement, ${start} to ${end}`);
      cumulative += stage.seconds;
    }
  }
});

test("the fill never reaches full while the read is still running", () => {
  for (const intent of INTENTS) {
    const stages = stagesFor(intent);
    for (const ms of [0, 1_000, 30_000, 90_000, 300_000, 3_600_000]) {
      const at = progressAt(ms, stages, false);
      assert.ok(at.fraction < 1, `${intent}: claimed done at ${ms}ms while still reading`);
    }
  }
});

test("only the response landing fills it", () => {
  const stages = stagesFor("cad");
  const done = progressAt(120_000, stages, true);
  assert.equal(done.fraction, 1);
  assert.equal(done.index, stages.length);
});

test("it moves visibly inside the first second, and keeps moving after the schedule", () => {
  const stages = stagesFor("cad");
  // A bar that does nothing for the first few seconds is indistinguishable from
  // a bar that is broken, which is what the constant-width version looked like.
  assert.ok(progressAt(750, stages, false).fraction > 0.005);
  // And a slow read must not freeze: the last of the ceiling is spent creeping.
  const at90 = progressAt(total("cad") * 1000, stages, false).fraction;
  const at150 = progressAt(150_000, stages, false).fraction;
  assert.ok(at150 > at90 + 0.005, `overrun stalled: ${at90} then ${at150}`);
});

test("the stage advances with the clock rather than sitting on one index", () => {
  const stages = stagesFor("cad");
  const seen = new Set<number>();
  for (let seconds = 0; seconds <= 100; seconds += 1) {
    seen.add(progressAt(seconds * 1000, stages, false).index);
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
});

test("the last stage never closes on a timer", () => {
  // Stages one to three are estimated. The fourth means "the reading is in
  // hand", so nothing but the response is allowed to close it.
  const stages = stagesFor("cad");
  for (const ms of [90_000, 200_000, 600_000]) {
    assert.equal(progressAt(ms, stages, false).index, 3, `moved past the last stage at ${ms}ms`);
  }
});

test("a stage has no start time until the clock has reached it", () => {
  const stages = stagesFor("cad");
  const early = progressAt(2_000, stages, false);
  assert.equal(early.startedAt[0], 0);
  assert.equal(early.startedAt[1], null);
  assert.equal(early.startedAt[3], null);

  // A finished read shows the whole history: printing dashes beside four
  // completed stages is the em-dash defect wearing a green tick.
  const finished = progressAt(90_000, stages, true);
  assert.ok(finished.startedAt.every((at) => at !== null));
});

test("overrun is reported, and not before the schedule is spent", () => {
  const stages = stagesFor("cad");
  assert.equal(progressAt(60_000, stages, false).overrun, false);
  assert.equal(progressAt(200_000, stages, false).overrun, true);
});

test("negative and absurd clocks do not produce a broken bar", () => {
  const stages = stagesFor("cad");
  for (const ms of [-5_000, 0, Number.MAX_SAFE_INTEGER]) {
    const at = progressAt(ms, stages, false);
    assert.ok(at.fraction >= 0 && at.fraction < 1, `fraction out of range at ${ms}ms: ${at.fraction}`);
    assert.ok(at.index >= 0 && at.index < stages.length, `index out of range at ${ms}ms: ${at.index}`);
  }
});

test("the clock reads as minutes and seconds", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(7), "0:07");
  assert.equal(clock(95), "1:35");
  assert.equal(clock(-3), "0:00");
});
