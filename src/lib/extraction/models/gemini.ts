import { GoogleGenerativeAI } from "@google/generative-ai";
import { ExtractionModelError, type ExtractionModel, type ExtractionRequest, type ExtractionResult } from "../contracts";
import { buildPrompt, parseModelResponse } from "./prompt";

/**
 * Cloud extraction model. COMMERCIAL MODE ONLY.
 *
 * Reached only through the dynamic import in `../factory.ts`, so this module is
 * never loaded into the process in air-gapped mode. Controlled datasheets must
 * not reach a third-party API, and that guarantee is structural, not a runtime
 * check inside this file.
 */

/**
 * Which Gemini model to call.
 *
 * Overridable because the free tier's request quota is PER MODEL, so a
 * measurement that cannot run on the production model can run on a sibling of
 * the same class with an untouched budget. It is not a tuning knob: the default
 * is what production uses, and anything else has to be asked for.
 */
function modelId(): string {
  return process.env.FORGE_GEMINI_MODEL || "gemini-3.6-flash";
}

/**
 * How many tokens the model may spend THINKING before it answers.
 *
 * Unset by default, which is the model's own dynamic budget and what every
 * number recorded so far was measured under. Set it to cap reasoning, or to 0
 * to ask for none.
 *
 * Why it exists, measured over 246 cached calls on 2026-08-13:
 *
 *   billed output tokens     1,091,025    $2.73
 *   tokens actually returned    ~88,734    $0.22
 *   never returned to us     ~1,002,291    $2.51
 *
 * 92% of what we pay for on the output side is reasoning we are billed for and
 * never see, and output is 68% of the whole bill. The clearest single case: a
 * CD4017B call that returned thirteen characters of JSON was billed for 2,726
 * output tokens.
 *
 * That makes this the largest cost lever in the product by a wide margin, and
 * the only open question is whether the thinking is what makes the model read a
 * mechanical drawing correctly. That is measurable, so it must be measured
 * rather than assumed, which is what the knob is for.
 *
 * **Use 1, not 0, to turn thinking off on the 3.x flash models.** Measured
 * against `gemini-3.6-flash` on 2026-08-13: a budget of 0 is rejected outright
 * with `400 Bad Request: Request contains an invalid argument`, while a budget
 * of 1 is accepted and reports `thoughtsTokenCount: 0`. Only some models, such
 * as `gemini-3-flash-preview`, accept 0. Zero is still passed through as asked
 * rather than quietly rewritten to 1, because a setting that silently becomes a
 * different setting is how a measurement ends up describing a run that never
 * happened.
 */
function thinkingBudget(): number | null {
  const raw = process.env.FORGE_THINKING_BUDGET;
  if (raw === undefined || raw === "") return null;
  const budget = Number(raw);
  return Number.isInteger(budget) && budget >= 0 ? budget : null;
}

/**
 * Generation settings, both of which are correctness requirements here rather
 * than tuning.
 *
 * **temperature 0.** Measured on AD8232 with an identical prompt: five calls,
 * four returned the pin table and one returned nothing at all. A sampled answer
 * means the same datasheet can extract differently on two runs, which is not a
 * quality problem so much as an audit problem. A QML reviewer who re-runs an
 * extraction has to get the record they signed off on.
 *
 * **responseMimeType JSON.** The contract was previously enforced by scraping
 * the first `{...}` out of whatever prose came back, and a model that wrapped
 * its answer in commentary or a markdown fence degraded to "no answer" silently.
 * Asking the API for JSON makes the shape the API's job.
 */
function generationConfig(): Record<string, unknown> {
  const budget = thinkingBudget();
  return {
    temperature: 0,
    responseMimeType: "application/json",
    // The REST field is `generationConfig.thinkingConfig.thinkingBudget`. This
    // SDK version predates it and has no type for it, but it forwards
    // `generationConfig` verbatim, so the field reaches the API. Omitted
    // entirely when unset, so the default request is byte-identical to the one
    // every existing measurement was taken with.
    ...(budget === null ? {} : { thinkingConfig: { thinkingBudget: budget } })
  };
}

/**
 * Wall-clock ceiling for a model call. The SDK exposes no timeout, and Node's
 * fetch has no default one, so a hung endpoint would otherwise hold the request
 * open until the platform kills it and the user gets a 504 instead of a record.
 *
 * This is a BACKSTOP, not the deadline that matters, and it is deliberately
 * longer than any route's: a caller with a request to serve enforces its own,
 * because only it knows how much of its budget is already spent. See
 * `extraction/budget.ts`. Left generous here so the benchmark, which has no
 * request to answer, can still see a call that takes 41.6 seconds succeed
 * instead of recording it as a transport failure.
 */
const MODEL_TIMEOUT_MS = 60_000;

