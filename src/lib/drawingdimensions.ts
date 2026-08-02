import { citationAt, type Citation, type DatasheetText, type PageText, type TextItem } from "./pdftext";
import { findPackageDrawing, type PackageCode } from "./packagedrawing";

/**
 * Reads dimensions off the mechanical drawing, deterministically.
 *
 * ## Why this can work when two earlier attempts could not
 *
 * The values on a package drawing are text with coordinates, but which value is
 * the lead width is carried by the ARROWS, which are graphics. Pairing a value
 * to its dimension line was tried twice and measured as failing: by nearest line
 * (22 of 24 labels had no single candidate) and by the CAD convention of
 * centring a value on its dimension line (the pairings were real lines, but
 * borders and view outlines, and the spans never correlated with the values).
 *
 * This uses a third signal that neither attempt looked at, and it is semantic
 * rather than geometric: **a drawing tags a repeated feature with how many times
 * it repeats.** `6X 1.27` is six places at 1.27, `8X 0.482/0.382` is eight places
 * at that width. The count is not decoration, it is checkable arithmetic against
 * the pin count we already extracted, and prose does not produce it.
 *
 * ## Measured against known answers
 *
 * Scored against the four families whose lead dimensions were read off real
 * drawings by hand and are pinned by tests in `packages.ts`, plus LMP7704-SP's
 * HBH0014A which was read by rendering it:
 *
 *     pitch       4/5 exact
 *     lead width  4/5 exact
 *
 * The fifth was UCC27524, and it was a PACKAGE-selection problem rather than a
 * rule problem: the values read (pitch 0.65, width 0.25-0.38) are correct, they
 * are just its PowerPAD VSSOP drawing rather than the SOIC one that part was
 * extracted as. It now reads NOTHING for that part instead of reading the wrong
 * package's dimensions, which is the only honest answer available: see the
 * confirmation gate below.
 *
 * ## The gate, and what it costs
 *
 * Nothing is read off a drawing that has not been confirmed to be this part's
 * package. Measured over the cache, the page ranking hands an LM358 asking for
 * SOIC its SOT-23-THIN drawing, a UCC27524 its PowerPAD VSSOP drawing and an
 * OPA333 its SOT-23 drawing, and all three return a real, correct pitch of 0.65
 * belonging to a package the part is not in. There is no way to tell downstream:
 * 0.65 is a perfectly ordinary figure and the pads would be placed on it.
 *
 * So the drawing must both NAME the extracted family and, where it prints an
 * outline code, agree with the pin count. Three of the corpus lose their drawn
 * dimensions to this and none of them should have had them.
 *
 * ## What it does NOT read yet
 *
 * The lead SPAN, which a land pattern also needs. TI tags it on a flat pack
 * (`2X 7.62`) and leaves it untagged on a SOIC or TSSOP, where it is a plain
 * max/min pair among several others. That needs its own measurement rather than
 * a guess, so it is absent rather than approximated.
 *
 * Until it is read, the span comes from the family entry in `packages.ts`, which
 * is why the outline CODE matters as much as the dimensions here: it is what
 * picks the right family entry, and therefore the right span.
 */

/** `6X 1.27`, the whole label in one text item, which is how these arrive. */
const COUNT_INLINE = /^(\d{1,3})\s*X\s+(\d{1,3}(?:\.\d{1,3})?)$/i;

/** `8X` alone, with its value stacked to the right as a max over a min. */
const COUNT_ALONE = /^(\d{1,3})\s*X$/i;

/** `6X .050` or `8X .012-.020`, an inch-primary label whose millimetres follow below. */
const COUNT_INCH = /^(\d{1,3})\s*X\s+\.\d/i;

/** A bare dimension value, with the parenthesised reference form allowed. */
const VALUE = /^\(?(\d{1,3}(?:\.\d{1,3})?)\)?$/;

/**
 * The millimetre value on an INCH-primary drawing.
 *
 * 11 of the 40 cached datasheets are dimensioned in inches with millimetres in
 * brackets on the line directly beneath: `6X .050` over `[1.27]`, and
 * `8X .012-.020` over `[0.31-0.51]`. Reading the bracketed line rather than
 * converting the inch value keeps this free of unit arithmetic, and the vendor
 * has already done the rounding they intend.
 */
const BRACKETED = /^\[\s*(\d{1,3}(?:\.\d{1,3})?)(?:\s*-\s*(\d{1,3}(?:\.\d{1,3})?))?\s*\]$/;

/** How far below a label its bracketed millimetre line sits. */
const BRACKET_REACH_Y = 14;
const BRACKET_REACH_X = 45;

/** How far right of the count its values sit, and how far above or below. */
const VALUE_REACH_X = 40;
const VALUE_REACH_Y = 12;

/**
 * Physical bounds on a lead width, in mm. Every surface-mount lead in the corpus
 * sits inside this, and it is what separates the width pair from the lead
 * THICKNESS pair, which is the same shape and a similar magnitude. The count tag
 * does most of that work already: a drawing tags the width and does not tag the
 * thickness.
 */
const LEAD_WIDTH_MIN = 0.1;
const LEAD_WIDTH_MAX = 1.0;

export interface DrawnValue<T> {
  value: T;
  page: number;
  citation: Citation | null;
}

export interface DrawnDimensions {
  /** The page these were read from. */
  page: number;
  /** The outline code the drawing is titled with, when it prints one. */
  code: PackageCode | null;
  pitchMm: DrawnValue<number> | null;
  leadWidthMm: DrawnValue<{ minMm: number; maxMm: number }> | null;
}

