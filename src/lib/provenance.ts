import type { Extracted } from "./types";

/**
 * Traceability rules, in one dependency-free module.
 *
 * Deliberately separate from `types.ts`: the client imports this as a VALUE, and
 * `types.ts` pulls in zod. Keeping these functions here means the browser bundle
 * does not gain a schema library just to render a warning label.
 *
 * The reason this is shared rather than reimplemented per caller: the UI must
 * flag exactly what the export boundary refuses. Two copies of the rule drift,
 * and then the app shows a record as fine and then rejects it, or worse accepts
 * one it displayed as unverified.
 */

/**
 * A value is traceable when a human can find it in the source document. Anything
 * a model produced without a verified citation is not: nobody can check it, and
 * IPC Class 3 / QML sign-off is exactly the process of checking.
 */
export function isUntraceable(field: Extracted<unknown>): boolean {
  return field.value !== null && field.method === "vlm" && field.citation === null;
}
