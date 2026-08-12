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

/**
 * Widest a lead may be as a fraction of its pitch. Mirrors the guard of the same
 * name in `packages.ts`; see the note at the width reader below.
 */
const MAX_LEAD_WIDTH_FRACTION_OF_PITCH = 0.75;





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
 * Whether a count tag on a pitch label is arithmetic on this part's pin count.
 *
 * Four forms, and every one of them is printed in the corpus. The first two were
 * here from the start; the last two were found on 2026-08-10 by dumping the
 * tagged labels on the pages where pitch came back null, and each cost a part
 * its drawing:
 *
 *   pinCount - 2   both rows of a dual package, gaps counted across the part
 *   pinCount/2 - 1 one row of a dual package, gaps counted per side
 *   pinCount - 4   all four rows of a QUAD package: 4 sides x (perSide - 1).
 *                  An MSP430F5529 is 80 pins in an LQFP and tags `76X 0.5`.
 *   pinCount       the vendor tags the pitch with the LEAD count rather than
 *                  the gap count. An ADS8688 is 38 pins and tags `38 X 0.5`.
 *
 * Still arithmetic on the pin count, which is the whole point of the check: a
 * number that matches none of these is not this part's pitch, and the drawing is
 * full of other count-tagged labels that would be read as one.
 */
function isGapCount(count: number, pinCount: number): boolean {
  return (
    count === pinCount - 2 ||
    count === pinCount / 2 - 1 ||
    count === pinCount - 4 ||
    count === pinCount
  );
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
    return {
      page: drawing.page,
      code: drawing.code,
      pitchMm: null,
      leadWidthMm: null
    };
  }

  const drawn = (item: TextItem) => ({ page: drawing.page, citation: citationAt(doc, item.start, 12) });

  // The pitch is tagged with the number of GAPS, which a vendor counts either
  // per side or across both. An INA240 writes 6X on an eight-pin part (three
  // gaps a side, six in total) and an LMP7704-SP writes 6X on a fourteen-pin
  // part (seven a side, six gaps a side). Both forms are accepted and nothing
  // else is, so the count still has to be arithmetic on the pin count.
  const pitch =
    pinCount !== null
      ? groups.find((group) => group.values.length === 1 && isGapCount(group.count, pinCount))
      : undefined;

  // The lead width is a tagged max/min pair inside the physical range. The count
  // is usually the pin count exactly, but not always (LMP7704-SP tags eight on a
  // fourteen-lead part), so the range is what confirms it rather than the count.
  //
  // Taking the FIRST such pair was wrong, and it read an ADS1115's DYN0010A
  // wrong: that drawing tags four pairs in range, and document order put the
  // 0.25-0.45 one first. The width is 0.18-0.30. The others are the lead
  // thickness (0.08-0.18), the terminal contact (0.35-0.55) and the lead
  // protrusion (0.25-0.45), and nothing in the text distinguishes them by name.
  //
  // Two facts about a lead do distinguish them, and both are physical rather
  // than typographic:
  //
  //   A lead cannot occupy most of its pitch, or neighbours would bridge in
  //   reflow. Measured over every drawing read here the width runs 40-60% of the
  //   pitch, and the misread sat at 90%.
  //
  // What is left after that test is not always one pair, and where it is not,
  // this reader says so instead of choosing. Taking the largest was tried and
  // was WRONG: an OPA2277's DRM0008A leaves 0.23-0.38 and 0.30-0.50, the width
  // is the smaller, and the rule picked the terminal LENGTH. Taking the smallest
  // fails the other way on drawings that tag the lead thickness.
  //
  // The two are separated by which DIRECTION the dimension runs: a lead's width
  // is measured along the row, its length across it. That is carried by the
  // arrows, which are graphics. This is the same wall the lead span ran into
  // below, for the same reason, and the answer is the same: read it off the
  // RENDERED page, where the arrows are visible, rather than guess here. A null
  // is what puts the field in front of that reader, since a field the
  // deterministic pass has filled is never asked about again.
  //
  // Where no pitch was read there is nothing to take a fraction of, so the
  // original first-match behaviour stands rather than a second guess.
  const inRange = groups.filter(
    (group) =>
      group.values.length === 2 &&
      group.values[0] >= LEAD_WIDTH_MIN &&
      group.values[1] <= LEAD_WIDTH_MAX
  );
  const pitchMm = pitch?.values[0];
  const plausible = pitchMm
    ? inRange.filter((group) => group.values[1] <= MAX_LEAD_WIDTH_FRACTION_OF_PITCH * pitchMm)
    : [];
  const width = pitchMm ? (plausible.length === 1 ? plausible[0] : undefined) : inRange[0];

  // The LEAD SPAN is still not read here, and an attempt on 2026-08-10 was
  // reverted rather than shipped. It is recorded because the idea is an obvious
  // one to try again.
  //
  // A drawing prints the span, the body length and the body width as three bare
  // max-over-min pairs. Nothing in the TEXT says which is which; the arrows do,
  // and they are graphics. The rule tried was that only the body has to be long
  // enough to hold its row of leads, so `(perSide - 1) * pitch` should pick it
  // out and leave the span as the largest of the rest.
  //
  // It reads DYN0010A backwards. An ADS1115's row is exactly 2.0 mm and its body
  // WIDTH is 2.0-2.2, so the width cleared the row test and was taken for the
  // body; the span then came back 2.8-3.0, which is the body LENGTH, when the
  // real span is 2.7-2.9. The part exported, and its pads would have been placed
  // on a dimension that runs the other way across the package.
  //
  // A footprint built from the wrong dimension is the exact failure this module
  // exists to prevent, and it is worse than the refusal it replaced because it
  // looks like an answer. Reading the span needs a signal that says which
  // DIRECTION a dimension runs, and the text layer does not carry one.
  return {
    page: drawing.page,
    code: drawing.code,
    pitchMm: pitch ? { value: pitch.values[0], ...drawn(pitch.item) } : null,
    leadWidthMm: width
      ? { value: { minMm: width.values[0], maxMm: width.values[1] }, ...drawn(width.item) }
      : null
  };
}
