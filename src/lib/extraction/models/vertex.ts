import { GoogleGenAI } from "@google/genai";
import { ExtractionModelError, type ExtractionModel, type ExtractionRequest, type ExtractionResult } from "../contracts";
import { buildPrompt } from "./prompt";
import { callWithRetry, thinkingBudget } from "./transport";

/**
 * The same Gemini models, reached through Google Cloud Vertex AI instead of AI
 * Studio. COMMERCIAL MODE ONLY.
 *
 * Reached only through the dynamic import in `../factory.ts`, so this module is
 * never loaded in air-gapped mode. Controlled datasheets must not reach a
 * third-party API, and that guarantee is structural rather than a runtime check
 * inside this file.
 *
 * ## Why it exists beside `gemini.ts`
 *
 * Same models, different billing and different auth. AI Studio bills a prepaid
 * balance against an API key; Vertex bills a Google Cloud project against a
 * service account. When one runs dry the other still works, and a customer with
 * a GCP relationship may only be able to buy the second.
 *
 * **There is no Vertex API key.** Authentication is Application Default
 * Credentials: the SDK reads the service account JSON that
 * `GOOGLE_APPLICATION_CREDENTIALS` points at. Nothing is pasted into a key
 * field, and `GOOGLE_GEMINI_API_KEY` is not consulted here.
 *
 * ## What is identical
 *
 * The prompt, the parsing, the retry policy, the timeout, the attempt
 * accounting AND the model. Only the transport and the billing differ, which is
 * what makes a Vertex run comparable with a stored AI Studio number.
 *
 * ## THE LOCATION DECIDES WHICH MODELS EXIST, and it is the whole story
 *
 * Probed on 2026-08-17, same project, same credentials, one call per cell:
 *
 *     global         3.6-flash OK   3.5-flash OK   3-flash-preview OK   2.5-flash OK
 *     us-central1    3.6-flash 404  3.5-flash 404  3-flash-preview 404  2.5-flash OK
 *     us-east5       3.6-flash 404  3.5-flash 404  3-flash-preview 404  2.5-flash OK
 *     europe-west4   3.6-flash 404  3.5-flash 404  3-flash-preview 404  2.5-flash OK
 *
 * So the newer models are published to the `global` endpoint only. A regional
 * endpoint reaches 2.5-flash and nothing above it.
 *
 * `global` is therefore the default. It keeps both providers on one model id,
 * which is the difference between a comparison and a confound.
 *
 * **The tradeoff a rad-hard customer may care about.** `global` lets Google
 * serve the request from any region. A deployment with data-residency terms has
 * to pin a region instead, and pinning costs access to every model above
 * 2.5-flash. That is a real decision rather than a default to inherit, which is
 * why the region is configurable and why this is written down.
 *
 * Note this is separate from the air-gap guarantee: a customer who cannot send
 * datasheets out at all uses the local model, not this file.
 *
 * Two things that made this take longer than it should have. `models.list()`
 * returns every model Google PUBLISHES regardless of what the caller can reach,
 * so it is useless for this question. And probing ONE region and reporting the
 * result as a project-level limitation is measuring one thing and describing
 * another.
 */

/** The Google Cloud project that gets billed. Not the display name. */
function project(): string {
  return process.env.FORGE_VERTEX_PROJECT ?? "";
}

/**
 * Which endpoint to call. `global` by default, because the newer models are
 * published there and nowhere else; see the header for the probe.
 *
 * Override it to pin a region when data residency requires it, knowing that
 * doing so drops the reachable models to 2.5-flash and below.
 */
function location(): string {
  return process.env.FORGE_VERTEX_LOCATION || "global";
}

/**
 * Which model to call, defaulting to the SAME id the AI Studio path uses.
 *
 * Deliberately in step. Two providers running different models would confound
 * the transport with the model on every comparison between them, and the cache
 * would hold two sets of answers that look interchangeable and are not.
 *
 * Reachable because `location()` defaults to `global`. On a pinned region this
 * 404s, which is the correct loud failure rather than a silent downgrade to an
 * older model.
 */
function modelId(): string {
  return process.env.FORGE_VERTEX_MODEL || process.env.FORGE_GEMINI_MODEL || "gemini-3.6-flash";
}

export class VertexExtractionModel implements ExtractionModel {
  /**
   * Carries the transport, the model id and the thinking budget, because the
   * bench cache keys on this name and on the prompt and NOTHING else about the
   * request.
   *
   * The `vertex:` prefix is not cosmetic. Without it a Vertex answer and an AI
   * Studio answer for the same part and prompt would collide on one cache key,
   * and a comparison between the two providers would silently replay whichever
   * ran first.
   */
  readonly name = [
    "vertex",
    // The model id ALWAYS goes in the name here, defaulted or not, because the
    // Vertex default differs from the AI Studio one. Leaving it out would let
    // two genuinely different models share a cache key.
    modelId(),
    thinkingBudget() === null ? null : `think${thinkingBudget()}`
  ]
    .filter(Boolean)
    .join(":");

  /**
   * Configured when there is a credential AND a project.
   *
   * Both are required and neither has a safe default. A missing project cannot
   * be guessed from the credential without assuming the service account's own
   * project is the one to bill, which is usually true and is exactly the kind of
   * assumption that produces a confusing bill.
   */
  isConfigured(): boolean {
    return Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS && project());
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      throw new ExtractionModelError(
        "config",
        "GOOGLE_APPLICATION_CREDENTIALS is not set. Vertex authenticates with a service account JSON, not an API key."
      );
    }
    if (!project()) {
      throw new ExtractionModelError(
        "config",
        "FORGE_VERTEX_PROJECT is not set. It must be the Google Cloud project ID, which is lowercase and often carries digits, not the project's display name."
      );
    }

    const ai = new GoogleGenAI({ vertexai: true, project: project(), location: location() });

    // Text first, then the renders in page order. The prompt names the pages and
    // says they are attached in that order, so the two must not diverge.
    const parts = [
      { text: buildPrompt(request) },
      ...request.images.map((image) => ({
        inlineData: { mimeType: image.mimeType, data: image.base64 }
      }))
    ];

    const budget = thinkingBudget();

    return callWithRetry("Vertex extraction", async () => {
      const response = await ai.models.generateContent({
        model: modelId(),
        contents: [{ role: "user", parts }],
        config: {
          // temperature 0: measured on AD8232 with an identical prompt, five
          // calls returned four pin tables and one nothing at all. A sampled
          // answer means the same datasheet extracts differently on two runs,
          // which is an audit problem: a QML reviewer who re-runs an extraction
          // has to get the record they signed off on.
          temperature: 0,
          // Asking the API for JSON makes the shape the API's job, rather than
          // scraping the first {...} out of whatever prose came back.
          responseMimeType: "application/json",
          ...(budget === null ? {} : { thinkingConfig: { thinkingBudget: budget } })
        }
      });

      const usage = response.usageMetadata;
      return {
        text: response.text ?? "",
        usage: usage
          ? {
              inputTokens: usage.promptTokenCount ?? 0,
              // Reasoning is billed as output and reported separately from the
              // candidate count. Folded in here, as the AI Studio path does.
              outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0)
            }
          : undefined
      };
    });
  }
}
