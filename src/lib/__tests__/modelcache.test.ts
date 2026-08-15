import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtractionModel, ExtractionRequest, ExtractionResult } from "../extraction/contracts";
import {
  cachingModel,
  requestKey,
  ModelCacheMiss,
  estimateUsd,
  formatCacheStats,
  slotDelayMs,
  permanentQuotaFailure,
  promptFingerprint,
  cacheCensus,
  preRunProjection,
  chargedSpend,
  cumulativeSpend
} from "../__bench__/modelcache";

/**
 * A temp directory, so running the suite never writes into the real cache and
 * never leaves anything in the working tree. `modelCacheDir()` reads the
 * environment per call, so setting it here is enough.
 */
const TEMP_DIR = mkdtempSync(join(tmpdir(), "forge-modelcache-"));
process.env.FORGE_MODEL_CACHE_DIR = TEMP_DIR;

process.on("exit", () => rmSync(TEMP_DIR, { recursive: true, force: true }));

function request(overrides: Partial<ExtractionRequest> = {}): ExtractionRequest {
  return {
    pages: [{ page: 3, text: "PACKAGE DIMENSIONS: body 4.90 mm" }],
    images: [],
    fileName: "LM358.pdf",
    partNumber: "LM358",
    packageType: "SOIC-8",
    fields: ["dimensions.leadSpanMm"],
    ...overrides
  };
}

/** Counts calls so a hit can be distinguished from a fast second call. */
function countingModel(result: ExtractionResult): ExtractionModel & { calls: number } {
  return {
    name: "gemini",
    calls: 0,
    isConfigured: () => true,
    async extract() {
      (this as { calls: number }).calls += 1;
      return result;
    }
  };
}

const ANSWER: ExtractionResult = {
  values: { "dimensions.leadSpanMm": { value: { minMm: 5.8, maxMm: 6.2 }, page: 3 } },
  usage: { inputTokens: 11_044, outputTokens: 3_035 }
};

test("an identical request is answered from disk, not from the model", async () => {
  const inner = countingModel(ANSWER);
  const model = cachingModel(inner, "use", () => "LM358");

  const first = await model.extract(request());
  const second = await model.extract(request());

  assert.equal(inner.calls, 1, "the second identical request must not reach the model");
  assert.deepEqual(second, first);
  assert.equal(model.stats.hits, 1);
  assert.equal(model.stats.misses, 1);
  assert.equal(model.wasHit(), true);
});

test("tokens saved are counted from the entry, so a replay reports what it did not spend", async () => {
  const model = cachingModel(countingModel(ANSWER), "use", () => "LM358-tokens");

  await model.extract(request({ fileName: "tokens.pdf" }));
  await model.extract(request({ fileName: "tokens.pdf" }));

  assert.equal(model.stats.inputTokens, 11_044, "the live call's real cost");
  assert.equal(model.stats.savedInputTokens, 11_044, "the replay's avoided cost");
  assert.equal(model.stats.savedOutputTokens, 3_035);
});

test("a changed prompt input is a different question and is re-asked", async () => {
  const inner = countingModel(ANSWER);
  const model = cachingModel(inner, "use", () => "prompt-change");

  await model.extract(request({ fileName: "a.pdf", packageType: "SOIC-8" }));
  // The package hint is part of the prompt. Answering this from the SOIC entry
  // would report the model against a question it was never asked, which is the
  // one failure mode a response cache can actually cause.
  await model.extract(request({ fileName: "a.pdf", packageType: "TSSOP-8" }));

  assert.equal(inner.calls, 2);
  assert.equal(model.stats.hits, 0);
});

test("a changed page render is a different question and is re-asked", async () => {
  const inner = countingModel(ANSWER);
  const model = cachingModel(inner, "use", () => "image-change");
  const page = { page: 3, mimeType: "image/png" as const, widthPx: 1275, heightPx: 1650 };

  await model.extract(request({ fileName: "b.pdf", images: [{ ...page, base64: "AAAA" }] }));
  await model.extract(request({ fileName: "b.pdf", images: [{ ...page, base64: "BBBB" }] }));

  assert.equal(inner.calls, 2, "the model saw different pixels, so the answer cannot be reused");
});

