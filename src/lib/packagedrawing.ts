import type { DatasheetText, PageText } from "./pdftext";
/**
 * Words that appear in a package designator without naming a family.
 *
 * Moved here on 2026-08-14 from `pintable.ts`, which was deleted with the rest
 * of the deterministic parser. This module is its only surviving caller.
 */
const NOT_A_FAMILY = new Set(["PIN", "PINS", "LEAD", "LEADS", "PACKAGE", "TOP", "VIEW", "AND", "WITH"]);

/** The family tokens inside a designator, e.g. `SOIC` out of `8-Pin SOIC (D)`. */
function packageFamilies(designator: string): string[] {
  return (designator.toUpperCase().match(/[A-Z][A-Z0-9]{1,9}/g) ?? []).filter(
    (word) => /[A-Z]{2}/.test(word) && !NOT_A_FAMILY.has(word)
  );
}

/**
 * Locates the package outline drawing in a datasheet.
 *
 * ## What this is for
 *
 * Some numbers a footprint needs are printed only inside the mechanical
 * drawing, and the text layer of a drawing is a bag of values with no way to
 * tell which one is the lead width: the arrows that carry that meaning are
 * graphics. Two attempts to pair a value to its dimension line by geometry were
 * measured and both failed, so for now the honest answer when a value cannot be
 * read is to ask the person, and the least friction way to ask is to put the
 * page in front of them rather than make them hunt for it.
 *
 * That is all this module does: say which page to show. It reads nothing off the
 * drawing and infers nothing from it.
 *
 * ## Why the text layer is enough to FIND the page
 *
 * The runtime parser has no access to the vector content, only to text items
 * with coordinates. That turns out to be sufficient, because a mechanical
 * drawing is unlike every other page in a datasheet in one measurable way: it is
 * dense with bare numbers. A page of prose has almost none, a parameter table
 * has them in a column with units and headings, and a drawing has dozens
 * scattered across it with nothing else.
 *
 * Measured over the 40-part benchmark cache: **29 of 40** parts get a drawing
 * page. The eleven it misses are the parts whose datasheets print no mechanical
 * drawing at all (the rad-hard specialists and the connector), the two whose
 * drawings are raster images with no text layer to count, and a few whose
 * drawings sit under a heading not listed here.
 */

/**
 * Headings a vendor puts on the page carrying the mechanical drawing. TI and ST
 * use the first two, ADI the third; the fourth is rarer but appears on
 * Microchip and Renesas parts.
 */
const DRAWING_HEADING =
  /PACKAGE\s+OUTLINE|MECHANICAL\s+DATA|OUTLINE\s+DIMENSIONS|PACKAGE\s+DRAWING/i;

/**
 * How few distinct columns a page's numbers may occupy, per value, before it is
 * a TABLE rather than a drawing.
 *
 * The mechanical section carries more than the package. TI files the shipping
 * material there too, so a tape carrier, a reel, a cardboard box and a table of
 * box sizes all sit under the same heading and all are dense with numbers. A
 * TLV9061 ranked its TAPE AND REEL BOX page first and an LM358 ranked a shipping
 * table with 173 values, and both even named the package, because shipping is
 * specified per package.
 *
 * A word list was tried first and it is the wrong instrument: there is no end to
 * the things a vendor files under mechanical data. What separates them is how
 * the numbers sit on the page. A table reuses the same handful of x positions
 * for every value it holds; a drawing gives nearly every value its own, because
 * each annotates a different feature. Distinct columns per value, measured:
 *
 *     real drawings   0.38  0.41  0.50  0.54  0.57  0.59
 *     tables          0.03  0.08  0.22
 *
 * Scale-invariant on purpose. The first version of this test asked what share of
 * values sat in the five densest columns, which is meaningless on a sparse
 * drawing: an SN65HVD230 outline has thirteen values, so five columns cover them
 * all by arithmetic, and it was thrown away.
 *
 * Threshold 0.3 sits in the measured gap. It was 0.2 first, and a UCC27524
 * PACKAGE MATERIALS page scored 0.22 and outranked the real SOIC outline, which
 * cost the drawing reader that part entirely.
 *
 * Found by RENDERING the page the ranking chose. Its text reads perfectly well.
 */
const MIN_COLUMNS_PER_VALUE = 0.3;

/** Column width for that test, matching the pin table's column tolerance. */
const COLUMN_TOLERANCE = 6;

/** A bare dimension value. Units, tolerances and prose are excluded by shape. */
const DIMENSION_VALUE = /^\(?\d{1,3}(?:\.\d{1,3})?\)?$/;

/**
 * The package code a drawing is titled with: `D0008A`, `DW0016B`, `PW0008A`.
 *
 * This is the strongest package identity in the document and it is worth more
 * than the prose designator, for two reasons. It names the exact JEDEC outline
 * rather than a family (`D` and `DW` are both "SOIC" in prose and differ by
 * 4.3 mm of lead span), and its four digits are the LEAD COUNT, which is
 * checkable arithmetic against the pin count already extracted rather than
 * another claim to be taken on trust.
 *
 * Shape is one to four letters, four digits, one revision letter. Anchored to
 * the page title so a code mentioned in a cross-reference elsewhere on the page
 * cannot stand in for the drawing's own.
 */
const PACKAGE_CODE = /\b([A-Z]{1,4})(\d{4})([A-Z])\b/;

/**
 * How many bare values a page must carry before it is a drawing rather than a
 * mention of one. Eight is well clear of both sides of the split measured on the
 * corpus: a contents entry or a revision-history line carries none, and the
 * thinnest real drawing carries twelve.
 */
const MIN_DIMENSION_VALUES = 8;

