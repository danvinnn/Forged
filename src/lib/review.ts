import type { Extracted, PartRecord, PinRecord } from "./types";
import { isUntraceable } from "./provenance";

/**
 * What a person should look at before this record is trusted.
 *
 * ## Why this exists
 *
 * Until now a value we were unsure of had exactly two fates. If it carried a
 * verified citation it was accepted silently, and if it did not it was dropped
 * at the export gate and the user was told a field was "missing" for a value we
 * had actually read. Both are wrong for the same reason: the information was in
 * hand and nobody was asked.
 *
 * The fix is not more confidence tuning. It is to put the value, the page it
 * came from, and what it affects in front of a person and let them take one
 * second to agree. That is cheaper than any amount of extraction work and it is
 * the only step that can produce a record someone will actually sign.
 *
 * ## Prompted by consequence, not by confidence
 *
 * A confidence number tells a user nothing actionable. "0.4" is not a reason to
 * look. "The schematic symbol is wired from these names" is. So every item
 * carries what BREAKS if it is wrong, and the list is ordered by that rather
 * than by the score.
 *
 * Dependency-free on purpose, exactly as `provenance.ts` is: the client renders
 * this and must not pull zod into the browser bundle to do it.
 */

/**
 * At or below this, a cited value is still worth a human glance.
 *
 * 0.5 is a model answer whose claim was found in the page text; 0.4 is one read
 * off a rendered image, where no text existed to check against. Both are real
 * evidence and neither is a verified read, so both are asked about.
 */
export const REVIEW_CONFIDENCE = 0.5;

export type ReviewReason =
  /** Read by a model and quoted back to the page text. Plausible, unchecked. */
  | "model-read"
  /** Read off a rendered page. No text existed to check the claim against. */
  | "read-from-image"
  /**
   * Recorded with no citation at all. This is the one that currently costs the
   * user an export: `resolveForExport` refuses it, and before this the only
   * recourse was to re-parse and hope.
   */
  | "unverifiable"
  /**
   * The code and the model read the page differently, and both claims check out
   * against pages of this document.
   *
   * Ranked above everything else because it is the only item here backed by two
   * independent readings rather than one uncertain one. Every other reason says
   * "nobody has checked this"; this one says "two readers checked it and got
   * different answers", which is the strongest signal available that something
   * is actually wrong.
   */
  | "disagreement";

export interface ReviewItem {
  /** Dotted path into the record, e.g. `dimensions.leadSpanMm`. */
  field: string;
  /** Field name in the user's language, not the standard's. */
  label: string;
  /** Rendered for display. The raw value stays in the record. */
  display: string;
  page: number | null;
  /** What the citation says, so the user knows what to look for on the page. */
  snippet: string | null;
  confidence: number | null;
  reason: ReviewReason;
  /** What goes wrong if this is accepted and it is wrong. */
  consequence: string;
  /** Whether the export is currently BLOCKED by this item. */
  blocking: boolean;
  /**
   * Present only on a `disagreement`: the other reading, and the page it came
   * from, so the reviewer can open both and settle it in one look.
   *
   * `display` above holds the value ON THE RECORD and this holds the one that
   * was NOT taken, which is the useful way round for a reviewer. Which reader
   * produced which is read from the conflict's `holding`, NOT assumed: the
   * record carries the model's value wherever the model outranked the code, and
   * assuming otherwise attributed both readings to the wrong reader on exactly
   * those fields. `source` below names the reader of the alternative.
   */
  alternative?: { display: string; page: number | null; source: "model" | "deterministic" };
}

/**
 * The fields worth a person's time, with what each one drives.
 *
 * Deliberately not every field in the record. A radiation rating is real data
 * and nothing in the generated output depends on it, so asking about it spends
 * the user's attention where it changes nothing. The budget for interruptions
 * is small and it belongs to the values that place copper.
 */
