import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertUnderLimit, bills, estimateUsd, readSpend, recordSpend, SpendLimitReached, spendLimitUsd } from "../spend";

/**
 * The product path had no spend ceiling and no ledger until 2026-08-30: both
 * lived only in the bench cache, so every parse a real user made called a billed
 * model with no cap and recorded nothing.
 *
 * The two things checked hardest here are the two that have already gone wrong
 * in the bench's own version of this file. A new provider slipping past the
 * "does it bill" test ran with NO CEILING AT ALL for a whole day, and spend was
 * once under-reported threefold by counting only the attempt that succeeded.
 */

function withLedger<T>(run: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "forge-spend-"));
  const path = join(dir, "spend.json");
  const keep = { ledger: process.env.FORGE_SPEND_LEDGER, limit: process.env.FORGE_SPEND_LIMIT_USD };
  process.env.FORGE_SPEND_LEDGER = path;
  try {
    return run(path);
  } finally {
    if (keep.ledger === undefined) delete process.env.FORGE_SPEND_LEDGER;
    else process.env.FORGE_SPEND_LEDGER = keep.ledger;
    if (keep.limit === undefined) delete process.env.FORGE_SPEND_LIMIT_USD;
    else process.env.FORGE_SPEND_LIMIT_USD = keep.limit;
  }
}

test("a local model is free, so it is neither counted nor capped", () => {
  // Not negotiable. An air-gapped customer runs their own weights on their own
  // hardware; charging them against a cloud price list reports a bill nobody
  // sent, and stopping them at a ceiling takes the product away from the
  // customer it was built for.
  assert.equal(bills("local:qwen3-vl"), false);
  assert.equal(bills("local-focused:qwen2.5vl:7b"), false);
  withLedger(() => {
    process.env.FORGE_SPEND_LIMIT_USD = "0.0001";
    recordSpend("local:qwen3-vl", { inputTokens: 10_000_000, outputTokens: 10_000_000 });
    assert.equal(readSpend().usd, 0);
    assert.doesNotThrow(() => assertUnderLimit("local:qwen3-vl"));
  });
});

test("anything that is not local is assumed to bill", () => {
  // FREE IS THE EXCEPTION. The bench's version asked `startsWith("gemini")`,
  // which is a list of the providers that bill, and the Vertex path arrived not
  // matching it: reported $0.00, wrote nothing, and ran with no ceiling.
  assert.equal(bills("gemini:gemini-3.6-flash"), true);
  assert.equal(bills("vertex:gemini-3.6-flash"), true);
  assert.equal(bills("some-provider-nobody-has-written-yet"), true);
});

test("the ledger accumulates across calls and survives being read back", () => {
  withLedger((path) => {
    const before = readSpend();
    recordSpend("vertex:gemini-3.6-flash", { inputTokens: 1_000_000, outputTokens: 0 });
    recordSpend("vertex:gemini-3.6-flash", { inputTokens: 1_000_000, outputTokens: 0 });
    assert.ok(existsSync(path));
    const ledger = readSpend();
    assert.ok(Math.abs(ledger.usd - before.usd - 0.6) < 1e-9, `expected $0.60 more, got ${ledger.usd - before.usd}`);
    assert.equal(ledger.calls - before.calls, 2);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).calls, ledger.calls);
  });
});

/**
 * The totals below are asserted as DELTAS because the module keeps an in-process
 * copy that survives the ledger file going missing, and each of these tests
 * points at a fresh empty directory.
 *
 * That is the behaviour, not an accident of the test: deleting the ledger must
 * not reset the ceiling. A cap a `rm` can clear is not a cap.
 */
test("every retry is counted, because every attempt is billed", () => {
  withLedger(() => {
    const before = readSpend().calls;
    recordSpend("vertex:gemini-3.6-flash", { inputTokens: 0, outputTokens: 0 }, 3);
    assert.equal(readSpend().calls - before, 3);
  });
});

test("a call that reports no tokens still moves the count", () => {
  // A provider that stops reporting usage must not be able to zero the total.
  withLedger(() => {
    const before = readSpend().calls;
    recordSpend("vertex:gemini-3.6-flash", undefined);
    assert.equal(readSpend().calls - before, 1);
  });
});

test("deleting the ledger file does not clear the ceiling", () => {
  withLedger(() => {
    process.env.FORGE_SPEND_LIMIT_USD = "1";
    recordSpend("vertex:gemini-3.6-flash", { inputTokens: 8_000_000, outputTokens: 0 });
    assert.throws(() => assertUnderLimit("vertex:gemini-3.6-flash"), SpendLimitReached);
  });
  // A second, empty ledger directory: the file is gone and the total is not.
  withLedger(() => {
    process.env.FORGE_SPEND_LIMIT_USD = "1";
    assert.throws(() => assertUnderLimit("vertex:gemini-3.6-flash"), SpendLimitReached);
  });
});

test("the ceiling is cumulative, and refuses BEFORE the call", () => {
  // Per-run was the wrong scope and would have prevented nothing: $4.04 across
  // nineteen runs whose largest was $1.02.
  withLedger(() => {
    process.env.FORGE_SPEND_LIMIT_USD = "1";
    recordSpend("vertex:gemini-3.6-flash", { inputTokens: 4_000_000, outputTokens: 0 });
    assert.throws(() => assertUnderLimit("vertex:gemini-3.6-flash"), SpendLimitReached);
  });
});

test("a limit of zero disables the ceiling", () => {
  withLedger(() => {
    process.env.FORGE_SPEND_LIMIT_USD = "0";
    recordSpend("vertex:gemini-3.6-flash", { inputTokens: 100_000_000, outputTokens: 0 });
    assert.doesNotThrow(() => assertUnderLimit("vertex:gemini-3.6-flash"));
  });
});

test("an unset or nonsense limit falls back to a real number, not to no limit", () => {
  // The unknown case has to land on the safe side. Switching provider once
  // silently disabled the ceiling entirely.
  const keep = process.env.FORGE_SPEND_LIMIT_USD;
  try {
    delete process.env.FORGE_SPEND_LIMIT_USD;
    assert.ok(spendLimitUsd() > 0);
    process.env.FORGE_SPEND_LIMIT_USD = "not-a-number";
    assert.ok(spendLimitUsd() > 0);
    process.env.FORGE_SPEND_LIMIT_USD = "-5";
    assert.ok(spendLimitUsd() > 0);
  } finally {
    if (keep === undefined) delete process.env.FORGE_SPEND_LIMIT_USD;
    else process.env.FORGE_SPEND_LIMIT_USD = keep;
  }
});

test("an unwritable ledger does not throw, because bookkeeping must not cost a library", () => {
  const keep = process.env.FORGE_SPEND_LEDGER;
  process.env.FORGE_SPEND_LEDGER = "/proc/definitely/not/writable/spend.json";
  try {
    assert.doesNotThrow(() => recordSpend("vertex:gemini-3.6-flash", { inputTokens: 1000, outputTokens: 10 }));
  } finally {
    if (keep === undefined) delete process.env.FORGE_SPEND_LEDGER;
    else process.env.FORGE_SPEND_LEDGER = keep;
  }
});

test("the estimate is the published Flash rate", () => {
  assert.equal(estimateUsd(undefined), 0);
  assert.ok(Math.abs(estimateUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }) - 2.8) < 1e-9);
});
