// Typed resolver failures. The kind decides whether the composite surfaces the error to the
// operator or swallows it and lets the user fall back to upload.
//
// NETWORK MODULE by association (it lives with the resolvers), though it makes no network call.
//
//   auth         : bad or missing credentials. HARD. The operator must fix config; do not hide it.
//   bad_response : the service answered but the shape was wrong (GraphQL errors, unparseable).
//                  HARD. Something is broken; surface it.
//   rate_limit   : throttled (429). SOFT. Transient; let the user upload instead of blocking them.
//   transport    : network/DNS/timeout failure. SOFT. Transient; same reasoning.

export type ResolverErrorKind = "auth" | "bad_response" | "rate_limit" | "transport";

export class ResolverError extends Error {
  constructor(
    readonly kind: ResolverErrorKind,
    readonly resolverName: string,
    message: string
  ) {
    super(message);
    this.name = "ResolverError";
  }

  // Hard errors surface to the operator when nothing was found. Soft errors degrade to "not
  // found" so the upload path stays open.
  get hard(): boolean {
    return this.kind === "auth" || this.kind === "bad_response";
  }
}

// An unknown throw (not a ResolverError) is treated as hard: unexpected failures should surface,
// not be silently swallowed as "not found".
export function isHardFailure(error: unknown): boolean {
  return error instanceof ResolverError ? error.hard : true;
}
