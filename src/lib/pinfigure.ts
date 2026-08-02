import { hasPrintedOrder, type DatasheetText, type PageText, type TextItem } from "./pdftext";
import { packageFamilies, splitSpacedRun } from "./pintable";

/**
 * Pinout figures, read from the page's geometry rather than from its text.
 *
 * ## Why a second figure reader
 *
 * `extractPinDiagram` in `datasheet.ts` reads the same figures out of the
 * flattened text, and it works: six parts no table parse could read give a
 * complete pinout there. But it depends on the figure surviving flattening as
 * `NAME n m NAME` on one line, and most do not. Instrumenting every rejection
 * path over the benchmark cache put a number on it: of the pages that reach the
 * table reader and are refused, the largest group by far are pinout figures, and
 * the text reader had already declined all of them.
 *
 * The information that recovers them is the same information that recovered the
 * pin TABLE: x and y, which `pdftext.ts` has been carrying on every item all
 * along.
 *
 * ## The proof, which is the whole reason this is allowed to exist
 *
 * A two-column top view numbers its left column upward and its right column
 * downward, so on every row `left + right` is the same constant, and that
 * constant is `pinCount + 1`. Both numbers are then bounded by the sum, so a
 * figure yielding `sum - 1` distinct numbers has yielded exactly 1..N with no
 * gaps. Prose does not do that by accident, and neither does an axis or a table
 * of values, because those do not pair up to a constant.
 *
 * Numbers alone are still not enough, and the corpus said so: an AD590 page one
 * has a perfectly self-consistent eight-number pair. Every number must also carry
 * a NAME beside it, which is what a pinout figure has and a numeric layout does
 * not.
 *
 * ## What it deliberately does NOT do
 *
 * It does not set the pin count on its own. A figure proves the figure is
 * complete; it does not prove the figure is the PACKAGE the caller wants, and
 * a datasheet routinely draws several. The same AD590 draws an eight-pin SOIC
 * while declaring a two-lead flatpack, and an AD8628 draws both an eight-pin
 * SOIC and a five-pin TSOT. Both are true. So this reports pins and leaves the
 * count to be corroborated by the document's own declared count, exactly as the
 * geometry table does. See `extractPins`.
 *
 * Odd, non-symmetric packages are out of reach by construction: a five-pin SOT
 * has three leads down one side and two down the other, so no constant sum
 * exists. That is a limit of the proof, not an oversight.
 *
 * ## Four-sided figures, which the constant sum also cannot reach
 *
 * A QFP or QFN is drawn as a rectangle with pins down all four edges, and
 * nothing in it pairs up: the left column runs 1..25, the bottom row 26..50, the
 * right column 51..75 and the top row 76..100, so no two numbers sum to a
 * constant. `readQuadFigure` proves such a figure a different way, by TILING —
 * see the note on that function.
 */

/** How far apart two x positions may be and still be the same column. */
const COLUMN_TOLERANCE = 6;

/** How far apart two numbers may sit vertically and still be the same row. */
const ROW_TOLERANCE = 3;

/**
 * How far from its number a name may sit. Generous because a figure puts the
 * name outside the package outline, but bounded so the opposite figure on a
 * two-up page cannot be read as this one's names.
 */
const NAME_REACH = 90;

/** Two rows is the smallest thing that can be a two-column figure at all. */
const MIN_PAIRS = 2;

/**
 * Numbers a side of a four-sided figure must carry. Two per side is the smallest
 * thing that is a rectangle rather than four corner labels, and it puts the
 * smallest readable quad at eight pins.
 */
const MIN_QUAD_SIDE = 2;

/**
 * Numbers a candidate EDGE must gather before it is worth trying as a side.
 *
 * Higher than the side minimum on purpose. Where two ladders interleave, one
 * number of each lands within tolerance of the other and seeds a pair that
 * spreads right across the page; requiring four keeps those out, since a real
 * pair of neighbours from the crossing ladder is only ever two. It also bounds
 * the search, which is quadratic in the number of candidate edges.
 *
 * The cost is stated rather than hidden: an eight-pin part drawn four-sided, two
 * pins to an edge, is out of reach here. Those are read by the two-column reader,
 * which runs first and whose constant-sum proof handles them.
 */
const MIN_QUAD_LINE = 4;

/**
 * Ceiling on the rectangles tried on one page. Every candidate side has already
 * had to be a contiguous run of integers, which on a real page leaves a handful;
 * this is only here so that a pathological page cannot make the search quadratic
 * in something unbounded.
 */
const MAX_QUAD_RECTANGLES = 4000;

/**
 * How far apart two runs of ONE rotated name may sit across their shared
 * baseline.
 *
 * Tight on purpose, because it has to separate a name's own parts from the name
 * next to it: on an STM32F407 LQFP144 figure `V` sits at x=139 with its
 * subscript `DD` at x=141, while the next pin's name is a full pin pitch away.
 */
const ROTATED_NAME_X_TOLERANCE = 4;

/** How a vendor opens a figure or table caption. Never how a pin name opens. */
const CAPTION_LABEL = /^(?:figure|table)\s+\d/i;

/** Longest a pin name may be. Beyond this it is prose that drifted in. */
const MAX_NAME_LENGTH = 24;

/**
 * Fraction of rows that may carry text between the two number columns before the
 * pair is judged to span two different figures rather than one package. A
 * package outline holds a label on a row or two; a neighbouring figure's names
 * are on every row.
 */
const MAX_LABELLED_ROWS = 0.6;

/** How far apart two baselines may be and still be the same printed line. */
const LINE_TOLERANCE = 2;

/**
 * How far from a figure its caption may sit, as a multiple of the text height.
 * Measured from the corpus: REF5025's sits 42 units above its figure, INA240's
 * 54 below.
 */
const CAPTION_REACH = 9;

export interface FigurePin {
  number: number;
  name: string;
  /** Offset into the document text, for the citation. */
  start: number;
}

