/**
 * The local model, asked SEVERAL NARROW QUESTIONS instead of one wide one.
 *
 * ## Why this exists
 *
 * Measured on 2026-08-12 against `qwen2.5vl:7b` on an M2 Pro, which is about
 * the largest vision model 16 GB will hold:
 *
 *   the production prompt (~23 fields, whole document)   0 fields returned
 *   the pin table alone, asked on its own                8/8 names, exact
 *   the printed land pattern alone                       2 of 3 numbers
 *   the package drawing's dimensions alone               1 of 3
 *
 * The same model that answers nothing when asked everything answers a pin table
 * perfectly when asked only that. A 7B has the capability and not the capacity
 * to hold twenty-three simultaneous questions, and pin tables are the field that
 * blocks more parts than any other.
 *
 * ## Why it is a separate model rather than a flag
 *
 * The split is a bad trade for the cloud model, which answers everything in one
 * call and would simply pay N times for the privilege of being asked N times. So
 * it lives entirely INSIDE an `ExtractionModel`, where nothing downstream can
 * tell the difference: the caller sends one request and gets one
 * `ExtractionResult`. `run.ts`, `request.ts`, `merge.ts` and the exporters are
 * untouched, and the existing cloud path cannot regress because no code it runs
 * has changed.
 *
 * ## The property that makes this better than one call, beyond accuracy
 *
 * A group that fails loses only itself. One wide call is all-or-nothing: a
 * malformed pin table costs the dimensions too. Here the pin table can fail and
 * the land pattern still arrives.
 */

import {
  ExtractionModelError,
  type ExtractionField,
  type ExtractionModel,
  type ExtractionRequest,
  type ExtractionResult
} from "../contracts";
import { callLocalModel, endpoint, modelName } from "./local";
import { LAND_PATTERN_HEADING } from "../sections";

/**
 * Fields grouped by the question a person would ask to find them.
 *
 * Grouped by WHERE THE ANSWER LIVES rather than by type, because that is what
 * makes a question narrow: identity is on the front page, the pin table is one
 * table, the land pattern is its own drawing on its own page. Asking for the
 * body dimensions and the land pattern together is two drawings and two
 * conventions in one question, which is the wide-question failure in miniature.
 *
 * Order matters only for reporting: the earliest groups are the ones measured
 * to work best, so a run killed halfway still has the useful half.
 */
export interface FieldGroup {
  readonly fields: readonly ExtractionField[];
  /**
   * How to find the PAGES that answer this group, by the heading a datasheet
   * prints above them. Not a parser: it locates a section, it does not read one.
   *
   * Null where there is nothing to locate by, which is the catch-all bucket. It
   * is not the same as a pattern that matches everything: `pagesFor` scores a
   * page by how often the pattern hits, so an empty pattern scores by LENGTH and
   * picks the longest page in the document.
   */
  readonly locate: RegExp | null;
}

export const FIELD_GROUPS: readonly FieldGroup[] = [
  {
    fields: ["partNumber", "manufacturer", "packageType", "pinCount"],
    locate: /package|device information|ordering|features/i
  },
  { fields: ["pins"], locate: /pin\s+(?:functions?|descriptions?|configuration)|terminal\s+functions?/i },
  {
    fields: [
      "dimensions.bodyLengthMm",
      "dimensions.bodyWidthMm",
      "dimensions.bodyHeightMm",
      "dimensions.pitchMm",
      "dimensions.leadCount"
    ],
    locate: /package\s+outline|mechanical\s+(?:data|drawing)|outline\s+dimensions/i
  },
  {
    fields: [
      "dimensions.leadLengthMm",
      "dimensions.leadWidthMm",
      "dimensions.leadSpanMm",
      "dimensions.leadSpanCrossMm",
      "dimensions.leadContactMm"
    ],
    locate: /package\s+outline|mechanical\s+(?:data|drawing)|outline\s+dimensions/i
  },
  // How the leads leave the body and how they attach, all off the same outline
  // drawing. Added 2026-08-18 with the land-pattern fields above, for the same
  // reason: they were on the record and in no group.
  {
    fields: [
      "dimensions.leadSides",
      "dimensions.leadForm",
      "dimensions.mounting",
      "dimensions.leadDiameterMm",
      "dimensions.leadsPerSide",
      "dimensions.vacantLeadSlot",
      "jedecOutline",
      "packageOutlineCode"
    ],
    locate: /package\s+outline|mechanical\s+(?:data|drawing)|outline\s+dimensions|pin\s+(?:configuration|assignment)/i
  },
  {
    // Every field read off the RECOMMENDED FOOTPRINT drawing, which is one page.
    //
    // This listed three. The mask details, the via grid and the cross-axis span
    // are printed on the same drawing and were added to the record without being
    // added here, so they fell into the catch-all bucket: thirteen unrelated
    // fields asked as ONE wide question over ONE page, which is the wide-question
    // failure this whole model exists to replace.
    fields: [
      "dimensions.landPadLengthMm",
      "dimensions.landPadWidthMm",
      "dimensions.landSpanMm",
      "dimensions.landSpanCrossMm",
      "dimensions.solderMaskExpansionMm",
      "dimensions.solderMaskDefined",
      "dimensions.thermalViaDiameterMm",
      "dimensions.thermalViaPitchMm"
    ],
    // Shared with the page selector in `run.ts` rather than written twice. The
    // same heading pattern in two files is the defect shape LEARNINGS.md names
    // first: fixed in one place, not the other.
    locate: LAND_PATTERN_HEADING
  },
  {
    fields: ["dimensions.thermalPadLengthMm", "dimensions.thermalPadWidthMm"],
    locate: /thermal\s+pad|exposed\s+pad|package\s+outline/i
  },
  {
    fields: ["radiation.tid", "radiation.see", "radiation.sel", "radiation.qmlClass"],
    locate: /radiation|total\s+ionizing|single[\s-]event|rad[\s-]hard/i
  }
];

