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
 *
 * BOTH model methods, not just `vlm`. `vlm-drawing` was omitted, and today that
 * omission is harmless by construction: `citeRenderedPage` returns a citation
 * whenever the page was one we sent, so a `vlm-drawing` value always carries
 * one and this can never fire on it.
 *
 * It is named anyway, because "harmless by construction" is a property of code
 * somewhere else. The rule being expressed is "a model answer nobody can locate
 * is not evidence", and that rule does not care which of the two model paths
 * produced it. Leaving the second one out meant the guard read as covering model
 * output while covering half of it, and the half it missed is the one that
 * reads mechanical drawings, which is where the numbers that place copper come
 * from.
 */
export function isUntraceable(field: Extracted<unknown>): boolean {
  return (
    field.value !== null &&
    (field.method === "vlm" || field.method === "vlm-drawing") &&
    field.citation === null
  );
}

/**
 * A value a person typed in, with the reader's provenance removed.
 *
 * ## Why the citation must go
 *
 * A citation is a promise that the value can be found at that place in the
 * document. When a person CORRECTS a field, they are saying the reader's value
 * was wrong, so the page it was read from is the page the wrong value came
 * from. Carrying that citation onto the new number turns it into a claim that
 * the datasheet says something it does not.
 *
 * That is not a cosmetic distinction here. The whole positioning of this
 * product is that every number can be traced back to a page for QML and IPC
 * Class 3 sign-off. A reviewer following a falsified citation finds a different
 * number at the other end, which is worse than finding none: an absent citation
 * says "a person supplied this", and a wrong one says "the vendor did".
 *
 * Found 2026-08-24. `handleCorrectReview` patched only value, confidence and
 * method, and the patch helper merges, so the model's citation survived every
 * hand correction. `updatePin` did it explicitly, passing the old citation
 * through with a comment saying the provenance changes with the edit.
 *
 * ## Why this is safe at the export gate
 *
 * `isUntraceable` refuses a MODEL value with no citation. A `user` value is not
 * a model value, so dropping the citation cannot block an export; it only stops
 * the record claiming a source it does not have.
 *
 * CONFIRMING is a different act and deliberately keeps its citation: a model
 * read it AND a person checked it against the page it names, which is a
 * stronger record than either alone. Only a correction discards.
 */
export function userEdited<T>(value: T): Extracted<T> {
  return { value, confidence: 1, method: "user", citation: null };
}
