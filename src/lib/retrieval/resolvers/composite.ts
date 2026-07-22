// Tries a list of resolvers in priority order and returns the first datasheet found.
//
// NETWORK MODULE (its children reach the network). Only ever loaded through the commercial
// branch of makeResolver. Never imported in air-gapped mode.
//
// Semantics, chosen to keep three outcomes distinct:
//   - not ready   : isConfigured() is false. Skipped silently. Example: Nexar with no creds.
//   - not found   : resolve() returns null. Try the next resolver.
//   - failure     : resolve() throws. Remember it, try the next resolver anyway.
//
// After the loop:
//   - a datasheet was found            -> return it.
//   - every ready resolver returned null -> return null (clean "not found"; caller falls
//                                           back to the upload path).
//   - at least one resolver threw and none found anything -> throw an aggregate error, so a
//     genuinely broken resolver (bad Nexar creds, transport failure) surfaces instead of
//     being silently swallowed as "not found".

import type { DatasheetRef, DatasheetResolver, ResolveOptions } from "../resolver";
import { isHardFailure } from "./errors";

export class CompositeResolver implements DatasheetResolver {
  readonly name: string;

  constructor(private readonly resolvers: DatasheetResolver[]) {
    if (resolvers.length === 0) {
      throw new Error("CompositeResolver requires at least one resolver");
    }
    this.name = `composite(${resolvers.map((r) => r.name).join(",")})`;
  }

  // Configured if any child is. If none are configured there is nothing useful to try.
  isConfigured(): boolean {
    return this.resolvers.some((r) => r.isConfigured());
  }

  async resolve(partNumber: string, opts?: ResolveOptions): Promise<DatasheetRef | null> {
    const hardFailures: { resolver: string; error: unknown }[] = [];

    for (const resolver of this.resolvers) {
      if (!resolver.isConfigured()) continue;

      try {
        const ref = await resolver.resolve(partNumber, opts);
        if (ref) return ref;
      } catch (error) {
        // Soft failures (rate limit, transport, timeout) are remembered but do not block the
        // fallback chain or the eventual upload path. Only hard failures (auth, bad response, or
        // an unexpected throw) are worth surfacing to the operator.
        if (isHardFailure(error)) {
          hardFailures.push({ resolver: resolver.name, error });
        }
      }
    }

    // Nothing found. If a hard failure happened, surface it so a real misconfig is not hidden
    // behind a generic "not found". Otherwise return null and let the caller offer upload.
    if (hardFailures.length > 0) {
      const detail = hardFailures
        .map((f) => `${f.resolver}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
        .join("; ");
      throw new Error(`All datasheet resolvers failed for ${partNumber}. ${detail}`);
    }

    return null;
  }
}
