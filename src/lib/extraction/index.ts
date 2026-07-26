/**
 * Public surface of the Layer 2 extraction layer.
 *
 * Deliberately does NOT re-export `./models`, so importing this module can
 * never pull a networked model into the air-gapped module graph. Reach models
 * through `makeExtractionModel` only.
 */
export {
  extractionFields,
  ExtractionModelError,
  type ExtractionField,
  type ExtractionModel,
  type ExtractionRequest,
  type ExtractionResult,
  type ModelValue
} from "./contracts";

export { makeExtractionModel } from "./factory";
export { mergeModelValues, unresolvedFields, verifyCitation, type MergeOutcome } from "./merge";
export { buildExtractionRequest } from "./request";
