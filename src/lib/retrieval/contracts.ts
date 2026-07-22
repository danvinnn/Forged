// The shapes the API routes speak, shared so the UI and Layer 2 build on one contract. Kept
// separate from the internal DatasheetRef because the wire shape deliberately omits the raw bytes
// and exposes only provenance.
//
// Air-gap safety: types and a pure mapper, no network.

import type { PartRecord } from "../types";
import type { DeploymentMode } from "./deployment";
import type { DatasheetRef } from "./resolver";

// Provenance for a retrieved datasheet, minus the bytes. This is what the UI shows and what the
// audit trail records.
export interface RetrievalSource {
  origin: "resolver" | "upload";
  resolver?: string; // set when origin is "resolver", e.g. "composite(nexar,scrape)"
  fileName: string;
  pdfUrl?: string;
  sourcePageUrl?: string;
  byteLength: number;
  sha256: string;
}

export interface RetrievalSuccess {
  part: PartRecord;
  source: RetrievalSource;
  mode: DeploymentMode;
}

// Stable codes so the UI can branch on the reason, not the message string. DATASHEET_NOT_FOUND is
// the signal to prompt the user to upload instead.
export type RetrievalErrorCode =
  | "PART_NUMBER_REQUIRED"
  | "AIRGAP_LOOKUP_DISABLED"
  | "DATASHEET_NOT_FOUND"
  | "RESOLVER_FAILED"
  | "UPLOAD_INVALID"
  | "INTERNAL";

export interface RetrievalError {
  error: string;
  code: RetrievalErrorCode;
  mode: DeploymentMode;
}

// Maps an internal ref to its wire-facing provenance.
export function toRetrievalSource(
  ref: DatasheetRef,
  origin: RetrievalSource["origin"],
  resolver?: string
): RetrievalSource {
  return {
    origin,
    resolver,
    fileName: ref.fileName,
    pdfUrl: ref.pdfUrl,
    sourcePageUrl: ref.sourcePageUrl,
    byteLength: ref.byteLength,
    sha256: ref.sha256
  };
}
