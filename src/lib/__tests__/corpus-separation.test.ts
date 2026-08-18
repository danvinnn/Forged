import { test } from "node:test";
import assert from "node:assert/strict";
import { BENCH_CORPUS } from "../retrieval/__bench__/corpus";
import { HOLDOUT_CORPUS } from "../__bench__/holdout";

/**
 * The hold-out must contain nothing that has been tuned against.
 *
 * This is the assumption every hold-out figure in this project rests on, and
 * until 2026-08-17 nothing checked it. THREE parts were in both corpora at once:
 * L7805, LTC3105 and TPS7A4700. Each had reader rules fitted to it in
 * `BENCH_CORPUS` while simultaneously counting toward "the number that predicts
 * a stranger's datasheet". The overlap was found by accident, when promoting a
 * part produced a duplicate entry and a two-part run reported three parts.
 *
 * Cheap to check, and it protects the one number here that cannot be recovered
 * once it is wrong: a contaminated hold-out does not look broken, it just reads
 * a little too high forever.
 */
test("no part is in both the tuned corpus and the hold-out", () => {
  const tuned = new Set(BENCH_CORPUS.map((part) => part.partNumber));
  const overlap = HOLDOUT_CORPUS.filter((part) => tuned.has(part.partNumber)).map((p) => p.partNumber);

  assert.deepEqual(
    overlap,
    [],
    `these parts are tuned against AND counted as unseen: ${overlap.join(", ")}. ` +
      `Remove them from the hold-out (never from the tuned corpus) and add a blind replacement.`
  );
});

test("neither corpus lists the same part twice", () => {
  // The duplicate that exposed the overlap. A repeated entry silently
  // double-weights one document in every percentage the bench reports.
  for (const [name, parts] of [
    ["BENCH_CORPUS", BENCH_CORPUS.map((p) => p.partNumber)],
    ["HOLDOUT_CORPUS", HOLDOUT_CORPUS.map((p) => p.partNumber)]
  ] as const) {
    const seen = new Set<string>();
    const dupes = parts.filter((part) => (seen.has(part) ? true : (seen.add(part), false)));
    assert.deepEqual(dupes, [], `${name} lists ${dupes.join(", ")} more than once`);
  }
});