/**
 * Transient upstream failures, retried; everything else is surfaced at once.
 *
 * Sending page images made this necessary rather than nice. A text-only request
 * is a few kilobytes and failed on 5 of 44 parts; the same corpus with renders
 * attached is one to two megabytes per call and failed on 13 of 44, and both
 * parts sampled from that set succeeded first time when retried by hand. So the
 * discards were upstream capacity, not the model declining to answer, and
 * without a retry the bench measures Google's queue instead of our extractor.
 *
 * A quota error is NOT retried here. Backing off inside one call cannot fix a
 * per-minute budget, and burning the caller's remaining time to discover that
 * is worse than reporting it.
 */
const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2_000;

/**
 * Failures that no amount of waiting fixes, checked BEFORE the transient test.
 *
 * A 429 means two completely different things and they need opposite handling.
 * "Rate limit exceeded" is a pace problem and backing off is exactly right.
 * "Your prepayment credits are depleted" is a billing problem, and retrying it
 * is pure waste: the account will not refill in four seconds.
 *
 * This list is what it is because the first version only excluded the word
 * "quota", and Google's billing message does not contain it. On 2026-08-05 the
 * account ran dry mid-run and all 59 failing parts were retried three times
 * each, which turned a clean stop into a slow, noisy one and made the cause
 * harder to see, not easier.
 */
const PERMANENT_FAILURE =
  /\b(?:quota|credits?\s+(?:are\s+)?(?:depleted|exhausted)|billing|payment|insufficient|suspended|disabled|unauthorized|forbidden|invalid\s+api\s+key|API key)\b/i;

function isTransient(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (PERMANENT_FAILURE.test(message)) return false;
  return /\b(?:429|500|502|503|504)\b|overload|unavailable|internal error|fetch failed|socket hang up|ECONNRESET|ETIMEDOUT/i.test(
    message
  );
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ExtractionModelError("transport", `${label} timed out after ${ms}ms.`)),
      ms
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export class GeminiExtractionModel implements ExtractionModel {
  /**
   * Carries the model id and the thinking budget, because the bench cache keys
   * on this name and on the prompt, and on NOTHING else about the request.
   *
   * Without it, changing the thinking budget would leave every cache key
   * identical, so a comparison run would replay answers taken under the old
   * setting and report, confidently, that the knob changed nothing. A setting
   * that alters the answer has to alter the key.
   *
   * Plain `gemini` when nothing is overridden, so the 246 entries already on
   * disk stay reachable and every number measured so far still replays.
   */
  readonly name = ["gemini", process.env.FORGE_GEMINI_MODEL, thinkingBudget() === null ? null : `think${thinkingBudget()}`]
    .filter(Boolean)
    .join(":");

  isConfigured(): boolean {
    return Boolean(process.env.GOOGLE_GEMINI_API_KEY);
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) {
      throw new ExtractionModelError("config", "GOOGLE_GEMINI_API_KEY is not set.");
    }

    const client = new GoogleGenerativeAI(apiKey);
    const model = client.getGenerativeModel({ model: modelId(), generationConfig: generationConfig() });

    // Text first, then the renders in page order. The prompt names the pages
    // and says they are attached in that order, so the two must not diverge.
    const parts = [
      { text: buildPrompt(request) },
      ...request.images.map((image) => ({
        inlineData: { mimeType: image.mimeType, data: image.base64 }
      }))
    ];

    let lastError: unknown;
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt += 1) {
      try {
        const response = await withTimeout(
          model.generateContent({ contents: [{ role: "user", parts }] }),
          MODEL_TIMEOUT_MS,
          "Gemini extraction"
        );
        const parsed = parseModelResponse(response.response.text());
        // `thoughtsTokenCount` is billed as output but is reported separately
        // and is NOT included in `candidatesTokenCount`. Measured on LM358:
        // 256 candidate tokens against 2,779 reasoning tokens, so leaving it
        // out understates the output side of the bill by more than 10x.
        const usage = response.response.usageMetadata;
        if (usage) {
          parsed.usage = {
            inputTokens: usage.promptTokenCount ?? 0,
            outputTokens:
              (usage.candidatesTokenCount ?? 0) +
              ((usage as { thoughtsTokenCount?: number }).thoughtsTokenCount ?? 0)
          };
        }
        return parsed;
      } catch (error) {
        lastError = error;
        // A timeout is ours, not theirs. Retrying a call that already burned the
        // full backstop would triple the worst case for no new information.
        const timedOut =
          error instanceof ExtractionModelError && /timed out after/.test(error.message);
        if (timedOut || !isTransient(error) || attempt === RETRY_ATTEMPTS - 1) break;
        await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * 2 ** attempt));
      }
    }

    if (lastError instanceof ExtractionModelError) throw lastError;
    throw new ExtractionModelError(
      "transport",
      lastError instanceof Error ? lastError.message : "Gemini request failed."
    );
  }
}
