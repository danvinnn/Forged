/**
 * WHAT THE PRODUCT HAS SPENT, and a ceiling on it.
 *
 * ## Why this exists
 *
 * Until 2026-08-30 both of these lived only in `src/lib/__bench__/modelcache.ts`.
 * The benches had a cumulative ceiling, a ledger and a cost report; the ROUTES
 * had none of the three. Every parse a real user made called a billed model with
 * no cap, recorded nothing, and left the bill to be discovered on Google's
 * console. The bench's own header explains why a per-run cap is the wrong scope:
 * $4.04 was spent across nineteen runs whose largest was $1.02, so a $2 per-run
 * ceiling would never once have fired. The damage is the sum of many
 * individually reasonable runs, and the same is true of many individually
 * reasonable parses.
 *
 * ## The three rules this file obeys
 *
 * A LOCAL MODEL IS FREE AND IS NEVER COUNTED OR BLOCKED. An air-gapped
 * deployment runs its own weights on its own hardware; charging it against a
 * cloud price list would report a bill nobody was sent, and stopping it at a
 * ceiling would take the product away from the customer it was built for.
 *
 * FREE IS THE EXCEPTION, NOT THE RULE. `wasPaidFor` in the bench cache asked
 * `startsWith("gemini")` until the Vertex path arrived not matching it, reported
 * `$0.00, this model is local`, wrote nothing, and ran with NO CEILING AT ALL.
 * That has been the shape of three separate billing defects. So the test names
 * the free case: a model that runs on this machine is free, and anything else is
 * assumed to bill until someone says otherwise. A genuinely free new provider is
 * then over-reported, which is visible and annoying; the other direction is
 * invisible.
 *
 * A LEDGER THAT CANNOT BE WRITTEN MUST NOT FAIL A PARSE. The user's library is
 * worth more than our bookkeeping. Every filesystem operation here is wrapped,
 * and a failure degrades to counting in memory for the life of the process.
 *
 * ## What it is not
 *
 * Not a billing system. The prices are Google's published Flash rates and are
 * wrong the moment Google changes them, so this is an ESTIMATE whose job is to
 * intervene at roughly the right magnitude, not to reconcile an invoice.
 *
 * Air-gap safe: no network, no external imports, and nothing here is loaded into
 * a decision an air-gapped deployment depends on.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Published Gemini Flash pricing, per million tokens. Estimate only.
 *
 * Deliberately the same two constants the bench uses, so a figure from one is
 * comparable with a figure from the other. Vertex calls the same model id and is
 * assumed to bill the same, which is an assumption rather than a checked fact.
 */
const USD_PER_M_INPUT = 0.3;
const USD_PER_M_OUTPUT = 2.5;

/**
 * The most this deployment may spend in total, in USD.
 *
 * CUMULATIVE, not per parse, for the reason in the header. Default 25: high
 * enough that ordinary evaluation never meets it, low enough that a runaway loop
 * or a wide-open endpoint stops at a number somebody would rather decide about
 * than discover.
 *
 * Set `FORGE_SPEND_LIMIT_USD=0` to disable.
 */
export function spendLimitUsd(): number {
  const raw = Number(process.env.FORGE_SPEND_LIMIT_USD);
  return Number.isFinite(raw) && raw >= 0 ? raw : 25;
}

/** Where the running total is kept. */
function ledgerPath(): string {
  return process.env.FORGE_SPEND_LEDGER || join(process.cwd(), ".forge", "spend.json");
}

/**
 * Thrown when a deployment has reached its ceiling.
 *
 * A distinct type because the ACTION is distinct: the money is still there and
 * the provider is fine, so the answer is a person deciding the spend is worth
 * continuing, not adding credit or retrying.
 */
export class SpendLimitReached extends Error {
  constructor(
    readonly spentUsd: number,
    readonly limitUsd: number
  ) {
    super(
      `This deployment has now spent about $${spentUsd.toFixed(2)} on reading datasheets, which is over its ` +
        `$${limitUsd.toFixed(2)} limit, so nothing was sent to the reader. That is the running total across ` +
        `every parse, not this one. Raise it with FORGE_SPEND_LIMIT_USD, or set it to 0 to remove the limit.`
    );
    this.name = "SpendLimitReached";
  }
}

export interface Ledger {
  /** Estimated USD across every billed call this deployment has made. */
  usd: number;
  /** Billed calls, counting retries, because every attempt is charged. */
  calls: number;
  /** ISO date of the first and most recent billed call. */
  since: string | null;
  updated: string | null;
}

const EMPTY: Ledger = { usd: 0, calls: 0, since: null, updated: null };

/**
 * The in-process copy, which is also the fallback when the file cannot be
 * written. Never the source of truth where a file exists, because two server
 * processes would then each keep their own half of the total.
 */
let memory: Ledger | null = null;

export function readSpend(): Ledger {
  try {
    const path = ledgerPath();
    if (!existsSync(path)) return memory ?? EMPTY;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Ledger>;
    return {
      usd: Number.isFinite(raw.usd) ? Number(raw.usd) : 0,
      calls: Number.isFinite(raw.calls) ? Number(raw.calls) : 0,
      since: typeof raw.since === "string" ? raw.since : null,
      updated: typeof raw.updated === "string" ? raw.updated : null
    };
  } catch {
    return memory ?? EMPTY;
  }
}

/**
 * Is this model one that bills?
 *
 * Named as the FREE case on purpose; see the header. `local:` is the prefix both
 * local models put on their own `name`.
 */
export function bills(modelName: string): boolean {
  // Both local models, and only those two. `local.ts` names itself
  // `local:<model>` and `local-focused.ts` names itself `local-focused:<model>`,
  // so the prefix is matched rather than the whole string: the model id after
  // the colon is whatever the operator pulled into Ollama.
  return !/^local(-focused)?:/.test(modelName);
}

export function estimateUsd(usage: { inputTokens: number; outputTokens: number } | undefined): number {
  if (!usage) return 0;
  return (usage.inputTokens / 1e6) * USD_PER_M_INPUT + (usage.outputTokens / 1e6) * USD_PER_M_OUTPUT;
}

/**
 * Refuse to call a billed model when the running total is already over.
 *
 * Checked BEFORE the call rather than after, because a ceiling enforced
 * afterwards has already spent the money it exists to prevent.
 */
export function assertUnderLimit(modelName: string): void {
  if (!bills(modelName)) return;
  const limit = spendLimitUsd();
  if (limit === 0) return;
  const spent = readSpend().usd;
  if (spent >= limit) throw new SpendLimitReached(spent, limit);
}

/**
 * Add one call to the total.
 *
 * `attempts` counts retries, because every attempt is billed whether or not it
 * returned anything. Under-reporting spend by counting only the successful
 * attempt is a defect this project has already made once.
 */
export function recordSpend(
  modelName: string,
  usage: { inputTokens: number; outputTokens: number } | undefined,
  attempts = 1
): void {
  if (!bills(modelName)) return;
  const now = new Date().toISOString();
  const before = readSpend();
  const next: Ledger = {
    // A call with no usage reported still HAPPENED and still cost something. The
    // count moves even where the estimate cannot, so a provider that stops
    // reporting tokens cannot silently zero the total.
    usd: before.usd + estimateUsd(usage),
    calls: before.calls + Math.max(1, attempts),
    since: before.since ?? now,
    updated: now
  };
  memory = next;
  try {
    const path = ledgerPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next, null, 2));
  } catch {
    // Bookkeeping must never cost the user their library. The in-memory copy
    // above still holds the total for the life of this process.
  }
}