/**
 * How many pages one narrow question may carry.
 *
 * Measured on qwen2.5vl:7b, and this is the whole reason this model exists: the
 * pin table asked over ONE page of text came back 8/8 correct, and the identical
 * question over the whole 68k-character document produced a paragraph about
 * drawings and no answer at all. The blocker is context size, not the number of
 * fields, so narrowing the fields without narrowing the pages changes nothing.
 */
const MAX_PAGES_PER_QUESTION = 1;

/** The groups this request actually needs, with nothing empty. */
export function groupsFor(fields: readonly ExtractionField[]): FieldGroup[] {
  const wanted = new Set(fields);
  const groups = FIELD_GROUPS.map((group) => ({
    ...group,
    fields: group.fields.filter((field) => wanted.has(field))
  })).filter((group) => group.fields.length > 0);

  // Anything not named in a group above still has to be asked about, or adding a
  // field to `contracts.ts` would silently stop it ever being requested here.
  //
  // NEVER WITH AN EMPTY PATTERN. This used `/(?:)/`, which with the `g` flag
  // `pagesFor` adds matches at every character position, so the bucket's hit
  // count became the page's LENGTH and the ranking handed it the longest page in
  // the document. `pagesFor`'s own comment two lines below says why that is the
  // worst possible choice: "a wrong LONG page is what produces confident
  // nonsense". `null` says there is nothing to locate, and the fallback then
  // does what it was written to do and sends the shortest page.
  const grouped = new Set(groups.flatMap((group) => group.fields));
  const ungrouped = [...wanted].filter((field) => !grouped.has(field));
  return ungrouped.length > 0 ? [...groups, { fields: ungrouped, locate: null }] : groups;
}

/**
 * The page that answers this group: the BEST match, not the first ones found.
 *
 * Ranked rather than filtered, because taking matches in document order is what
 * broke this. Measured on LM358, whose pin table is on page 3: the locator also
 * matched pages 2 and 31, all three went in document order, and asked over those
 * 10k characters the model returned invented placeholders, `Pin 1`, `Pin 2`,
 * `Pin 3`. Asked over page 3 ALONE it returned the real names. The wrong pages
 * did not dilute the answer, they replaced it.
 *
 * The score is how often the section's own heading appears, then SHORTNESS as
 * the tie-break. A page whose heading occurs repeatedly is the section itself; a
 * long page mentioning it once is prose about it, and a datasheet's real pin
 * table page is short because it is mostly table.
 */
export function pagesFor(
  group: FieldGroup,
  pages: ExtractionRequest["pages"]
): ExtractionRequest["pages"] {
  const anywhere = group.locate ? new RegExp(group.locate.source, "gi") : null;
  const scored = anywhere
    ? pages
        .map((page) => ({ page, hits: (page.text.match(anywhere) ?? []).length }))
        .filter((entry) => entry.hits > 0)
        .sort((a, b) => b.hits - a.hits || a.page.text.length - b.page.text.length)
    : [];

  // Nothing announced itself. Send the shortest few rather than the first few:
  // a wrong LONG page is what produces confident nonsense.
  const fallback = [...pages].sort((a, b) => a.text.length - b.text.length);
  const chosen = scored.length > 0 ? scored.map((entry) => entry.page) : fallback;
  return chosen.slice(0, MAX_PAGES_PER_QUESTION);
}

