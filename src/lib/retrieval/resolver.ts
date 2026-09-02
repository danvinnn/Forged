// The swappable seam for Layer 1 (Retrieval). A resolver turns a part number into
// a downloaded datasheet PDF. That is the whole job. Parsing the PDF is Layer 2 and
// lives behind parseDatasheetPdf in ../datasheet.ts; a resolver never parses.
//
// Air-gap safety: this file is types only. It makes no network calls and imports
// nothing that does, so it is safe to load in an air-gapped deployment. The concrete
// resolvers that DO reach the network live under ./resolvers and are only ever loaded
// through the commercial branch of makeResolver (see ./factory.ts).

// A resolved (or uploaded) datasheet, already downloaded into memory. This is the
// single hand-off type into the parser: both the commercial resolvers and the
// enterprise upload path produce one of these.
export interface DatasheetRef {
  fileName: string;
  // Present for network-resolved datasheets. Absent for uploads, which have no URL.
  // (Deviation from ARCHITECTURE.md, which types this as required. Made optional so
  // one DatasheetRef type covers both the resolver output and the upload path.)
  pdfUrl?: string;
  sourcePageUrl?: string;
  bytes: ArrayBuffer; // the downloaded PDF, ready to hand to the parser
  byteLength: number;
  sha256: string; // hash of bytes; the audit anchor identifying this exact PDF

  // Which concrete resolver actually produced this ref. Set by CompositeResolver to the winning
  // CHILD's name, because the composite's own name lists every resolver it tried and so answers
  // "who could have" rather than "who did". The audit trail needs the latter: "resolved via
  // manufacturer from ti.com" and "resolved via scrape" are different provenance claims, and
  // traceability is a hard requirement, not a debugging nicety. Absent for uploads.
  resolvedBy?: string;
}

export interface ResolveOptions {
  manufacturer?: string;
  /**
   * Wall-clock instant (Date.now() milliseconds) after which a resolver should stop starting new
   * work and report what it has.
   *
   * Added 2026-09-02. The chain budget used to be enforced only BETWEEN resolvers, on the reasoning
   * that a single resolver could overshoot by at most its own per-call timeout. That stopped being
   * true as the scrape resolver grew: it now walks direct candidates, then several queries across
   * several search backends, then up to twelve ranked results each of which can be a page fetch plus
   * further downloads. Measured on a clean run, a MISS took a median of 12.8s and hit the 30s
   * ceiling, against a 12s budget.
   *
   * That is not just slow. The budget exists to sit UNDER the host's function timeout so a miss
   * produces our own "upload instead" answer rather than a platform 504, and a 30s miss on a 10 to
   * 15 second serverless function produces exactly the 504 the design is trying to avoid.
   *
   * Optional, and advisory: a resolver that ignores it still behaves correctly, just slowly.
   */
  deadlineAt?: number;
}

// Turns a part number into a downloaded datasheet PDF. A resolver is the ONLY kind of
// component permitted to reach the network in the retrieval layer, which is exactly why
// none are constructed in air-gapped mode.
export interface DatasheetResolver {
  readonly name: string;

  // A resolver may be present in the wiring but not usable right now, for example the
  // a credentialed resolver whose keys are not set. The composite skips resolvers that
  // report themselves not ready, rather than treating a missing credential as a hard
  // failure. Resolvers with no configuration to check simply return true.
  isConfigured(): boolean;

  // Returns null when this resolver found no datasheet, so the caller can fall through
  // to the next resolver and ultimately to the upload path. Throws only on a real auth
  // or transport failure, which is a different signal from "not found".
  resolve(partNumber: string, opts?: ResolveOptions): Promise<DatasheetRef | null>;
}