export interface PinFigure {
  pins: FigurePin[];
  page: number;
  start: number;
  /**
   * The caption printed with the figure, which names the package it draws and
   * often the device too: `INA240 PW Package 8-Pin TSSOP Top View`. Empty when
   * the figure carries none.
   */
  caption: string;
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Closes a space a figure typeset INSIDE one pin name, between letters and the
 * digits that finish it.
 *
 * An STM32F407 LQFP100 figure prints pin 70 as `PA 11` while printing `PA10` and
 * `PA12` either side of it, and that space is kerning, not a name. Left in, the
 * net is called `PA 11` and matches nothing else in the design.
 *
 * Bounded to a letter followed by digits, which is what separates it from a
 * space that IS part of the name: an LMP7704-SP's `OUT A` and an OPA2277's
 * `+In B` are the vendor's own names for the channels of a multi-channel part,
 * both of them letter-space-LETTER, and both are on shipping parts guarded by
 * the pin-name oracle.
 */
function closeKernedDigits(text: string): string {
  return text.replace(/([A-Za-z])\s+(\d)/g, "$1$2");
}

function isInteger(text: string): boolean {
  return /^\d{1,3}$/.test(text);
}

/**
 * How many times the typical row spacing a vertical gap must exceed before it is
 * a gap BETWEEN figures rather than between rows of one.
 *
 * A package's number column is evenly spaced, so its own gaps are all about the
 * row pitch. Measured on PCF8574 page 3, whose four figures are laid out two by
 * two: the rows inside a figure sit 11 to 13 units apart and the nearest gap
 * between figures is over 100.
 */
const RUN_GAP_FACTOR = 2.5;

/**
 * Splits a column into vertically contiguous runs.
 *
 * Clustering integers by x alone is not enough, and this was the single largest
 * cause of unread pinouts in the corpus. A page drawing several packages puts
 * their number columns at similar x, and within the column tolerance they merge
 * into one band that belongs to no figure. PCF8574 page 3 draws FOUR figures and
 * the merged band produced a pair whose every row summed to 21, correctly, and
 * yielded 24 numbers for a 20-pin part: the constant-sum proof passed and the
 * completeness test then refused the whole page.
 *
 * Splitting on the row pitch separates them, and it is the figure's own geometry
 * that says where: a column of pin numbers is evenly spaced, so a gap several
 * times the median is not the next pin, it is the next figure.
 */
function verticalRuns(band: TextItem[]): TextItem[][] {
  const sorted = [...band].sort((left, right) => right.y - left.y);
  if (sorted.length < 3) return [sorted];

  const gaps: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    gaps.push(sorted[index - 1].y - sorted[index].y);
  }
  const ordered = [...gaps].sort((left, right) => left - right);
  const median = ordered[Math.floor(ordered.length / 2)];
  if (!(median > 0)) return [sorted];

  const runs: TextItem[][] = [];
  let current: TextItem[] = [sorted[0]];
  for (let index = 1; index < sorted.length; index += 1) {
    if (gaps[index - 1] > median * RUN_GAP_FACTOR) {
      runs.push(current);
      current = [sorted[index]];
    } else {
      current.push(sorted[index]);
    }
  }
  runs.push(current);
  return runs;
}

/** Vertical bands of integers, which is what a figure's two number columns are. */
function integerBands(items: TextItem[]): TextItem[][] {
  const integers = items
    .filter((item) => isInteger(clean(item.str)))
    .sort((left, right) => left.x - right.x);

  const bands: TextItem[][] = [];
  let current: TextItem[] = [];
  for (const item of integers) {
    if (current.length === 0 || item.x - current[current.length - 1].x <= COLUMN_TOLERANCE) {
      current.push(item);
    } else {
      bands.push(current);
      current = [item];
    }
  }
  if (current.length > 0) bands.push(current);

  return bands.flatMap(verticalRuns).filter((band) => band.length >= MIN_PAIRS);
}

/**
 * The name printed beside a pin number, on the outside of the package outline.
 *
 * Everything on the number's baseline on the given side is taken and joined in x
 * order without spaces, because a name arrives in as many runs as its typesetting
 * needs: `V` then `IN` for VIN, `V` then `OUT` for VOUT.
 */
function nameBeside(items: TextItem[], number: TextItem, side: "left" | "right"): string {
  const onSide = items.filter((item) => {
    if (item === number) return false;
    if (!clean(item.str) || isInteger(clean(item.str))) return false;
    // A run drawn in an order its string does not describe cannot be read as a
    // name; see `hasPrintedOrder`. Dropped rather than repaired, so the name
    // comes up short and the figure refuses.
    if (!hasPrintedOrder(item)) return false;
    return side === "left"
      ? item.x < number.x && number.x - item.x <= NAME_REACH
      : item.x > number.x && item.x - number.x <= NAME_REACH;
  });

  // The run is ANCHORED on the pin's own baseline, and only the anchor has to be
  // there. A subscript sits below it, by an amount set by the font of the name
  // rather than by the number's: `VCC` is `V` at height 9 with `CC` under it, and
  // the number beside them is height 6. Measured on one SN74LVC1G08 page the drop
  // is 2.27 in the figure at the top and 3.38 in the one below, so a flat
  // tolerance of 3 sat between them, the same part read as `VCC` in one figure and
  // `V` in the other, and the page was refused for disagreeing with itself.
  const beside = onSide.filter((item) => Math.abs(item.y - number.y) <= ROW_TOLERANCE);
  if (beside.length === 0) return "";

  // A name is a CONTIGUOUS RUN. It may sit far from its number, because the
  // package outline is drawn between them, but its own parts are touching: `V`
  // then `CC`, `V` then `ref`. The neighbouring figure's name is beyond a gap.
  //
  // Reach alone is not enough and the corpus says so. An SN74LVC1G08 page draws
  // FOUR packages side by side about 100 units apart, so a 90 unit reach crosses
  // into the next one: pin 1 came back called `YA`, which is the DRL figure's `Y`
  // with the DSF figure's `A` after it, and pin 3 `CCGND`. Taking only the run
  // nearest the number leaves each figure with its own names.
  const ordered = [...beside].sort(
    (left, right) =>
      (side === "left" ? number.x - (left.x + left.width) : left.x - number.x) -
      (side === "left" ? number.x - (right.x + right.width) : right.x - number.x)
  );

  // Adjacency is measured against the font size rather than a constant, so this
  // holds at any scale the figure is drawn at.
  const anchor = ordered[0];
  const limit = Math.max(anchor.height, 6);
  // A subscript belongs to the run when it is x-adjacent to it and within about
  // two thirds of the ANCHOR's own font size vertically. Rows on these figures sit
  // 13 or more apart, so this cannot reach the row below, and x-adjacency is still
  // required either way.
  // Capped well under any real row pitch, because the reported height is not
  // reliably the font size: on an ADG5412 figure the name runs come back tall
  // enough that seven tenths of them reaches the row below, and pin 1 merged into
  // `IN1D1S1`. A subscript never sits further than this.
  const drop = Math.min(anchor.height * 0.7, ROW_TOLERANCE * 1.5);
  const run = [anchor];
  let low = anchor.x;
  let high = anchor.x + anchor.width;

  for (const item of onSide) {
    if (run.includes(item)) continue;
    if (Math.abs(item.y - anchor.y) > drop) continue;
    const gap = item.x >= high ? item.x - high : low - (item.x + item.width);
    if (gap > limit) continue;
    run.push(item);
    low = Math.min(low, item.x);
    high = Math.max(high, item.x + item.width);
  }

  const joined = clean(
    run
      .sort((left, right) => left.x - right.x)
      .map((item) => item.str)
      .join("")
  )
    // A footnote marker is punctuation about the figure, not part of the pin. An
    // OPA333 labels its unconnected pins `NC(1)`, and `NC(1)` is not a net.
    .replace(/\(\d{1,2}\)$/, "")
    .trim();

  return closeKernedDigits(joined);
}

