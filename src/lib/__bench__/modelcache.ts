// A disk cache for extraction model responses, for the benchmarks only.
//
// Why this exists: on 2026-08-05 a bench run died halfway through because the
// account's prepaid credits ran out, and the run had to be abandoned. Nothing
// about that run was novel. It asked the same model the same questions about
// the same 44 datasheets it had already been asked days earlier, because a
// change to `merge.ts` or `packages.ts` meant re-running the whole thing.
//
// Almost every change made to this repo is DOWNSTREAM of the model call:
// merging, citation checks, the package table, the land pattern math. None of
// them change what we would ask the model, so none of them need a new answer.
// Paying again for a byte-identical question is the entire cost problem.
//
// The key is a hash of the request we would actually send: the prompt text and
// the rendered images. So the cache invalidates itself exactly when the
// question changes, which is what correctness requires, and never when only the
// handling of the answer changes, which is what the budget requires.
//
// Bench-only on purpose. A production cache would have to answer when a stale
// answer becomes wrong, and that question does not have a good answer for a
// record someone signs off on. Here there is no such worry: the input is a
// fixed corpus of frozen PDFs.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtractionModel, ExtractionRequest, ExtractionResult } from "../extraction/contracts";
import { buildPrompt } from "../extraction/models/prompt";

/**
 * Where entries live. Read per call rather than once at import, so a test can
 * point it at a temp directory without having to control import order.
 */
export function modelCacheDir(): string {
  return process.env.FORGE_MODEL_CACHE_DIR || join(process.cwd(), ".model-cache");
}

/**
 * Bumped by hand to discard every entry.
 *
 * Not normally needed: a prompt change already changes every key. This is for
 * the case where the answer's MEANING changed without the prompt changing, e.g.
 * a different model id behind the same name.
 */
const CACHE_VERSION = 1;

export type CacheMode =
  /** Read the cache, call live on a miss, write what comes back. The default. */
  | "use"
  /** Never call live. A miss is reported as a miss. Guarantees zero spend. */
  | "offline"
  /** Ignore existing entries: call live for everything and overwrite. */
  | "refresh"
  /** Call nothing at all. Report what a run WOULD cost, then stop. */
  | "estimate";

export interface CacheStats {
  hits: number;
  /** Live calls ATTEMPTED, whether or not they came back. */
  misses: number;
  /** Attempts that threw. Non-zero means the run is partial, whatever else reads well. */
  failed: number;
  /** Misses that were not called because the mode forbade it. */
  skipped: number;
  /** Times a call was rate limited and waited. Non-zero means the pacing was too loose. */
  rateLimitWaits: number;
  /** Times the limiter held a call back BEFORE sending it. Expected, and free. */
  pacedWaits: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens that were NOT spent because an entry was already on disk. */
  savedInputTokens: number;
  savedOutputTokens: number;
}

interface CacheEntry {
  version: number;
  model: string;
  /** Recorded so an entry can be traced back to a part by hand. */
  label: string;
  storedAt: string;
  usage?: { inputTokens: number; outputTokens: number };
  result: ExtractionResult;
}

/** Thrown when an offline run has no cached answer. Distinguishable in reports. */
export class ModelCacheMiss extends Error {
  constructor(label: string) {
    super(`no cached model response for ${label}`);
    this.name = "ModelCacheMiss";
  }
}

/**
 * The exact bytes we would send, hashed.
 *
 * The prompt is rebuilt here rather than taken from the model so the key tracks
 * `buildPrompt` itself. If the prompt wording, the field list, the package hint
 * or the page text changes, the key changes and the answer is re-fetched. That
 * coupling is the point: a cache that survives a prompt change would silently
 * report yesterday's model against today's question.
 */
export function requestKey(modelName: string, request: ExtractionRequest): string {
  const hash = createHash("sha256");
  hash.update(`v${CACHE_VERSION}\n`);
  hash.update(`${modelName}\n`);
  hash.update(buildPrompt(request));
  for (const image of request.images) {
    hash.update(`\n${image.page}:${image.mimeType}:${image.base64.length}\n`);
    hash.update(image.base64);
  }
  return hash.digest("hex");
}