test("a live call that throws is still counted, and marks the run incomplete", async () => {
  // Regression, 2026-08-09. The counter sat after the await, so eighteen calls
  // rejected on quota reported "live calls 0" beside eighteen errors, and the
  // run read as though the cache had served everything. A stats line that goes
  // quiet exactly when something is going wrong is worse than none.
  const failing: ExtractionModel = {
    name: "gemini",
    isConfigured: () => true,
    extract: async () => {
      throw new Error("[429] You exceeded your current quota");
    }
  };
  const model = cachingModel(failing, "use", () => "quota-part");

  await assert.rejects(() => model.extract(request({ fileName: "quota.pdf" })));

  assert.equal(model.stats.misses, 1, "the attempt happened and must be visible");
  assert.equal(model.stats.failed, 1);
  assert.match(formatCacheStats(model.stats), /1 FAILED/);
  assert.match(formatCacheStats(model.stats), /INCOMPLETE/, "the report must say the numbers are a floor");
});

test("a failed call writes no cache entry, so a retry still asks", async () => {
  let attempts = 0;
  const flaky: ExtractionModel = {
    name: "gemini",
    isConfigured: () => true,
    extract: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("[503] overloaded");
      return ANSWER;
    }
  };
  const model = cachingModel(flaky, "use", () => "flaky-part");

  await assert.rejects(() => model.extract(request({ fileName: "flaky.pdf" })));
  await model.extract(request({ fileName: "flaky.pdf" }));

  assert.equal(attempts, 2, "a failure must not be mistaken for an answer");
  assert.equal(model.stats.hits, 0);
});

test("offline mode never calls the model and reports the miss as a miss", async () => {
  const inner = countingModel(ANSWER);
  const model = cachingModel(inner, "offline", () => "offline-part");

  await assert.rejects(() => model.extract(request({ fileName: "never-asked.pdf" })), ModelCacheMiss);
  assert.equal(inner.calls, 0, "offline must guarantee zero spend");
  assert.equal(model.stats.skipped, 1);
  assert.equal(model.stats.misses, 0, "a skipped call is not a live call");
});

test("offline mode still replays what is on disk", async () => {
  const warm = cachingModel(countingModel(ANSWER), "use", () => "warm-part");
  await warm.extract(request({ fileName: "warm.pdf" }));

  const inner = countingModel(ANSWER);
  const offline = cachingModel(inner, "offline", () => "warm-part");
  const replayed = await offline.extract(request({ fileName: "warm.pdf" }));

  assert.deepEqual(replayed.values, ANSWER.values);
  assert.equal(inner.calls, 0);
});

test("refresh ignores an existing entry and overwrites it", async () => {
  const first = countingModel(ANSWER);
  await cachingModel(first, "use", () => "refresh-part").extract(request({ fileName: "refresh.pdf" }));

  const updated: ExtractionResult = { values: { "dimensions.leadSpanMm": { value: 9.9, page: 4 } } };
  const second = countingModel(updated);
  const model = cachingModel(second, "refresh", () => "refresh-part");
  await model.extract(request({ fileName: "refresh.pdf" }));

  assert.equal(second.calls, 1, "refresh must re-ask");

  // And the overwrite must stick, or the next run would replay the stale answer.
  const after = cachingModel(countingModel(ANSWER), "offline", () => "refresh-part");
  const replayed = await after.extract(request({ fileName: "refresh.pdf" }));
  assert.deepEqual(replayed.values["dimensions.leadSpanMm"]?.value, 9.9);
});

test("the key does not depend on the label, so renaming a part does not orphan its answer", () => {
  const a = requestKey("gemini", request({ fileName: "same.pdf" }));
  const b = requestKey("gemini", request({ fileName: "same.pdf" }));
  assert.equal(a, b);
  assert.notEqual(requestKey("gemini", request()), requestKey("local", request()));
});