/**
 * A line that reads like a figure caption rather than like the page around it.
 *
 * Vendors caption a pinout with the package it draws, and usually the device as
 * well: `INA240 PW Package`, `8-Pin TSSOP`, `OPA333 D Package`, `HKJ Package`.
 * Requiring one of those two shapes is what stops a body-text line that happens
 * to sit near the figure from being read as its caption.
 *
 * `pinout` and `ballout` are here because a four-sided figure is captioned with
 * neither of the other two forms: ST writes `Figure 13. STM32F40xxx LQFP100
 * pinout`, which names the device and the package and contains the word
 * `package` nowhere. Without it the only line on that page this recognised was
 * the footnote underneath, `The above figure shows the package top view`, which
 * names nothing and left the figure looking unlabelled.
 */
const FIGURE_CAPTION = /\bpackage\b|\b\d{1,3}[-\s]?(?:pin|lead)\b|\b(?:pin|ball)out\b/i;

/**
 * A device named in a caption. Anything with a digit in it, which is what
 * separates `OPA2333` from the `DRB` and `SOIC` beside it.
 */
const CAPTION_DEVICE = /\b[A-Z][A-Z0-9]{2,}(?:-[A-Z0-9]+)*\b/g;

/** Groups a page's items into printed lines. */
function pageLines(items: TextItem[]): { y: number; items: TextItem[] }[] {
  const sorted = [...items].sort((left, right) => right.y - left.y);
  const lines: { y: number; items: TextItem[] }[] = [];

  for (const item of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - item.y) <= LINE_TOLERANCE) last.items.push(item);
    else lines.push({ y: item.y, items: [item] });
  }

  return lines;
}

/**
 * The caption belonging to one figure.
 *
 * Searched ABOVE and BELOW, because vendors do both and the corpus has one of
 * each on the same kind of page: REF5025 prints `HKJ Package` above its figure,
 * INA240 prints `INA240 PW Package 8-Pin TSSOP` below its own. The nearest
 * qualifying line in either direction wins.
 *
 * Restricted to the figure's own horizontal extent, which is what keeps two
 * figures printed side by side from sharing a caption: their captions are on the
 * SAME line, one after the other, so only x separates them.
 */
function captionFor(page: PageText, figureItems: TextItem[]): string {
  // The extent is the numbers widened by the reach the NAMES occupy, because a
  // caption is set to the width of the whole drawing rather than to its pin
  // numbers. Measured on INA240: its `8-Pin TSSOP` sits five units outside the
  // number columns, so an extent taken from the numbers alone misses the very
  // token that distinguishes that figure from the SOIC beside it.
  const left = Math.min(...figureItems.map((item) => item.x)) - NAME_REACH;
  const right = Math.max(...figureItems.map((item) => item.x + item.width)) + NAME_REACH;
  const top = Math.max(...figureItems.map((item) => item.y));
  const bottom = Math.min(...figureItems.map((item) => item.y));
  const reach = Math.max(...figureItems.map((item) => item.height), 1) * CAPTION_REACH;

  // Every qualifying line within reach, not just the nearest, because vendors
  // break a caption across lines and put the parts that matter on different
  // ones: an OPA333 page four names the device on one line (`OPA2333 D or DGK
  // Package`) and the package on the next (`8-Pin SOIC or VSSOP`). Reading only
  // the nearer line left the figure looking like an unlabelled one.
  return clean(
    pageLines(page.items)
      .filter((line) => {
        if (line.y <= top && line.y >= bottom) return false;
        const distance = line.y > top ? line.y - top : bottom - line.y;
        return distance <= reach;
      })
      .map((line) =>
        clean(
          line.items
            .filter((item) => item.x + item.width / 2 >= left && item.x + item.width / 2 <= right)
            .sort((first, second) => first.x - second.x)
            .map((item) => item.str)
            .join(" ")
        )
      )
      .filter((text) => FIGURE_CAPTION.test(text))
      .join(" ")
  );
}

/**
 * Reads every complete pinout figure on one page.
 *
 * A page can hold several: a datasheet draws one per package, and TI prints two
 * side by side.
 *
 * Four-sided figures are read only when the two-column reader found NOTHING on
 * the page. The two readers describe the same drawing in different ways, and
 * where both have an answer the established one is the answer: it has the
 * corpus behind it, and a page that yields a two-column figure AND a rectangle
 * is a page this reader does not understand well enough to arbitrate. Adding
 * the quad only where the page is otherwise silent is what makes it unable to
 * take a part away.
 */
export function readFiguresFromPage(page: PageText): PinFigure[] {
  const bands = integerBands(page.items);
  const figures: PinFigure[] = [];

  for (let a = 0; a < bands.length; a += 1) {
    for (let b = a + 1; b < bands.length; b += 1) {
      const figure =
        readFigure(page, bands[a], bands[b]) ??
        readCornerNumbered(page, bands[a], bands[b]) ??
        readAsymmetricFigure(page, bands[a], bands[b]);
      if (figure) figures.push(figure);
    }
  }

  if (figures.length === 0) figures.push(...readQuadFigures(page));

  return figures;
}

