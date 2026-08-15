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
import { extractionFields } from "../extraction/contracts";
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
  /** False when the free tier served this call, so it cost nothing to fetch. */
  billed?: boolean;
  /**
   * Which QUESTION TEMPLATE this answer was stored under. See
   * `promptFingerprint`. Absent on entries written before 2026-08-13, which is
   * why the census below reports "unknown" as its own bucket rather than
   * guessing.
   */
  prompt?: string;
  usage?: { inputTokens: number; outputTokens: number };
  result: ExtractionResult;
}

/**
 * A fingerprint of the QUESTION, with no document in it.
 *
 * The cache key is a hash of the whole request, so a change to the prompt
 * wording strands every entry on disk at once. That is correct, and it is also
 * the single most expensive thing that can happen here: $4.04 went on nineteen
 * runs where the cache was cold not because the corpus had grown but because
 * the prompt had been edited, and nothing said so. The run just quietly re-asked
 * all 76 questions and looked exactly like a run that hit.
 *
 * This is the part of the key that is the same for every part, so it can be
 * compared against what is on disk WITHOUT parsing a single PDF or rendering a
 * single page. That is what makes a pre-run warning possible: the answer is
 * available before anything has been spent.
 *
 * Several shapes are hashed together because the prompt branches: the first
 * pass asks which pages to render and the second does not, and the package hint
 * and the candidate list each add their own paragraph. Hashing one shape would
 * miss an edit made to any of the others.
 */
export function promptFingerprint(): string {
  const base: ExtractionRequest = {
    pages: [],
    images: [],
    fileName: "fingerprint.pdf",
    fields: [...extractionFields]
  };
  const shapes: ExtractionRequest[] = [
    base,
    { ...base, partNumber: "PART", packageType: "PKG (8)" },
    { ...base, partNumber: "PART", packageCandidates: ["PKG-A", "PKG-B"] },
    // The second pass: images present, so the render request drops out.
    {
      ...base,
      partNumber: "PART",
      images: [{ page: 1, mimeType: "image/png", base64: "", widthPx: 1, heightPx: 1 }]
    }
  ];
  const hash = createHash("sha256");
  hash.update(`v${CACHE_VERSION}\n`);
  for (const shape of shapes) hash.update(`${buildPrompt(shape)}\n`);
  return hash.digest("hex").slice(0, 16);
}

/**
 * The most this cache may EVER have cost, in USD, across every run.
 *
 * Cumulative, not per-run, and the difference is the whole point. The first
 * version of this capped a single run, which was the wrong scope and would have
 * prevented nothing: $4.04 was spent across NINETEEN runs whose largest was
 * $1.02, so a $2 per-run ceiling never once fired. The damage was the sum of
 * many individually reasonable runs, each re-asking everything because a prompt
 * change invalidates every cached answer by design.
 *
 * Capping the total is what actually intervenes: it stops at the point where
 * someone should decide whether the project is worth more money, rather than at
 * a point no single run reaches.
 *
 * Set to 0 to disable, or raise it deliberately when the answer is yes.
 */
function spendLimitUsd(): number {
  const raw = Number(process.env.FORGE_SPEND_LIMIT_USD);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10;
}

/**
 * Thrown when a run hits its spend ceiling. Distinct from a quota error: this
 * one is OUR limit, the money is still available, and the fix is to decide the
 * run is worth it rather than to add credit.
 */