test("entries land in the configured directory, never in the working tree", async () => {
  const model = cachingModel(countingModel(ANSWER), "use", () => "placement");
  await model.extract(request({ fileName: "placement.pdf" }));
  assert.ok(readdirSync(TEMP_DIR).some((f) => f.startsWith("placement-") && f.endsWith(".json")));
});

test("cost estimate uses input and output rates separately", () => {
  // Output is the expensive side and it is where reasoning tokens land, which
  // is exactly what the original estimate missed.
  assert.ok(estimateUsd(0, 1_000_000) > estimateUsd(1_000_000, 0));
  assert.equal(estimateUsd(0, 0), 0);
});

// --- the two kinds of 429 -----------------------------------------------------
//
// Google returns 429 both for "you are going too fast" and for "your account is
// out of money", and only the message distinguishes them. Retrying the second
// costs three waits per part for something the first response already settled:
// over an hour, on a 38-part run, to learn nothing.

// VERBATIM from a real response. It mentions "billing", which is why matching on
// vocabulary cannot tell the two apart: an earlier guard keyed on that word and
// classified every rate limit as permanent, so the retry never fired at all.
// The server states a retry delay only for the recoverable one.
const TRANSIENT = new Error(
  "[GoogleGenerativeAI Error]: [429 Too Many Requests] You exceeded your current quota, " +
    "please check your plan and billing details. " +
    "* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, " +
    "limit: 20, model: gemini-3.6-flash. Please retry in 0.01s"
);
const DEPLETED = new Error(
  "[GoogleGenerativeAI Error]: [429 Too Many Requests] Your prepayment credits are depleted. " +
    "Please go to AI Studio to manage your project and billing."
);

// The one that cost two wrong fixes. A DAILY cap still reports a retry delay, so
// the delay is not the discriminator; the quota ID is.
const DAILY_CAP = new Error(
  "[GoogleGenerativeAI Error]: [429 Too Many Requests] You exceeded your current quota, " +
    "please check your plan and billing details. Please retry in 23s. " +
    '[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{' +
    '"quotaMetric":"generativelanguage.googleapis.com/generate_content_free_tier_requests",' +
    '"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier","quotaValue":"20"}]}]'
);

function throwingOnce(error: Error): { model: ExtractionModel; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    model: {
      name: "test",
      isConfigured: () => true,
      extract: async (): Promise<ExtractionResult> => {
        calls += 1;
        if (calls === 1) throw error;
        return { values: {} };
      }
    }
  };
}

test("a transient rate limit is waited out rather than recorded as a failure to read", async () => {
  const inner = throwingOnce(TRANSIENT);
  const model = cachingModel(inner.model, "use", () => "transient");

  await model.extract(request({ fileName: "transient.pdf" }));

  assert.equal(inner.calls(), 2, "the call is retried");
  assert.equal(model.stats.rateLimitWaits, 1, "and the wait is reported, so a slow run is explained");
});

test("depleted account credits fail immediately, because waiting cannot fix them", async () => {
  const inner = throwingOnce(DEPLETED);
  const model = cachingModel(inner.model, "use", () => "depleted");

  await assert.rejects(() => model.extract(request({ fileName: "depleted.pdf" })));

  assert.equal(inner.calls(), 1, "no retry");
  assert.equal(model.stats.rateLimitWaits, 0, "and no wait");
});

test("under the ceiling nothing waits, so the limiter is invisible", async () => {
  const model = cachingModel(
    { name: "test", isConfigured: () => true, extract: async () => ({ values: {} }) },
    "use",
    () => "paced"
  );

  const started = Date.now();
  for (let index = 0; index < 5; index += 1) {
    await model.extract(request({ fileName: `paced-${index}.pdf` }));
  }

  assert.ok(Date.now() - started < 1000, "no delay while there is headroom");
  assert.equal(model.stats.pacedWaits, 0);
  assert.equal(model.stats.rateLimitWaits, 0, "the limit is never reached, so it is never hit");
});