/**
 * A run that is nothing but space-separated integers, split into one item per
 * number.
 *
 * `splitSpacedRun` requires TWO spaces between parts, which is what stops it
 * cutting a phrase like `Main function` in half, and that bound is right for a
 * table. A figure breaks it: an STM32H743 LQFP144 pinout hands over its entire
 * bottom row, thirty-six numbers, as one run separated by SINGLE spaces, so that
 * edge carries no integer items and the rectangle has only three sides.
 *
 * Splitting on one space is safe HERE because of what is being required of the
 * run: every part of it is an integer, so there is no phrase to damage. A
 * description cannot qualify. The positions are the run's own width shared out by
 * character, which is exact for a row of equal-width numbers.
 */
const NUMBER_ROW = /^\d{1,3}(?: \d{1,3})+$/;

function splitNumberRow(item: TextItem): TextItem[] {
  const text = clean(item.str);
  if (!NUMBER_ROW.test(text)) return [item];

  const parts: TextItem[] = [];
  const pattern = /\d+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    parts.push({
      ...item,
      str: match[0],
      x: item.x + (match.index / text.length) * item.width,
      width: (match[0].length / text.length) * item.width
    });
  }

  return parts.length > 1 ? parts : [item];
}

/** Whether a set of numbers is a run of consecutive integers, in any order. */
function isRun(values: number[]): boolean {
  if (new Set(values).size !== values.length) return false;
  const sorted = [...values].sort((left, right) => left - right);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] !== sorted[index - 1] + 1) return false;
  }
  return true;
}

/** One edge of a candidate rectangle, and where it sits on the page. */
interface QuadSide {
  axis: "v" | "h";
  at: number;
}

/**
 * The edges a four-sided figure could be built from: positions where enough
 * integers share a coordinate to be a side.
 *
 * ## Why the seeds, rather than the chained clustering used everywhere else
 *
 * A quad figure prints two ladders at right angles and their coordinates
 * INTERLEAVE. On an STM32H743 LQFP144 pinout the top row's numbers sit at x=156,
 * 164, 173, 182 and the bottom row's at 152, 160, 169, 177, so every gap along x
 * is about four units, and a chain that admits each item within tolerance of the
 * PREVIOUS one links all 144 numbers into a single band that is neither a column
 * nor a row. Measured on that page: one band of 144.
 *
 * Seeding a candidate on each item and taking everything within tolerance of the
 * SEED keeps the two ladders apart, because membership stops at the seed's own
 * neighbourhood instead of walking.
 *
 * ## Why an edge must be longer than it is thick
 *
 * Two numbers from different ladders are always within tolerance of each other
 * somewhere, so a pair on its own says nothing. Requiring the members to spread
 * further ALONG the edge than across it is what makes a column a column.
 */
function quadSides(items: TextItem[]): QuadSide[] {
  const integers = items.filter((item) => isInteger(clean(item.str)));
  const sides: QuadSide[] = [];

  for (const [axis, across, along] of [
    ["v", (item: TextItem) => item.x, (item: TextItem) => item.y],
    ["h", (item: TextItem) => item.y, (item: TextItem) => item.x]
  ] as const) {
    const seen = new Set<number>();
    for (const seed of integers) {
      const members = integers.filter((item) => Math.abs(across(item) - across(seed)) <= COLUMN_TOLERANCE);
      if (members.length < MIN_QUAD_LINE) continue;

      const spreadAlong = Math.max(...members.map(along)) - Math.min(...members.map(along));
      const spreadAcross = Math.max(...members.map(across)) - Math.min(...members.map(across));
      if (spreadAlong <= spreadAcross) continue;

      const at = members.reduce((sum, item) => sum + across(item), 0) / members.length;
      const key = Math.round(at);
      if (seen.has(key)) continue;
      seen.add(key);
      sides.push({ axis, at });
    }
  }

  return sides;
}

/**
 * The name printed along a top or bottom row, which vendors set ROTATED.
 *
 * A rotated run's reported `width` is its length along its OWN baseline, which
 * runs up the page, so it says nothing about how wide the run is horizontally.
 * Pairing by horizontal overlap therefore reads the wrong name and does it
 * silently: on the STM32F407 LQFP100 figure it returned VDD for pins 98, 99 and
 * 100 alike, because three names overlap every number's reported extent. What
 * DOES line up is the left edge, which is the baseline both the number and its
 * name are set from.
 *
 * The parts of one name are then joined along that baseline in increasing y,
 * which is the reading direction of rotated text, so `V` at y=687 followed by
 * `DD` at y=692 reads VDD on a top row and on a bottom row alike.
 */
/**
 * The names printed along a top or bottom row, which vendors set ROTATED, paired
 * to that row's numbers.
 *
 * ## Why the whole row at once
 *
 * A rotated run's reported `width` is its length along its OWN baseline, which
 * runs up the page, so it says nothing about how wide the run is horizontally.
 * Pairing by horizontal overlap therefore reads the wrong name and does it
 * silently: on the STM32F407 LQFP100 figure it returned VDD for pins 98, 99 and
 * 100 alike, because three names overlap every number's reported extent.
 *
 * Pairing by nearest left edge fixes that figure and breaks the next one, for a
 * reason worth stating: a row whose numbers had to be recovered from a merged
 * run carries an ESTIMATED x. So the reliable statement is not about any one
 * name's position, it is that the names and the numbers are two ladders of the
 * same length and the same pitch. This pairs them in order and then checks that
 * the offset between them is constant, which is a measurement the wrong pairing
 * fails.
 *
 * Returns null rather than a partial answer, so a row that cannot be named
 * refuses the whole figure.
 */
