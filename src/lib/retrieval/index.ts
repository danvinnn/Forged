// Public surface of the retrieval layer.
//
// This re-exports only the air-gap-safe pieces: the deployment gate, the resolver types,
// the upload path, and the factory. It deliberately does NOT re-export anything under
// ./resolvers. Those are network modules and must only ever be reached through the dynamic
// import in makeResolver's commercial branch. Keeping them out of the public surface means a
// stray `import { ManufacturerResolver } from "../retrieval"` cannot pull networking code into an
// air-gapped code path.

export { getDeploymentMode, isAirGapped, DEPLOYMENT_MODE_ENV } from "./deployment";
export type { DeploymentMode } from "./deployment";

export type { DatasheetRef, DatasheetResolver, ResolveOptions } from "./resolver";

export { ingestUpload, UploadValidationError } from "./upload";
export { MAX_PDF_BYTES, MIN_PDF_BYTES, PdfValidationError } from "./pdf";
export { sanitizeFileName } from "./filename";
export type { UploadInput } from "./upload";

export { makeResolver } from "./factory";

export { RateLimiter, InMemoryRateLimitStore, clientKey, lookupLimiter, uploadLimiter, activeLookupLimiter, activeUploadLimiter, __setLimiterOverrides } from "./ratelimit";
export type { RateLimitResult, RateLimitStore, RateLimiterOptions } from "./ratelimit";

export { toRetrievalSource } from "./contracts";
export type {
  RetrievalSource,
  RetrievalSuccess,
  RetrievalError,
  RetrievalErrorCode
} from "./contracts";