/**
 * How many other drawing pages to offer. A TI datasheet covering several
 * packages prints an outline, a land pattern and a stencil page for each, so the
 * raw list runs to nineteen on a TLV9061 and is useless at that length. The
 * first is the one to show; these are for a user who says it is the wrong one.
 */
const MAX_ALTERNATES = 4;

export interface PackageCode {
  /** The whole code as printed, e.g. `DW0016B`. */
  code: string;
  /** The outline prefix, e.g. `DW`. This is what identifies the family. */
  prefix: string;
  /** Lead count encoded in the four digits, e.g. 16. */
  leadCount: number;
}

export interface PackageDrawing {
  /** 1-based page number, for rendering the page to the user. */
  page: number;
  /** How many bare dimension values it carries. Higher is a denser drawing. */
  valueCount: number;
  /** True when the page names the package the part was extracted as. */
  namesPackage: boolean;
  /**
   * The code this drawing is titled with, when it prints one. Null for vendors
   * that do not use the convention, which is not an error: it means this
   * particular cross-check is unavailable, not that the drawing is wrong.
   */
  code: PackageCode | null;
  /**
   * Other pages that also look like drawings. A datasheet covering several
   * packages prints one per package, and nothing here reads them, so they are
   * offered rather than chosen between.
   */
  alternatePages: number[];
}

function dimensionValues(page: PageText) {
  return page.items.filter((item) => DIMENSION_VALUE.test(item.str.trim()));
}

/**
 * How far past the heading the drawing's own code sits. It is the next token
 * after the title on every drawing in the corpus (`PACKAGE OUTLINE DW0016B`),
 * and the window keeps a code cited in a note further down the page from being
 * read as this drawing's identity.
 */
const CODE_REACH = 40;

function readPackageCode(page: PageText): PackageCode | null {
  const heading = DRAWING_HEADING.exec(page.text);
  if (!heading) return null;
  const window = page.text.slice(heading.index, heading.index + heading[0].length + CODE_REACH);
  const match = PACKAGE_CODE.exec(window);
  if (!match) return null;
  const leadCount = Number(match[2]);
  // A code whose digits are not a plausible lead count is not a package code.
  if (!Number.isInteger(leadCount) || leadCount < 2 || leadCount > 2000) return null;
  return { code: match[0], prefix: match[1], leadCount };
}

/**
 * Whether a page names this family, allowing for how a vendor punctuates it.
 *
 * `\bLQFP64\b` cannot match a page that prints `LQFP-64` or `LQFP 64`, because
 * the digits are part of the needle and the separator is not. LEARNINGS records
 * the mirror of this trap (`\bLQFP\b` cannot match `LQFP64`, three instances in
 * two days); this is the same word-boundary problem with the digits on the other
 * side. The cost is not a refusal but something quieter: `namesPackage` is the
 * first ranking key, so a miss drops the page that describes the requested
 * package below whichever drawing simply carries more numbers, which the comment
 * on `findPackageDrawing` records as measurably picking the WRONG package.
 *
 * So the family word and its digits are matched with any punctuation or space
 * between them, and with a boundary on each end so `SO` still cannot match
 * `SOIC`.
 */
function namesFamily(text: string, family: string): boolean {
  const split = /^([A-Z]+)(\d+)$/.exec(family);
  const pattern = split ? `${split[1]}[\\s-]?${split[2]}` : family;
  return new RegExp(`\\b${pattern}\\b`, "i").test(text);
}

/** Distinct columns per value. Low means the values are stacked in a table. */
function columnsPerValue(values: PageText["items"]): number {
  if (values.length === 0) return 0;
  const columns = new Set(values.map((value) => Math.round(value.x / COLUMN_TOLERANCE)));
  return columns.size / values.length;
}

/**
 * The page most likely to carry the package outline drawing, or null when the
 * datasheet prints none.
 *
 * Ranked by whether the page names the package this part was extracted as, then
 * by how many dimension values it carries. A datasheet mentions its mechanical
 * section in the contents and again in the revision history before reaching the
 * drawing itself, and those mentions carry no numbers, which is the same failure
 * the pin-section reader hit and is separated here the same way.
 */
export function findPackageDrawing(
  doc: DatasheetText,
  packageType?: string
): PackageDrawing | null {
  // The package the part was extracted as, which is what decides WHICH drawing
  // to show. Density alone is the wrong key and the corpus says so: a TLV9061 is
  // a five-pin SOT-23 and the densest drawing in its datasheet belongs to the
  // sixteen-pin quad, because more pins means more dimensions.
  const families = packageType ? packageFamilies(packageType) : [];

  const candidates = doc.pages
    .filter((page) => DRAWING_HEADING.test(page.text))
    .map((page) => {
      const values = dimensionValues(page);
      return {
        page: page.page,
        valueCount: values.length,
        columnsPerValue: columnsPerValue(values),
        namesPackage: families.some((family) => namesFamily(page.text, family)),
        code: readPackageCode(page)
      };
    })
    .filter(
      (candidate) =>
        candidate.valueCount >= MIN_DIMENSION_VALUES &&
        candidate.columnsPerValue >= MIN_COLUMNS_PER_VALUE
    )
    .sort(
      (left, right) =>
        Number(right.namesPackage) - Number(left.namesPackage) ||
        right.valueCount - left.valueCount ||
        left.page - right.page
    );

  if (candidates.length === 0) return null;

  return {
    page: candidates[0].page,
    valueCount: candidates[0].valueCount,
    namesPackage: candidates[0].namesPackage,
    code: candidates[0].code,
    alternatePages: candidates.slice(1, 1 + MAX_ALTERNATES).map((candidate) => candidate.page)
  };
}
