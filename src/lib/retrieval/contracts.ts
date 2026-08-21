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
  resolver?: string; // set when origin is "resolver"; the concrete winner, e.g. "manufacturer"
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
  | "RATE_LIMITED"
  // The PDF is structurally valid but too large or too complex to parse within
  // the resource limits (page count, extracted text size, object count, time).
  | "PARSE_LIMIT_EXCEEDED"
  // Retrieval found something that is not a component datasheet: a distributor
  // page, a breakout-board writeup, a product brief. Distinct from every reading
  // failure because the ACTION is distinct - re-running finds the same page, and
  // the user uploading the datasheet is what fixes it. See `looksLikeWrongDocument`.
  | "NOT_A_DATASHEET"
  // The pass that reads the package DRAWINGS could not be run, after a retry.
  // Distinct from every other code here because it is the one the user should
  // simply try again: the document is fine and the reader was briefly not.
  // See `SecondPassFailedError` for why this is an error rather than a thinner
  // record with a warning on it.
  | "MODEL_UNAVAILABLE"
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
    // Prefer the concrete resolver that produced the ref over the chain name passed by the caller.
    // The caller only knows it holds a composite; the ref knows which child actually won.
    resolver: ref.resolvedBy ?? resolver,
    fileName: ref.fileName,
    pdfUrl: ref.pdfUrl,
    sourcePageUrl: ref.sourcePageUrl,
    byteLength: ref.byteLength,
    sha256: ref.sha256
  };
}
