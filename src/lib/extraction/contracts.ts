import type { PinRecord } from "../types";

/**
 * Layer 2 extraction model contract.
 *
 * This module is reachable in air-gapped mode and must contain no networking
 * code and no external URLs. Concrete models live under `models/` and are
 * reached only through a dynamic import in `factory.ts`, the same structural
 * gate the resolver factory uses.
 */

/** Fields a model may be asked to resolve. Dotted paths address nested values. */
export const extractionFields = [
  "partNumber",
  "manufacturer",
  "packageType",
  "pinCount",
  "pins",
  "dimensions.bodyLengthMm",
  "dimensions.bodyWidthMm",
  "dimensions.bodyHeightMm",
  "dimensions.pitchMm",
  "dimensions.leadLengthMm",
  "dimensions.leadCount",
  "radiation.tid",
  "radiation.see",
  "radiation.sel",
  "radiation.qmlClass"
] as const;

export type ExtractionField = (typeof extractionFields)[number];

/**
 * One value the model claims to have read, with the page it claims to have read
 * it from. The page is a CLAIM, not a citation: it is verified against the
 * document before it becomes one, because an unverifiable citation is worse
 * than no citation for a QML audit trail.
 */
export interface ModelValue {
  value: string | number | PinRecord[] | null;
  /** 1-indexed page the model says the value appears on, if it reported one. */
  page: number | null;
}

export interface ExtractionRequest {
  /** Page-scoped text. Models are given pages, not one flattened blob, so they can cite. */
  pages: Array<{ page: number; text: string }>;
  fileName: string;
  /** Requested part number, when the caller knows it. */
  partNumber?: string;
  /**
   * Only the fields the deterministic pass could not resolve. A model is never
   * asked about, and can never overwrite, a value that was read off the page by
   * code.
   */
  fields: ExtractionField[];
}

export interface ExtractionResult {
  /** Values the model produced, keyed by field. Absent means "no answer". */
  values: Partial<Record<ExtractionField, ModelValue>>;
  /** Free-form observations to surface as record notes. */
  notes?: string[];
}

export interface ExtractionModel {
  /** Identifies the model in provenance and logs, e.g. "gemini" or "local:qwen3-vl". */
  readonly name: string;
  /** Whether this model has everything it needs to run (key, endpoint, etc.). */
  isConfigured(): boolean;
  extract(request: ExtractionRequest): Promise<ExtractionResult>;
}

/** Thrown when a model is misconfigured or its response cannot be used. */
export class ExtractionModelError extends Error {
  readonly kind: "config" | "transport" | "bad_response";

  constructor(kind: "config" | "transport" | "bad_response", message: string) {
    super(message);
    this.name = "ExtractionModelError";
    this.kind = kind;
  }
}
