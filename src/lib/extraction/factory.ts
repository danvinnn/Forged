import type { DeploymentMode } from "../retrieval/deployment";
import type { ExtractionModel, ExtractionRequest, ExtractionResult } from "./contracts";
import { assertUnderLimit, recordSpend } from "../spend";

/**
 * Chooses the extraction model for a deployment mode.
 *
 * Air-gap safe: this module must contain no networking code, no external URLs,
 * and no STATIC import of `./models`. Concrete models are reached only through
 * a dynamic import inside the branch that is allowed to use them, so in
 * air-gapped mode the cloud model is never loaded into the process. This is the
 * same structural guarantee `retrieval/factory.ts` provides for resolvers, and
 * it is enforced by the air-gap guard test.
 */
/**
 * The model, with what it costs counted and capped.
 *
 * ## Why the wrapper is here and not in each model
 *
 * Every model would have to remember to do it, and the one that forgot would be
 * the one that billed. This is the single door both routes go through, so a
 * provider added later is metered whether or not its author thought about it -
 * which is the failure that produced the Vertex billing hole, where a new
 * provider slipped past a check written as a list of the providers that bill.
 *
 * The ceiling is asserted BEFORE the call. A limit enforced afterwards has
 * already spent the money it exists to prevent.
 *
 * A local model is neither counted nor capped; see `spend.ts` for why that
 * direction is not negotiable.
 */
function metered(model: ExtractionModel): ExtractionModel {
  return {
    name: model.name,
    isConfigured: () => model.isConfigured(),
    async extract(request: ExtractionRequest): Promise<ExtractionResult> {
      assertUnderLimit(model.name);
      // RECORDED WHETHER OR NOT IT SUCCEEDS. A call that threw was still made and
      // still billed, and a ceiling that only counts successes can be walked
      // straight through by a provider that is failing.
      try {
        const result = await model.extract(request);
        recordSpend(model.name, result.usage, result.attempts);
        return result;
      } catch (error) {
        recordSpend(model.name, undefined, (error as { attempts?: number }).attempts ?? 1);
        throw error;
      }
    }
  };
}

export async function makeExtractionModel(mode: DeploymentMode): Promise<ExtractionModel | null> {
  if (mode === "commercial") {
    // VERTEX FIRST, where it is configured.
    //
    // Not a quality judgement: it is the same models through a different door.
    // It leads because configuring it is deliberate. `GOOGLE_APPLICATION_CREDENTIALS`
    // plus a project ID is something a person set up on purpose, whereas an API
    // key often lingers in an env file after the balance behind it is spent, and
    // silently preferring the dead one is a confusing failure.
    //
    // Both are dynamic imports on this branch only, which is what keeps them out
    // of an air-gapped process. Enforced by the air-gap guard test, not by care.
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS && process.env.FORGE_VERTEX_PROJECT) {
      const { VertexExtractionModel } = await import("./models/vertex");
      const model = new VertexExtractionModel();
      if (model.isConfigured()) return metered(model);
    }

    // Cloud model. Only ever loaded on the commercial path.
    if (process.env.GOOGLE_GEMINI_API_KEY) {
      const { GeminiExtractionModel } = await import("./models/gemini");
      const model = new GeminiExtractionModel();
      if (model.isConfigured()) return metered(model);
    }
    // A commercial deploy may still prefer a self-hosted model.
    const local = await makeLocalModel();
    if (local) return metered(local);
    return null;
  }

  // Air-gapped: only a locally hosted open-weight model is permitted, and its
  // endpoint must resolve to a private address. Controlled datasheets cannot
  // leave the customer network, so a public endpoint here is a misconfiguration
  // that the model itself refuses (see models/local.ts).
  const local = await makeLocalModel();
  return local ? metered(local) : null;
}

/**
 * The local model, in whichever shape the environment asked for.
 *
 * One function rather than the same block written twice, because it WAS written
 * twice and the two copies drifted: the focused variant was wired into the
 * commercial branch only, so an air-gapped run silently used the wide-question
 * model and the split looked like it had failed.
 */
async function makeLocalModel(): Promise<ExtractionModel | null> {
  if (!process.env.FORGE_LOCAL_MODEL_URL) return null;

  // Opt-in only. A small local model answers a NARROW question far better than a
  // wide one (measured on qwen2.5vl:7b: nothing at all for the whole prompt over
  // the whole document, 8/8 pin names for the pin table over one page), but it
  // costs one call per group, so it is never the default and never the cloud
  // model's problem. Nothing downstream can tell the two apart.
  if (process.env.FORGE_LOCAL_FOCUSED) {
    const { FocusedLocalExtractionModel } = await import("./models/local-focused");
    const focused = new FocusedLocalExtractionModel();
    if (focused.isConfigured()) return focused;
  }

  const { LocalExtractionModel } = await import("./models/local");
  const model = new LocalExtractionModel();
  return model.isConfigured() ? model : null;
}