test("at the ceiling the next request waits for the oldest to age out", () => {
  // The arithmetic, checked without a test that sleeps for a minute.
  //
  // The failure this replaces: reacting to 429s cannot hold a rate limit,
  // because a RETRY IS ITSELF A REQUEST. At the cap, four attempts per part over
  // eighteen parts added seventy-two more requests, each refreshing the window
  // it was waiting for. Two runs were lost and every number they printed was a
  // floor.
  const now = 1_000_000;

  assert.equal(slotDelayMs([now - 5_000, now - 1_000], now, 3), 0, "below the limit, no wait");

  // Three in the window with a limit of three: wait until the oldest is 60s old.
  const atCap = slotDelayMs([now - 50_000, now - 20_000, now - 1_000], now, 3);
  assert.ok(atCap > 9_000 && atCap < 11_000, `expected about 10s, got ${atCap}`);

  // Requests older than the window do not count against it.
  assert.equal(slotDelayMs([now - 61_000, now - 62_000, now - 1_000], now, 3), 0);
});


test("a DAILY cap is not retried, even though it states a retry delay", async () => {
  // Measured: waiting three minutes for `GenerateRequestsPerDayPerProjectPerModel`
  // fails exactly as it did at the start. Thirteen parts x three attempts x 60s
  // is 39 minutes spent learning what the first response already said.
  const inner = throwingOnce(DAILY_CAP);
  const model = cachingModel(inner.model, "use", () => "daily");

  await assert.rejects(() => model.extract(request({ fileName: "daily.pdf" })));

  assert.equal(inner.calls(), 1, "no retry");
  assert.equal(model.stats.rateLimitWaits, 0, "and no wait");
});


/**
 * A permanent 429 must name the RIGHT cause.
 *
 * Measured on 2026-08-12: a run stopped and reported "DAILY quota exhausted ...
 * re-running tomorrow continues where this stopped." The API had actually said
 * the project was over its MONTHLY SPEND CAP. Tomorrow would have changed
 * nothing, and the cap is a setting no amount of waiting or credit clears. The
 * classifier was right that the failure was permanent and the printed sentence
 * was wrong, which is the worse half: it sent the operator away for a day.
 */
const SPEND_CAP =
  "[429 Too Many Requests] Your project has exceeded its monthly spending cap. " +
  "Please go to AI Studio at https://ai.studio/spend to manage your project spend cap.";

test("a monthly spend cap is not reported as a daily quota", () => {
  const verdict = permanentQuotaFailure(SPEND_CAP);

  assert.ok(verdict, "still permanent: retrying cannot clear a spend cap");
  assert.match(verdict.kind, /spend cap/i);
  assert.doesNotMatch(verdict.kind, /daily/i, "the wrong cause costs a day");
  assert.doesNotMatch(verdict.advice, /tomorrow/i, "waiting cannot clear a monthly cap");
  assert.match(verdict.advice, /ai\.studio\/spend/, "name the page that actually fixes it");
});

test("each permanent kind is told apart from the others", () => {
  const daily = permanentQuotaFailure(
    "[429] GenerateRequestsPerDayPerProjectPerModel-FreeTier limit 20. Please retry in 23s"
  );
  assert.match(daily?.kind ?? "", /daily/i);
  assert.match(daily?.advice ?? "", /tomorrow/i, "this is the one case where waiting works");

  const credits = permanentQuotaFailure("[429] Your prepayment credits are depleted.");
  assert.match(credits?.kind ?? "", /credits/i);

  // An ordinary per-minute limit is recoverable and must stay that way.
  assert.equal(
    permanentQuotaFailure("[429] ...PerMinute... quota exceeded. Please retry in 56.7s"),
    null
  );
});


