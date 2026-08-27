/**
 * THE INVARIANT.
 *
 *     No value ships silently unless two INDEPENDENT sources agree on it.
 *     Everything else is put in front of the user.
 *
 * There is no third state and nothing falls through. "We could not confirm this"
 * is not a caveat on the rule; it is an outcome the rule already handles.
 *
 * ## Why this, and not more extraction
 *
 * The goal this product is held to is: correct, or it tells you precisely what
 * it could not read and asks you for that - and the asking has to be rare enough
 * that a user still saves time. That goal forbids exactly ONE thing, a value
 * that is WRONG AND SILENT. It does not require reading perfectly. It requires
 * classifying perfectly, which is achievable outright.
 *
 * So this file does not try to read anything. It asks, of each value that
 * reaches the output, whether a second source agrees, and it sorts the answer
 * into two piles.
 *
 * ## Independent means read by different MEANS, not the same means twice
 *
 * This is the load-bearing part. A model that misreads a rotated figure misreads
 * it the same way twice, so a second model call is not a second source. Every
 * pairing below is a reading against a DIFFERENT KIND of reading:
 *
 *     the pinout        a model reading the document, against text-layer geometry
 *     the copper        the vendor's printed footprint, against IPC-7351B arithmetic
 *     the pin count     the pin table, against the mechanical drawing's lead count
 *     the pitch         the pitch, against the body it has to fit inside
 *     the body          the body, against the lead span that has to reach past it
 *     the thermal pad   the outline's D2/E2, against the printed footprint's own pad
 *
 * None of those pairs share a failure mode, which is the only property that
 * makes agreement worth anything.
 *
 * ## The unit is a GLANCE, not a field
 *
 * A flagged item is something a user settles by looking at one page once. The
 * pinout is one item whether the part has 8 pins or 144, because a person checks
 * a pinout against a figure in one look. Counting 144 pins as 144 items would
 * make the number meaningless and the panel unusable.
 *
 * ## What is deliberately NOT here
 *
 * Radiation ratings, JEDEC codes, manufacturer, and every other field that does
 * not place copper or wire a net. They are real data and nothing in the output
 * depends on them, so asking about them spends the user's attention where it
 * changes nothing. The budget for interruptions is small and it belongs to the
 * values that place copper. Same rule `review.ts` states for its own list.
 */

import type { FootprintGeometry } from "./geometry";
import { declaredLeadCount } from "./packagevariants";
import { pinoutEvidence, type PinoutEvidence } from "./pinevidence";
import type { DatasheetText } from "./pdftext";
import type { ResolvedPart } from "./types";

export type ConfirmState =
  /** Two independent sources agree. It ships without being mentioned. */
  | "confirmed"
  /** One source, or two that disagree. The user is shown it. */
  | "flagged";

export interface Confirmation {
  /** Stable identifier, for a UI and for a diff between two runs. */
  id: string;
  /** What was confirmed, in the engineer's language. */
  label: string;
  state: ConfirmState;
  /**
   * What the two readings were and what they said, written to be read alone.
   *
   * A user seeing one line and nothing else must be able to act on it, so
   * "34 of 48 pin names are corroborated by the numbering printed on page 29"
   * is the standard, not "pinout unconfirmed".
   */
  detail: string;
  /** What goes wrong if this is wrong. Present on flagged items only. */
  consequence?: string;
  /**
   * A short slug naming WHY, for grouping.
   *
   * Not shown to a user - `detail` is what they read. This exists so
   * `bench:confirm` can report the flags as CLASSES rather than as ninety-four
   * separate stories, which is the difference between a work queue and a list.
   * RULES.md rule 4: fix the class, never the instance.
   */
  because?: string;
  /** The page to put in front of the user, where the document has one. */
  page: number | null;
}

