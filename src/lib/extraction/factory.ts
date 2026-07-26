import type { DeploymentMode } from "../retrieval/deployment";
import type { ExtractionModel } from "./contracts";

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
export async function makeExtractionModel(mode: DeploymentMode): Promise<ExtractionModel | null> {
  if (mode === "commercial") {
    // Cloud model. Only ever loaded on the commercial path.
    if (process.env.GOOGLE_GEMINI_API_KEY) {
      const { GeminiExtractionModel } = await import("./models/gemini");
      const model = new GeminiExtractionModel();
      if (model.isConfigured()) return model;
    }
    // A commercial deploy may still prefer a self-hosted model.
    if (process.env.FORGE_LOCAL_MODEL_URL) {
      const { LocalExtractionModel } = await import("./models/local");
      const model = new LocalExtractionModel();
      if (model.isConfigured()) return model;
    }
    return null;
  }

  // Air-gapped: only a locally hosted open-weight model is permitted, and its
  // endpoint must resolve to a private address. Controlled datasheets cannot
  // leave the customer network, so a public endpoint here is a misconfiguration
  // that the model itself refuses (see models/local.ts).
  if (process.env.FORGE_LOCAL_MODEL_URL) {
    const { LocalExtractionModel } = await import("./models/local");
    const model = new LocalExtractionModel();
    if (model.isConfigured()) return model;
  }

  return null;
}
