// Tries a list of resolvers in priority order and returns the first datasheet found.
//
// NETWORK MODULE (its children reach the network). Only ever loaded through the commercial
// branch of makeResolver. Never imported in air-gapped mode.
//
// Semantics, chosen to keep three outcomes distinct:
//   - not ready   : isConfigured() is false. Skipped silently. Example: a resolver with no creds.
//   - not found   : resolve() returns null. Try the next resolver.
//   - failure     : resolve() throws. Remember it, try the next resolver anyway.
//
// After the loop:
//   - a datasheet was found            -> return it.
//   - every ready resolver returned null -> return null (clean "not found"; caller falls
//                                           back to the upload path).
//   - at least one resolver threw and none found anything -> throw an aggregate error, so a
//     genuinely broken resolver (bad credentials, transport failure) surfaces instead of
//     being silently swallowed as "not found".

import type { DatasheetRef, DatasheetResolver, ResolveOptions } from "../resolver";
import { isHardFailure } from "./errors";
import { logger } from "../logging";

// Wall-clock ceiling for the whole chain. This matters more than it looks: our target parts are
// rad-hard, and rad-hard MISSES in every resolver, so the full-chain walk is the COMMON path, not
// the exceptional one. Without a ceiling, a VORAGO lookup pays every resolver's timeouts in series
// before the user is finally told to upload. Better to give up early and show the upload prompt
// than to be slow and then say no. The budget is checked between resolvers rather than enforced
// mid-flight, so a single resolver can still overshoot by its own timeout; per-call AbortControllers
// in http.ts bound that.
// 12s, not 25s, and configurable. This has to sit UNDER the host's function timeout or the platform
// kills the request first and the user gets a 504 instead of our clean DATASHEET_NOT_FOUND, which
// throws away the graceful degradation the whole chain is built around. Many serverless defaults are
// 10 to 15 seconds, so the default is chosen to fit inside the smaller of those with headroom for
// the response. Raise it with FORGE_CHAIN_BUDGET_MS on a host that allows longer requests.
const DEFAULT_BUDGET_FALLBACK_MS = 12_000;

export function resolveChainBudgetMs(): number {
  const raw = Number(process.env.FORGE_CHAIN_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUDGET_FALLBACK_MS;
}

export class CompositeResolver implements DatasheetResolver {
  readonly name: string;
  private readonly budgetMs: number;

  constructor(
    private readonly resolvers: DatasheetResolver[],
    options?: { budgetMs?: number }
  ) {
    if (resolvers.length === 0) {
      throw new Error("CompositeResolver requires at least one resolver");
    }
    this.budgetMs = options?.budgetMs ?? resolveChainBudgetMs();
    this.name = `composite(${resolvers.map((r) => r.name).join(",")})`;
  }

  // Configured if any child is. If none are configured there is nothing useful to try.
  isConfigured(): boolean {
    return this.resolvers.some((r) => r.isConfigured());
  }

  async resolve(partNumber: string, opts?: ResolveOptions): Promise<DatasheetRef | null> {
    const hardFailures: { resolver: string; error: unknown }[] = [];
    const startedAt = Date.now();
    let budgetExhausted = false;

    for (const resolver of this.resolvers) {
      if (!resolver.isConfigured()) continue;

      // Stop starting new work once the budget is spent. Anything already tried still counts.
      if (Date.now() - startedAt >= this.budgetMs) {
        budgetExhausted = true;
        break;
      }

      const attemptedAt = Date.now();
      try {
        const ref = await resolver.resolve(partNumber, opts);
        // Stamp the winning child so the audit trail records who actually resolved it, not just
        // which chain was configured. A nested composite that already stamped keeps its inner name.
        if (ref) {
          // Resolver win rates and latency are otherwise invisible in production.
          logger.info({
            event: "resolver_hit",
            resolver: ref.resolvedBy ?? resolver.name,
            partNumber,
            byteLength: ref.byteLength,
            durationMs: Date.now() - attemptedAt
          });
          return { ...ref, resolvedBy: ref.resolvedBy ?? resolver.name };
        }
        logger.debug({
          event: "resolver_miss",
          resolver: resolver.name,
          partNumber,
          durationMs: Date.now() - attemptedAt
        });
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
    // A budget cutout with no hard failure deliberately returns null, not an error: from the user's
    // side "we could not find it, upload instead" is the correct and actionable outcome, and a
    // timeout is not something they can fix.
    if (hardFailures.length > 0) {
      const detail = hardFailures
        .map((f) => `${f.resolver}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
        .join("; ");
      const budgetNote = budgetExhausted
        ? ` (chain budget of ${this.budgetMs}ms was exhausted, so later resolvers were skipped)`
        : "";
      throw new Error(`All datasheet resolvers failed for ${partNumber}. ${detail}${budgetNote}`);
    }

    // The honest not-found. Logged so the miss RATE is measurable: a rising one
    // is the signal that search is being blocked rather than that these parts
    // genuinely have no datasheet.
    logger.info({
      event: "resolver_chain_miss",
      chain: this.name,
      partNumber,
      budgetExhausted,
      durationMs: Date.now() - startedAt
    });
    return null;
  }
}