const REVIEWABLE: Array<{ field: string; label: string; consequence: string }> = [
  {
    field: "pins",
    label: "Pin names",
    consequence: "The schematic symbol is wired from these names. A wrong name is a wrong netlist."
  },
  {
    field: "pinCount",
    label: "Pin count",
    consequence: "Sets how many pads are generated. A wrong count is a footprint that does not fit the part."
  },
  {
    field: "packageType",
    label: "Package",
    consequence: "Selects which land pattern family is used. The wrong family is the wrong footprint entirely."
  },
  {
    field: "dimensions.leadSpanMm",
    label: "Lead span (tip to tip)",
    consequence: "Pads are placed from this. Too small and the lands sit inside the leads; too large and they miss."
  },
  {
    field: "dimensions.pitchMm",
    label: "Lead pitch",
    consequence: "Sets the spacing between pads. A wrong pitch misaligns every pin at once."
  },
  {
    field: "dimensions.leadWidthMm",
    label: "Lead width",
    consequence: "Sets how wide each land is. Too wide risks bridging to the neighbouring pin."
  },
  {
    field: "dimensions.leadContactMm",
    label: "Lead contact length",
    consequence: "Recorded for review. Land length uses the characterised family value, not this one."
  },
  {
    field: "dimensions.bodyLengthMm",
    label: "Body length",
    consequence: "Drives the courtyard and the silkscreen outline rather than the copper."
  },
  {
    field: "dimensions.bodyWidthMm",
    label: "Body width",
    consequence: "Drives the courtyard and the silkscreen outline rather than the copper."
  }
];

function fieldAt(part: PartRecord, path: string): Extracted<unknown> | null {
  if (!path.includes(".")) {
    return (part as unknown as Record<string, Extracted<unknown>>)[path] ?? null;
  }
  const [group, key] = path.split(".");
  const bag = (part as unknown as Record<string, Record<string, Extracted<unknown>>>)[group];
  return bag?.[key] ?? null;
}

/**
 * Short, human, and never a raw JSON dump of a pin array.
 *
 * `unit` is applied to bare numbers. Without it a pitch reads "2.54", which a
 * reviewer glancing at a page of millimetre dimensions has to supply the unit
 * for themselves, and the one place that guess goes wrong is exactly the place
 * this panel exists to catch.
 */
function display(value: unknown, unit?: string): string {
  if (value === null || value === undefined) return "not read";
  if (Array.isArray(value)) {
    const pins = value as PinRecord[];
    const preview = pins
      .slice(0, 4)
      .map((pin) => `${pin.number}=${pin.name}`)
      .join(", ");
    return pins.length > 4 ? `${pins.length} pins: ${preview}, ...` : `${pins.length} pins: ${preview}`;
  }
  if (typeof value === "object") {
    const range = value as { minMm?: number; maxMm?: number };
    if (typeof range.minMm === "number" && typeof range.maxMm === "number") {
      return range.minMm === range.maxMm ? `${range.minMm} mm` : `${range.minMm} to ${range.maxMm} mm`;
    }
  }
  if (typeof value === "number" && unit) return `${value} ${unit}`;
  return String(value);
}

function reasonFor(field: Extracted<unknown>): ReviewReason | null {
  if (field.value === null) return null;
  // Anything a person or the deterministic reader produced is not up for review.
  // The model is the only source that guesses.
  if (field.method !== "vlm" && field.method !== "vlm-drawing") return null;

  if (field.citation === null) return "unverifiable";
  if (field.method === "vlm-drawing") return "read-from-image";
  if (field.confidence !== null && field.confidence <= REVIEW_CONFIDENCE) return "model-read";
  return null;
}

/**
 * Everything worth confirming, most consequential first.
 *
 * Blocking items lead, because those are the ones costing the user an export
 * right now rather than merely inviting a second look.
 */