export class SpendLimitReached extends Error {
  constructor(readonly spentUsd: number, readonly limitUsd: number) {
    super(
      `Stopped: this cache has now cost about $${spentUsd.toFixed(2)} in total, over the ` +
        `$${limitUsd.toFixed(2)} limit. That is EVERY run, not this one. Answers already ` +
        `fetched are cached, so a re-run continues from here. Decide whether it is worth ` +
        `more, then raise it with FORGE_SPEND_LIMIT_USD=<usd>, or 0 to disable.`
    );
    this.name = "SpendLimitReached";
  }
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
        // A HIT proves this entry was stored under the prompt we just built,
        // because the prompt is part of the key. So an entry written before
        // fingerprints existed can be stamped here rather than left "unknown"
        // forever, and one free `--offline` pass backfills the whole cache.
        // Only ever fills a blank: an existing fingerprint is never rewritten.
        if (!cached.prompt) {
          try {
            writeFileSync(path, JSON.stringify({ ...cached, prompt: promptFingerprint() }, null, 2));
          } catch {
            // Cosmetic. A cache that cannot be re-written still answers.
          }
        }
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
        // A failed call is still a charge. Recording it here is the whole point:
        // the cache directory only ever knew about successes, so every failure
        // and every retry was spend nobody could see.
        stats.failed += 1;
        if (wasPaidFor(inner.name, !freeTier())) recordBilled(1, null);
        throw error;
      }
      stats.inputTokens += result.usage?.inputTokens ?? 0;
      stats.outputTokens += result.usage?.outputTokens ?? 0;

      // Every attempt the model made, not just the one that came back. A 503
      // retried twice is three charges and one cache entry.
      if (wasPaidFor(inner.name, !freeTier())) {
        const usd = result.usage ? estimateUsd(result.usage.inputTokens, result.usage.outputTokens) : null;
        recordBilled(result.attempts ?? 1, usd);
      }

      const entry: CacheEntry = {
        version: CACHE_VERSION,
        model: inner.name,
        label,
        storedAt: new Date().toISOString(),
        prompt: promptFingerprint(),
        billed: !freeTier(),
        usage: result.usage,
        result
      };
      writeFileSync(path, JSON.stringify(entry, null, 2));

      // Stop the run the moment it has spent more than it was allowed to.
      //
      // Deliberately AFTER the entry is written: the call that trips the limit
      // has already been paid for, so discarding its answer would mean paying
      // for it again on the re-run. The first version of this threw before the
      // write and did exactly that.
      if (wasPaidFor(inner.name, !freeTier())) {
        const limit = spendLimitUsd();
        // The CHARGED total, not the stored one. Checking the cache directory
        // here is what let a run reported at $1.88 actually cost $3.16 and sail
        // past a ceiling that was supposed to be a hard stop.
        const spent = chargedSpend().usd;
        if (limit > 0 && spent > limit) throw new SpendLimitReached(spent, limit);
      }

      return result;
    }
  };
}

/**
 * Every provider call this cache has CAUSED TO BE BILLED, including the ones
 * that returned nothing.
 *
 * The cache directory is a record of successes. Google charges for attempts.
 * Those are different numbers, and quoting the first as the second under-reported
 * spend by 40% on 2026-08-14: a run reported at $1.88 was charged $3.16, the gap
 * being 503s retried up to three times each, every attempt billed and only the
 * winner stored.
 *
 * So attempts are appended here as they happen, priced at their real usage where
 * the call came back and at the running average where it did not. This file is
 * the number to trust and the number the ceiling checks.
 */
/**
 * The ledger is a sidecar, not an answer. Every scan of the cache directory has
 * to skip it, and they all go through this so adding another sidecar cannot
 * silently turn into a phantom cache entry the way the first one did.
 */
function isEntryFile(name: string): boolean {
  return name.endsWith(".json") && name !== "_billed.json";
}

function ledgerPath(): string {
  return join(modelCacheDir(), "_billed.json");
}

interface Ledger {
  /** Provider calls billed, successful or not. */
  attempts: number;
  /** Best estimate of what they cost, in USD. */
  usd: number;
}

function readLedger(): Ledger {
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(), "utf8")) as Partial<Ledger>;
    return { attempts: raw.attempts ?? 0, usd: raw.usd ?? 0 };
  } catch {
    return { attempts: 0, usd: 0 };
  }
}

/**
 * Records billed attempts.
 *
 * `usd` may be null when the call failed and reported no usage, in which case
 * the running average stands in. An estimate that exists beats a charge that is
 * invisible, which is what the previous accounting did with every failure.
 */
function recordBilled(attempts: number, usd: number | null): void {
  if (attempts <= 0) return;
  const dir = modelCacheDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const current = readLedger();
  const perCall = usd ?? averagePaidCallUsd();
  const next: Ledger = {
    attempts: current.attempts + attempts,
    usd: current.usd + (usd === null ? perCall * attempts : usd + perCall * (attempts - 1))
  };
  try {
    writeFileSync(ledgerPath(), JSON.stringify(next, null, 2));
  } catch {
    // A ledger that cannot be written must not fail the run; the report will say
    // it is falling back to the cached-successes floor.
  }
}

/** What a paid call has cost on average, for pricing attempts that returned nothing. */
function averagePaidCallUsd(): number {
  const dir = modelCacheDir();
  if (!existsSync(dir)) return 0;
  let input = 0, output = 0, calls = 0;
  for (const file of readdirSync(dir).filter(isEntryFile)) {
    const entry = readEntry(join(dir, file));
    if (!entry?.usage || !wasPaidFor(entry.model, entry.billed)) continue;
    input += entry.usage.inputTokens;
    output += entry.usage.outputTokens;
    calls += 1;
  }
  return calls === 0 ? 0 : estimateUsd(input / calls, output / calls);
}

