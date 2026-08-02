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

    let text: string;
    try {
      const response = await withTimeout(
        model.generateContent({
          contents: [{ role: "user", parts: [{ text: buildPrompt(request) }] }]
        }),
        MODEL_TIMEOUT_MS,
        "Gemini extraction"
      );
      text = response.response.text();
    } catch (error) {
      if (error instanceof ExtractionModelError) throw error;
      throw new ExtractionModelError(
        "transport",
        error instanceof Error ? error.message : "Gemini request failed."
      );
    }

    return parseModelResponse(text);
  }
}