function namesAlongRow(
  items: TextItem[],
  numbers: TextItem[],
  side: "above" | "below"
): Map<TextItem, string> | null {
  const ordered = [...numbers].sort((left, right) => left.x - right.x);
  const rowY = ordered.reduce((sum, item) => sum + item.y, 0) / ordered.length;
  const first = ordered[0].x;
  const last = ordered[ordered.length - 1].x;
  const pitch = ordered.length > 1 ? (last - first) / (ordered.length - 1) : COLUMN_TOLERANCE;

  // Candidates are name-shaped runs on the outer side of the row, within the
  // row's own span.
  //
  // The figure's own CAPTION sits inside that region on these pages and has to
  // be excluded by name, because the length bound does not reach it: STM32H743's
  // `Figure 7. LQFP144 pinout` is twenty-four characters, exactly the limit, and
  // it joined the ladder as a thirty-seventh name for thirty-six pins.
  const candidates = items.filter((item) => {
    const text = clean(item.str);
    if (!text || isInteger(text) || text.length > MAX_NAME_LENGTH) return false;
    if (CAPTION_LABEL.test(text)) return false;
    if (!hasPrintedOrder(item)) return false;
    if (!/[A-Za-z]/.test(text)) return false;
    const distance = side === "above" ? item.y - rowY : rowY - item.y;
    if (distance <= 0 || distance > NAME_REACH) return false;
    return item.x >= first - pitch && item.x <= last + pitch;
  });

  // One name may be drawn as several runs stacked along its own baseline, so
  // runs sharing an x are one name. Chained here rather than seeded because
  // names on a row are a pitch apart and a name's own parts are a couple of
  // units apart, which is a gap the chain cannot cross.
  const groups: TextItem[][] = [];
  for (const item of [...candidates].sort((left, right) => left.x - right.x)) {
    const current = groups[groups.length - 1];
    if (current && item.x - current[current.length - 1].x <= ROTATED_NAME_X_TOLERANCE) current.push(item);
    else groups.push([item]);
  }

  if (groups.length !== ordered.length) return null;

  // The two ladders have the same pitch, so pairing them by ORDER is exact even
  // where their x values do not coincide. That matters: a row whose numbers were
  // recovered from one merged run carries an estimated x, and on an STM32H743
  // LQFP144 figure that estimate sits a constant five units left of the names,
  // which is more than half the pin pitch. Matching each number to the nearest
  // name would have paired every one of them with its NEIGHBOUR.
  //
  // Requiring the offset to be CONSTANT is what makes pairing by order a
  // measurement rather than an assumption: two ladders of the same length that
  // are not the same ladder do not hold a fixed offset across their whole span.
  const offsets = groups.map((group, index) => group[0].x - ordered[index].x);
  const smallest = Math.min(...offsets);
  const largest = Math.max(...offsets);
  if (largest - smallest > COLUMN_TOLERANCE) return null;

  const names = new Map<TextItem, string>();
  for (let index = 0; index < ordered.length; index += 1) {
    const joined = clean(
      groups[index]
        .sort((left, right) => left.y - right.y)
        .map((item) => item.str)
        .join("")
    )
      .replace(/\(\d{1,2}\)$/, "")
      .trim();
    if (!joined) return null;
    names.set(ordered[index], closeKernedDigits(joined));
  }

  return names;
}

/**
 * Reads a four-sided pinout figure: a QFP, QFN or LCC drawn as a rectangle with
 * pins down all four edges.
 *
 * ## The proof
 *
 * The constant sum the two-column reader rests on does not exist here. What does
 * is a TILING: four sides, each numbering CONSECUTIVELY, which between them use
 * every number from 1 to N exactly once. An STM32F407 LQFP100 figure runs 1..25
 * down the left, 26..50 across the bottom, 51..75 up the right and 76..100 back
 * across the top, and four contiguous runs partitioning 1..N is not something a
 * page of axis ticks or callouts produces by accident.
 *
 * Every number must also carry a NAME, exactly as in the two-column reader and
 * for the same reason: a numeric layout can tile, and a pinout is the only thing
 * that labels each cell.
 *
 * ## Why the sides are LINES and each number is assigned to its nearest
 *
 * The four edges meet at corners, and a corner number sits on two of them at
 * once: on that same figure `50` ends the bottom row at x=441 while the right
 * column stands at x=442, so clustering alone puts it in both and the tiling
 * then fails on a duplicate. Assigning every number to the nearest of the four
 * lines gives each one exactly one side, and a genuine corner number resolves
 * cleanly because it sits ON one of the lines and merely near the other.
 */
function readQuadFigures(page: PageText): PinFigure[] {
  // Split once, and used for finding the sides AND for reading the names, so the
  // number items the tiling proof ran on are the same objects the names are
  // measured against.
  //
  // A figure merges a pin's name and number into one run as readily as a table
  // merges a row's cells: an STM32H743 LQFP144 figure hands over its whole left
  // column as `PE2   1`, `PE3   2`, so that side carries no integer items at all
  // and the rectangle has only three edges. This is the same split
  // `readContinuedTable` pays for the same reason, and it is applied HERE rather
  // than in `readFiguresFromPage` so that the two-column reader, which the corpus
  // is measured on, sees exactly what it saw before.
  const items = page.items.flatMap(splitSpacedRun).flatMap(splitNumberRow);

  const sides = quadSides(items);
  const vertical = sides.filter((side) => side.axis === "v");
  const horizontal = sides.filter((side) => side.axis === "h");
  if (vertical.length < 2 || horizontal.length < 2) return [];

  const integers = items.filter((item) => isInteger(clean(item.str)));
  const figures: PinFigure[] = [];
  let tried = 0;

  for (let a = 0; a < vertical.length; a += 1) {
    for (let b = a + 1; b < vertical.length; b += 1) {
      for (let c = 0; c < horizontal.length; c += 1) {
        for (let d = c + 1; d < horizontal.length; d += 1) {
          if (tried >= MAX_QUAD_RECTANGLES) return figures;
          tried += 1;
          const figure = readQuadFigure(page, items, integers, [
            vertical[a],
            vertical[b],
            horizontal[c],
            horizontal[d]
          ]);
          if (figure) figures.push(figure);
        }
      }
    }
  }

  return figures;
}