export function collectReviewItems(part: PartRecord): ReviewItem[] {
  const items: ReviewItem[] = [];
  const byField = new Map(REVIEWABLE.map((entry) => [entry.field, entry]));

  // Disagreements first, and they are their own kind of item: the value is on
  // the record and traceable, so no `reasonFor` check would ever surface it.
  // Without this the strongest evidence we have that something is wrong is the
  // one thing the panel does not mention.
  // Defaulted at the point of use: this module reads records that arrive over
  // the wire, including ones serialised before the field existed.
  for (const conflict of part.conflicts ?? []) {
    const entry = byField.get(conflict.field);
    if (!entry) continue;
    // A conflict a person already decided is not a question any more. Same rule
    // the export gate uses, so the panel and the gate can never disagree about
    // whether something is still open.
    const method = fieldAt(part, conflict.field)?.method;
    if (method === "user" || method === "user-confirmed") continue;
    // Which reading the record actually holds, and which one is the road not
    // taken. Read from `holding` rather than assumed to be the deterministic
    // side; see the note on `alternative`.
    const held = conflict.holding === "model" ? conflict.model : conflict.deterministic;
    const other = conflict.holding === "model" ? conflict.deterministic : conflict.model;
    items.push({
      field: conflict.field,
      label: entry.label,
      display: held.display,
      page: held.page,
      snippet: null,
      confidence: fieldAt(part, conflict.field)?.confidence ?? null,
      reason: "disagreement",
      consequence: entry.consequence,
      // Not blocking. Both readings are cited, the record holds the one with an
      // oracle behind it, and stopping an export over a difference the user has
      // not looked at yet would make the safer behaviour the more annoying one.
      blocking: false,
      alternative: {
        display: other.display,
        page: other.page,
        source: conflict.holding === "model" ? "deterministic" : "model"
      }
    });
  }

  for (const entry of REVIEWABLE) {
    const field = fieldAt(part, entry.field);
    if (!field) continue;
    const reason = reasonFor(field);
    if (!reason) continue;

    items.push({
      field: entry.field,
      label: entry.label,
      // Every dimension in this record is in millimetres and says so in its
      // name, so the unit follows from the field rather than being repeated on
      // each entry, where one omission would read as a unitless number.
      display: display(field.value, entry.field.endsWith("Mm") ? "mm" : undefined),
      page: field.citation?.page ?? null,
      snippet: field.citation?.snippet ?? null,
      confidence: field.confidence,
      reason,
      consequence: entry.consequence,
      blocking: isUntraceable(field)
    });
  }

  // Disagreements lead, then blocking items, then the declared order of
  // REVIEWABLE, which is written most-consequential first.
  //
  // Above blocking on purpose. A blocking item is a value nobody has checked; a
  // disagreement is a value two readers checked and answered differently. The
  // second is rarer and more likely to be a real defect, and it is also the
  // cheapest to settle, because both pages are named.
  const order = REVIEWABLE.map((entry) => entry.field);
  const rank = (item: ReviewItem) => (item.reason === "disagreement" ? 0 : item.blocking ? 1 : 2);
  return items.sort((left, right) => {
    if (rank(left) !== rank(right)) return rank(left) - rank(right);
    return order.indexOf(left.field) - order.indexOf(right.field);
  });
}

/** Pages a reviewer needs in front of them, most cited first, deduplicated. */
export function reviewPages(items: readonly ReviewItem[], limit = 3): number[] {
  const counts = new Map<number, number>();
  for (const item of items) {
    // A disagreement is only settleable with BOTH pages, so both are counted.
    // Rendering one side of a contradiction is worse than rendering neither.
    if (item.alternative?.page != null) {
      counts.set(item.alternative.page, (counts.get(item.alternative.page) ?? 0) + 1);
    }
    if (item.page === null) continue;
    counts.set(item.page, (counts.get(item.page) ?? 0) + 1);
  }
  return [...counts]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, limit)
    .map(([page]) => page);
}