interface CountGroup {
  count: number;
  values: number[];
  item: TextItem;
}

function valueOf(text: string): number | null {
  const match = VALUE.exec(text.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Every `NX value` label on the page, with the values belonging to it.
 *
 * A count sits either inline with its single value, or alone with a stacked
 * max/min pair immediately to its right: an `8X` on LMP7704-SP page 29 sits
 * BETWEEN `0.482` above and `0.382` below, not beside them, which is why a
 * same-baseline search finds nothing.
 */
function countGroups(page: PageText): CountGroup[] {
  const groups: CountGroup[] = [];

  for (const item of page.items) {
    const text = item.str.trim();
    const inline = COUNT_INLINE.exec(text);
    const alone = COUNT_ALONE.exec(text);
    const inch = COUNT_INCH.exec(text);
    if (!inline && !alone && !inch) continue;

    const values: number[] = [];
    if (inline) values.push(Number(inline[2]));

    // An inch-primary label states its millimetres in brackets on the line
    // below. Those are taken and the inch figure is ignored, so no conversion
    // happens here and the vendor's own rounding is preserved.
    if (inch || alone || inline) {
      for (const other of page.items) {
        if (other === item) continue;
        const bracket = BRACKETED.exec(other.str.trim());
        if (!bracket) continue;
        if (other.y >= item.y || item.y - other.y > BRACKET_REACH_Y) continue;
        if (Math.abs(other.x - item.x) > BRACKET_REACH_X) continue;
        values.push(Number(bracket[1]));
        if (bracket[2]) values.push(Number(bracket[2]));
      }
    }

    for (const other of page.items) {
      if (other === item) continue;
      const value = valueOf(other.str);
      if (value === null) continue;
      const dx = other.x - (item.x + item.width);
      if (dx < -4 || dx >= VALUE_REACH_X) continue;
      if (Math.abs(other.y - item.y) > VALUE_REACH_Y) continue;
      values.push(value);
    }

    if (values.length === 0) continue;
    groups.push({
      count: Number((inline ?? alone ?? inch)![1]),
      values: [...new Set(values)].sort((left, right) => left - right),
      item
    });
  }

  return groups;
}

/**
 * Reads what the drawing states outright.
 *
 * Returns null for anything it cannot confirm. Nothing here is approximated: a
 * value that does not satisfy its rule is absent, because a pitch guessed from a
 * drawing is the same failure as a pitch defaulted to 1.27.
 */
export function readDrawingDimensions(
  doc: DatasheetText,
  packageType: string | undefined,
  pinCount: number | null
): DrawnDimensions | null {
  const drawing = findPackageDrawing(doc, packageType);
  if (!drawing) return null;

  // ONLY read a drawing that is provably this part's package. A datasheet prints
  // one drawing per package it offers, and the ranking that picks between them
  // is a text match that can land on the wrong one: measured on the cache, an
  // LM358 asking for SOIC gets the SOT-23-THIN page, a UCC27524 gets the
  // PowerPAD VSSOP page and an OPA333 gets the SOT-23 page. Every value on those
  // pages is real, correct, and about a different package, which is the worst
  // kind of wrong number because nothing downstream can tell.
  //
  // Two independent confirmations, both required:
  //   - the page NAMES the family the part was extracted as, and
  //   - the outline code's lead count, where it prints one, equals the pin count.
  if (!drawing.namesPackage) return null;
  if (drawing.code && pinCount !== null && drawing.code.leadCount !== pinCount) return null;

  const page = doc.pages.find((candidate) => candidate.page === drawing.page);
  if (!page) return null;

  const groups = countGroups(page);
  if (groups.length === 0) {
    // The page is still the right page even when no count-tagged label parses,
    // and its code is worth returning on its own: it is what tells a SOIC narrow
    // from a SOIC wide.
    return { page: drawing.page, code: drawing.code, pitchMm: null, leadWidthMm: null };
  }

  const drawn = (item: TextItem) => ({ page: drawing.page, citation: citationAt(doc, item.start, 12) });

  // The pitch is tagged with the number of GAPS, which a vendor counts either
  // per side or across both. An INA240 writes 6X on an eight-pin part (three
  // gaps a side, six in total) and an LMP7704-SP writes 6X on a fourteen-pin
  // part (seven a side, six gaps a side). Both forms are accepted and nothing
  // else is, so the count still has to be arithmetic on the pin count.
  const pitch =
    pinCount !== null
      ? groups.find(
          (group) =>
            group.values.length === 1 &&
            (group.count === pinCount - 2 || group.count === pinCount / 2 - 1)
        )
      : undefined;

  // The lead width is the tagged max/min pair inside the physical range. The
  // count is usually the pin count exactly, but not always (LMP7704-SP tags
  // eight on a fourteen-lead part), so the range is what confirms it rather than
  // the count.
  const width = groups.find(
    (group) =>
      group.values.length === 2 &&
      group.values[0] >= LEAD_WIDTH_MIN &&
      group.values[1] <= LEAD_WIDTH_MAX
  );

  return {
    page: drawing.page,
    code: drawing.code,
    pitchMm: pitch ? { value: pitch.values[0], ...drawn(pitch.item) } : null,
    leadWidthMm: width
      ? { value: { minMm: width.values[0], maxMm: width.values[1] }, ...drawn(width.item) }
      : null
  };
}