/**
 * How many flagged items a part may carry before it is not worth shipping.
 *
 * Anthony's number, 2026-08-27: "i feel like anything over 5 and the user gets
 * frustrated. so we dont want any more than 5 if possible."
 *
 * A part above it is refused WITH THE LIST rather than shipped with a dozen
 * boxes to fill in. That is what keeps the promise absolute: the user never
 * faces more than five, because past five we say this datasheet cannot be done
 * automatically instead of handing them the job back.
 */
export const MAX_FLAGGED = 5;

/** A value with a genuine second source behind it. */
function confirmed(id: string, label: string, detail: string, page: number | null = null): Confirmation {
  return { id, label, state: "confirmed", detail, page };
}

function flagged(
  id: string,
  label: string,
  because: string,
  detail: string,
  consequence: string,
  page: number | null = null
): Confirmation {
  return { id, label, state: "flagged", detail, consequence, because, page };
}

/**
 * THE PINOUT, against the pin numbering printed in the document's own text.
 *
 * See `pinevidence.ts` for what that reading is and what it can and cannot see.
 * Confirmed only when EVERY pin agrees: a netlist is not partly right, and a
 * user told "44 of 48 confirmed" has to check the pinout anyway.
 */
function confirmPinout(part: ResolvedPart, evidence: PinoutEvidence | null): Confirmation {
  const id = "pinout";
  const label = "Pin names and numbering";
  const consequence =
    "The schematic symbol is wired from these names and the pads are numbered from them. A wrong name is a wrong netlist, and a shifted number is a board that looks right in CAD.";
  const total = part.pins.length;
  if (total === 0) {
    return flagged(id, label, "no-pins", "No pin table was read from this document.", consequence);
  }
  if (!evidence) {
    return flagged(
      id,
      label,
      "no-numbering-in-text",
      `${total} pin names were read from this document, and no pin numbering was read from its text layer to check them against. ` +
        `That is the usual outcome where a pinout is drawn as artwork rather than typed.`,
      consequence
    );
  }
  const page = evidence.pages[0] ?? null;
  if (evidence.agreeing.length >= total) {
    return confirmed(
      id,
      label,
      `All ${total} pin names match the numbering printed on page ${evidence.pages.join(", page ")}.`,
      page
    );
  }
  return flagged(
    id,
    label,
    "partly-corroborated",
    `${evidence.agreeing.length} of ${total} pin names match the numbering printed on page ${evidence.pages.join(", page ")}. ` +
      `The rest are not drawn in that document's text and were not checked.`,
    consequence,
    page
  );
}

/**
 * THE COPPER, from whichever reading did not produce it.
 *
 * The generator records this while it builds, because only it holds both
 * patterns; see `FootprintProvenance.corroboration`. This turns that record into
 * the user's language.
 */
function confirmCopper(part: ResolvedPart, geometry: FootprintGeometry): Confirmation {
  const id = "land-pattern";
  const label = "Land pattern (the pads)";
  const consequence =
    "These pads are the copper the part is soldered to. Wrong here and the footprint misses the leads, on every board built from it.";
  const { corroboration } = geometry.provenance;
  const page = part.vendorLandPattern?.page ?? null;
  if (corroboration.agrees) return confirmed(id, label, corroboration.detail, page);
  return flagged(id, label, corroboration.because, corroboration.detail, consequence, page);
}

/**
 * HOW MANY PADS, from the mechanical drawing rather than the pin table.
 *
 * Two second sources and either will do, because they are independent of the pin
 * table in the same way: the drawing counts leads and the package name states
 * them, and neither is derived from the table the pins came from.
 */
