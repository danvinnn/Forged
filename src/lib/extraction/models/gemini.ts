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
 * Wall-clock ceiling for a model call. The SDK exposes no timeout, and Node's
 * fetch has no default one, so a hung endpoint would otherwise hold the request
 * open until the platform kills it and the user gets a 504 instead of a record.
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
    const model = client.getGenerativeModel({ model: MODEL_ID });

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
