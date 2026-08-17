/**
 * Time budget for the model pass, carved out of the calling route's own.
 *
 * ## Why this exists
 *
 * Measured on the benchmark corpus: a model call takes up to 41.6 seconds. The
 * parse route's `maxDuration` is 30. The model's own internal ceiling is 60, so
 * it can never be the thing that stops first — the PLATFORM stops, and it does so
 * by killing the function. That turns a deterministic record which had already
 * been extracted successfully into a 504, and the user gets nothing at all for a
 * request that had mostly worked.
 *
 * The route has to own this deadline rather than the model, because only the
 * route knows how much of its budget retrieval and parsing already spent. An
 * expired model pass is then a NOTE on the record rather than an error, which is
 * the same posture the rest of Layer 2 takes: the deterministic pass always runs
 * first and always wins, so there is always something to return.
 *
 * This module is reachable in air-gapped mode and contains no networking.
 */

/**
 * Held back for the work after the model returns, which is `buildReadout`: the
 * drawing lookup, the printed-footprint lookup, one footprint build per offered
 * package, the confidence checks, and rasterising the pages the panel shows. All
 * local, none of it free, and the deadline that matters is the platform's rather
 * than ours.
 *
 * This named the land-pattern cross-check first. That ran here until the printed
 * pattern became the pads directly and there was no computed substitute left to
 * compare against it; the margin is still needed, for the work listed above.
 */
export const RESPONSE_MARGIN_MS = 3_000;

/**
 * Below this there is no point asking. A call that cannot plausibly finish is a
 * guaranteed wasted request, and on a metered API that is real money for a
 * result that will be thrown away.
 */
export const MIN_MODEL_BUDGET_MS = 5_000;

/**
 * What is left for the model, given the route's whole budget and what has been
 * spent so far. May be negative, which the caller reads as "do not ask".
 *
 * `FORGE_MODEL_BUDGET_MS` caps it further, for an operator who wants model calls
 * to give up sooner than the route would make them.
 */
export function modelBudgetMs(routeBudgetMs: number, elapsedMs: number): number {
  const configured = Number(process.env.FORGE_MODEL_BUDGET_MS);
  const ceiling = Number.isFinite(configured) && configured > 0 ? configured : Infinity;
  return Math.min(ceiling, routeBudgetMs - RESPONSE_MARGIN_MS - elapsedMs);
}

/** Whether there is enough of the budget left to be worth a call. */
export function worthAsking(budgetMs: number): boolean {
  return budgetMs >= MIN_MODEL_BUDGET_MS;
}

/**
 * A model pass abandoned on the route's deadline rather than failed.
 *
 * Distinct from a transport failure because the two call for different actions:
 * a failure is worth retrying, a deadline means this document is too big for
 * this route's budget and retrying will do the same thing again.
 */
export class ModelDeadlineError extends Error {
  constructor(readonly budgetMs: number) {
    super(`The extraction model did not answer within ${Math.round(budgetMs)}ms.`);
    this.name = "ModelDeadlineError";
  }
}

/**
 * Races work against the deadline.
 *
 * The loser's rejection is swallowed deliberately. `Promise.race` leaves it
 * unobserved, and in Node an unobserved rejection arriving after the response has
 * been sent takes the process down — which would turn one slow model call into an
 * outage rather than a note on a record.
 */
export function withDeadline<T>(work: Promise<T>, budgetMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ModelDeadlineError(budgetMs)), budgetMs);
  });
  work.catch(() => {});
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}