/**
 * A run that spends more than it was allowed to stops itself.
 *
 * Measured, not hypothetical: $4.04 went on 245 calls in one day where a full
 * run is 76 calls. Most of the excess was re-asks caused by changing the prompt
 * between runs, which invalidates every cached answer by design. Nothing in the
 * tool noticed, and the person paying found it before the report did.
 */
test("spending stops once the cache has cost more IN TOTAL than allowed", async () => {
  // Cumulative, not per-run. A per-run cap was the first version and would have
  // caught nothing: the $4.04 that prompted this was 19 runs whose largest was
  // $1.02. The sum is what hurt, so the sum is what is capped.
  // Its own cache directory: the limit is now CUMULATIVE, so a directory shared
  // with the other tests here would already be over budget before this starts.
  const own = mkdtempSync(join(tmpdir(), "forge-spend-"));
  process.env.FORGE_MODEL_CACHE_DIR = own;
  process.env.FORGE_SPEND_LIMIT_USD = "0.02";
  const model = cachingModel(countingModel(ANSWER), "use", () => "spendy");

  // One answer costs about $0.014, so the second call crosses $0.02.
  // Varying the PACKAGE, because that is in the prompt and so in the cache key.
  // Varying only the file name would make the second call a hit and spend nothing.
  await model.extract(request({ packageType: "SOIC-8" }));
  await assert.rejects(
    () => model.extract(request({ packageType: "TSSOP-8" })),
    (error: Error) => error.name === "SpendLimitReached"
  );

  // The call that tripped the limit is still CACHED, so a re-run continues from
  // it rather than paying for it twice.
  const replay = cachingModel(countingModel(ANSWER), "offline", () => "spendy");
  await replay.extract(request({ packageType: "TSSOP-8" }));
  assert.equal(replay.stats.hits, 1, "nothing already paid for is thrown away");

  delete process.env.FORGE_SPEND_LIMIT_USD;
  process.env.FORGE_MODEL_CACHE_DIR = TEMP_DIR;
  rmSync(own, { recursive: true, force: true });
});