function readQuadFigure(
  page: PageText,
  items: TextItem[],
  integers: TextItem[],
  lines: QuadSide[]
): PinFigure | null {
  const groups: TextItem[][] = [[], [], [], []];

  for (const item of integers) {
    let nearest = -1;
    let best = COLUMN_TOLERANCE;
    for (let index = 0; index < lines.length; index += 1) {
      const distance =
        lines[index].axis === "v" ? Math.abs(item.x - lines[index].at) : Math.abs(item.y - lines[index].at);
      if (distance < best) {
        best = distance;
        nearest = index;
      }
    }
    if (nearest !== -1) groups[nearest].push(item);
  }

  if (groups.some((group) => group.length < MIN_QUAD_SIDE)) return null;

  // Each side numbers consecutively, and between them they use 1..N once each.
  const numbers = new Map<number, TextItem>();
  for (const group of groups) {
    const values = group.map((item) => Number(clean(item.str)));
    if (!isRun(values)) return null;
    for (const item of group) numbers.set(Number(clean(item.str)), item);
  }
  const total = groups.reduce((sum, group) => sum + group.length, 0);
  if (numbers.size !== total) return null;
  for (let value = 1; value <= total; value += 1) if (!numbers.has(value)) return null;

  // Which edge is which, so a name is looked for on the OUTSIDE of the package.
  const [firstVertical, secondVertical] = lines[0].at <= lines[1].at ? [0, 1] : [1, 0];
  const [topRow, bottomRow] = lines[2].at >= lines[3].at ? [2, 3] : [3, 2];
  const outward: Record<number, "left" | "right" | "above" | "below"> = {
    [firstVertical]: "left",
    [secondVertical]: "right",
    [topRow]: "above",
    [bottomRow]: "below"
  };

  const pins: FigurePin[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    const side = outward[index];

    if (side === "left" || side === "right") {
      for (const item of groups[index]) {
        const name = nameBeside(items, item, side);
        if (!name || name.length > MAX_NAME_LENGTH) return null;
        pins.push({ number: Number(clean(item.str)), name, start: item.start });
      }
      continue;
    }

    const named = namesAlongRow(items, groups[index], side);
    if (!named) return null;
    for (const item of groups[index]) {
      const name = named.get(item);
      if (!name || name.length > MAX_NAME_LENGTH) return null;
      pins.push({ number: Number(clean(item.str)), name, start: item.start });
    }
  }

  pins.sort((first, second) => first.number - second.number);
  return {
    pins,
    page: page.page,
    start: pins[0].start,
    caption: captionFor(page, groups.flat())
  };
}

/**
 * A figure that numbers only its CORNER pins, leaving the rest to position.
 *
 * ST draws an RHF310A's ceramic Flat-8 with `1` and `8` at the top, `4` and `5`
 * at the bottom, and the four names down each side unnumbered. The constant-sum
 * proof passes on the two numbered rows and the completeness test then refuses
 * the figure, correctly, because four numbers is not eight pins.
 *
 * It is still fully determined, with no free parameter to guess:
 *
 *   - the two numbered rows fix the FIRST and LAST pin of each column,
 *   - the number of NAME rows between them fixes how many pins the column has,
 *   - and those two have to agree, on BOTH sides, before anything is returned.
 *
 * So `1` at the top of a column, `4` at the bottom and exactly four names between
 * them can only be 1, 2, 3, 4. If the names do not count out, the figure is
 * refused exactly as before. That is an arithmetic check on the document rather
 * than an assumption about it, which is the same bar the constant-sum proof sets.
 */
function readCornerNumbered(page: PageText, left: TextItem[], right: TextItem[]): PinFigure | null {
  const rows: { left: TextItem; right: TextItem }[] = [];
  for (const item of left) {
    const opposite = right.find((candidate) => Math.abs(candidate.y - item.y) <= ROW_TOLERANCE);
    if (opposite) rows.push({ left: item, right: opposite });
  }
  // Exactly the two extremes, which is what "corner numbered" means. Three or
  // more numbered rows is a partial read of an ordinary figure, and guessing at
  // the gaps in one of those is not the same thing at all.
  if (rows.length !== 2) return null;

  const ordered = [...rows].sort((first, second) => second.left.y - first.left.y);
  const [top, bottom] = ordered;
  const sum = Number(clean(top.left.str)) + Number(clean(top.right.str));
  if (Number(clean(bottom.left.str)) + Number(clean(bottom.right.str)) !== sum) return null;

  const perSide = (sum - 1) / 2;
  if (!Number.isInteger(perSide) || perSide < MIN_PAIRS) return null;

  const leftFrom = Number(clean(top.left.str));
  const leftTo = Number(clean(bottom.left.str));
  const rightFrom = Number(clean(top.right.str));
  const rightTo = Number(clean(bottom.right.str));
  if (Math.abs(leftTo - leftFrom) + 1 !== perSide) return null;
  if (Math.abs(rightTo - rightFrom) + 1 !== perSide) return null;

  const columns = [
    { anchor: top.left, from: leftFrom, to: leftTo, side: "left" as const },
    { anchor: top.right, from: rightFrom, to: rightTo, side: "right" as const }
  ];

  const pins: FigurePin[] = [];
  for (const column of columns) {
    // Name rows on the outer side of this column, between the two numbered rows.
    const named = pageLines(page.items)
      .filter((line) => line.y <= top.left.y + ROW_TOLERANCE && line.y >= bottom.left.y - ROW_TOLERANCE)
      .map((line) => ({
        y: line.y,
        name: nameBeside(page.items, { ...column.anchor, y: line.y }, column.side)
      }))
      .filter((entry) => entry.name.length > 0 && entry.name.length <= MAX_NAME_LENGTH)
      .sort((first, second) => second.y - first.y);

    // One name per pin, no more and no fewer. This is the check that makes the
    // inference safe, and it is what refuses every other partially numbered
    // figure in the corpus.
    if (named.length !== perSide) return null;

    const step = column.to >= column.from ? 1 : -1;
    named.forEach((entry, index) => {
      pins.push({ number: column.from + index * step, name: entry.name, start: column.anchor.start });
    });
  }

  const seen = new Set(pins.map((pin) => pin.number));
  if (seen.size !== sum - 1) return null;
  for (let value = 1; value <= sum - 1; value += 1) if (!seen.has(value)) return null;

  pins.sort((first, second) => first.number - second.number);
  return {
    pins,
    page: page.page,
    start: pins[0].start,
    caption: captionFor(page, [top.left, top.right, bottom.left, bottom.right])
  };
}