function entryPath(label: string, key: string): string {
  const safe = label.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40);
  return join(modelCacheDir(), `${safe}-${key.slice(0, 16)}.json`);
}

function readEntry(path: string): CacheEntry | null {
  if (!existsSync(path)) return null;
  try {
    const entry = JSON.parse(readFileSync(path, "utf8")) as CacheEntry;
    // A truncated or hand-edited file is a miss, not a crash.
    if (entry.version !== CACHE_VERSION || !entry.result) return null;
    return entry;
  } catch {
    return null;
  }
}

export interface CachingModel extends ExtractionModel {
  readonly stats: CacheStats;
  /**
   * Whether the LAST call was served from disk. The bench uses this to skip the
   * inter-call rate-limit delay, which is what makes a fully cached run finish
   * in seconds instead of minutes.
   */
  wasHit(): boolean;
}

/**
 * Wraps a model so identical requests are answered from disk.
 *
 * `label` is cosmetic, used only to make the cache directory readable; the key
 * alone decides what matches.
 */
/**
 * Waits out a rate limit instead of recording it as a failure to read.
 *
 * Measured 2026-08-10, and it invalidated a whole run before it was found. The
 * free tier allows 20 requests per minute; a bench pass needing more got
 * `429 Too Many Requests` on eleven parts, each surfaced as
 * `ERROR:ExtractionModelError`, which the bench counts exactly like a model that
 * looked at the page and found nothing. The run printed 69% READ against 85% the
 * hour before, and it read as a regression in the parser. It was a quota.
 *
 * This is a measurement-integrity fix rather than a performance one: a bench
 * whose headline number moves with someone else's API quota cannot be used to
 * decide anything. `--offline` is unaffected and still never touches the network.
 */
const RATE_LIMIT_ATTEMPTS = 4;
const RATE_LIMIT_FALLBACK_MS = 45_000;
const RATE_LIMIT_MAX_WAIT_MS = 180_000;

/**
 * Stay UNDER the limit instead of discovering it.
 *
 * The free tier allows 20 requests per rolling minute. Reacting to 429s cannot
 * hold that line, because a retry is itself a request: once at the cap, four
 * attempts per part over eighteen parts added seventy-two more requests, each
 * one refreshing the window it was waiting for. Two full runs were lost that way
 * and every number they printed was a floor.
 *
 * So requests are paced BEFORE they are sent, against a rolling window that
 * counts every attempt including retries. Under the ceiling nothing waits and
 * the limiter is invisible; at it, the next call sleeps exactly until the oldest
 * request ages out.
 *
 * The default leaves deliberate headroom: the quota is shared with anything else
 * on the key, including a browser tab someone left open on the app.
 */
/** Read per call, not at import, so a test can set it without controlling import order. */
function requestsPerWindow(): number {
  return Math.max(1, Number(process.env.FORGE_MODEL_RPM ?? 12));
}
export const RATE_WINDOW_MS = 60_000;

/**
 * How long the next request must wait, given the ones already sent.
 *
 * Pure, and exported, so the at-the-ceiling case can be tested without a test
 * that actually sleeps for a minute. Mutates nothing: the caller records the
 * attempt only once it is really being sent.
 */
export function slotDelayMs(sentAt: readonly number[], now: number, limit: number): number {
  const live = sentAt.filter((at) => now - at < RATE_WINDOW_MS);
  if (live.length < limit) return 0;
  // +250ms so the oldest is genuinely outside the window on the recheck, rather
  // than landing exactly on the boundary and looping.
  return RATE_WINDOW_MS - (now - Math.min(...live)) + 250;
}

/** Timestamps of every attempt in the current window. Module-scoped: the limit is per KEY. */
const attempts: number[] = [];

