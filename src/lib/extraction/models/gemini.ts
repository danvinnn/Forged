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

const MODEL_ID = "gemini-3.6-flash";

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
const GENERATION_CONFIG = {
  temperature: 0,
  responseMimeType: "application/json"
} as const;

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
  readonly name = "gemini";

  isConfigured(): boolean {
    return Boolean(process.env.GOOGLE_GEMINI_API_KEY);
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const apiKey = process.env.GOOGLE_GEMINI_API_KEY;
    if (!apiKey) {
      throw new ExtractionModelError("config", "GOOGLE_GEMINI_API_KEY is not set.");
    }

    const client = new GoogleGenerativeAI(apiKey);
    const model = client.getGenerativeModel({ model: MODEL_ID, generationConfig: GENERATION_CONFIG });

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