/**
 * A two-column figure whose sides hold DIFFERENT numbers of pins.
 *
 * The constant-sum proof cannot reach these, and the file has said so from the
 * start: a five-pin SOT has three leads down one side and two down the other, so
 * no two numbers pair to a constant and the rows do not even line up. An AD8628
 * draws exactly that — `OUT 1`, `V- 2`, `+IN 3` down the left and `V+ 5`, `-IN 4`
 * down the right, with nothing opposite pin 2.
 *
 * ## The proof that replaces the sum
 *
 * A top view numbers counter-clockwise from pin 1, so the two columns PARTITION
 * 1..N: the left runs 1..k downward and ascending, the right runs N..k+1 downward
 * and descending. Requiring all four of those facts — starts at 1, starts at N,
 * both monotone, union exactly 1..N with no repeats — is as strong as the sum,
 * and for the same reason: a page of numbers that is not a pinout does not do it.
 *
 * The sum is not weaker where it applies, so this runs only after `readFigure`
 * and `readCornerNumbered` have both declined the same pair of columns. It is
 * held to the same one-package test, because a cross pair of two neighbouring
 * figures' columns is exactly as available here as it is there.
 */
function readAsymmetricFigure(page: PageText, first: TextItem[], second: TextItem[]): PinFigure | null {
  const leftFirst = first[0].x <= second[0].x;
  const left = [...(leftFirst ? first : second)].sort((a, b) => b.y - a.y);
  const right = [...(leftFirst ? second : first)].sort((a, b) => b.y - a.y);
  if (left.length < MIN_PAIRS || right.length < MIN_PAIRS) return null;

  const leftValues = left.map((item) => Number(clean(item.str)));
  const rightValues = right.map((item) => Number(clean(item.str)));
  const total = leftValues.length + rightValues.length;

  // Pin 1 at the top left, pin N at the top right, each column monotone in the
  // direction the numbering runs.
  if (leftValues[0] !== 1 || rightValues[0] !== total) return null;
  for (let index = 1; index < leftValues.length; index += 1) {
    if (leftValues[index] !== leftValues[index - 1] + 1) return null;
  }
  for (let index = 1; index < rightValues.length; index += 1) {
    if (rightValues[index] !== rightValues[index - 1] - 1) return null;
  }
  // Which, together, means they tile 1..N. Stated as its own check rather than
  // inferred, because the two runs meeting in the middle is the whole claim.
  if (leftValues[leftValues.length - 1] + 1 !== rightValues[rightValues.length - 1]) return null;

  // A figure whose sides hold the SAME count is a symmetric one that the sum
  // proof already declined, and taking it here would be reading a figure two
  // ways. Refuse rather than second-guess it.
  if (leftValues.length === rightValues.length) return null;

  // The two columns must be two sides of one package, on the same evidence the
  // symmetric reader uses. Paired on the rows that DO line up, which is all the
  // crowding test ever looked at.
  const rows: { left: TextItem; right: TextItem }[] = [];
  for (const item of left) {
    const opposite = right.find((candidate) => Math.abs(candidate.y - item.y) <= ROW_TOLERANCE);
    if (opposite) rows.push({ left: item, right: opposite });
  }
  if (rows.length < MIN_PAIRS) return null;
  if (!isOnePackage(page, rows)) return null;

  const pins: FigurePin[] = [];
  for (const [column, side] of [
    [left, "left"],
    [right, "right"]
  ] as const) {
    for (const item of column) {
      const name = nameBeside(page.items, item, side);
      if (!name || name.length > MAX_NAME_LENGTH) return null;
      pins.push({ number: Number(clean(item.str)), name, start: item.start });
    }
  }

  pins.sort((a, b) => a.number - b.number);
  return {
    pins,
    page: page.page,
    start: pins[0].start,
    caption: captionFor(page, [...left, ...right])
  };
}

/**
 * Whether two number columns are the two sides of ONE package, rather than the
 * inner columns of two packages drawn side by side.
 *
 * Factored out of `readFigure` so the asymmetric reader is held to the same
 * test. The comment above `readFigure`'s call site is the argument; in short, a
 * cross pair has the neighbouring figures' NAMES between its columns and there is
 * one per pin, while a real outline carries a label on a row or two.
 */
function isOnePackage(page: PageText, rows: { left: TextItem; right: TextItem }[]): boolean {
  const crowded = rows.filter((row) =>
    page.items.some(
      (item) =>
        item !== row.left &&
        item !== row.right &&
        Math.abs(item.y - row.left.y) <= ROW_TOLERANCE &&
        item.x > row.left.x + row.left.width &&
        item.x < row.right.x &&
        /[A-Za-z0-9]/.test(clean(item.str))
    )
  ).length;
  return crowded < rows.length * MAX_LABELLED_ROWS;
}

function readFigure(page: PageText, left: TextItem[], right: TextItem[]): PinFigure | null {
  const rows: { left: TextItem; right: TextItem }[] = [];
  for (const item of left) {
    const opposite = right.find((candidate) => Math.abs(candidate.y - item.y) <= ROW_TOLERANCE);
    if (opposite) rows.push({ left: item, right: opposite });
  }
  if (rows.length < MIN_PAIRS) return null;

  // The two columns must be the two sides of ONE package.
  //
  // Without this, a page drawing two packages side by side pairs the FIRST
  // figure's right-hand column with the SECOND figure's left-hand column. That
  // cross pair passes the constant-sum test and the completeness test perfectly
  // well, because both are real halves of real figures, and it returns a
  // scrambled pinout: an INA240 came back with IN+ at both pin 2 and pin 8.
  //
  // What separates the two cases is HOW MANY rows carry text between the
  // columns. A cross pair has the neighbouring figures' names between them, and
  // there is one name per pin, so every row has some. A real package outline
  // carries a label instead, and a label occupies one or two rows out of however
  // many the package has: `ADG5412/ADG5413` and `TOP VIEW` on a sixteen-pin
  // part, `TOP VIEW` and `(Not to Scale)` on an AD590. Requiring the columns to
  // be strictly empty between them was tried first and threw both of those away.
  // What counts as text between the columns is NAME-shaped content, meaning a
  // letter or a digit. A cross pair has the neighbouring figures' pin names there
  // and those always are; a schematic symbol drawn inside the outline is `+` and
  // `-` and is not.
  //
  // Measured, and it was returning a wrong pinout: a TSV911 page draws an SO8
  // single and an SO8 dual, and their pin 1 is NC on one and Out1 on the other.
  // Counting the op-amp's own `+`/`-` marks as crowding refused the DUAL on three
  // rows of four and let the SINGLE through on two of four, so one of two
  // conflicting eight-pin pinouts was returned and the disagreement that should
  // have refused the page never got the chance to fire. It was right by luck.
  if (!isOnePackage(page, rows)) return null;

  // The left column ascends and the right descends, so every row sums to the
  // same constant. This is the test that a numeric layout cannot pass.
  const sum = Number(clean(rows[0].left.str)) + Number(clean(rows[0].right.str));
  for (const row of rows) {
    if (Number(clean(row.left.str)) + Number(clean(row.right.str)) !== sum) return null;
  }

  // And since both numbers are bounded by the sum, sum - 1 distinct values means
  // exactly 1..N with no gaps. Anything less is a partial read of the figure.
  const numbers = new Map<number, TextItem>();
  for (const row of rows) {
    numbers.set(Number(clean(row.left.str)), row.left);
    numbers.set(Number(clean(row.right.str)), row.right);
  }
  if (numbers.size !== rows.length * 2 || numbers.size !== sum - 1) return null;
  for (let value = 1; value <= sum - 1; value += 1) if (!numbers.has(value)) return null;

  // Every number must carry a name. Without this an AD590's page-one layout,
  // whose numbers pair to a constant sum perfectly well, reads as an eight-pin
  // part. A pinout figure labels its pins; nothing else on a page does.
  const pins: FigurePin[] = [];
  for (const row of rows) {
    for (const [item, side] of [
      [row.left, "left"],
      [row.right, "right"]
    ] as const) {
      const name = nameBeside(page.items, item, side);
      if (!name || name.length > MAX_NAME_LENGTH) return null;
      pins.push({ number: Number(clean(item.str)), name, start: item.start });
    }
  }

  pins.sort((first, second) => first.number - second.number);
  const spanned = rows.flatMap((row) => [row.left, row.right]);
  return {
    pins,
    page: page.page,
    start: pins[0].start,
    caption: captionFor(page, spanned)
  };
}