async function waitForSlot(onWait: (ms: number) => void): Promise<void> {
  for (;;) {
    const now = Date.now();
    const wait = slotDelayMs(attempts, now, requestsPerWindow());
    if (wait === 0) {
      attempts.push(now);
      while (attempts.length > 0 && now - attempts[0] >= RATE_WINDOW_MS) attempts.shift();
      return;
    }
    onWait(wait);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/**
 * A 429 that WAITING will not fix.
 *
 * Google returns the same status code for "you are going too fast" and "your
 * account is out of money", and only the message distinguishes them:
 *
 *   transient  "Quota exceeded for metric: ...generate_content_free_tier_requests,
 *               limit: 20 ... Please retry in 56.7s"
 *   permanent  "Your prepayment credits are depleted. Please go to AI Studio ...
 *               to manage your project and billing."
 *
 * Found on 2026-08-11 by trying an older paid key whose credits had run out.
 * Treated as retryable it would have cost three waits of 45 s on EVERY part, so
 * a 38-part run spends over an hour discovering, slowly, something the first
 * response already said. Fail immediately and say which kind it was.
 */
/**
 * A 429 that waiting cannot fix, distinguished by the quota Google names.
 *
 * The `retryDelay` field is NOT the discriminator, which cost two wrong fixes to
 * learn. A daily cap still reports "retry in 23s", and waiting three minutes for
 * it fails exactly as it did at the start. The reliable signal is the quota ID
 * in the error body:
 *
 *   GenerateRequestsPerDayPerProjectPerModel-FreeTier   value 20   PER DAY
 *   ...PerMinute...                                                recoverable
 *
 * Nor is vocabulary: the ordinary free-tier 429 reads "please check your plan
 * and BILLING details", so a guard keyed on that word classified every rate
 * limit as permanent and disabled the retry altogether.
 *
 * There is a THIRD permanent kind, met on 2026-08-12 with credits on the key:
 *
 *   "Your project has exceeded its monthly spending cap."
 *
 * It is not a daily cap and not depleted credits. A run that reports it as
 * "daily" tells the operator to wait until tomorrow, which cannot work: the cap
 * is monthly and is a SETTING, so only raising it helps. Naming the wrong cause
 * costs a day, so this returns WHICH kind it was and the printed line quotes
 * Google's own sentence rather than asserting a cause of its own.
 */
type PermanentQuota = { readonly kind: string; readonly advice: string };

export function permanentQuotaFailure(message: string): PermanentQuota | null {
  if (/spend(ing)? cap/i.test(message)) {
    return {
      kind: "monthly SPEND CAP reached",
      advice:
        "This is a project setting, not a rate limit: waiting does not clear it, " +
        "and adding credits does not either. Raise the cap at https://ai.studio/spend."
    };
  }
  if (/credits? (are |is )?depleted|prepayment/i.test(message)) {
    return { kind: "prepaid credits depleted", advice: "Add credits to the project, then re-run." };
  }
  if (/PerDay/i.test(message)) {
    return {
      kind: "DAILY request quota exhausted",
      advice: "The quota resets on Google's clock, so re-running tomorrow continues from here."
    };
  }
  // No quota ID and no retry hint: assume unrecoverable rather than burn the
  // full retry budget on every remaining part. Say so honestly instead of
  // picking one of the named causes above.
  if (!/retry in [\d.]+\s*s/i.test(message) && /\b429\b|quota/i.test(message)) {
    return {
      kind: "unrecoverable 429 (no quota named)",
      advice: "Google named no quota and gave no retry hint. Read the message above."
    };
  }
  return null;
}

function isPermanentQuotaFailure(message: string): boolean {
  return permanentQuotaFailure(message) !== null;
}

function isRateLimited(error: unknown): boolean {
  const message = errorText(error);
  if (isPermanentQuotaFailure(message)) return false;
  return /\b429\b|too many requests|quota|rate.?limit/i.test(message);
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
}

/** Google states the wait in the error body: "Please retry in 56.730807439s". */
function retryAfterMs(error: unknown): number {
  const message = errorText(error);
  const stated = /retry in ([\d.]+)\s*s/i.exec(message);
  const ms = stated ? Math.ceil(Number(stated[1]) * 1000) + 2000 : RATE_LIMIT_FALLBACK_MS;
  return Math.min(ms, RATE_LIMIT_MAX_WAIT_MS);
}

async function extractWithRateLimitRetry(
  inner: ExtractionModel,
  request: ExtractionRequest,
  stats: CacheStats
): Promise<ExtractionResult> {
  let last: unknown;
  for (let attempt = 1; attempt <= RATE_LIMIT_ATTEMPTS; attempt += 1) {
    // Every attempt takes a slot, retries included. Counting only first attempts
    // is what let the retries dig the hole deeper.
    await waitForSlot((ms) => {
      stats.pacedWaits += 1;
      if (ms > 5_000) console.error(`  pacing: ${Math.round(ms / 1000)}s to stay under ${requestsPerWindow()}/min`);
    });
    try {
      return await inner.extract(request);
    } catch (error) {
      last = error;
      // A run that stops for a reason nobody can act on is worse than one that
      // stops loudly. Say which of the two 429s this was.
      const permanent = permanentQuotaFailure(errorText(error));
      if (permanent) {
        console.error(`  ${permanent.kind}: retrying cannot help.`);
        console.error(`  Google said: ${errorText(error).trim().slice(0, 300)}`);
        console.error(`  ${permanent.advice}`);
        console.error("  Answers already fetched are cached, so a re-run continues from here.");
        throw error;
      }
      if (!isRateLimited(error) || attempt === RATE_LIMIT_ATTEMPTS) throw error;
      const wait = retryAfterMs(error);
      stats.rateLimitWaits += 1;
      console.error(`  rate limited, waiting ${Math.round(wait / 1000)}s (attempt ${attempt})`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw last;
}

export function cachingModel(inner: ExtractionModel, mode: CacheMode, labelFor: () => string): CachingModel {
  const dir = modelCacheDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const stats: CacheStats = {
    hits: 0,
    misses: 0,
    failed: 0,
    skipped: 0,
    rateLimitWaits: 0,
    pacedWaits: 0,
    inputTokens: 0,
    outputTokens: 0,
    savedInputTokens: 0,
    savedOutputTokens: 0
  };
  let lastWasHit = false;

  return {
    name: inner.name,
    stats,
    wasHit: () => lastWasHit,
    isConfigured: () => inner.isConfigured(),

    async extract(request: ExtractionRequest): Promise<ExtractionResult> {
      const label = labelFor();
      const key = requestKey(inner.name, request);
      const path = entryPath(label, key);

      const cached = mode === "refresh" ? null : readEntry(path);
      if (cached) {
        lastWasHit = true;
        stats.hits += 1;
        stats.savedInputTokens += cached.usage?.inputTokens ?? 0;
        stats.savedOutputTokens += cached.usage?.outputTokens ?? 0;
        return cached.result;
      }

      lastWasHit = false;

      // Both no-spend modes stop here. `estimate` counts what a real run would
      // cost; `offline` is the mode to iterate in, where a miss is a fact to
      // report rather than a reason to reach for the network.
      if (mode === "offline" || mode === "estimate") {
        stats.skipped += 1;
        throw new ModelCacheMiss(label);
      }

      // Counted BEFORE the call, not after.
      //
      // Incrementing on the far side of the await meant a call that threw was
      // never counted, so a run that made eighteen live calls and had every one
      // rejected on quota reported "live calls 0" next to eighteen errors. A
      // stats line that goes quiet exactly when something is going wrong is
      // worse than no stats line, and this module exists to stop exactly that
      // class of invisible failure.
      stats.misses += 1;
      let result: ExtractionResult;
      try {
        result = await extractWithRateLimitRetry(inner, request, stats);
      } catch (error) {
        stats.failed += 1;
        throw error;
      }
      stats.inputTokens += result.usage?.inputTokens ?? 0;
      stats.outputTokens += result.usage?.outputTokens ?? 0;

      const entry: CacheEntry = {
        version: CACHE_VERSION,
        model: inner.name,
        label,
        storedAt: new Date().toISOString(),
        usage: result.usage,
        result
      };
      writeFileSync(path, JSON.stringify(entry, null, 2));
      return result;
    }
  };
}

/** Entries currently on disk. Reported so a run says what it is standing on. */
export function cacheSize(): number {
  const dir = modelCacheDir();
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
}

/**
 * Published Gemini Flash pricing, per million tokens, for reporting only.
 *
 * Here so a run can print what it spent instead of leaving it to be discovered
 * on a billing page. Wrong the moment Google changes it, which is why nothing
 * depends on it being right: it is a number in a report, not a decision input.
 */
const USD_PER_M_INPUT = 0.3;
const USD_PER_M_OUTPUT = 2.5;

/** Everything the cache has ever been paid for, summed across every run. */
export function cumulativeSpend(): { usd: number; calls: number } {
  const dir = modelCacheDir();
  if (!existsSync(dir)) return { usd: 0, calls: 0 };
  let input = 0;
  let output = 0;
  let calls = 0;
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
    const entry = readEntry(join(dir, file));
    if (!entry?.usage) continue;
    input += entry.usage.inputTokens;
    output += entry.usage.outputTokens;
    calls += 1;
  }
  return { usd: estimateUsd(input, output), calls };
}

export function estimateUsd(inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1_000_000) * USD_PER_M_INPUT + (outputTokens / 1_000_000) * USD_PER_M_OUTPUT;
}

/**
 * What a live run would cost, projected from calls we have actually paid for.
 *
 * Deliberately NOT a token count computed from the prompt. Counting tokens by
 * hand is how the estimate went wrong the first time: it got the text path
 * roughly right, missed that images are about four times the input, and left
 * reasoning tokens out of the output side entirely. Averaging real usage
 * reported by the provider cannot make any of those mistakes, and it says so
 * when it has nothing to average.
 */
export function projectCost(calls: number): string {
  const dir = modelCacheDir();
  if (calls === 0) return "  nothing to call: every request is already cached.";
  if (!existsSync(dir)) return `  ${calls} live calls needed, and no measured usage to price them from.`;

  let input = 0;
  let output = 0;
  let sampled = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const entry = readEntry(join(dir, file));
    if (!entry?.usage) continue;
    input += entry.usage.inputTokens;
    output += entry.usage.outputTokens;
    sampled += 1;
  }
  if (sampled === 0) {
    return `  ${calls} live calls needed. No cached call reported its usage, so there is no basis to price them.`;
  }

  const avgIn = input / sampled;
  const avgOut = output / sampled;
  const usd = estimateUsd(avgIn * calls, avgOut * calls);
  return [
    `  ${calls} live calls needed`,
    `  measured average ${Math.round(avgIn).toLocaleString()} in / ${Math.round(avgOut).toLocaleString()} out per call, over ${sampled} paid calls`,
    `  projected ~$${usd.toFixed(2)}`
  ].join("\n");
}

export function formatCacheStats(stats: CacheStats): string {
  const spent = estimateUsd(stats.inputTokens, stats.outputTokens);
  const saved = estimateUsd(stats.savedInputTokens, stats.savedOutputTokens);
  const lines = [
    `  cache hits      ${stats.hits}`,
    `  live calls      ${stats.misses}${stats.failed > 0 ? ` (${stats.failed} FAILED)` : ""}`
  ];
  if (stats.skipped > 0) lines.push(`  not called      ${stats.skipped} (no cached answer)`);
  if (stats.failed > 0) {
    lines.push(
      `  INCOMPLETE      ${stats.failed} call(s) never answered, so every number below is a floor.`
    );
  }
  if (stats.misses > stats.failed) {
    lines.push(
      `  spent THIS RUN  ${stats.inputTokens.toLocaleString()} in, ${stats.outputTokens.toLocaleString()} out (~$${spent.toFixed(2)})`
    );
  }
  // The RUNNING TOTAL, because the per-run figure is the one that misleads.
  //
  // Every line above is scoped to one invocation, and a bench gets run over and
  // over: refreshed after a prompt change, re-run after a fix, replayed to check
  // a number. Reporting "this run cost $0.71" alongside nothing else invited
  // reading it as the bill, and the account had by then paid for six runs. The
  // gap was about 3x and it was found by the person paying, not by this report.
  //
  // A floor, not the bill: a call that fails after the model has generated is
  // charged and writes no cache entry, so it cannot be counted here.
  const total = cumulativeSpend();
  if (total.calls > 0) {
    lines.push(
      `  spent IN TOTAL  ~$${total.usd.toFixed(2)} over ${total.calls} cached call(s), all runs ever (a floor: failed calls are billed and not cached)`
    );
  }
  if (stats.hits > 0 && stats.savedInputTokens > 0) {
    lines.push(
      `  tokens saved    ${stats.savedInputTokens.toLocaleString()} in, ${stats.savedOutputTokens.toLocaleString()} out (~$${saved.toFixed(2)})`
    );
  }
  return lines.join("\n");
}
