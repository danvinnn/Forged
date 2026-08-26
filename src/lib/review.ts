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
  | "unverifiable";

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
  // THE PRINTED LAND PATTERN.
  //
  // These three are the pads themselves wherever the datasheet drew its own
  // recommended footprint, which is 36 of 39 hold-out documents. They were not
  // reviewable until 2026-08-14, so the panel was asking a person to check the
  // lead span, which only matters when the pattern has to be COMPUTED, while the
  // numbers that were being emitted as copper went unmentioned.
  {
    field: "dimensions.landPadLengthMm",
    label: "Land length (printed footprint)",
    consequence: "This IS the pad, along the lead, when the datasheet printed its own footprint. Read wrongly, every land is the wrong size."
  },
  {
    field: "dimensions.landPadWidthMm",
    label: "Land width (printed footprint)",
    consequence: "This IS the pad, across the lead. Too wide and neighbouring lands bridge at reflow."
  },
  {
    field: "dimensions.landSpanMm",
    label: "Land centre span (printed footprint)",
    consequence: "Sets how far apart the two rows of lands sit. Wrong here and the whole footprint misses the leads."
  },
  {
    // Added 2026-08-18. All three place copper and none could be reviewed, so an
    // uncited one blocked the export with no way to clear it, and a wrong one
    // could not be corrected. The panel is an allowlist and these three fell out
    // of it as they were added to the record, which is the same list-versus-
    // enumeration mistake `untraceableDimensions` in types.ts was rewritten to
    // remove.
    field: "dimensions.landSpanCrossMm",
    label: "Land centre span, other axis (printed footprint)",
    consequence:
      "Sets how far apart the OTHER pair of rows sits on a four-sided package. Wrong here and half the footprint misses its leads."
  },
  {
    field: "dimensions.vacantLeadSlot",
    label: "Empty grid position",
    consequence:
      "Says which position on the short row carries no lead. Put the gap in the wrong slot and every pin after it is miswired, on a board that looks correct in CAD."
  },
  {
    field: "dimensions.leadsPerSide",
    label: "Leads on each side",
    consequence:
      "Divides the pins between the sides of a four-sided package. A wrong split puts leads where the package has none."
  },
  {
    field: "dimensions.leadSides",
    label: "Sides carrying leads",
    consequence: "Decides whether the pads are laid out in two rows or four. The wrong answer is a completely different footprint."
  },
  {
    // Added 2026-08-17. Both of these place copper and neither was ever put in
    // front of a person: `mounting` decides holes versus lands, which is not a
    // detail a reviewer can spot afterwards, and the hole is sized from
    // `leadDiameterMm` and nothing else.
    field: "dimensions.mounting",
    label: "How it mounts (surface or through-hole)",
    consequence:
      "Decides whether the footprint is lands on the surface or plated holes through the board. Wrong here and the part cannot be fitted at all."
  },
  {
    field: "dimensions.leadDiameterMm",
    label: "Lead diameter (through-hole)",
    consequence:
      "IPC-7251 sizes the hole from this and nothing else. Too small and the lead will not go in; too large and the joint has no barrel to wet."
  },
  {
    field: "dimensions.leadForm",
    label: "Lead form",
    consequence: "Decides which land-pattern model applies. A no-lead package computed as gull-wing looks correct in CAD and is not."
  },
  {
    field: "dimensions.thermalPadLengthMm",
    label: "Exposed pad length",
    consequence: "The thermal land is soldered and mandatory. Wrong size means the part does not sit down, or solder bridges to the leads."
  },
  {
    field: "dimensions.thermalPadWidthMm",
    label: "Exposed pad width",
    consequence: "As above, across the pad."
  },
  {
    field: "dimensions.leadContactMm",
    label: "Lead contact length",
    consequence: "The seated foot. Sets the land length wherever the pattern has to be computed from the package drawing."
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

/** Every field the panel can ask about, for tests that check nothing is missed. */
export const REVIEWABLE_FIELDS: readonly string[] = REVIEWABLE.map((entry) => entry.field);

/**
 * The human name for a field path, for messages OUTSIDE the review panel.
 *
 * `/api/export` refuses with the exact field paths it could not resolve, and
 * until 2026-08-24 the screen threw that list away and printed "required values
 * were not extracted from the datasheet. Fill them in before exporting." The
 * user was told to fill in something the sentence declined to name.
 *
 * The table above already carries a name for every field a person is ever shown,
 * so it is reused rather than a second list started. The fallback turns an
 * unlisted path into something readable rather than printing
 * `dimensions.landSpanCrossMm` at somebody: a field with no entry here is one
 * nobody wrote a label for, which is a gap in the table and not a reason to
 * show its source code.
 */
export function labelForField(field: string): string {
  const entry = REVIEWABLE.find((candidate) => candidate.field === field);
  if (entry) return entry.label;
  const bare = field.replace(/^dimensions\./, "").replace(/Mm$/, "");
  const spaced = bare.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

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

  // Blocking items lead, then the declared order of REVIEWABLE, which is written
  // most-consequential first.
  //
  // There used to be a third rank above blocking, for DISAGREEMENTS: a value two
  // readers had answered differently. Comparing two readers needs two readers,
  // and the deterministic one was deleted on 2026-08-14, so no disagreement has
  // been produced since. The rank was removed with the cross-check; this comment
  // went on describing it, which is how a reader of this file would conclude the
  // panel surfaces contradictions it has no way to find.
  const order = REVIEWABLE.map((entry) => entry.field);
  const rank = (item: ReviewItem) => (item.blocking ? 0 : 1);
  return items.sort((left, right) => {
    if (rank(left) !== rank(right)) return rank(left) - rank(right);
    return order.indexOf(left.field) - order.indexOf(right.field);
  });
}

/** Pages a reviewer needs in front of them, most cited first, deduplicated. */
export function reviewPages(items: readonly ReviewItem[], limit = 3): number[] {
  const counts = new Map<number, number>();
  for (const item of items) {
    // One page per item, counted so the most-cited pages win the limit. This
    // said it was counting both sides of a disagreement; there are no
    // disagreements to have sides, and a `ReviewItem` has only ever carried one
    // page.
    if (item.page === null) continue;
    counts.set(item.page, (counts.get(item.page) ?? 0) + 1);
  }
  return [...counts]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])
    .slice(0, limit)
    .map(([page]) => page);
}