/**
 * Reads the pinout figure from whichever page carries it.
 *
 * Figures implying different pin counts are different packages, and choosing
 * between them is not this reader's job: an AD8628 draws an eight-pin SOIC and a
 * five-pin TSOT, and both are the part. Figures agreeing on the count but
 * disagreeing on a NAME are two devices, which is real too: an ISO7741 pin 6 is
 * IND in one figure and OUTD in the other. Either way the answer is a refusal.
 */
export function extractPinFigureByGeometry(
  doc: DatasheetText,
  partNumber?: string,
  packageType?: string,
  /**
   * The count the document declares for this part, used ONLY to choose between
   * figures that have each already proved themselves complete. See below.
   */
  declaredCount?: number | null
): PinFigure | null {
  const found: PinFigure[] = [];
  for (const page of doc.pages) found.push(...readFiguresFromPage(page));
  if (found.length === 0) return null;

  if (agree(found)) return found[0];

  // They disagree, so they are different devices or different packages, and the
  // caption is what says which. Device first: an OPA333 datasheet draws the
  // OPA2333's eight-pin figures too, and those are answers to a question nobody
  // asked. Then package: an INA240 draws its PW and its D, which have genuinely
  // different pinouts, and only the designator separates them.
  const ours = claimedByDevice(found, partNumber);
  if (agree(ours)) return ours[0];

  const mine = claimedByPackage(ours, packageType);
  if (agree(mine)) return mine[0];

  // Last, the count the document declares for this part. An STM32F407 draws its
  // LQFP64, LQFP100, LQFP144 and LQFP176 as four complete figures and captions
  // every one of them with the FAMILY name, `STM32F40xxx`, so neither the device
  // nor the package claim separates them; the ordering scheme on the same
  // document's last pages says this part has 100 pins, and exactly one of the
  // four figures has 100.
  //
  // This is the rule `readContinuedTable` already applies to a table's per-package
  // number columns, and it is safe for the same reason: the count only ever
  // SELECTS among figures that have each already passed the tiling or constant-sum
  // proof, so a wrong count matches nothing and refuses rather than promoting a
  // bad read. `agree` still has to hold on what survives, so two figures of the
  // same length that disagree about a name are refused exactly as before.
  if (declaredCount == null) return null;
  const counted = ours.filter((figure) => figure.pins.length === declaredCount);
  return agree(counted) ? counted[0] : null;
}

/** Whether every figure describes the same pinout, which is the only readable case. */
function agree(figures: PinFigure[]): boolean {
  if (figures.length === 0) return false;

  const names = new Map<number, string>();
  for (const figure of figures) {
    if (figure.pins.length !== figures[0].pins.length) return false;
    for (const pin of figure.pins) {
      const existing = names.get(pin.number);
      if (existing !== undefined && existing.toUpperCase() !== pin.name.toUpperCase()) return false;
      names.set(pin.number, pin.name);
    }
  }

  return true;
}

/** Uppercase alphanumerics, so `LMP7704-SP` and `LMP7704SP` compare equal. */
function normalizeDevice(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Drops figures whose caption names a device other than the one asked about.
 *
 * A caption naming no device at all is kept: most figures are captioned by
 * package alone (`HKJ Package`, `8-Pin SOIC`) and the document covers one part.
 */
function claimedByDevice(figures: PinFigure[], partNumber: string | undefined): PinFigure[] {
  const wanted = partNumber ? normalizeDevice(partNumber) : "";
  if (!wanted) return figures;

  const kept = figures.filter((figure) => {
    const devices = (figure.caption.match(CAPTION_DEVICE) ?? [])
      .filter((token) => /\d/.test(token))
      .map(normalizeDevice);
    if (devices.length === 0) return true;
    return devices.some((device) => device === wanted || wanted.startsWith(device));
  });

  return kept.length > 0 ? kept : figures;
}

/**
 * Narrows figures to the one drawing the package the document declares.
 *
 * This is the same key the pin TABLE uses for its per-package columns, applied
 * to the figure that carries the same ambiguity. An INA240 captions its two
 * figures `8-Pin TSSOP` and `8-Pin SOIC` and its front matter declares the
 * TSSOP, so the TSSOP figure is the answer and the SOIC one is a different
 * package's pinout.
 */
function claimedByPackage(figures: PinFigure[], packageType: string | undefined): PinFigure[] {
  if (!packageType) return [];
  const families = packageFamilies(packageType);
  if (families.length === 0) return [];

  return figures.filter((figure) =>
    families.some((family) => new RegExp(`\\b${family}\\b`, "i").test(figure.caption))
  );
}
