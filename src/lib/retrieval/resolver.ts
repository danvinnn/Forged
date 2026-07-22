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
}

export interface ResolveOptions {
  manufacturer?: string;
}

// Turns a part number into a downloaded datasheet PDF. A resolver is the ONLY kind of
// component permitted to reach the network in the retrieval layer, which is exactly why
// none are constructed in air-gapped mode.
export interface DatasheetResolver {
  readonly name: string;

  // A resolver may be present in the wiring but not usable right now, for example the
  // Nexar resolver when its credentials are not set. The composite skips resolvers that
  // report themselves not ready, rather than treating a missing credential as a hard
  // failure. Resolvers with no configuration to check simply return true.
  isConfigured(): boolean;

  // Returns null when this resolver found no datasheet, so the caller can fall through
  // to the next resolver and ultimately to the upload path. Throws only on a real auth
  // or transport failure, which is a different signal from "not found".
  resolve(partNumber: string, opts?: ResolveOptions): Promise<DatasheetRef | null>;
}