function confirmPinCount(part: ResolvedPart): Confirmation {
  const id = "pin-count";
  const label = "Number of pins";
  const consequence =
    "Sets how many pads are generated and how many pins the symbol carries. A wrong count is a footprint that does not fit the part.";
  const drawing = part.dimensions.leadCount;
  const named = declaredLeadCount(part.packageType);
  if (drawing !== null && drawing === part.pinCount) {
    return confirmed(id, label, `${part.pinCount} pins, and the package outline drawing counts ${drawing} leads.`);
  }
  if (named !== null && named === part.pinCount) {
    return confirmed(id, label, `${part.pinCount} pins, and this document names the package ${part.packageType}.`);
  }
  if (drawing !== null && drawing !== part.pinCount) {
    return flagged(
      id,
      label,
      "drawing-disagrees",
      `The pin table lists ${part.pinCount} pins and the package outline drawing counts ${drawing} leads.`,
      consequence
    );
  }
  if (named !== null && named !== part.pinCount) {
    return flagged(
      id,
      label,
      "name-disagrees",
      `The pin table lists ${part.pinCount} pins and this document names the package ${part.packageType}.`,
      consequence
    );
  }
  return flagged(
    id,
    label,
    "no-second-source",
    `${part.pinCount} pins, from the pin table alone. Neither a lead count on the package outline nor a lead count in the package name was read to check it against.`,
    consequence
  );
}

/** How close two readings of the same printed dimension must sit, in mm. */
const PAD_AGREEMENT_MM = 0.05;

/**
 * THE PITCH, against the footprint the datasheet prints for the same package.
 *
 * The pitch is read off the package OUTLINE drawing, dimension `e`. The same
 * number is stated again on the recommended FOOTPRINT drawing, which is a
 * different page laid out by different people for a different purpose. Two
 * drawings, two readings.
 *
 * ## Why not "the lead row has to fit the body"
 *
 * That was tried and measured on 2026-08-27 and it is not a confirmation. Across
 * 94 correctly read parts the lead row spans between 0.44 and 1.03 of the body
 * it sits on, so a bound wide enough to admit every correct part admits almost
 * every wrong pitch too, and a bound tight enough to mean anything flagged 22
 * correct readings. A check that cannot fail on a real record confirms nothing;
 * one that fires on correct answers spends the user's attention and teaches them
 * to click past it. Neither is worth shipping, so the bound was dropped rather
 * than tuned.
 *
 * The printed footprint is available on 29 of 106 shipping parts and states the
 * pitch on all 29 of them. Where it is absent, this says so; that is a gap in
 * our reading of the document and it is reported as one.
 */
function confirmPitch(part: ResolvedPart): Confirmation {
  const id = "pitch";
  const label = "Lead pitch";
  const consequence = "Sets the spacing between pads. A wrong pitch misaligns every pin at once.";
  const pitchMm = part.dimensions.pitchMm;
  if (pitchMm === null) {
    return flagged(id, label, "not-read", "No lead pitch was read from this document.", consequence);
  }
  const printed = part.vendorLandPattern?.valuesMm ?? [];
  const page = part.vendorLandPattern?.page ?? null;
  if (printed.some((value) => Math.abs(value - pitchMm) <= PAD_AGREEMENT_MM)) {
    return confirmed(
      id,
      label,
      `${pitchMm} mm on the package outline drawing, and the footprint printed on page ${page} states the same pitch.`,
      page
    );
  }
  return flagged(
    id,
    label,
    printed.length > 0 ? "printed-footprint-differs" : "no-printed-footprint",
    printed.length > 0
      ? `${pitchMm} mm on the package outline drawing. The footprint printed on page ${page} does not state that pitch.`
      : `${pitchMm} mm, from the package outline drawing alone. No printed footprint was read from this datasheet that states it again.`,
    consequence,
    page
  );
}

/**
 * THE BODY, against the lead span that has to reach past it.
 *
 * The body drives the courtyard, the silkscreen outline and the 3D solid rather
 * than the copper, which is why it is one item and not three. Its second source
 * is the span: leads leave a package and end outside it, so a span read off a
 * different dimension line bounds the body from above.
 */