test("a free local model is never counted against the spend limit", async () => {
  const ownFree = mkdtempSync(join(tmpdir(), "forge-free-"));
  process.env.FORGE_MODEL_CACHE_DIR = ownFree;
  process.env.FORGE_SPEND_LIMIT_USD = "0.001";
  const local: ExtractionModel = {
    name: "local:qwen2.5vl:7b",
    isConfigured: () => true,
    extract: async () => ANSWER
  };
  const model = cachingModel(local, "use", () => "free");

  // Ollama costs nothing, so no number of calls may trip a spend ceiling.
  for (let i = 0; i < 5; i += 1) await model.extract(request({ packageType: `QFN-${i}` }));

  assert.equal(model.stats.misses, 5);
  delete process.env.FORGE_SPEND_LIMIT_USD;
  process.env.FORGE_MODEL_CACHE_DIR = TEMP_DIR;
  rmSync(ownFree, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The pre-run projection.
//
// The spend ceiling is a backstop and saves nothing: it stops a run after the
// money is gone, and half a hold-out run scores nothing. These cover the part
// that can actually save money, which is knowing BEFORE the first call that the
// prompt changed and the whole cache is unreachable.
// ---------------------------------------------------------------------------

test("the prompt fingerprint is stable across calls and independent of the document", () => {
  // Must not move on its own, or every run would report the cache as stranded.
  assert.equal(promptFingerprint(), promptFingerprint());
});

test("the census sorts entries by whether this run's prompt can reach them", async () => {
  const own = mkdtempSync(join(tmpdir(), "forge-census-"));
  process.env.FORGE_MODEL_CACHE_DIR = own;

  const model = cachingModel(countingModel(ANSWER), "use", () => "censused");
  await model.extract(request({ packageType: "SOIC-8" }));

  // Written by this build, so reachable by it.
  assert.deepEqual(cacheCensus(), { reachable: 1, stranded: 0, unknown: 0 });

  // An answer stored under a DIFFERENT question. This is the state that costs
  // money: paid for, on disk, and impossible for this run to hit.
  const [file] = readdirSync(own).filter((name) => name.endsWith(".json") && name !== "_billed.json");
  const entry = JSON.parse(readFileSync(join(own, file), "utf8")) as Record<string, unknown>;
  writeFileSync(join(own, "older-0000000000000000.json"), JSON.stringify({ ...entry, prompt: "an older prompt" }));
  // And one from before fingerprints were recorded at all, which is neither.
  delete entry.prompt;
  writeFileSync(join(own, "ancient-1111111111111111.json"), JSON.stringify(entry));

  assert.deepEqual(cacheCensus(), { reachable: 1, stranded: 1, unknown: 1 });

  process.env.FORGE_MODEL_CACHE_DIR = TEMP_DIR;
  rmSync(own, { recursive: true, force: true });
});

test("a cache hit stamps an unfingerprinted entry, so a free offline pass backfills", async () => {
  const own = mkdtempSync(join(tmpdir(), "forge-backfill-"));
  process.env.FORGE_MODEL_CACHE_DIR = own;

  const model = cachingModel(countingModel(ANSWER), "use", () => "backfilled");
  await model.extract(request({ packageType: "SOIC-8" }));

  // Age the entry: strip the fingerprint the way every entry written before
  // 2026-08-13 lacks one.
  const [file] = readdirSync(own).filter((name) => name.endsWith(".json") && name !== "_billed.json");
  const entry = JSON.parse(readFileSync(join(own, file), "utf8")) as Record<string, unknown>;
  delete entry.prompt;
  writeFileSync(join(own, file), JSON.stringify(entry));
  assert.equal(cacheCensus().unknown, 1);

  // Replaying it OFFLINE spends nothing, and a hit proves the entry was stored
  // under this exact prompt, because the prompt is part of the key.
  const replay = cachingModel(countingModel(ANSWER), "offline", () => "backfilled");
  await replay.extract(request({ packageType: "SOIC-8" }));
  assert.equal(replay.stats.hits, 1);
  assert.deepEqual(cacheCensus(), { reachable: 1, stranded: 0, unknown: 0 });

  process.env.FORGE_MODEL_CACHE_DIR = TEMP_DIR;
  rmSync(own, { recursive: true, force: true });
});

test("the projection names a changed prompt as the reason a run will re-ask everything", async () => {
  const own = mkdtempSync(join(tmpdir(), "forge-projection-"));
  process.env.FORGE_MODEL_CACHE_DIR = own;

  const model = cachingModel(countingModel(ANSWER), "use", () => "projected");
  await model.extract(request({ packageType: "SOIC-8" }));

  // Strand it, which is what editing the prompt does to every entry at once.
  const [file] = readdirSync(own).filter((name) => name.endsWith(".json") && name !== "_billed.json");
  const entry = JSON.parse(readFileSync(join(own, file), "utf8")) as Record<string, unknown>;
  writeFileSync(join(own, file), JSON.stringify({ ...entry, prompt: "the prompt before the edit" }));

  const report = preRunProjection({ parts: 38, callsPerPart: 2, modelName: "gemini" });
  assert.match(report, /WHY IT IS COLD/);
  assert.match(report, /prompt changed/);
  assert.match(report, /at most 76 live calls/);
  // Priced off real usage, so the figure is one to act on rather than a guess.
  assert.match(report, /projected ~\$\d+\.\d\d/);

  process.env.FORGE_MODEL_CACHE_DIR = TEMP_DIR;
  rmSync(own, { recursive: true, force: true });
});

test("a local run is projected at nothing, whatever is on disk", async () => {
  const own = mkdtempSync(join(tmpdir(), "forge-projection-local-"));
  process.env.FORGE_MODEL_CACHE_DIR = own;

  const report = preRunProjection({ parts: 38, callsPerPart: 7, modelName: "local-focused:qwen2.5vl:7b" });
  assert.match(report, /\$0\.00, this model is local/);
  // No ceiling talk and no projection: there is nothing to decide about.
  assert.doesNotMatch(report, /projected/);

  process.env.FORGE_MODEL_CACHE_DIR = TEMP_DIR;
  rmSync(own, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Billed attempts.
//
// The defect this closes, 2026-08-14: a hold-out run was reported at $1.88 and
// the account was charged $3.16. The cache directory is a record of SUCCESSES,
// and Google charges for ATTEMPTS. Google returned a lot of 503s that day, every
// retry was billed, and only the winning attempt was ever written to disk. The
// spend ceiling read the same directory, so it did not fire either.
// ---------------------------------------------------------------------------

test("a call that fails is still counted as charged", async () => {
  const own = mkdtempSync(join(tmpdir(), "forge-billed-"));
  process.env.FORGE_MODEL_CACHE_DIR = own;

  // Prime the average with one good call, so a failure can be priced at all.
  await cachingModel(countingModel(ANSWER), "use", () => "ok").extract(request({ packageType: "SOIC-8" }));
  const afterSuccess = chargedSpend();

  const failing: ExtractionModel = {
    name: "gemini",
    isConfigured: () => true,
    extract: async () => {
      throw new Error("503 Service Unavailable");
    }
  };
  await assert.rejects(() =>
    cachingModel(failing, "use", () => "boom").extract(request({ packageType: "TSSOP-8" }))
  );

  const afterFailure = chargedSpend();
  assert.ok(afterFailure.usd > afterSuccess.usd, "a failed call costs money and must be recorded");
  assert.equal(afterFailure.calls, afterSuccess.calls + 1);

  // And the cache directory still shows only the success, which is exactly why
  // it cannot be the number anyone is quoted.
  assert.equal(cumulativeSpend().calls, 1, "the cache still only knows about successes");

  process.env.FORGE_MODEL_CACHE_DIR = TEMP_DIR;
  rmSync(own, { recursive: true, force: true });
});

test("retries inside one call are all charged, not just the winner", async () => {
  const own = mkdtempSync(join(tmpdir(), "forge-retries-"));
  process.env.FORGE_MODEL_CACHE_DIR = own;

  // A model that succeeded on its third attempt reports so. Three charges, one
  // cache entry: the exact shape of the $1.88-versus-$3.16 gap.
  const retried: ExtractionModel = {
    name: "gemini",
    isConfigured: () => true,
    extract: async () => ({ ...ANSWER, attempts: 3 })
  };
  await cachingModel(retried, "use", () => "retried").extract(request({ packageType: "SOIC-8" }));

  const charged = chargedSpend();
  assert.equal(charged.calls, 3, "three attempts reached the provider");
  assert.equal(cumulativeSpend().calls, 1, "and one answer reached the disk");
  assert.ok(charged.usd > cumulativeSpend().usd, "so the charge exceeds what the cache shows");

  process.env.FORGE_MODEL_CACHE_DIR = TEMP_DIR;
  rmSync(own, { recursive: true, force: true });
});

test("the ceiling stops on what was CHARGED, not on what was stored", async () => {
  const own = mkdtempSync(join(tmpdir(), "forge-ceiling-"));
  process.env.FORGE_MODEL_CACHE_DIR = own;
  process.env.FORGE_SPEND_LIMIT_USD = "0.03";

  // One answer is about $0.014. Reported as retried three times it is ~$0.042,
  // over the limit, though the cache would show a single $0.014 entry.
  const retried: ExtractionModel = {
    name: "gemini",
    isConfigured: () => true,
    extract: async () => ({ ...ANSWER, attempts: 3 })
  };
  await assert.rejects(
    () => cachingModel(retried, "use", () => "spendy").extract(request({ packageType: "SOIC-8" })),
    (error: Error) => error.name === "SpendLimitReached"
  );

  delete process.env.FORGE_SPEND_LIMIT_USD;
  process.env.FORGE_MODEL_CACHE_DIR = TEMP_DIR;
  rmSync(own, { recursive: true, force: true });
});
