import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MIN_MODEL_BUDGET_MS,
  ModelDeadlineError,
  RESPONSE_MARGIN_MS,
  modelBudgetMs,
  withDeadline,
  worthAsking
} from "../budget";

/**
 * Measured: a model call takes up to 41.6 seconds and the parse route's
 * maxDuration is 30. The model's own ceiling is 60, so it can never stop first;
 * the platform kills the function instead and a deterministic record that had
 * already succeeded comes back as a 504.
 */

const ROUTE_BUDGET_MS = 30_000;

test("the model gets what is left of the route's budget, less the response margin", () => {
  assert.equal(modelBudgetMs(ROUTE_BUDGET_MS, 0), ROUTE_BUDGET_MS - RESPONSE_MARGIN_MS);
  assert.equal(modelBudgetMs(ROUTE_BUDGET_MS, 5_000), ROUTE_BUDGET_MS - RESPONSE_MARGIN_MS - 5_000);
});

test("a parse that used the whole budget leaves nothing to ask with", () => {
  // A 357-page STM32H743ZI takes most of a second to parse, but retrieval on a
  // slow vendor host is what actually eats this, and the answer must not be to
  // start a call the platform will kill.
  const budget = modelBudgetMs(ROUTE_BUDGET_MS, 29_000);

  assert.ok(budget < MIN_MODEL_BUDGET_MS);
  assert.equal(worthAsking(budget), false);
});

test("an operator can cap the model budget below the route's", () => {
  const previous = process.env.FORGE_MODEL_BUDGET_MS;
  process.env.FORGE_MODEL_BUDGET_MS = "8000";
  try {
    assert.equal(modelBudgetMs(ROUTE_BUDGET_MS, 0), 8_000);
  } finally {
    if (previous === undefined) delete process.env.FORGE_MODEL_BUDGET_MS;
    else process.env.FORGE_MODEL_BUDGET_MS = previous;
  }
});

test("a garbage cap is ignored rather than obeyed", () => {
  const previous = process.env.FORGE_MODEL_BUDGET_MS;
  for (const value of ["0", "-1", "not-a-number"]) {
    process.env.FORGE_MODEL_BUDGET_MS = value;
    assert.equal(
      modelBudgetMs(ROUTE_BUDGET_MS, 0),
      ROUTE_BUDGET_MS - RESPONSE_MARGIN_MS,
      `${value} must not become the budget`
    );
  }
  if (previous === undefined) delete process.env.FORGE_MODEL_BUDGET_MS;
  else process.env.FORGE_MODEL_BUDGET_MS = previous;
});

test("work that answers in time is returned untouched", async () => {
  assert.equal(await withDeadline(Promise.resolve("answer"), 1_000), "answer");
});

test("work that overruns is abandoned as a deadline, not a failure", async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve("too late"), 5_000));

  await assert.rejects(
    () => withDeadline(slow, 20),
    (error: unknown) => {
      assert.ok(error instanceof ModelDeadlineError, "the caller must be able to tell these apart");
      assert.equal(error.budgetMs, 20);
      return true;
    }
  );
});

test("a real failure stays a real failure", async () => {
  await assert.rejects(
    () => withDeadline(Promise.reject(new Error("transport blew up")), 1_000),
    (error: unknown) => {
      assert.ok(!(error instanceof ModelDeadlineError));
      return true;
    }
  );
});

test("an abandoned call rejecting later does not take the process down", async () => {
  // Promise.race leaves the loser unobserved, and in Node an unobserved rejection
  // arriving after the response has been sent is fatal. That would turn one slow
  // model call into an outage rather than a note on a record.
  const rejectsLater = new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error("late transport failure")), 30);
  });

  await assert.rejects(() => withDeadline(rejectsLater, 10), ModelDeadlineError);

  let fatal: unknown = null;
  const capture = (error: unknown) => {
    fatal = error;
  };
  process.on("unhandledRejection", capture);
  await new Promise((resolve) => setTimeout(resolve, 80));
  process.off("unhandledRejection", capture);

  assert.equal(fatal, null, "the loser's rejection must already have been observed");
});
