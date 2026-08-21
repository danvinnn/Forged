import { ExtractionModelError, type ExtractionResult } from "../contracts";
import { parseModelResponse } from "./prompt";

/**
 * What every cloud model call needs that is not the call itself: the retry
 * policy, the timeout backstop, the attempt accounting and the thinking budget.
 *
 * Shared rather than written per provider. Gemini and Vertex speak to the same
 * models through different SDKs, so everything here would otherwise exist twice
 * and drift, which is the failure shape LEARNINGS.md names first. The attempt
 * counter is the sharpest example: it was wrong on the failure path once
 * already, fixed in one place, and a second copy would have to be found and
 * fixed again.
 *
 * COMMERCIAL MODE ONLY, like the providers it serves. Reached only from modules
 * under `models/`, which the factory loads by dynamic import.
 */

/**
 * How many tokens the model may spend THINKING before it answers.
 *
 * Unset by default, which is the model's own dynamic budget and what every
 * number recorded so far was measured under.
 *
 * Measured over 246 cached calls on 2026-08-13:
 *
 *   billed output tokens     1,091,025    $2.73
 *   tokens actually returned    ~88,734    $0.22
 *   never returned to us     ~1,002,291    $2.51
 *
 * 92% of what we pay for on the output side is reasoning we are billed for and
 * never see, and output is 68% of the whole bill.
 *
 * **Use 1, not 0, to turn thinking off on the 3.x flash models.** Measured
 * against `gemini-3.6-flash`: a budget of 0 is rejected with `400 Bad Request`,
 * while 1 is accepted and reports `thoughtsTokenCount: 0`. Zero is still passed
 * through as asked rather than quietly rewritten, because a setting that
 * silently becomes a different setting is how a measurement ends up describing
 * a run that never happened.
 */
export function thinkingBudget(): number | null {
  const raw = process.env.FORGE_THINKING_BUDGET;
  if (raw === undefined || raw === "") return null;
  const budget = Number(raw);
  return Number.isInteger(budget) && budget >= 0 ? budget : null;
}

/**
 * Wall-clock ceiling for a model call. Neither SDK exposes a timeout and Node's
 * fetch has no default one, so a hung endpoint would otherwise hold the request
 * open until the platform kills it.
 *
 * A BACKSTOP, not the deadline that matters: a caller with a request to serve
 * enforces its own, because only it knows how much of its budget is spent.
 *
 * RAISED FROM 60s ON 2026-08-20, because 60 was being HIT rather than
 * approached. Measured with `bench:repeat`, six parts, live calls, net of the
 * bench's own rate-limit pacing:
 *
 *     LM358         timed out on both runs AND both retries, returning nothing
 *     STM32F407VG   timed out, so the run was not comparable
 *     ADS1115       timed out once per run, and only succeeded on the retry
 *
 * A ceiling that the normal case hits is not a backstop, it is a failure
 * generator: every one of those was a call we paid for and threw away. 90s is
 * chosen as comfortably past the slowest call we have observed complete, while
 * still being short enough that two of them plus a retry stay inside the route
 * budget below.
 */
export const MODEL_TIMEOUT_MS = 90_000;

/**
 * Transient upstream failures, retried; everything else surfaced at once.
 *
 * Sending page images made this necessary. A text-only request failed on 5 of 44
 * parts; the same corpus with renders attached is one to two megabytes per call
 * and failed on 13 of 44, and both parts sampled from that set succeeded first
 * time when retried by hand. Without a retry the bench measures Google's queue
 * rather than our extractor.
 */
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2_000;

/**
 * Failures no amount of waiting fixes, checked BEFORE the transient test.
 *
 * A 429 means two different things needing opposite handling. "Rate limit
 * exceeded" is a pace problem and backing off is right. "Your prepayment credits
 * are depleted" is billing, and retrying is pure waste.
 *
 * This list is what it is because the first version only excluded "quota", and
 * Google's billing message does not contain that word. On 2026-08-05 the account
 * ran dry mid-run and all 59 failing parts were retried three times each.
 */
const PERMANENT_FAILURE =
  /\b(?:quota|credits?\s+(?:are\s+)?(?:depleted|exhausted)|billing|payment|insufficient|suspended|disabled|unauthorized|forbidden|invalid\s+api\s+key|API key|PERMISSION_DENIED|SERVICE_DISABLED)\b/i;

export function isTransient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (PERMANENT_FAILURE.test(message)) return false;
  return /\b(?:429|500|502|503|504)\b|overload|unavailable|internal error|fetch failed|socket hang up|ECONNRESET|ETIMEDOUT/i.test(
    message
  );
}

export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ExtractionModelError("transport", `${label} timed out after ${ms}ms.`)),
      ms
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** One provider's answer, reduced to what this module needs to know. */
export interface RawAnswer {
  text: string;
  /**
   * Billed tokens. `thoughtsTokenCount` is billed as output, reported
   * separately, and NOT included in the candidate count: measured on LM358, 256
   * candidate tokens against 2,779 reasoning tokens, so omitting it understates
   * the output side by more than 10x. Providers must fold it in before passing
   * usage here.
   */
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * Runs one provider call with the shared retry policy and returns the parsed
 * result, or throws an `ExtractionModelError` carrying the attempt count.
 *
 * EVERY attempt reached the provider and was billed, including ones that threw.
 * The failure path used to carry no count at all, so a call retried three times
 * and never answered was recorded as a single charge, on exactly the branch
 * where retries are most likely.
 */
export async function callWithRetry(label: string, attemptOnce: () => Promise<RawAnswer>): Promise<ExtractionResult> {
  let lastError: unknown;
  let made = 0;

  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
    made = attempt + 1;
    try {
      const answer = await withTimeout(attemptOnce(), MODEL_TIMEOUT_MS, label);
      const parsed = parseModelResponse(answer.text);
      parsed.attempts = made;
      if (answer.usage) parsed.usage = answer.usage;
      return parsed;
    } catch (error) {
      lastError = error;
      // A timeout is ours, not theirs. Retrying a call that already burned the
      // full backstop would triple the worst case for no new information.
      const timedOut = error instanceof ExtractionModelError && /timed out after/.test(error.message);
      if (timedOut || !isTransient(error) || attempt === RETRY_ATTEMPTS - 1) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** attempt));
    }
  }

  if (lastError instanceof ExtractionModelError) {
    throw new ExtractionModelError(lastError.kind, lastError.message, made);
  }
  throw new ExtractionModelError(
    "transport",
    lastError instanceof Error ? lastError.message : `${label} failed.`,
    made
  );
}
