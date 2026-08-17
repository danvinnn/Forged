import { GoogleGenerativeAI } from "@google/generative-ai";
import { ExtractionModelError, type ExtractionModel, type ExtractionRequest, type ExtractionResult } from "../contracts";
import { buildPrompt } from "./prompt";
import { callWithRetry, thinkingBudget } from "./transport";

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

    // Retry policy, timeout and attempt accounting come from `transport.ts`,
    // shared with the Vertex provider. They were duplicated here first and the
    // attempt counter had already been fixed once in one place.
    return callWithRetry("Gemini extraction", async () => {
      const response = await model.generateContent({ contents: [{ role: "user", parts }] });
      const usage = response.response.usageMetadata;
      return {
        text: response.response.text(),
        usage: usage
          ? {
              inputTokens: usage.promptTokenCount ?? 0,
              // `thoughtsTokenCount` is billed as output, reported separately,
              // and NOT included in `candidatesTokenCount`. Measured on LM358:
              // 256 candidate tokens against 2,779 reasoning tokens.
              outputTokens:
                (usage.candidatesTokenCount ?? 0) +
                ((usage as { thoughtsTokenCount?: number }).thoughtsTokenCount ?? 0)
            }
          : undefined
      };
    });
  }
}