function confirmBody(part: ResolvedPart): Confirmation {
  const id = "body";
  const label = "Package body size";
  const consequence =
    "Drives the courtyard, the silkscreen outline and the 3D solid. Wrong here and the part fouls its neighbours on the board, or the silkscreen sits under the copper.";
  const length = part.dimensions.bodyLengthMm;
  const width = part.dimensions.bodyWidthMm;
  if (length === null || width === null) {
    return flagged(
      id,
      label,
      "not-read",
      "The body outline was not read from this document, so the courtyard falls back to the extent of the lands.",
      consequence
    );
  }
  const span = part.dimensions.leadSpanMm;
  const across = Math.min(length, width);
  if (span && span.maxMm >= across) {
    return confirmed(
      id,
      label,
      `${length} x ${width} mm, and the ${span.minMm} to ${span.maxMm} mm lead span read from the same drawing reaches past it.`
    );
  }
  if (span) {
    return flagged(
      id,
      label,
      "span-ends-inside-body",
      `${length} x ${width} mm, but the lead span reaches only ${span.maxMm} mm, which ends inside the body.`,
      consequence
    );
  }
  return flagged(
    id,
    label,
    "no-span-to-bound-it",
    `${length} x ${width} mm, read from one drawing and checked against nothing: no lead span was read to bound it.`,
    consequence
  );
}

/**
 * THE EXPOSED PAD, against the footprint the datasheet printed.
 *
 * The pad's size is dimensioned D2 and E2 on the package outline, and the same
 * pad is drawn again on the recommended footprint a few pages later. Two
 * drawings, two readings, and the pad is soldered and mandatory - it carries the
 * part's heat out and, on most no-lead packages, it is the ground connection.
 */
function confirmThermalPad(part: ResolvedPart): Confirmation | null {
  if (!part.exposedPad) return null;
  const id = "thermal-pad";
  const label = "Exposed thermal pad";
  const consequence =
    "The thermal land is soldered and mandatory. Wrong size and the part does not sit down, or solder bridges from the pad to the leads.";
  const length = part.dimensions.thermalPadLengthMm;
  const width = part.dimensions.thermalPadWidthMm;
  const page = part.vendorLandPattern?.page ?? null;
  if (length === null || width === null) {
    return flagged(id, label, "not-read", "The exposed pad's size (D2 and E2) was not read from this document.", consequence, page);
  }
  const printed = part.vendorLandPattern?.valuesMm ?? [];
  const has = (value: number) => printed.some((candidate) => Math.abs(candidate - value) <= PAD_AGREEMENT_MM);
  if (printed.length > 0 && has(length) && has(width)) {
    return confirmed(
      id,
      label,
      `${length} x ${width} mm from the package outline, and the footprint printed on page ${page} draws the same pad.`,
      page
    );
  }
  return flagged(
    id,
    label,
    printed.length > 0 ? "printed-pad-differs" : "no-printed-pad",
    printed.length > 0
      ? `${length} x ${width} mm from the package outline. The footprint printed on page ${page} does not draw a pad that size.`
      : `${length} x ${width} mm from the package outline, and no printed footprint was read that draws the same pad.`,
    consequence,
    page
  );
}

export interface ConfirmationReport {
  items: Confirmation[];
  /** THE NUMBER. Everything else in this file exists to produce it. */
  flagged: Confirmation[];
  /** True when this part carries more to check than `MAX_FLAGGED`. */
  overBudget: boolean;
}

/**
 * Every value this bundle would ship, with its state.
 *
 * `doc` is the document the record was read from. Without it the pinout has no
 * second source and is flagged accordingly, which is the honest answer: a caller
 * that cannot supply the document cannot confirm the netlist.
 */
export function confirmations(
  part: ResolvedPart,
  geometry: FootprintGeometry,
  doc: DatasheetText | null
): ConfirmationReport {
  const evidence = doc && part.pins.length > 0 ? pinoutEvidence(doc, part.pins, part.pinCount) : null;
  const items = [
    confirmPinout(part, evidence),
    confirmCopper(part, geometry),
    confirmPinCount(part),
    confirmPitch(part),
    confirmBody(part),
    confirmThermalPad(part)
  ].filter((item): item is Confirmation => item !== null);

  const flags = items.filter((item) => item.state === "flagged");
  return { items, flagged: flags, overBudget: flags.length > MAX_FLAGGED };
}