/** Entries currently on disk. Reported so a run says what it is standing on. */
export function cacheSize(): number {
  const dir = modelCacheDir();
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter(isEntryFile).length;
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

/**
 * Whether an entry cost money at all.
 *
 * A locally hosted model is free, and pricing its tokens at the cloud model's
 * rate reports a bill nobody was sent. Caught on the first local run: two calls
 * against Ollama were reported as `~$0.02`. The whole point of the running
 * total is that it matches what the account was charged, so an entry that was
 * never charged must not appear in it.
 */
function wasPaidFor(model: string | undefined, billed?: boolean): boolean {
  // An explicit `false` means the account was on the free tier when this answer
  // was fetched, so it cost nothing however many tokens it burned. Absent means
  // billed, which is right for every entry written before this existed.
  if (billed === false) return false;
  // Prefix, not equality: the name now carries the model id and thinking budget
  // when either is overridden, e.g. `gemini:gemini-3.5-flash:think512`. An exact
  // match would have quietly priced every measurement run at zero, which is the
  // same class of mistake as pricing free local calls at cloud rates.
  return model?.startsWith("gemini") ?? false;
}

/**
 * Whether this account is on the free tier, where requests are rate limited but
 * not charged.
 *
 * Declared rather than detected, because nothing in a response says which tier
 * served it. It matters because the cost report and the spend ceiling would
 * otherwise treat a free measurement run as money spent: the ceiling would stop
 * a run that cost nothing, and the running total would report a bill the account
 * never received. Reporting spend that did not happen is the same failure as
 * missing spend that did, and this project has already made the second one.
 */
function freeTier(): boolean {
  return process.env.FORGE_FREE_TIER === "1";
}

/** Everything the cache has ever been PAID for, summed across every run. */
export function cumulativeSpend(): { usd: number; calls: number } {
  const dir = modelCacheDir();
  if (!existsSync(dir)) return { usd: 0, calls: 0 };
  let input = 0;
  let output = 0;
  let calls = 0;
  for (const file of readdirSync(dir).filter(isEntryFile)) {
    const entry = readEntry(join(dir, file));
    if (!entry?.usage || !wasPaidFor(entry.model, entry.billed)) continue;
    input += entry.usage.inputTokens;
    output += entry.usage.outputTokens;
    calls += 1;
  }
  return { usd: estimateUsd(input, output), calls };
}

/**
 * What the account was actually CHARGED, as opposed to what landed on disk.
 *
 * Falls back to the cached-successes total when no ledger exists yet, which is
 * every cache written before 2026-08-14. That fallback is a floor and says so.
 */
export function chargedSpend(): { usd: number; calls: number; fromLedger: boolean } {
  const ledger = readLedger();
  if (ledger.attempts > 0) return { usd: ledger.usd, calls: ledger.attempts, fromLedger: true };
  const cached = cumulativeSpend();
  return { usd: cached.usd, calls: cached.calls, fromLedger: false };
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
  for (const file of readdirSync(dir).filter(isEntryFile)) {
    const entry = readEntry(join(dir, file));
    // PAID entries only. A local model reports usage too, and averaging its
    // calls in with the cloud model's prices a run off calls that cost nothing,
    // which drags the projection down by however much local iteration has been
    // done. The figure has to match what the account would be charged.
    if (!entry?.usage || !wasPaidFor(entry.model, entry.billed)) continue;
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

/** What is on disk, sorted by whether this run's prompt can still reach it. */
export interface CacheCensus {
  /** Stored under the prompt we are about to send. These are the only ones that can hit. */
  reachable: number;
  /** Paid for under a DIFFERENT prompt. Money already spent that this run cannot use. */
  stranded: number;
  /** Written before the fingerprint existed. Might hit, might not; not guessed at. */
  unknown: number;
}

export function cacheCensus(): CacheCensus {
  const dir = modelCacheDir();
  const census: CacheCensus = { reachable: 0, stranded: 0, unknown: 0 };
  if (!existsSync(dir)) return census;
  const current = promptFingerprint();
  for (const file of readdirSync(dir).filter(isEntryFile)) {
    const entry = readEntry(join(dir, file));
    if (!entry) continue;
    if (!entry.prompt) census.unknown += 1;
    else if (entry.prompt === current) census.reachable += 1;
    else census.stranded += 1;
  }
  return census;
}

/**
 * What this run is about to cost, printed BEFORE it spends anything.
 *
 * The ceiling in this file is a backstop: it stops a run after the money is
 * gone, and a hold-out run stopped halfway is worth nothing because the score
 * needs every part. It never saves anything. This does, and it is the honest
 * answer to "how does a ceiling save money": it does not, foresight does.
 *
 * The failure it addresses is specific and it happened nineteen times. A change
 * to the prompt invalidates every cached answer by design, so the next run
 * silently re-asks the entire corpus. Nothing about that run looks different
 * from one that hits the cache until the bill arrives, and the bill arrived
 * three runs late. The one fact that would have stopped it is knowable for free
 * before the first call: the prompt on disk is not the prompt about to be sent.
 *
 * Costs nothing to produce, reads no PDF and calls nothing. It does not block:
 * the operator reads it and decides, or does not, and the ceiling still catches
 * what they miss.
 */
export function preRunProjection(options: {
  /** Documents this run will visit. */
  parts: number;
  /** Model calls each part can make. Two here: the text pass and the render pass. */
  callsPerPart: number;
  /** The model that will actually be called, so a free one is not priced as a paid one. */
  modelName: string;
}): string {
  const { parts, callsPerPart, modelName: model } = options;
  const census = cacheCensus();
  const ceiling = parts * callsPerPart;
  const paid = wasPaidFor(model, !freeTier());
  const lines = [`Before spending, ${model}:`];

  lines.push(`  corpus          ${parts} parts, up to ${callsPerPart} call(s) each (${ceiling} at most)`);
  lines.push(
    `  cached answers  ${census.reachable} reachable, ${census.stranded} stranded` +
      (census.unknown > 0 ? `, ${census.unknown} unknown (stored before this was recorded)` : "")
  );

  if (!paid) {
    lines.push(
      freeTier() && model.startsWith("gemini")
        ? "  cost            $0.00, free tier. Rate limited, not charged."
        : "  cost            $0.00, this model is local"
    );
    return lines.join("\n");
  }

  // The live-call count is a CEILING, not a prediction. Which requests hit
  // cannot be known without building every one of them, which means parsing and
  // rendering the whole corpus; the point of this is to be free. So it reports
  // the worst case and says that is what it is.
  lines.push(projectCost(ceiling).replace(/^ {2}(\d+) live calls needed$/m, "  at most $1 live calls"));

  const total = chargedSpend();
  const limit = spendLimitUsd();
  lines.push(
    `  spent already   ~$${total.usd.toFixed(2)} over ${total.calls} ${total.fromLedger ? "billed" : "cached"} call(s)` +
      (limit > 0 ? `, ceiling $${limit.toFixed(2)}` : ", no ceiling set")
  );

  // The diagnosis, which is the part worth printing. A cold cache is normal on a
  // new corpus and a warning sign after a prompt edit, and the two are
  // indistinguishable from the run itself.
  if (census.stranded > 0 && census.reachable === 0) {
    lines.push(
      `  WHY IT IS COLD  the prompt changed: all ${census.stranded} stored answers were paid for ` +
        `under a different question and CANNOT be hit. This run re-asks everything.`
    );
  } else if (census.stranded > census.reachable && census.stranded > 0) {
    lines.push(
      `  NOTE            ${census.stranded} answers are stranded under older prompts, ` +
        `so most of what is on disk cannot help.`
    );
  } else if (census.reachable === 0 && census.unknown === 0 && census.stranded === 0) {
    lines.push("  WHY IT IS COLD  the cache is empty. A first run pays for everything.");
  } else if (census.unknown > census.reachable) {
    // Answerable for free, so say how rather than guessing. `--offline` replays
    // the corpus without calling anything and stamps every entry it hits, which
    // turns this line into a real reachable/stranded split.
    lines.push(
      `  UNSURE          ${census.unknown} answers predate the fingerprint, so how much of this ` +
        `run hits is unknown. \`--offline\` costs nothing and settles it.`
    );
  }

  return lines.join("\n");
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
  const charged = chargedSpend();
  if (charged.calls > 0) {
    lines.push(
      charged.fromLedger
        ? `  CHARGED TOTAL   ~$${charged.usd.toFixed(2)} over ${charged.calls} billed call(s), all runs ever (includes failures and retries)`
        : `  spent IN TOTAL  ~$${charged.usd.toFixed(2)} over ${charged.calls} cached call(s) — a FLOOR, this cache predates attempt tracking`
    );
  }
  if (stats.hits > 0 && stats.savedInputTokens > 0) {
    lines.push(
      `  tokens saved    ${stats.savedInputTokens.toLocaleString()} in, ${stats.savedOutputTokens.toLocaleString()} out (~$${saved.toFixed(2)})`
    );
  }
  return lines.join("\n");
}