/**
 * The RENDERS for the pages a group was given, and no others.
 *
 * Narrowing the fields and the pages while sending every image is not narrowing
 * the question. On the second pass the request carries a render of each page the
 * model asked to see, and a 150 DPI page is far more context than the page's
 * text; passing all of them to all seven groups hands a 7B model more to hold
 * than the one wide call this model exists to replace, seven times over.
 *
 * A group whose page was never rendered gets no image and answers from text,
 * which is what it did on the first pass anyway.
 */
export function imagesFor(
  pages: ExtractionRequest["pages"],
  images: ExtractionRequest["images"]
): ExtractionRequest["images"] {
  const wanted = new Set(pages.map((page) => page.page));
  return images.filter((image) => wanted.has(image.page));
}

/**
 * The one kind every group failed with, or null when they disagreed.
 *
 * Reporting a kind the failures did not share would be inventing a diagnosis,
 * so a mixed run falls back to the honest general answer: we did not get one.
 */
function sharedKind(errors: readonly unknown[]): ExtractionModelError["kind"] | null {
  const kinds = new Set(
    errors.map((error) => (error instanceof ExtractionModelError ? error.kind : "unknown"))
  );
  if (kinds.size !== 1) return null;
  const only = [...kinds][0];
  return only === "unknown" ? null : only;
}

export class FocusedLocalExtractionModel implements ExtractionModel {
  readonly name = `local-focused:${modelName()}`;

  isConfigured(): boolean {
    return endpoint().length > 0;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const groups = groupsFor(request.fields);
    const values: ExtractionResult["values"] = {};
    // What the model LOOKED FOR and did not find, gathered like the values.
    // Dropping it made a document that is silent about a field indistinguishable
    // from a field nobody asked about, which is the distinction that took a whole
    // investigation to recover on the cloud path.
    const declined = new Set<ExtractionField>();
    const notes: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let answered = 0;
    const failed: string[] = [];
    const errors: unknown[] = [];

    for (const group of groups) {
      const fields = group.fields;
      try {
        // Narrow the PAGES and their RENDERS as well as the fields. Any one of
        // the three left wide is the failure this model was built to fix.
        const pages = pagesFor(group, request.pages);
        const result = await callLocalModel({
          ...request,
          fields: [...fields],
          pages,
          images: imagesFor(pages, request.images)
        });
        // Later groups never overwrite earlier ones. A group is asked only about
        // its own fields, so an answer outside them is the model volunteering
        // something it was not asked for, and the group that OWNS a field is the
        // one whose question was aimed at it.
        for (const [key, value] of Object.entries(result.values)) {
          const field = key as ExtractionField;
          if (!(field in values)) values[field] = value;
        }
        for (const field of result.declined ?? []) declined.add(field);
        for (const note of result.notes ?? []) notes.push(note);
        inputTokens += result.usage?.inputTokens ?? 0;
        outputTokens += result.usage?.outputTokens ?? 0;
        answered += 1;
      } catch (error) {
        // The whole point of splitting: one bad group must not cost the others.
        // Recorded rather than swallowed, so a run cannot look complete when it
        // is not.
        failed.push(`${fields.join(",")}: ${error instanceof Error ? error.message : "failed"}`);
        errors.push(error);
      }
    }

    if (answered === 0) {
      // An `ExtractionModelError` and its kind, like every other throw in this
      // layer. A bare Error here made total failure the one model failure a
      // caller could not classify, and the kind that matters most is `config`:
      // a public or unresolvable endpoint fails every group identically and is
      // the user's to fix, not something to report as the network being down.
      throw new ExtractionModelError(
        sharedKind(errors) ?? "transport",
        `Every focused question failed against ${this.name}. ${failed.slice(0, 3).join(" | ")}`
      );
    }

    return {
      values,
      // A field ANSWERED by a later group is not declined, whatever an earlier
      // one said about it.
      ...(declined.size > 0
        ? { declined: [...declined].filter((field) => !(field in values)) }
        : {}),
      ...(notes.length > 0 ? { notes } : {}),
      usage: { inputTokens, outputTokens }
    };
  }
}
