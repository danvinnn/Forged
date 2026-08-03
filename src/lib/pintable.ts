import { hasPrintedOrder } from "./pdftext";
import type { DatasheetText, PageText, TextItem } from "./pdftext";

/**
 * Pin-function tables, read from the page's geometry rather than from its text.
 *
 * ## Why the text is not enough
 *
 * `pdf-parse` flattens a page into lines by baseline, and a pin table's
 * description column wraps. So one logical row arrives as three lines, out of
 * order, with the wrap ABOVE the row it belongs to:
 *
 *     CAN transmit data input (LOW for dominant and HIGH for recessive bus...
 *     D 1 I
 *     input
 *
 * No row-at-a-time regex recovers from that, which two separate attempts have
 * now measured: number-first tables, and widening the type column. Both are
 * recorded in DEFERRED.md as measured negatives. The information that separates
 * the columns is the x coordinate, and it was being discarded.
 *
 * ## What this uses
 *
 * `pdftext.ts` already carries it. Every `TextItem` has `x`, `y`, `width`,
 * `height` and its offsets into the document text, so this needs no new
 * dependency, no second parse and no change to the air-gap posture. It reads
 * what was already there.
 *
 * ## The method, and why it verifies itself
 *
 * The number column is not found by position or by heading. It is found by
 * asking which vertical band of integers spells 1..N with no gaps, which is the
 * same self-proving test the pinout-figure reader uses: prose does not produce
 * that by accident. Everything else keys off it.
 *
 * Rows are then assembled by assigning each item to its NEAREST number, rather
 * than by baseline. That is what makes the wrapped description land on the right
 * row, and it also picks up a name split across two baselines by a subscript
 * (`V` over `ref`, whose number sits lower than both).
 */

/** How far apart two x positions may be and still be the same column. */
const COLUMN_TOLERANCE = 6;

/**
 * How far from its number an item may sit and still belong to that row, as a
 * multiple of the row's text height. Wrapped description lines sit one line away;
 * anything much further belongs to a different part of the page.
 */
const ROW_REACH = 3.5;

/** Shortest run of pins worth reporting, matching the pin-table text reader. */
const MIN_PINS = 2;

/** Longest plausible pin count, so a page of figures cannot become a table. */
const MAX_PINS = 600;

/**
 * The type column's vocabulary, used to tell a pin table from everything else
 * on a page that also numbers things 1..N.
 *
 * The 1..N test alone is not enough, and the corpus showed exactly how it fails:
 * a two-column pinout DIAGRAM has the opposite side's numbers where the type
 * belongs (INA240 read `1:IN+[7 REF1]`), a bond-pad coordinate table numbers its
 * rows the same way (REF5025 read `[X MIN 35.45 Bond Pad Coordinates]`), and a
 * features list on page one can be numbered too (AD8232).
 *
 * A real pin-function table always has this column and none of those do. Note
 * that this vocabulary was tried once before as a ROW matcher and measured as
 * worthless; as a TABLE validator it is what makes the reader safe.
 */
const PIN_TYPE_WORDS = new Set([
  "I", "O", "I/O", "IO", "DI", "DO", "AI", "AO", "IN", "OUT", "INOUT",
  "INPUT", "OUTPUT", "BIDIRECTIONAL", "PASSIVE", "ANALOG", "DIGITAL",
  "P", "PWR", "POWER", "SUPPLY", "GND", "GROUND", "VSS", "VDD", "VCC", "VS",
  "NC", "N/C", "NONE", "—", "-", "PAD", "THERMAL"
]);

/**
 * Longest a type CELL may be, in words, before it stops being a type and starts
 * being a description.
 */
const MAX_TYPE_WORDS = 3;

/**
 * Whether a cell is a pin TYPE, allowing the phrases vendors actually print.
 *
 * The set above holds single words, and set membership alone missed the most
 * common house style there is. TI writes `Digital input`, `Power supply`,
 * `Analog output` and `Analog input, output`; every word of each is already in
 * the vocabulary and not one of the phrases is, so a perfectly ordinary
 * `Pin Functions` table failed the type check and was discarded whole. Measured
 * on ADS8688, whose 38-pin table types every row that way.
 *
 * A phrase qualifies only when EVERY word of it is type vocabulary, which is
 * what keeps this from becoming a prose matcher. The description column beside
 * it reads `Data input for serial communication`, whose first word is not in the
 * set, so it is rejected on the first word and the two columns stay
 * distinguishable. The word bound does the same job from the other end.
 */
function isPinType(text: string): boolean {
  const cleaned = clean(text).toUpperCase();
  if (cleaned.length === 0) return false;
  if (PIN_TYPE_WORDS.has(cleaned)) return true;

  // Split on the separators these phrases actually use, so `ANALOG INPUT, OUTPUT`
  // and `INPUT/OUTPUT` are read as their words rather than as one unknown token.
  const words = cleaned.split(/[\s,/]+/).filter((word) => word.length > 0);
  if (words.length < 2 || words.length > MAX_TYPE_WORDS) return false;
  return words.every((word) => PIN_TYPE_WORDS.has(word));
}

/**
 * Fraction of rows whose type cell must be recognised. Not all of them: real
 * tables carry the odd blank or an exposed-pad row spelled its own way.
 */
const MIN_TYPED_ROWS = 0.6;


/** Longest a pin name may be. Beyond this it is a sentence, not a name. */
const MAX_NAME_LENGTH = 24;

/**
 * Longest a pin name may be on a table the vendor CAPTIONED as its pin functions.
 *
 * Multiplexed MCU port names run past the ordinary bound: an MSP430F5529 prints
 * `P4.0/PM_UCB1STE/PM_UCA1CLK`, which is 26 characters and entirely real. The
 * looser bound is tied to the caption rather than applied everywhere, because the
 * bound's job is to catch prose drifting into the name column and a caption is the
 * vendor saying which column that is. Prose joined without spaces is far longer
 * than this: the run that motivated the check in the first place was
 * `GENERALDESCRIPTIONWithanoffsetvoltageofonly`, at 43.
 */
const MAX_CAPTIONED_NAME_LENGTH = 32;

/**
 * How far a column heading may sit from the column it heads. Wider than the
 * column tolerance because a heading like `ISO7740` is longer than the two-digit
 * numbers beneath it and is typeset from a different left edge.
 */
const HEADING_X_TOLERANCE = 30;

/** How far apart two baselines may be and still be the same printed line. */
const LINE_TOLERANCE = 2;

/**
 * How far two items' left edges may differ and still be the SAME alignment.
 *
 * Much tighter than `COLUMN_TOLERANCE`, which asks whether two items are in the
 * same column. This asks whether they were laid out against the same edge, which
 * is what separates a table's number column from the page number printed in the
 * same margin three units away.
 */
const ALIGNED_TOLERANCE = 2;

/**
 * The caption a vendor prints above a pin table, and the device it names.
 *
 * This is the only thing on the page that says which device a table describes.
 * A datasheet covering several devices captions each table with its own:
 * `Table 5-1. Pin Functions: OPA277`, `Table 5-2. Pin Functions: OPA2277`,
 * `Table 5-3. Pin Functions: OPA4277`. Nothing else distinguishes them, and pin
 * count does not: the first two are both eight-pin tables and only one of them
 * is the dual's.
 *
 * The colon is required. A table captioned plainly `Pin Functions` covers the
 * whole document (LMP7704-SP, UCC27524) or puts its variants in columns
 * (ISO7741), and both of those are already handled elsewhere.
 */
const PIN_TABLE_CAPTION = /(?:pin|terminal)\s+functions?\s*:\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)/i;

/**
 * The caption a vendor prints above a pin-function table, in the form that says
 * so outright.
 *
 * This is the vendor DECLARING that what follows is a pin-function table, which
 * is a better answer to "is this really a pin table" than the type column, whose
 * whole job was to guess at it. Surveyed over the corpus, every form in use is
 * here: `Table 3. Pin Function Descriptions` (ADI), `Table 4-1. Pin Functions`
 * (TI), `Table 1. Pin description` (ST), `Table 7-1. Terminal Functions` (TI
 * MSP430), and ADR4525's package-qualified `Table 9. 8-Lead SOIC Pin Function
 * Descriptions`.
 *
 * Two things make it safe to lean on, and both were measured against the corpus:
 *
 * The `Table` prefix is required, so a FIGURE caption cannot qualify. AD8232
 * page 6 prints `Figure 2. Pin Configuration` directly above `Table 3. Pin
 * Function Descriptions`, and the figure's own numbers form a qualifying 1..N
 * band. Only one of those two is a table.
 *
 * Everything between the number and the phrase must be a PACKAGE qualifier.
 * That is what separates ADR4525's `8-Lead SOIC Pin Function Descriptions` from
 * the trap next door: an MSP430F5529 prints sixteen tables captioned `Table
 * 9-46. Port P1 (P1.0 to P1.7) Pin Functions`, which are register maps, not the
 * part's pinout, and a looser match reads one of them as the pin table.
 *
 * `pin definitions` is the one phrase allowed a free prefix, because ST captions
 * its MCU pinout `Table 5. Medium-density STM32F103xx pin definitions` and the
 * device name sitting there is not a package qualifier. The same family writes it
 * `pin and ball definitions` (STM32F407VG) and `Pin/ball definition`
 * (STM32H743ZI) when the document also covers a BGA. Loosening it for that
 * phrase and not for `pin functions` is what keeps the register maps out: every
 * one of those traps is captioned `... Pin Functions`, and nothing in the corpus
 * captions anything but its pinout `pin definitions`.
 */
const PIN_FUNCTION_CAPTION =
  /^table\s+(\d+(?:[-.]\d+)*)\s*[.:]\s*(?:(\d{1,3}[-\s](?:lead|pin)\s+[A-Za-z][A-Za-z0-9-]{1,12})\s+)?(?:(?:pin|terminal)\s+(?:function|description)s?|[A-Za-z0-9 ,()-]{0,40}?\bpin(?:\s*\/\s*ball|\s+and\s+ball)?\s+definitions?)\b/i;

/**
 * The marker a vendor prints when a table runs onto the next page.
 *
 * It matters because a page holding half a table still holds a gap-free 1..N
 * run, so the proof that makes this reader safe passes on a FRAGMENT. An
 * MSP430F5529 prints `Table 7-1. Terminal Functions` over rows 1 to 11 and
 * `Table 7-1. Terminal Functions (continued)` over the rest, and the first page
 * on its own reads as a perfectly consistent 11-pin part. It has 80 pins.
 */
const CONTINUED_CAPTION = /\(\s*continued\s*\)/i;

/**
 * The title a vendor prints over a pin table WITHOUT numbering it as a table.
 *
 * TI's current template does exactly this: a section headed `6 Pin Configuration
 * and Functions`, a pinout figure, then a table titled plainly `Pin Functions`
 * and continued on the next page as `Pin Functions (continued)`. There is no
 * `Table N.` anywhere, so `PIN_FUNCTION_CAPTION` never sees it and the table can
 * only be read by the uncaptioned path. That path needs the page's own numbers to
 * spell 1..N, which a NAME-ordered table split across two pages does not do, so
 * the whole shape was unreadable. It is TI's house style, not one datasheet.
 *
 * The match is on the WHOLE line, not a prefix, and that is what keeps the
 * register maps out. An MSP430F5529 prints sixteen tables called `Table 9-46.
 * Port P1 (P1.0 to P1.7) Pin Functions`, which are not this part's pinout; every
 * one of them carries the `Table N.` prefix and a port name, so none of them is
 * ever exactly this line.
 */
const PLAIN_PIN_TABLE_TITLE = /^(?:pin|terminal)\s+functions?(?:\s*\(\s*continued\s*\))?$/i;

/** The label given to a table declared by a plain title, which carries no number. */
const PLAIN_PIN_TABLE_LABEL = "pin-functions";

/** A vendor's declaration that a pin-function table starts below this line. */
interface PinTableCaption {
  y: number;
  text: string;
  /** The caption's own number, e.g. `7-1`, which its continuation repeats. */
  label: string;
  /** The package the caption names, when it qualifies the table with one. */
  packageQualifier: string | null;
}

/**
 * The pin-function captions on a page, topmost first.
 *
 * A page carrying more than one is a page carrying more than one table, which is
 * the ADR4525 shape: `Table 9. 8-Lead SOIC ...` above `Table 10. 8-Lead LCC ...`,
 * both numbering 1..8 in the SAME x column. See `readPinTablesFromPage`.
 */
function pinFunctionCaptions(items: TextItem[]): PinTableCaption[] {
  const captions: PinTableCaption[] = [];
  for (const line of pageLines(items)) {
    const match = PIN_FUNCTION_CAPTION.exec(line.text);
    if (match) {
      captions.push({
        y: line.y,
        text: line.text,
        label: clean(match[1]),
        packageQualifier: match[2] ? clean(match[2]) : null
      });
      continue;
    }
    // A table the vendor titled but did not number; see PLAIN_PIN_TABLE_TITLE.
    // It shares one label across the document, which is what lets the continued
    // reader join `Pin Functions` to `Pin Functions (continued)` on the next page.
    if (PLAIN_PIN_TABLE_TITLE.test(clean(line.text))) {
      captions.push({
        y: line.y,
        text: line.text,
        label: PLAIN_PIN_TABLE_LABEL,
        packageQualifier: null
      });
    }
  }
  return captions.sort((left, right) => right.y - left.y);
}

/**
 * The captions in a document whose table runs across a page break, by label.
 *
 * Both halves are dropped, not just the continuation. Neither is the whole
 * table, and half a pinout is the thing this reader refuses everywhere else.
 */
function continuedTableLabels(doc: DatasheetText): Set<string> {
  const labels = new Set<string>();
  for (const page of doc.pages) {
    for (const line of pageLines(page.items)) {
      if (!CONTINUED_CAPTION.test(line.text)) continue;
      const match = PIN_FUNCTION_CAPTION.exec(line.text);
      if (match) labels.add(clean(match[1]));
      else if (PLAIN_PIN_TABLE_TITLE.test(clean(line.text))) labels.add(PLAIN_PIN_TABLE_LABEL);
    }
  }
  return labels;
}

/**
 * A cell holding pin numbers rather than a pin name.
 *
 * The comma form is how a table writes one signal that appears at several
 * positions (`NC 1, 5, 8`), and it is the reason this is not just an integer
 * test.
 */
const NUMBER_CELL = /^\d{1,3}(?:\s*,\s*\d{1,3})*$/;

/**
 * The same cell, allowing the TRAILING COMMA a cell wrapped onto the next line
 * ends with.
 *
 * A cell naming more positions than fit the column width is broken across lines
 * by the typesetter, and each fragment arrives as its own run: a PCF8574 writes
 * `P[0..7]`'s eight positions as `5, 6, 7, 8, ` / `10, 11, 12, ` / `13` on three
 * baselines. `NUMBER_CELL` rejects the first two outright, so the column lost
 * three quarters of its numbers and never spelled 1..N.
 *
 * Used to RECOGNISE a fragment. Whether the fragments are one cell is decided by
 * `mergeWrappedCells`, which is a separate question and the one that matters.
 */
const WRAPPED_NUMBER_CELL = /^\d{1,3}(?:\s*,\s*\d{1,3})*\s*,$/;

/** A fragment that a following one continues, which is what the comma means. */
function isContinued(text: string): boolean {
  return WRAPPED_NUMBER_CELL.test(clean(text));
}

/**
 * Joins the fragments of a cell wrapped across baselines back into one cell.
 *
 * The comma is the evidence and it is the vendor's own: a run ending in one is
 * not a finished list, so the run below it in the same column finishes it. Applied
 * only WITHIN a column, whose members already overlap in x, so a comma at the end
 * of one column's cell can never reach across into another's.
 *
 * The merged cell is anchored at the MIDPOINT of the fragments it spans, because
 * that is where the vendor prints the name: PCF8574 centres `P[0..7]` on
 * y=226.2 against fragments at 235.8, 226.2 and 216.6. All four of its package
 * columns put their name on the midpoint, including the two-fragment ones. Same
 * rule the continued-table reader already uses to find a name beside a tall cell.
 */
function mergeWrappedCells(column: TextItem[]): TextItem[] {
  const ordered = [...column].sort((upper, lower) => lower.y - upper.y);
  const merged: TextItem[] = [];

  for (let index = 0; index < ordered.length; index += 1) {
    const parts = [ordered[index]];
    while (isContinued(parts[parts.length - 1].str) && index + 1 < ordered.length) {
      index += 1;
      parts.push(ordered[index]);
    }

    // A fragment still asking to be continued when the column has run out is a
    // cell this cannot assemble, and half a cell is a wrong pinout rather than a
    // short one.
    if (isContinued(parts[parts.length - 1].str)) return [];

    if (parts.length === 1) {
      merged.push(parts[0]);
      continue;
    }

    const left = Math.min(...parts.map((part) => part.x));
    const right = Math.max(...parts.map((part) => part.x + part.width));
    const top = Math.max(...parts.map((part) => part.y));
    const bottom = Math.min(...parts.map((part) => part.y));

    merged.push({
      ...parts[0],
      str: parts.map((part) => clean(part.str)).join(" "),
      x: left,
      width: right - left,
      y: (top + bottom) / 2,
      height: Math.max(...parts.map((part) => part.height))
    });
  }

  return merged;
}

/**
 * A pin name written as a RANGE over a bus, expanded to one name per position.
 *
 * TI writes a bus as one row: `A [0..2]` against `2, 3, 4` and `P[0..7]` against
 * eight positions. Naming every one of those pins `P[0..7]` is a wrong netlist,
 * so a row this cannot expand is refused rather than repeated; see the caller.
 *
 * Only the ASCENDING `lo..hi` form is read, and only when the count of indices
 * equals the count of positions in the cell. Both restrictions are load-bearing:
 *
 * - `..` states its direction. The colon forms do not: `D[15:0]` is conventionally
 *   listed MSB first, so pairing it with the cell's ascending pin numbers would
 *   invert the bus silently. That convention is not written anywhere on the page,
 *   and inferring it is the guess this file exists to refuse.
 * - The count match is the self-check. `P[0..7]` is eight names, and a cell that
 *   yields any other number of positions means the row was assembled wrongly.
 *
 * Verified against PCF8574's own DW or N figure, which prints the mapping this
 * produces pin for pin: `A[0..2]` -> 1, 2, 3 and `P[0..7]` -> 4, 5, 6, 7, 9, 10,
 * 11, 12, with P0 at 4 and P7 at 12.
 */
const RANGE_NAME = /^([A-Za-z][A-Za-z0-9_.]{0,9})\[(\d{1,3})\.\.(\d{1,3})\]$/;

/** Any bracketed index range, including the forms `RANGE_NAME` will not read. */
const BRACKETED_RANGE = /\[\s*\d{1,3}\s*(?:\.\.|:|-|to)\s*\d{1,3}\s*\]$/i;

function expandRangeName(name: string, positions: number): string[] | null {
  const match = RANGE_NAME.exec(name.replace(/\s+/g, ""));
  if (!match) return null;

  const [, base, from, to] = match;
  const low = Number(from);
  const high = Number(to);
  if (high <= low) return null;
  if (high - low + 1 !== positions) return null;

  const names: string[] = [];
  for (let index = low; index <= high; index += 1) names.push(`${base}${index}`);
  return names;
}

/**
 * Fraction of rows that must carry a number cell left of the chosen column
 * before the table is judged to number several packages. Same threshold as the
 * type column, for the same reason: real tables have the odd blank row.
 */
const MIN_NUMBERED_ROWS = 0.6;

/** The pin numbers a cell names, so `1, 2, 6, 7` becomes four pins. */
function expandNumberCell(text: string): number[] {
  return clean(text)
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value >= 1);
}

/**
 * Groups items into columns by whether their printed extents OVERLAP.
 *
 * Left-edge clustering is what the rest of this file uses and it does not work
 * here, because these cells are not left-aligned and vary enormously in width: an
 * RHFL4913 prints `1, 2, 6, 7` starting at x=234 and `13` at x=245 in the same
 * column, with `9, 11, 12, 15` starting at 228. Their left edges span 20 units,
 * three times the column tolerance, so a left-edge cluster shatters the column
 * into four. Their printed extents all overlap.
 */
function overlappingColumns(items: TextItem[]): TextItem[][] {
  const sorted = [...items].sort((left, right) => left.x - right.x);
  const columns: TextItem[][] = [];
  let current: TextItem[] = [];
  let reach = -Infinity;

  for (const item of sorted) {
    if (current.length > 0 && item.x <= reach) {
      current.push(item);
      reach = Math.max(reach, item.x + item.width);
    } else {
      if (current.length > 0) columns.push(current);
      current = [item];
      reach = item.x + item.width;
    }
  }
  if (current.length > 0) columns.push(current);
  return columns;
}

/**
 * Columns whose cells hold GROUPS of pin numbers, spelling 1..N once expanded.
 *
 * This is how ST writes a rad-hard regulator's pinout, and the corpus has it on
 * RHFL4913 and RHFL4913A, both of which were unreadable:
 *
 *     Pin name   FLAT-16P        SMD.5   TO-257
 *     VO         1, 2, 6, 7      1       3
 *     VI         3, 4, 5         2       1
 *     GND        13              3       2
 *     NC         9, 11, 12, 15
 *
 * One signal, several positions, one cell. The number column the rest of this
 * file looks for does not exist: there is no band of bare integers to find, so
 * nothing keyed off it and the table was refused outright.
 *
 * The proof is unchanged and is what makes this safe. Expanded, the FLAT-16P
 * column holds sixteen distinct values spelling 1..16 with no gaps and no
 * repeats, which is the same self-verifying test every other reader here uses,
 * and prose does not produce it by accident.
 *
 * At least one cell must name MORE THAN ONE pin. A column of bare integers is the
 * ordinary shape and the ordinary reader already has it; requiring a grouped cell
 * keeps this reader to the shape it exists for rather than competing.
 */
export function findGroupedNumberColumns(items: TextItem[]): TextItem[][] {
  const cells = items.filter(
    (item) => NUMBER_CELL.test(clean(item.str)) || WRAPPED_NUMBER_CELL.test(clean(item.str))
  );
  if (cells.length < 2) return [];

  const qualifying: TextItem[][] = [];

  for (const band of overlappingColumns(cells)) {
    // Fragments of a wrapped cell are rejoined before the column is judged,
    // because every test below counts POSITIONS and a split cell miscounts them.
    const column = mergeWrappedCells(band);
    if (column.length === 0) continue;

    if (!column.some((item) => expandNumberCell(item.str).length > 1)) continue;

    const values = column.flatMap((item) => expandNumberCell(item.str));
    const distinct = new Set(values);
    if (distinct.size !== values.length) continue;
    if (values.length < MIN_PINS || values.length > MAX_PINS) continue;

    let contiguous = true;
    for (let value = 1; value <= values.length; value += 1) {
      if (!distinct.has(value)) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;

    qualifying.push(column);
  }

  return qualifying;
}

export interface GeometryPin {
  number: string;
  name: string;
  type: string;
  description: string;
  /** Offset into the document text, for the citation. */
  start: number;
}

export interface GeometryPinTable {
  pins: GeometryPin[];
  page: number;
  start: number;
  /**
   * The device named by the table's caption, when it names one. Null for a
   * table captioned for the whole document, which is the common case.
   */
  device: string | null;
  /**
   * Set when this table was chosen because its caption names the part that was
   * asked for. That is a proof about the DEVICE rather than about the table, so
   * callers may treat the count as corroborated; see `extractPins`.
   */
  claimed: boolean;
  /**
   * The vendor captioned these rows as a pin-function table. That is a stronger
   * statement about what the rows ARE than the type column ever was, and it is
   * what lets the type requirement be waived; see `PIN_FUNCTION_CAPTION`.
   */
  captioned: boolean;
  /**
   * The package the caption names, on a datasheet whose tables are captioned per
   * package (`8-Lead SOIC`, `8-Lead LCC`). Null when the caption qualifies
   * nothing, which is the common case.
   */
  packageQualifier: string | null;
  /** The caption's number, so a table split across pages can be recognised. */
  captionLabel: string | null;
}

function isInteger(text: string): boolean {
  return /^\d{1,3}$/.test(text);
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Groups values into clusters where neighbours are within `tolerance`.
 * Returns the clusters in ascending order of their members' first value.
 */
function cluster<T>(values: T[], of: (value: T) => number, tolerance: number): T[][] {
  const sorted = [...values].sort((left, right) => of(left) - of(right));
  const clusters: T[][] = [];
  let current: T[] = [];

  for (const value of sorted) {
    if (current.length === 0 || of(value) - of(current[current.length - 1]) <= tolerance) {
      current.push(value);
    } else {
      clusters.push(current);
      current = [value];
    }
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

/**
 * Whether a set of pin numbers is exactly 1..N: no gaps and nothing above N.
 *
 * This is the proof the whole file rests on. It is applied to one page's column
 * by `findNumberColumns` and to the UNION of a table's pages by
 * `readContinuedTable`, and it means the same thing in both places.
 */
function spellsOneToN(values: number[]): boolean {
  const distinct = new Set(values);
  if (distinct.size !== values.length) return false;
  if (values.length < MIN_PINS || values.length > MAX_PINS) return false;
  for (let value = 1; value <= values.length; value += 1) {
    if (!distinct.has(value)) return false;
  }
  return true;
}

/**
 * Bands of integers that could be a pin-number column, WITHOUT requiring the
 * band to spell 1..N.
 *
 * Split out from `findNumberColumns` because a table continued across pages
 * holds a FRAGMENT of its numbering on each page, so the 1..N proof cannot be
 * applied per page: an MSP430F5529's first page reads 1..11 and the part has 80
 * pins. The proof still has to be paid, and `readContinuedTable` pays it on the
 * union of the pages instead. Nothing else may use this: on its own it is a
 * clustering, not a proof.
 *
 * The no-repeats and size checks stay here, because a band repeating a value is
 * not one column whatever it is joined to.
 */
function findIntegerColumns(items: TextItem[]): TextItem[][] {
  const integers = items.filter((item) => isInteger(clean(item.str)));
  if (integers.length < MIN_PINS) return [];

  const qualifying: TextItem[][] = [];

  for (const band of cluster(integers, (item) => item.x, COLUMN_TOLERANCE)) {
    const values = band.map((item) => Number(clean(item.str)));
    if (new Set(values).size !== values.length) continue;
    if (values.length < MIN_PINS || values.length > MAX_PINS) continue;
    qualifying.push([...band].sort((left, right) => Number(clean(left.str)) - Number(clean(right.str))));
  }

  return qualifying;
}

/**
 * Bands of number CELLS that could be a pin-number column, without requiring the
 * band to spell 1..N.
 *
 * The grouped counterpart of `findIntegerColumns`, and it exists for the same
 * reason: a table continued across pages holds a fragment of its numbering on
 * each page, so the proof has to be paid on the union. Nothing else may use it.
 *
 * Two differences from the bare-integer finder, both forced by the shape:
 *
 * A cell may name SEVERAL pins. TI writes a device's grounds as one row reading
 * `GND | 14, 28`, so the column has to be counted in PINS rather than in cells or
 * a 28-pin part reads as 27 and the union proof fails on a table that is
 * perfectly consistent.
 *
 * The band is found by OVERLAP rather than by left edge, because a column of
 * cells of different widths is centred rather than left-aligned: DRV8825 starts
 * its single digits at x=118 and `14, 28` at x=109, nine apart, so a left-edge
 * cluster shatters one column into two. The extents all overlap.
 */
function findIntegerCellColumns(items: TextItem[]): TextItem[][] {
  const cells = items.filter((item) => NUMBER_CELL.test(clean(item.str)));
  if (cells.length < MIN_PINS) return [];

  const qualifying: TextItem[][] = [];

  for (const band of overlappingColumns(cells)) {
    const values = band.flatMap((item) => expandNumberCell(item.str));
    if (new Set(values).size !== values.length) continue;
    if (values.length < MIN_PINS || values.length > MAX_PINS) continue;
    qualifying.push(band);
  }

  return qualifying;
}

/**
 * The number column: the band of integers that reads 1..N with no gaps.
 *
 * A datasheet page is full of integers, and most of the bands they form are
 * nonsense: axis ticks, table values, figure callouts. Requiring the band to be
 * exactly 1..N is what separates a pin-number column from all of them without
 * needing to know anything about the page's layout.
 *
 * The proof is the SET, not the order. Plenty of real tables are ordered by pin
 * name rather than by number (an ADI or TI table listing EN1 at 7 before GND1 at
 * 2), and requiring document order refused all of them. A band whose values are a
 * permutation of 1..N with no repeats is still something prose does not produce
 * by accident.
 */
export function findNumberColumns(items: TextItem[]): TextItem[][] {
  return findIntegerColumns(items).filter((band) =>
    spellsOneToN(band.map((item) => Number(clean(item.str))))
  );
}


/**
 * The heading above a number column, which on a multi-variant table names the
 * device that column belongs to.
 *
 * An ISO7741 datasheet documents three parts and its pin table carries one
 * number column each, headed `ISO7740`, `ISO7741`, `ISO7742`. The heading sits
 * slightly left of the numbers it heads, so the search is a band around the
 * column rather than a strict x match.
 */
export function columnHeading(items: TextItem[], column: TextItem[], tableTop?: number): string | null {
  const top = column.reduce((highest, item) => (item.y > highest.y ? item : highest));
  // The heading row belongs to the TABLE, not to each column, and a column whose
  // first row is blank for this variant starts lower than its neighbours. An
  // ISO7740 column begins two rows below the ISO7741 one because the first pin
  // does not exist on that device, which put its heading out of reach and made a
  // three-variant table look like a one-variant one.
  const baseline = tableTop ?? top.y;
  const reach = Math.max(top.height, 1) * 4;

  const above = items
    .filter(
      (item) =>
        item.y > baseline &&
        item.y <= baseline + reach &&
        Math.abs(item.x - top.x) <= HEADING_X_TOLERANCE &&
        /[A-Z]/i.test(item.str) &&
        /\d/.test(item.str)
    )
    .sort((left, right) => left.y - right.y);

  return above.length > 0 ? clean(above[0].str) : null;
}

/**
 * Chooses which variant's column to read when a table has more than one.
 *
 * Only an exact match counts. A datasheet covering an ISO7740, an ISO7741 and an
 * ISO7742 offers no way to guess between them, and reading the wrong column
 * returns a pinout for a device the user did not ask about, which is the failure
 * this file already refuses in two other forms.
 */
function selectVariantColumn(
  items: TextItem[],
  columns: TextItem[][],
  partNumber: string | undefined,
  packageType: string | undefined
): { column: TextItem[]; multiVariant: boolean } | null {
  if (columns.length === 1) return { column: columns[0], multiVariant: false };

  // All the variant columns of one table share a heading row, so it is located
  // from the highest row any of them reaches.
  const tableTop = Math.max(...columns.map((column) => Math.max(...column.map((item) => item.y))));

  // And they all START at that row, give or take the blank first cell a variant
  // has where the device has no such pin. A band that begins well below it is
  // somewhere else on the page, and it must not be mistaken for a variant of
  // this table: a TLV9061's pinout FIGURE numbers 1..3 a hundred units under the
  // pin table, close enough in x to inherit the table's `SOT-553` heading, which
  // made two columns claim the SOT family and turned a resolvable table into a
  // tie. Same allowance as the heading search, and for the same reason.
  const rows = columns.flat();
  const rowHeight = Math.max(...rows.map((item) => item.height), 1);
  const sameTable = columns.filter(
    (column) => Math.max(...column.map((item) => item.y)) >= tableTop - rowHeight * 4
  );

  const headed = sameTable
    .map((column) => ({ column, heading: columnHeading(items, column, tableTop) }))
    .filter((entry): entry is { column: TextItem[]; heading: string } => entry.heading !== null);

  // Two or more columns each headed by something device-shaped is what a
  // multi-variant table looks like, and it is the only case where picking the
  // wrong column silently returns another device's pinout. Everywhere else a
  // second qualifying band is just another numeric column on the page, and
  // refusing over it cost two parts that had been reading correctly.
  if (headed.length >= 2) {
    const wanted = partNumber ? partNumber.trim().toUpperCase() : null;
    const byDevice = wanted ? headed.filter((entry) => entry.heading.toUpperCase() === wanted) : [];
    if (byDevice.length === 1) return { column: byDevice[0].column, multiVariant: true };

    // The columns may be PACKAGES rather than devices, which is the same shape
    // and a different question. A TLV9061 numbers its five pins three times over
    // under `SOT-23, SOT-553`, `SC70` and `X2SON`, and those headings answer
    // "which package" rather than "which device", so the part number can never
    // match one. The package we are in does, and it is the same evidence
    // `ownsNumberColumn` resolves the other multi-package layout with.
    //
    // Exact single match or nothing, exactly as above: two columns claiming the
    // family is a tie, and reading either is the guess this file refuses.
    const families = packageType ? packageFamilies(packageType) : [];
    if (families.length > 0) {
      const byPackage = headed.filter((entry) =>
        packageFamilies(entry.heading).some((family) => families.includes(family))
      );
      if (byPackage.length === 1) return { column: byPackage[0].column, multiVariant: true };
    }

    return null;
  }

  return {
    column: columns.reduce((longest, column) => (column.length > longest.length ? column : longest)),
    multiVariant: false
  };
}

/** Reassembles the page's printed lines, which is the unit a caption occupies. */
function pageLines(items: TextItem[]): { y: number; text: string }[] {
  return cluster(items, (item) => item.y, LINE_TOLERANCE).map((line) => ({
    y: line[0].y,
    text: clean([...line].sort((left, right) => left.x - right.x).map((item) => item.str).join(" "))
  }));
}

/**
 * The device named by the caption nearest above a table.
 *
 * Nearest rather than first, because a page carries more than one table and
 * therefore more than one caption: TLV9061 page 6 opens with the continuation of
 * `Pin Functions: TLV9061S` and then starts `Pin Functions: TLV9062` halfway
 * down. The caption immediately above a table is the one that introduces it.
 */
function captionDevice(items: TextItem[], tableTop: number): string | null {
  let nearest: { y: number; device: string } | null = null;

  for (const line of pageLines(items)) {
    if (line.y <= tableTop) continue;
    const match = PIN_TABLE_CAPTION.exec(line.text);
    if (!match) continue;
    if (!nearest || line.y < nearest.y) nearest = { y: line.y, device: match[1] };
  }

  return nearest ? nearest.device : null;
}

/**
 * Words in a package designator that do not name a family.
 *
 * Everything else in it is treated as a family token, which is deliberate: the
 * families this has to recognise (`LCCC`, `GDIP`, `X2SON`, `VSSOP`) are not a
 * list anyone can finish, and a designator that contributes no usable token
 * simply fails to match and the table is refused.
 */
const NOT_A_FAMILY = new Set(["PIN", "PINS", "LEAD", "LEADS", "PACKAGE", "TOP", "VIEW", "AND", "WITH"]);

export function packageFamilies(designator: string): string[] {
  return (designator.toUpperCase().match(/[A-Z][A-Z0-9]{1,9}/g) ?? []).filter(
    (word) => /[A-Z]{2}/.test(word) && !NOT_A_FAMILY.has(word)
  );
}

/**
 * The heading printed over a column of pin numbers.
 *
 * Matched by the heading's x RANGE containing the column's centre, rather than
 * by left edges. That is how these are typeset and the difference is decisive: an
 * LM358 heading reads `SOIC, SOT23-8, VSSOP, CDIP, PDIP, SO, TSSOP, CFP` across
 * two lines spanning 190 to 305, over a column of numbers at 244. Comparing left
 * edges puts it 54 units away, which is further than the neighbouring column.
 */
function headingOver(items: TextItem[], column: TextItem[], tableTop: number): string {
  const centre = column.reduce((sum, item) => sum + item.x + item.width / 2, 0) / column.length;
  const reach = Math.max(...column.map((item) => item.height), 1) * 5;

  return clean(
    items
      .filter(
        (item) =>
          item.y > tableTop &&
          item.y <= tableTop + reach &&
          item.x <= centre &&
          item.x + item.width >= centre
      )
      .sort((left, right) => right.y - left.y)
      .map((item) => item.str)
      .join(" ")
  );
}

/**
 * Whether the chosen column is the one numbering the package that was asked for.
 *
 * A table numbering several packages is only readable when the caller says which
 * package they want AND that package's column is the one carrying the 1..N
 * proof. An INA240 shows why the second half matters: its table numbers the PW
 * (TSSOP) and D (SOIC) packages side by side, the SOIC column is the one that
 * reads 1..N, and the designator extracted from the front matter is the TSSOP.
 * Reading the column that happens to be provable would return SOIC numbering for
 * a part labelled TSSOP, which is the silent wrong answer this whole file exists
 * to avoid. The caller can still name the SOIC at export and get it.
 */
function ownsNumberColumn(
  items: TextItem[],
  column: TextItem[],
  siblings: TextItem[][],
  tableTop: number,
  packageType: string | undefined
): boolean {
  if (!packageType) return false;
  const families = packageFamilies(packageType);
  if (families.length === 0) return false;

  const names = (heading: string) => families.some((family) => new RegExp(`\\b${family}\\b`).test(heading));

  if (!names(headingOver(items, column, tableTop))) return false;
  // Ambiguous if a sibling column claims the same family: two columns for one
  // package is not something this can resolve, and it is a real shape (a package
  // sold in two pin counts).
  return !siblings.some((sibling) => names(headingOver(items, sibling, tableTop)));
}

/**
 * How tall one row of this table is, in the page's own units.
 *
 * Text height is the obvious answer and it is not a reliable one: pdf.js reports
 * the AD8232's pin-number runs as 81 points tall in an 8 point table, which
 * inflates every bound derived from it. The floor ran a hundred points past the
 * last row and swallowed the unnumbered `EP` line below the table, so pin 20
 * came back named `EPHPSENSE`.
 *
 * The spacing BETWEEN the numbered rows is measured off the table itself and
 * cannot be misreported. The median is used because a row whose description
 * wraps sits further from its neighbour than the rest, and the smaller of the
 * two is taken so this can only ever tighten a bound, never loosen one.
 */
function rowHeightOf(numbers: TextItem[]): number {
  const reported = Math.max(...numbers.map((item) => item.height), 1);
  if (numbers.length < 3) return reported;

  const descending = [...numbers].sort((left, right) => right.y - left.y);
  const gaps: number[] = [];
  for (let index = 1; index < descending.length; index += 1) {
    const gap = descending[index - 1].y - descending[index].y;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return reported;

  gaps.sort((left, right) => left - right);
  return Math.min(reported, gaps[Math.floor(gaps.length / 2)]);
}

/**
 * Assigns every other item on the page to the pin number it is nearest to.
 *
 * Nearest-by-baseline rather than same-baseline is the whole trick. A wrapped
 * description sits one line above or below its row and lands correctly; a name
 * split by a subscript lands correctly; and an item far from any number, which
 * is to say the rest of the page, is dropped by the reach limit.
 */
function assignRows(
  items: TextItem[],
  numbers: TextItem[],
  anchors = numbers,
  rowHeight?: number
): Map<number, TextItem[]> {
  const rows = new Map<number, TextItem[]>();
  for (let index = 0; index < anchors.length; index += 1) rows.set(index, []);

  const heights = anchors.map((item) => item.height).filter((height) => height > 0);
  const reach = (rowHeight ?? (heights.length > 0 ? Math.max(...heights) : 10)) * ROW_REACH;

  for (const item of items) {
    if (!clean(item.str)) continue;

    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let index = 0; index < anchors.length; index += 1) {
      const distance = Math.abs(item.y - anchors[index].y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }

    if (bestIndex === -1 || bestDistance > reach) continue;
    rows.get(bestIndex)!.push(item);
  }

  // Buckets past the numbers belong to rows this package does not have. They are
  // built only so that their contents are claimed by something, and then dropped.
  for (let index = numbers.length; index < anchors.length; index += 1) rows.delete(index);

  return rows;
}

/**
 * The heading a vendor prints over the description column.
 *
 * Used only to read a NUMBER-FIRST table, where the pin number is the leftmost
 * column and the name sits to its right: `Pin No. | Mnemonic | Description`.
 * There the usual left-of-the-number rule finds no name at all, and the widest
 * gap cannot supply one either, because a name broken across runs by a subscript
 * (`+V` over `S`, `LOD` then `−`) puts a gap inside the name itself.
 *
 * The heading gives the boundary exactly, and it is the vendor's own statement
 * of where the column starts rather than an inference from spacing.
 */
const DESCRIPTION_HEADING = /^(?:description|function)s?$/i;

/**
 * The words a vendor heads a pin table's columns with.
 *
 * Used to find where the header block ENDS, which the text height cannot say. A
 * header is several printed lines deep and each line is a separate baseline:
 * LM358 spends four lines on `PIN / NAME / LCCC / SOIC, SOT23-8, VSSOP, CDIP,
 * PDIP, SO, TSSOP, CFP / I/O / DESCRIPTION`. Anything left over from it lands in
 * the NAME column of the first data row, and the corpus shows exactly that: an
 * ISO7741 pin 7 came back called `EN1NAMEISO7740`, an LM358 pin 2
 * `IN1–NAMELCCC(1)`, a TLV9061 pin 4 `IN–NAME`.
 *
 * A pin is never called any of these, so finding one is proof the line is header
 * rather than data. Every word here appears in the corpus.
 */
const COLUMN_HEADING_WORDS = new Set([
  "PIN", "PINS", "NAME", "NAMES", "NO", "NO.", "NUMBER", "TYPE", "I/O", "IO",
  "DESCRIPTION", "DESCRIPTIONS", "FUNCTION", "FUNCTIONS", "SIGNAL", "TERMINAL",
  "MNEMONIC", "SYMBOL"
]);

/** How far above the first row a header may be looked for, in rows. */
const HEADER_SEARCH_ROWS = 5;

/**
 * Most words a header line may hold.
 *
 * A header is a handful of short cells; prose is a sentence. Without this the
 * heading words are matched inside ordinary text and the ceiling cuts the first
 * row's own name off: `SN65HVD230 and SN65HVD231: VCC / 2 reference output pin`
 * ends in the word "pin" and would be read as the header row.
 */
const MAX_HEADER_WORDS = 6;

/**
 * A device named at the head of a table cell, as in `SN65HVD232: No Connect`.
 *
 * A datasheet covering a family writes one row per pin and qualifies the
 * differences by device. SN65HVD230's pin 5 is printed as two stacked entries
 * under a single number:
 *
 *     V          O   SN65HVD230 and SN65HVD231: VCC / 2 reference output pin
 *      ref
 *     5
 *     NC         NC  SN65HVD232: No Connect
 *
 * Both names sit against the same pin number and only one belongs to the part
 * being asked about, so the reader took both and pin 5 came back called `VNCref`.
 * Pin 8 came back `RNCS` the same way.
 */
const CELL_DEVICE = /\b[A-Z][A-Z0-9]{4,}(?:-[A-Z0-9]+)?\s*:/;

/**
 * Every device-shaped token on such a line, which is NOT the same set.
 *
 * The colon marks only the LAST device in a list, so matching on the colon alone
 * reads `SN65HVD230 and SN65HVD231:` as speaking for the '231 and drops the '230's
 * own name. The membership test has to see both.
 */
const DEVICE_TOKEN = /\b[A-Z][A-Z0-9]{4,}(?:-[A-Z0-9]+)?\b/g;

/**
 * Name-column items on a line that speaks for a DIFFERENT device.
 *
 * A line naming several devices is kept when any of them is ours, which is what
 * `SN65HVD230 and SN65HVD231:` needs. A line naming only others is dropped, and
 * only its NAME-column items are: a description legitimately mentions other parts
 * (UCC27524's ENA cites the UCC27324's pin compatibility) and dropping that would
 * lose real text.
 */
function otherDeviceNames(
  items: TextItem[],
  numberX: number,
  partNumber: string | undefined
): Set<TextItem> {
  const excluded = new Set<TextItem>();
  if (!partNumber) return excluded;
  const wanted = normalizeDevice(partNumber);

  for (const line of pageLines(items)) {
    // The colon is what says this cell is qualified BY device at all. Without it
    // a line merely mentioning a part number would lose its name.
    if (!CELL_DEVICE.test(line.text)) continue;
    const devices = (line.text.match(DEVICE_TOKEN) ?? []).map(normalizeDevice);
    if (devices.length === 0) continue;
    if (devices.some((device) => device === wanted || wanted.startsWith(device))) continue;

    for (const item of items) {
      if (Math.abs(item.y - line.y) > LINE_TOLERANCE) continue;
      if (item.x + item.width > numberX + COLUMN_TOLERANCE) continue;
      excluded.add(item);
    }
  }

  return excluded;
}

/**
 * A footnote marker, which a vendor hangs off a heading or a pin name.
 *
 * Excluded from names because it is punctuation about the table rather than part
 * of any pin: an LM358's `(1)` sits under its `LCCC` heading and was read as part
 * of pin 2's name.
 */
const FOOTNOTE_MARKER = /^\(\d{1,2}\)$/;

/**
 * A cell whose whole content is the not-connected designator.
 *
 * Matched against ONE cell rather than against the assembled description, which
 * is the difference between reading and guessing. A description is assembled down
 * the page, so RHF1201 pin 20's reads `Not connected to the NC dice` with its
 * wrapped note interleaved, and no anchored pattern over that string means
 * anything. The single cell at the description column's own x is exactly `NC`.
 *
 * Requiring the WHOLE cell is what keeps a description that merely mentions one:
 * a UCC27524's ENA cites the UCC27324's `N/C` pin and keeps its own name.
 */
const NOT_CONNECTED_CELL = /^(?:NC|N\/C)$/i;

/**
 * The baseline of the LOWEST header line above the table's first row.
 *
 * Bounded to a few rows above the data so a heading word elsewhere on the page
 * cannot move the ceiling, and deliberately NOT bounded by the caption, because
 * plenty of real tables carry a header and no caption this reader recognises
 * (SN65HVD230 heads its columns `PIN / NAME / NO. / TYPE / DESCRIPTION` under a
 * plain `Pin Functions` line).
 *
 * Returning the LOWEST such line is what keeps a wrapped description: the first
 * row's description often begins on a line ABOVE the row's own baseline, and that
 * line sits below the header.
 */
function headerLineY(items: TextItem[], firstRowY: number, rowHeight: number): number | null {
  let lowest: number | null = null;

  for (const line of pageLines(items)) {
    if (line.y <= firstRowY) continue;
    if (line.y > firstRowY + rowHeight * HEADER_SEARCH_ROWS) continue;
    const words = line.text.split(/\s+/).map((word) => word.toUpperCase().replace(/[,;]$/, ""));
    if (words.length > MAX_HEADER_WORDS) continue;
    // A multi-package table heads its columns with the PACKAGES, so that row is a
    // header even though it holds none of the usual heading words. Without this an
    // STM32F103C8's `LFBGA100 VFQFPN36` line sits inside the first row's reach and
    // is read as part of a pin name (`VFQFPN36PA0-WKUP`).
    if (!words.some((word) => COLUMN_HEADING_WORDS.has(word))) {
      // A multi-package table heads its columns with the PACKAGES, so that row is
      // a header even though it holds none of the usual heading words: an
      // STM32F103C8's `LFBGA100 VFQFPN36` line otherwise sits inside the first
      // row's reach and is read as part of a pin name (`VFQFPN36PA0-WKUP`).
      //
      // A MAJORITY of the line must name a family, and at least two words must.
      // One incidental match is not a header row, and requiring only one dropped
      // the ceiling onto an MSP430F5529 data row and cut a wrapped pin name in
      // half (`PM_UCB1SCL` for `P4.2/PM_UCB1SOMI/PM_UCB1SCL`). Caught by the
      // pin-name oracle.
      const families = words.filter((word) => packageFamilies(word).length > 0).length;
      if (families < 2 || families * 2 <= words.length) continue;
    }
    if (lowest === null || line.y < lowest) lowest = line.y;
  }

  return lowest;
}

/** A header cell naming the column that holds the pin's NAME. */
const NAME_HEADING = /^(?:pin\s*)?names?$|^mnemonics?$|^signal(?:\s*names?)?$/i;

/**
 * Where the header says the pin NAME column starts, when it sits to the RIGHT of
 * the numbers.
 *
 * Position cannot find it on these tables. An STM32F103C8 prints four packages'
 * BGA ball designators to the LEFT of its LQFP number columns, so "whatever is
 * left of the number" reads a name of `B2E2` — a ball designator, not a net. The
 * header row says where the name is, and it is the only thing on the page that
 * does.
 *
 * Searched across the whole header BLOCK rather than one printed line, because a
 * multi-line header splits its cells over several baselines: this one puts `Pin
 * name` and `Type` on different lines.
 */
/**
 * The topmost row of ANY of the page's number columns. A package that does not
 * have the table's first few signals starts lower than its neighbours, so the
 * chosen column's own first row is not the top of the table.
 */
function tableTopY(topmost: TextItem, columns: TextItem[][]): number {
  return Math.max(topmost.y, ...columns.flat().map((item) => item.y));
}

function nameHeadings(
  items: TextItem[],
  firstRowY: number,
  captionY: number
): { nameX: number; nextX: number | null } | null {
  const block = items.filter(
    (item) => item.y > firstRowY && item.y < captionY && clean(item.str).length > 0
  );
  const heading = block
    .filter((item) => NAME_HEADING.test(clean(item.str)))
    .sort((left, right) => left.y - right.y)[0];
  if (!heading) return null;

  const next = block
    .filter((item) => item.x > heading.x && !FOOTNOTE_MARKER.test(clean(item.str)))
    .sort((left, right) => left.x - right.x)[0];

  return { nameX: heading.x, nextX: next ? next.x : null };
}

/**
 * The left edge of the content column a heading sits over.
 *
 * A vendor does not left-align a heading with the cells beneath it: RHF1201
 * prints `Description` at x=158 over descriptions starting at x=144, and an
 * STM32F103C8 prints `Type` at x=311 over cells starting at x=301. So the heading
 * LOCATES the column and the column's own content bounds it.
 */
function contentEdgeUnder(items: TextItem[], headingX: number, after: number): number {
  const clusters = cluster(items.filter((item) => item.x > after), (item) => item.x, COLUMN_TOLERANCE);
  if (clusters.length === 0) return headingX;
  const nearest = clusters.reduce((best, candidate) =>
    Math.abs(candidate[0].x - headingX) < Math.abs(best[0].x - headingX) ? candidate : best
  );
  return Math.min(nearest[0].x, headingX);
}

/**
 * The description column's heading, searched in the band between the table's
 * first row and the caption above it, which is where a heading row sits.
 *
 * Deliberately not bounded by `ceiling`. That is derived from the reported text
 * height, and the height pdf.js reports is not always the font size: on AD8232
 * page 6 the pin-number runs come back 81 points tall in an 8 point table, which
 * puts the ceiling a hundred points above the heading row and hides it. The
 * caption and the first row are positions, not metrics, so they do not have that
 * failure mode.
 */
function descriptionHeading(
  items: TextItem[],
  numberX: number,
  firstRowY: number,
  captionY: number
): TextItem | null {
  const headings = items
    .filter(
      (item) =>
        item.y > firstRowY &&
        item.y < captionY &&
        item.x > numberX + COLUMN_TOLERANCE &&
        DESCRIPTION_HEADING.test(clean(item.str))
    )
    .sort((left, right) => left.y - right.y);

  return headings.length > 0 ? headings[0] : null;
}

/**
 * Splits one row's items into name, type and description by x.
 *
 * The number column is the origin: anything to its left is the name, and to its
 * right the type comes first and the description is the rest. The boundary
 * between those two is the largest horizontal gap on the right-hand side, which
 * is how a table is typeset and does not require knowing the column headings.
 */
function splitRow(row: TextItem[], numberX: number): { name: string; type: string; description: string } {
  const ordered = [...row].sort((left, right) => left.x - right.x || right.y - left.y);

  const left = ordered.filter((item) => item.x + item.width <= numberX + COLUMN_TOLERANCE);
  const right = ordered.filter((item) => item.x > numberX + COLUMN_TOLERANCE);

  // A name is one token even when it arrives as several runs ("V" then "ref"),
  // so it is joined without spaces; a description is prose and keeps them.
  const name = left
    .filter((item) => !FOOTNOTE_MARKER.test(clean(item.str)))
    .map((item) => clean(item.str))
    .join("");

  if (right.length === 0) return { name, type: "", description: "" };

  let splitAt = 1;
  let widest = 0;
  for (let index = 1; index < right.length; index += 1) {
    const gap = right[index].x - (right[index - 1].x + right[index - 1].width);
    if (gap > widest) {
      widest = gap;
      splitAt = index;
    }
  }

  return {
    name,
    type: clean(right.slice(0, splitAt).map((item) => item.str).join(" ")),
    description: clean(right.slice(splitAt).map((item) => item.str).join(" "))
  };
}

/**
 * Reads a pin table off one page.
 *
 * Returns null unless the page yields a gap-free 1..N run, every pin of which
 * has a name. A table that cannot be read whole is refused rather than reported,
 * which is the same rule the text reader and the figure reader follow: half a
 * pinout produces half a footprint, and that is worse than an honest gap.
 *
 * A page carrying two captioned tables has two answers and this has one return
 * value, so it refuses; `readPinTablesFromPage` is the one that reads both.
 */
export function readPinTableFromPage(
  page: PageText,
  partNumber?: string,
  packageType?: string
): GeometryPinTable | null {
  const tables = readPinTablesFromPage(page, partNumber, packageType);
  return tables.length === 1 ? tables[0] : null;
}

/**
 * Every pin-function table on one page.
 *
 * Nearly always one, and the exception is what this exists for. ADR4525 page 11
 * prints its SOIC table directly above its LCC table in the SAME x column, so
 * the band of integers there holds `1..8` TWICE: sixteen values, eight distinct,
 * and the no-repeats proof throws the whole page away. Both tables are perfectly
 * readable on their own.
 *
 * They are separated by their CAPTIONS, which is the vendor's own statement of
 * where each table begins, and deliberately not by watching for the numbering to
 * restart. That was tried, measured and reverted: cutting a band wherever the
 * numbers go backwards destroys the name-ordered tables this reader supports on
 * purpose, where a table listing EN1 at 7 before GND1 at 2 goes backwards and is
 * entirely legitimate. A caption says nothing about ordering.
 */
export function readPinTablesFromPage(
  page: PageText,
  partNumber?: string,
  packageType?: string
): GeometryPinTable[] {
  const captions = pinFunctionCaptions(page.items);

  if (captions.length < 2) {
    const caption = captions[0] ?? null;

    // Side-by-side blocks are tried FIRST, and this is the one reader that may
    // displace a table the ordinary one would have read. It has to be, because the
    // failure it prevents is a page where the ordinary reader SUCCEEDS and is
    // wrong: RHF1201's left-hand block would read as a complete 1..24 for a 48-pin
    // part, and today it is stopped only by the accident that four of its numbers
    // are glued to their neighbouring cells. A part whose blocks are clean has no
    // such luck.
    //
    // Preferring it is sound rather than a preference. Both readings satisfy a
    // 1..N proof, but the tiling explains EVERY numbered row on the page while the
    // single-block reading leaves a whole block of them unaccounted for, and a
    // reader that ignores half a captioned table is reading a fragment.
    if (caption) {
      const blocks = readSideBySideTable(page.items, page.page, caption, partNumber, packageType);
      if (blocks) return [blocks];
    }

    const table = readOneTable(page.items, page.page, caption, partNumber, packageType);
    if (table) return [table];

    // Only where every reader above found nothing, so this can never displace a
    // table that already reads. It exists for a layout the others cannot see
    // rather than as a second opinion about the same rows.
    return caption ? readGroupedTable(page.items, page.page, caption, packageType) : [];
  }

  // Each caption owns the band from itself down to the next one. The last owns
  // the rest of the page.
  const tables: GeometryPinTable[] = [];
  for (let index = 0; index < captions.length; index += 1) {
    const top = captions[index].y;
    const bottom = index + 1 < captions.length ? captions[index + 1].y : -Infinity;
    const slice = page.items.filter((item) => item.y < top && item.y > bottom);
    const table = readOneTable(slice, page.page, captions[index], partNumber, packageType);
    if (table) tables.push(table);
    else tables.push(...readGroupedTable(slice, page.page, captions[index], packageType));
  }
  return tables;
}

/**
 * Reads a table whose cells hold GROUPS of pin numbers. See
 * `findGroupedNumberColumns` for the shape and why the ordinary reader cannot
 * see it.
 *
 * Requires the vendor's caption, for the same reason the type-column waiver
 * does: this shape has no type column at all, so the caption is the only
 * evidence that these rows are a pinout rather than any other table of numbers.
 * Without it this would be a reader with nothing but a 1..N test, and a 1..N test
 * alone has already been measured admitting bond-pad coordinate tables.
 *
 * The column HEADING becomes the table's package qualifier, because on this
 * layout the columns ARE the packages. That is what lets the caller pick: an
 * RHFL4913 is a 16-pin part in FLAT-16P and a 3-pin part in TO-257, and both are
 * correct answers to different questions.
 */
function readGroupedTable(
  pageItems: TextItem[],
  pageNumber: number,
  caption: PinTableCaption,
  packageType?: string
): GeometryPinTable[] {
  const columns = findGroupedNumberColumns(pageItems);
  if (columns.length === 0) return [];

  // How many of this caption's columns are headed by a PACKAGE, counted before
  // any of them is read.
  //
  // The ambiguity belongs to the table, not to the columns that happened to
  // survive. A PCF8574 numbers four packages side by side and only its RGT column
  // is readable, the other three being rejected for reasons of their own; judging
  // by the survivors alone left one qualified table, which every rule downstream
  // then treats as unambiguous. It is not: the RGT column puts VCC at pin 1 and
  // the DW column on the same row puts A0 there, both over sixteen pins, so a
  // caller holding the SOIC is handed VQFN numbering with nothing to notice it
  // by. Package-qualified columns are counted here so a table that offers a
  // choice keeps offering it.
  const packageColumns = columns.filter((column) => {
    const topmost = column.reduce((highest, item) => (item.y > highest.y ? item : highest));
    if (caption.y <= topmost.y) return false;
    const heading = headingOver(
      pageItems.filter((item) => item.y < caption.y),
      column,
      topmost.y
    );
    return packageFamilies(heading).length > 0;
  }).length;

  const tables: GeometryPinTable[] = [];

  for (const column of columns) {
    const topmost = column.reduce((highest, item) => (item.y > highest.y ? item : highest));
    if (caption.y <= topmost.y) continue;

    const left = Math.min(...column.map((item) => item.x));
    const rowHeight = rowHeightOf(column);

    // The name sits left of the column, on the row of its cell. Nearest by
    // baseline rather than equal, because a name broken by a subscript (`V` over
    // `O`) puts its parts on two lines either side of the number.
    const named = column.map((cell) => {
      const parts = pageItems
        .filter(
          (item) =>
            item.x + item.width <= left + COLUMN_TOLERANCE &&
            Math.abs(item.y - cell.y) <= rowHeight * 1.5 &&
            clean(item.str).length > 0
        )
        .sort((a, b) => a.x - b.x || b.y - a.y);
      return { cell, parts, name: parts.map((item) => clean(item.str).replace(/\s+/g, "")).join("") };
    });

    if (named.some((entry) => entry.name.length === 0 || entry.name.length > MAX_NAME_LENGTH)) continue;

    // A NUMBER left of the column means this is not the leftmost pin-number
    // column, so ANOTHER package's numbering is being read as part of the name.
    // Measured: a TXB0104 numbers two packages side by side and came back with
    // pin 2 called `A12` and pin 6 called `NC6,9`, which is the name with the
    // neighbouring column's cell glued on. A pin name is never a bare number, so
    // one is enough to reject the column outright.
    //
    // This is the same failure `ownsNumberColumn` exists to prevent on the
    // ordinary layout, and it is worth being stricter here: that reader can fall
    // back on a type column, and this shape has none.
    if (
      named.some((entry) =>
        entry.parts.some(
          (item) =>
            NUMBER_CELL.test(clean(item.str)) || WRAPPED_NUMBER_CELL.test(clean(item.str))
        )
      )
    )
      continue;

    // A MERGED cell is taller than a row, so its name band is wide enough to
    // reach the rows above and below it. One name is the only readable outcome:
    // two swept in together glue into a name neither row has. Judged by printed
    // line rather than by run, so a name broken by a subscript still counts once.
    const spanned = named.some(
      (entry) =>
        entry.cell.str.trimEnd().length > 0 &&
        entry.parts.length > 0 &&
        expandNumberCell(entry.cell.str).length > 1 &&
        cluster(entry.parts, (item) => item.y, LINE_TOLERANCE).length > 1
    );
    if (spanned) continue;

    const pins: GeometryPin[] = [];
    let unreadableRange = false;

    for (const entry of named) {
      const numbers = expandNumberCell(entry.cell.str);

      // A bus written as one row names one pin per index. Expanded when the
      // range says which way it runs and the counts agree, refused otherwise,
      // because repeating `P[0..7]` across eight pins is a wrong netlist.
      const expanded = expandRangeName(entry.name, numbers.length);
      if (expanded === null && BRACKETED_RANGE.test(entry.name)) {
        unreadableRange = true;
        break;
      }

      numbers.forEach((number, index) => {
        pins.push({
          number: String(number),
          name: expanded ? expanded[index] : entry.name,
          type: "",
          description: "",
          start: entry.cell.start
        });
      });
    }
    if (unreadableRange) continue;
    pins.sort((a, b) => Number(a.number) - Number(b.number));

    // The heading over this column names the package it numbers, on the layout
    // this reader exists for. Where it does not name a recognisable family the
    // table carries no qualifier and the ordinary rules judge it.
    //
    // Searched strictly BELOW the caption, because a heading sits between the
    // caption and the rows. Without that bound the caption is swept into it and
    // the package comes back called `Table 1. FLAT-16P`.
    const heading = headingOver(
      pageItems.filter((item) => item.y < caption.y),
      column,
      topmost.y
    );
    const family = packageFamilies(heading).length > 0 ? clean(heading) : null;

    tables.push({
      pins,
      page: pageNumber,
      start: pins[0].start,
      device: PIN_TABLE_CAPTION.exec(caption.text)?.[1] ?? null,
      claimed: false,
      captioned: true,
      packageQualifier: family,
      captionLabel: caption.label
    });
  }

  // A table that numbers SEVERAL packages side by side answers a question the
  // caller has to ask, and it answers it only for the package they name.
  //
  // Judged on `packageColumns` rather than on how many tables were read, because
  // the choice belongs to the table and a column the reader could not lift does
  // not withdraw it. PCF8574 is the case: four package columns, of which only RGT
  // is readable, so counting survivors left one table that every rule downstream
  // treated as unambiguous. It is not. RGT puts VCC at pin 1 and the DW column on
  // the same rows puts A0 there, both over sixteen pins, so a caller holding the
  // SOIC was handed VQFN numbering with nothing to notice it by.
  //
  // Kept here rather than in `selectPackageQualifiedTables` because that function
  // also judges tables whose qualifier is an outline CODE, which no comparison
  // against a family NAME can match: an MSP430F5529's table is qualified `PN` and
  // its package reads `LQFP (80)`, and requiring those to agree refuses a table
  // that was correct.
  if (packageColumns >= 2) {
    const wanted = packageType ? packageFamilies(packageType) : [];
    return tables.filter(
      (table) =>
        table.packageQualifier === null ||
        (wanted.length > 0 &&
          packageFamilies(table.packageQualifier).some((family) => wanted.includes(family)))
    );
  }

  // One column and no package named is unambiguous. Several is a choice, and the
  // package qualifier is what the caller answers it with; see
  // `selectPackageQualifiedTables`.
  return tables.length === 1 || packageType !== undefined
    ? tables
    : tables.filter((table) => table.packageQualifier === null);
}

/**
 * A number column chosen by something other than the per-page 1..N proof.
 *
 * Only `readContinuedTable` supplies one, having proved the column across the
 * whole table rather than on this page. `columns` is every integer band on the
 * page, which is what the sibling-column removal below needs in order to keep
 * another package's numbering out of the name and type cells.
 */
interface ForcedColumn {
  column: TextItem[];
  columns: TextItem[][];
}

/**
 * The ways a run of text could be a pin number glued to a pin name.
 *
 * `pdf-parse` reports one text run per drawing operation, and a vendor that draws
 * the number and the name in a single operation hands over `3VCCBE`. RHF1201 does
 * it on four rows of one table, which is why its left-hand block reads 1, 2, 6, 8
 * and skips 3, 4, 5 and 7.
 *
 * Every split is returned rather than one being chosen, because the choice is not
 * decidable from the run: `52ND` is pin 5 of a signal called `2ND` and pin 52 of
 * one called `ND`, and only the numbering can say which. The caller accepts a
 * split solely when the number FILLS A GAP in an otherwise contiguous run, and
 * refuses when more than one split would; see `completeBlock`.
 */
function gluedSplits(text: string): { number: number; name: string }[] {
  const splits: { number: number; name: string }[] = [];
  for (let digits = 1; digits <= 3 && digits < text.length; digits += 1) {
    if (!/^\d+$/.test(text.slice(0, digits))) break;
    const rest = text.slice(digits);
    // A name begins with a letter. Without this every prefix of a multi-digit
    // number is a candidate and the gap test is asked to referee nonsense.
    if (!/^[A-Za-z]/.test(rest)) continue;
    splits.push({ number: Number(text.slice(0, digits)), name: rest });
  }
  return splits;
}

/** One block of a table printed as several side-by-side blocks. */
interface NumberBlock {
  /** The block's number column, including any recovered from a glued run. */
  numbers: TextItem[];
  /** The glued runs this block took apart, so the caller can substitute them. */
  synthesized: { original: TextItem; parts: TextItem[] }[];
  x: number;
  min: number;
  max: number;
}

/**
 * Splits a glued run into a number item and a name item, positioned by the share
 * of the run each takes.
 *
 * The widths are an estimate, and they only have to be good enough to put the
 * name to the right of the number column and to the left of the description,
 * which are tens of points apart. Nothing downstream measures a name.
 */
function splitGluedItem(item: TextItem, digits: number): TextItem[] {
  const text = clean(item.str);
  const numberWidth = (item.width * digits) / text.length;
  return [
    { ...item, str: text.slice(0, digits), width: numberWidth },
    { ...item, str: text.slice(digits), x: item.x + numberWidth, width: item.width - numberWidth }
  ];
}

/**
 * Fills the gaps in a number column from glued runs sitting in that column.
 *
 * Returns null unless the block ends up contiguous, and the gap is what makes
 * this safe: a split is accepted only when the number it yields is one the column
 * is MISSING, so an accepted split is corroborated by the numbering rather than
 * assumed from the text. Where two splits of one run would both fill a gap, or two
 * runs would fill the same gap, the run is ambiguous and the block is refused.
 *
 * A gap is INTERIOR by construction, which bounds what this can recover: a glued
 * run holding the number one past the block's last is not recoverable, because
 * nothing says the block ended there rather than at the number actually seen.
 * Extending the range to reach a candidate would be speculation, and the whole
 * safety of this rests on the candidate having to land somewhere already known to
 * be empty. RHF1201's four glued runs are all interior.
 */
function completeBlock(band: TextItem[], candidates: TextItem[]): NumberBlock | null {
  const values = band.map((item) => Number(clean(item.str)));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const missing = new Set<number>();
  for (let value = min; value <= max; value += 1) {
    if (!values.includes(value)) missing.add(value);
  }

  const numbers = [...band];
  const synthesized: { original: TextItem; parts: TextItem[] }[] = [];

  if (missing.size > 0) {
    const claimed = new Map<number, TextItem>();

    for (const candidate of candidates) {
      const filling = gluedSplits(clean(candidate.str)).filter((split) => missing.has(split.number));
      // Two readings of one run that both fill a gap: the run does not say which
      // pin it is, and guessing is the thing this file exists not to do.
      if (filling.length !== 1) continue;
      const { number } = filling[0];
      // Two runs offering the same pin is the same ambiguity from the other side.
      if (claimed.has(number)) return null;
      claimed.set(number, candidate);
    }

    for (const [number, candidate] of claimed) {
      const digits = String(number).length;
      const parts = splitGluedItem(candidate, digits);
      synthesized.push({ original: candidate, parts });
      numbers.push(parts[0]);
      missing.delete(number);
    }

    if (missing.size > 0) return null;
  }

  numbers.sort((left, right) => Number(clean(left.str)) - Number(clean(right.str)));
  return { numbers, synthesized, x: medianOf(numbers.map((item) => item.x)), min, max };
}

/**
 * Reads one logical table printed as several side-by-side blocks.
 *
 * RHF1201 prints its 48 pins as `1-24 | 25-48` across one page, which no reader
 * here could see: each block is a band of integers that does not start at 1 or
 * does not reach N, so the per-column 1..N proof fails on both.
 *
 * What separates this from a table numbering several PACKAGES is decidable and
 * needs no vocabulary: variant columns number the SAME pins, so their values
 * overlap (an ISO7741 prints 1..16 three times, an MSP430F5529 prints 1..80 beside
 * 1..64), while blocks of one table number DISJOINT ranges that tile 1..N exactly
 * once. Overlap means variants and is left to the reader that handles them.
 *
 * The caption is required, and it is the only thing standing between this and a
 * two-column pinout FIGURE, whose left and right columns also tile 1..N once. A
 * figure caption cannot qualify, because `PIN_FUNCTION_CAPTION` demands the
 * `Table` prefix.
 *
 * Each block is read from its own vertical SLICE of the page. That is not tidiness:
 * it gives each block its own `Description` heading, which is what bounds the name
 * column, and it keeps the neighbouring block's prose out of this block's rows.
 */
function readSideBySideTable(
  pageItems: TextItem[],
  pageNumber: number,
  caption: PinTableCaption,
  partNumber?: string,
  packageType?: string
): GeometryPinTable | null {
  const below = pageItems.filter((item) => item.y < caption.y);
  const bands = findIntegerColumns(below);
  if (bands.length < 2) return null;

  const blocks: NumberBlock[] = [];
  for (const band of bands) {
    const x = medianOf(band.map((item) => item.x));
    // A glued run sits IN the number column, which is what makes it a candidate
    // for having eaten that column's value.
    const candidates = below.filter(
      (item) =>
        !band.includes(item) &&
        Math.abs(item.x - x) <= COLUMN_TOLERANCE &&
        gluedSplits(clean(item.str)).length > 0
    );
    const block = completeBlock(band, candidates);
    if (block) blocks.push(block);
  }

  // The blocks must tile 1..N: start at the one holding pin 1 and follow the
  // numbering. Two blocks starting at the same pin is an overlap, which means
  // variants rather than blocks, so the chain refuses instead of choosing.
  const chain: NumberBlock[] = [];
  let next = 1;
  for (;;) {
    const starting = blocks.filter((block) => block.min === next && !chain.includes(block));
    if (starting.length === 0) break;
    if (starting.length > 1) return null;
    chain.push(starting[0]);
    next = starting[0].max + 1;
  }

  if (chain.length < 2) return null;

  const total = chain.reduce((sum, block) => sum + block.numbers.length, 0);
  if (!spellsOneToN(chain.flatMap((block) => block.numbers.map((item) => Number(clean(item.str)))))) {
    return null;
  }

  // Each block owns the page from its own column up to the next block's column.
  const byX = [...chain].sort((left, right) => left.x - right.x);
  const pins: GeometryPin[] = [];

  for (let index = 0; index < byX.length; index += 1) {
    const block = byX[index];
    const lo = index === 0 ? -Infinity : block.x - COLUMN_TOLERANCE;
    const hi = index + 1 < byX.length ? byX[index + 1].x - COLUMN_TOLERANCE : Infinity;

    const originals = new Set(block.synthesized.map((entry) => entry.original));
    const slice = [
      ...below.filter((item) => item.x >= lo && item.x < hi && !originals.has(item)),
      ...block.synthesized.flatMap((entry) => entry.parts)
    ];

    const table = readOneTable(slice, pageNumber, caption, partNumber, packageType, {
      column: block.numbers,
      columns: [block.numbers]
    });
    if (!table) return null;
    pins.push(...table.pins);
  }

  pins.sort((left, right) => Number(left.number) - Number(right.number));
  if (pins.length !== total) return null;

  return {
    pins,
    page: pageNumber,
    start: pins[0].start,
    device: PIN_TABLE_CAPTION.exec(caption.text)?.[1] ?? null,
    claimed: false,
    captioned: true,
    packageQualifier: caption.packageQualifier,
    captionLabel: caption.label
  };
}

/**
 * Aggregate diagnostic: which gate refused a page, counted across a corpus.
 *
 * Gated on an env var and off in every normal run. It exists so the hold-out can
 * be studied as a STATISTIC without opening any document in it, which is the only
 * way to work that corpus without burning it.
 */
const REFUSALS: string[] = [];
export function drainRefusals(): string[] {
  const drained = [...REFUSALS];
  REFUSALS.length = 0;
  return drained;
}
function refuse(reason: string, page?: number): null {
  if (process.env.FORGE_DEBUG_REFUSAL) REFUSALS.push(`${page ?? "?"}|${reason}`);
  return null;
}

function readOneTable(
  pageItems: TextItem[],
  pageNumber: number,
  caption: PinTableCaption | null,
  partNumber?: string,
  packageType?: string,
  forced?: ForcedColumn
): GeometryPinTable | null {
  const page = { items: pageItems, page: pageNumber };
  const columns = forced ? forced.columns : findNumberColumns(page.items);
  if (columns.length === 0) return refuse("no number column spelling 1..N", pageNumber);

  const selected = forced
    ? // A page carrying more than one integer band is a table numbering more than
      // one package, which is exactly the multi-variant case: an MSP430F5529
      // prints its 80-pin PN column beside its 64-pin RGC column. Saying so here
      // is what strips the sibling column out of the row before it is read as a
      // type or a description.
      { column: forced.column, multiVariant: columns.length > 1 }
    : selectVariantColumn(page.items, columns, partNumber, packageType);
  if (!selected) return refuse("several variant columns, none chosen", pageNumber);

  const { column: numbers, multiVariant } = selected;
  const numberX = numbers[0].x;

  // A multi-variant table puts the other devices' number columns between this
  // one and the type column. Left in, they are read as the type and the table is
  // rejected; taken out, the row reads as it would on a single-variant page.
  //
  // Every bare integer is dropped, not just the ones that formed a qualifying
  // 1..N column. An ISO7741's third variant lists more numbers than it has pins,
  // so its column never qualifies, and it was still sitting exactly where the
  // type belongs. On a single-variant page this is left alone, because there a
  // stray integer is more likely to be part of a description.
  const siblingX = multiVariant
    ? columns.filter((column) => column !== numbers).map((column) => column[0].x)
    : [];

  const excluded = new Set(
    multiVariant
      ? page.items.filter(
          (item) =>
            !numbers.includes(item) &&
            (isInteger(clean(item.str)) ||
              // The placeholder a variant column carries where the device has no
              // such pin. It is an em dash rather than a number, so the integer
              // rule misses it, and it sits left of the chosen column, so it was
              // being read as part of the name: an ISO7741 pin 7 came back as
              // "EN1—".
              siblingX.some((x) => Math.abs(item.x - x) <= COLUMN_TOLERANCE))
        )
      : columns.filter((column) => column !== numbers).flat()
  );

  // The column headings sit above the topmost row and would otherwise be pulled
  // into it, which produced names like "NAMESwitchCollectorPIN". One line of
  // headroom is kept because a wrapped description legitimately sits just above
  // the row it belongs to.
  //
  // Topmost by position, not `numbers[0]`: the run is ordered by pin number, and
  // a table sorted by pin name puts some other pin at the top of the page.
  const topmost = numbers.reduce((highest, item) => (item.y > highest.y ? item : highest));

  // A caption only speaks for rows BELOW it. On a segmented slice that holds by
  // construction; on a whole page it has to be checked, because a page can carry
  // a table above the caption of the next one.
  const above = caption && caption.y > topmost.y ? caption : null;

  // Where the vendor prints a heading row, that row IS the top of the table and
  // there is no need to infer one from the text height. Preferred when present
  // because the inferred bound is only as good as the reported height, which on
  // some documents is wildly wrong; see `descriptionHeading`.
  const rowHeight = rowHeightOf(numbers);

  // The pitch the ceiling and floor are measured in comes from EVERY number
  // column, not from the chosen one. A package that has few of the page's signals
  // gives a sparse column whose median gap is several rows, and the band then
  // reaches far enough to swallow a column heading above the table and the page
  // footer below it: an STM32F103C8 pin came back named `PB1DS5319Rev20`.
  // Taken from the DENSEST column, not from the chosen one and not from all of
  // them pooled. Pooling is wrong because variant columns number the same rows, so
  // their gaps interleave to roughly half the real pitch, which tightened the band
  // enough to cut a wrapped name in half: an MSP430F5529 pin 47 came back
  // `PM_UCB1SCL` instead of `P4.2/PM_UCB1SOMI/PM_UCB1SCL`. Caught by the pin-name
  // oracle, which is the only check here that reads a value rather than counting
  // one.
  const densest = columns.reduce((best, candidate) => (candidate.length > best.length ? candidate : best), numbers);
  const pitch = rowHeightOf(densest);
  const header = above ? descriptionHeading(page.items, numberX, topmost.y, above.y) : null;

  // Where the vendor heads its columns, that header row IS the top of the table.
  // Preferred over anything inferred from the text height, which on some
  // documents is wildly wrong, and it is what keeps a multi-line header out of
  // the first row's NAME cell; see `headerLineY`.
  const headerY = headerLineY(page.items, topmost.y, pitch);
  const ceiling = headerY !== null ? headerY - LINE_TOLERANCE : topmost.y + pitch * 1.5;

  // And a floor, for the same reason at the other end. A table's footnote legend
  // sits just below the last row, and the last row reached down and took it: an
  // ISO7741's final pin came back named "(1)VCC2I = Input, O = Output". One line
  // of headroom again, because the last row's description may wrap below it.
  const bottommost = numbers.reduce((lowest, item) => (item.y < lowest.y ? item : lowest));
  const floor = bottommost.y - pitch * 1.5;

  // Rows this package does not have. A table covering several packages still
  // prints every signal, and writes a placeholder where a package has no such
  // pin: an LM358's `NC` row carries eleven LCCC pin numbers and an em dash in
  // the SOIC column. The row owns no number, so its name was claimed by whichever
  // numbered row sat nearest and pin 8 came back called `NCV+`.
  //
  // Making the placeholder an anchor in its own right is what fixes it: the row's
  // items are claimed by the placeholder, which is then discarded. Anything in
  // the number column's own band that is not one of the numbers is such a marker,
  // whatever character the vendor used for it.
  const placeholders = page.items.filter(
    (item) =>
      !numbers.includes(item) &&
      !excluded.has(item) &&
      Math.abs(item.x - numberX) <= COLUMN_TOLERANCE &&
      item.y <= ceiling &&
      item.y >= floor &&
      clean(item.str).length > 0 &&
      !isInteger(clean(item.str))
  );

  // Names belonging to a sibling device in the same family table; see
  // `otherDeviceNames`.
  const foreign = otherDeviceNames(page.items, numberX, partNumber);

  const inTable = (item: TextItem) =>
    !numbers.includes(item) &&
    !placeholders.includes(item) &&
    !excluded.has(item) &&
    !foreign.has(item) &&
    item.y <= ceiling &&
    item.y >= floor;

  const rows = assignRows(page.items.filter(inTable), numbers, [...numbers, ...placeholders], rowHeight);

  // A table that numbers SEVERAL PACKAGES carries a second pin-number column
  // between the name and the chosen one, and its cells are read as part of the
  // name: an OPA333 pin 1 came back called "NCOUT1, 5, 86", which is the SOIC
  // column's "1, 5, 8" and "6" glued onto two rows that had merged. The packages
  // disagree about which signal sits at which position, so nothing on the page
  // says which of them the caller wants, and reading either one is a guess.
  //
  // The sibling columns of a multi-variant table are already removed above, so
  // what reaches here is a column the 1..N proof could not see: a package whose
  // numbering has gaps from this table's point of view.
  //
  // It can be resolved, but only by the caller naming the package, and only when
  // the package they named is the one whose column carries the 1..N proof. See
  // `ownsNumberColumn`.
  const leftByRow = numbers.map((_, index) =>
    (rows.get(index) ?? []).filter((item) => item.x + item.width <= numberX + COLUMN_TOLERANCE)
  );
  const leftBands = cluster(leftByRow.flat(), (item) => item.x, COLUMN_TOLERANCE);
  const nameBand = new Set(leftBands[0] ?? []);
  const numberedRows = leftByRow.filter((row) =>
    row.some((item) => !nameBand.has(item) && NUMBER_CELL.test(clean(item.str)))
  ).length;

  if (numberedRows >= numbers.length * MIN_NUMBERED_ROWS) {
    const siblingBands = leftBands
      .slice(1)
      .filter((band) => band.some((item) => NUMBER_CELL.test(clean(item.str))));
    if (!ownsNumberColumn(page.items, numbers, siblingBands, topmost.y, packageType))
      return refuse("column belongs to another package", pageNumber);

    // The package that was asked for is the one this column numbers, so the
    // others are dropped exactly as a multi-variant table's siblings are, and
    // the rows are reassembled without them.
    for (const band of siblingBands) for (const item of band) excluded.add(item);
    const kept = assignRows(page.items.filter(inTable), numbers, [...numbers, ...placeholders], rowHeight);
    rows.clear();
    for (const [index, items] of kept) rows.set(index, items);
  }

  const cells = numbers.map((_, index) => splitRow(rows.get(index) ?? [], numberX));

  // A NUMBER-FIRST table, where the pin number is the leftmost column and the
  // name sits to its right: `Pin No. | Mnemonic | Description`. Nothing is left
  // of the numbers, so every name came out empty and the table was refused one
  // check later. It is a common ADI layout and it is what kept AD8232, ADR4525
  // and ADG5412 unreadable.
  //
  // Only ever entered on a CAPTIONED table with a headed description column.
  // Both conditions are doing work. Without the caption, a pinout figure listing
  // its numbers down the left and its names down the right has exactly this
  // shape, and reading it as a table is how figures became pinouts before; the
  // type column used to be what stopped that, and on these tables there is no
  // type column to check. Without the heading there is no defensible boundary
  // between the name and the description.
  const emptyNames = cells.every((cell) => cell.name.length === 0);
  const headingX = header ? header.x : null;

  // The heading LOCATES the description column; the column's own content is what
  // bounds it. A vendor does not left-align a heading with the text beneath it:
  // RHF1201 prints `Description` at x=158 over a column of descriptions beginning
  // at x=144, so bounding the name by the heading swept the whole description into
  // it and pin 1 came back called `GNDBIDigitalbufferground`. Taking the x cluster
  // the heading sits nearest and using ITS left edge reads the name column as
  // typeset, without needing to know how the vendor aligns headings.
  const rowItems = [...rows.values()].flat();
  const descriptionX =
    headingX === null ? null : contentEdgeUnder(rowItems, headingX, numberX + COLUMN_TOLERANCE);

  // Where the header puts the pin NAME to the right of the numbers, that band is
  // the name — but only once its far edge is known, and on these tables that edge
  // cannot come from position or from the next heading. An STM32F103C8 prints four
  // packages' BGA ball designators LEFT of its number columns, so reading the name
  // from the left gives `B2E2`, a ball designator rather than a net; and its name
  // column has a RAGGED left edge, because a long name like `PA0-WKUP` starts
  // further left than the rest, so clustering finds the column's own outlier
  // instead of its neighbour.
  //
  // The TYPE column is what bounds it, and that column is found by its CONTENT
  // rather than by its geometry: its cells are the pin-type vocabulary this file
  // already keeps. That is stable against every alignment problem above, because
  // it does not depend on where anything sits, only on what it says.
  const headings = above ? nameHeadings(page.items, tableTopY(topmost, columns), above.y) : null;
  const nameFromRight = headings !== null && headings.nameX > numberX + COLUMN_TOLERANCE && !emptyNames;

  if (nameFromRight) {
    // The band opens after the LAST number column, not at the name heading. This
    // column is CENTRED, so its left edge is ragged and a heading-anchored band
    // cuts the long names: `PC13-TAMPER-` starts at x=224 under a heading at 237,
    // while the short `RTC` on the line below starts at 243. Anchoring on the
    // heading kept only `RTC` and produced a wrong netlist for that pin.
    //
    // Everything between the last number and the type column belongs to the name,
    // which is what the header says and what the page shows.
    const numberEdge = Math.max(
      numberX,
      ...columns.flat().filter((item) => item.x < headings!.nameX).map((item) => item.x)
    );
    const lo = numberEdge + COLUMN_TOLERANCE;
    // The BEST candidate rather than the first to clear a bar. A type column is
    // not uniformly recognisable: this one reads `I/O`, `I/O`, `S-`, where the
    // last is a supply cell split by its own subscript, so a share threshold
    // rejects the very column it is looking for. Whichever cluster carries the
    // most type vocabulary is the type column, and two cells are required so a
    // single stray word cannot nominate one.
    const typed = (candidate: TextItem[]) =>
      candidate.filter((item) => isPinType(item.str)).length;

    const typeColumn = cluster(
      [...rows.values()].flat().filter((item) => item.x > lo),
      (item) => item.x,
      COLUMN_TOLERANCE
    ).reduce<TextItem[] | null>(
      (best, candidate) =>
        typed(candidate) >= 2 && (best === null || typed(candidate) > typed(best)) ? candidate : best,
      null
    );

    // No type column, no edge, no guess. A wrong pin name is a wrong netlist.
    if (!typeColumn) return refuse("no type column and no name edge", pageNumber);
    const hi = typeColumn[0].x;

    for (let index = 0; index < numbers.length; index += 1) {
      const row = rows.get(index) ?? [];
      cells[index] = {
        name: row
          .filter((item) => item.x > lo && item.x < hi && !FOOTNOTE_MARKER.test(clean(item.str)))
          // Reading order, which for a cell wrapped onto a second line is DOWN
          // the page and then across. Sorting by x first reverses a centred
          // column's wrap: `PC15-` sits at x=244 above `OSC32_OUT` at x=226, and
          // by x that reads `OSC32_OUTPC15-`.
          .sort((left, right) => right.y - left.y || left.x - right.x)
          .map((item) => clean(item.str).replace(/\s+/g, ""))
          .join(""),
        type: "",
        description: clean(
          row
            .filter((item) => item.x >= hi)
            .sort((left, right) => right.y - left.y || left.x - right.x)
            .map((item) => item.str)
            .join(" ")
        )
      };
    }
  }

  if (emptyNames && descriptionX !== null) {
    const lo = numberX + COLUMN_TOLERANCE;
    const hi = descriptionX - COLUMN_TOLERANCE;
    for (let index = 0; index < numbers.length; index += 1) {
      const row = rows.get(index) ?? [];
      const between = row
        .filter((item) => item.x > lo && item.x < hi)
        .sort((left, right) => left.x - right.x || right.y - left.y);
      const rest = row
        .filter((item) => item.x >= hi)
        .sort((left, right) => right.y - left.y || left.x - right.x);

      cells[index] = {
        // Joined without spaces for the same reason the left-hand name is: a
        // name arriving as several runs (`+V` over `S`, `LOD` then `−`) is one
        // token, not two words. Spacing INSIDE a run goes the same way, because
        // it is letter-spacing rather than a word break: AD8232 pin 9 is drawn
        // as the single run `O PA M P` and is called OPAMP.
        name: between
          .filter((item) => !FOOTNOTE_MARKER.test(clean(item.str)))
          .map((item) => clean(item.str).replace(/\s+/g, ""))
          .join(""),
        type: "",
        description: clean(rest.map((item) => item.str).join(" "))
      };
    }
  }

  // A name the length of a sentence is prose that drifted into the column. The
  // bound is looser on a CAPTIONED table, for the same reason the type column is
  // waived there: the vendor has stated that these rows are its pin functions, so
  // this IS its name column, and an MCU's port names are genuinely long.
  // `P4.0/PM_UCB1STE/PM_UCA1CLK` is 26 characters of real MSP430F5529 pin name and
  // was the last thing keeping its 80-pin table unreadable.
  const maxName = above ? MAX_CAPTIONED_NAME_LENGTH : MAX_NAME_LENGTH;

  for (const cell of cells) {
    if (cell.name.length > maxName) return refuse("a name is longer than a name can be", pageNumber);
  }

  // A pin the vendor leaves UNNAMED because it is not connected.
  //
  // Read off a render of RHF1201 page 6, because the text layer cannot show it:
  // pins 4, 5, 20 and 21 have an empty Name cell and the word `NC` in the
  // DESCRIPTION column, while pin 19 beside them has `DR` in Name and `Data ready
  // output` in Description. Both `NC` and `Data ready output` are printed at the
  // same x, so no column rule separates them and the row simply has no name.
  //
  // This runs BEFORE the stacked-name rule below, and that order is the whole
  // point. Left nameless, pin 20 adopts its neighbour's row and comes back called
  // `DR`, which is a wrong netlist of exactly the kind the pin-name oracle exists
  // to catch. Naming it from the vendor's own cell is reading rather than
  // inferring: `NC` is the designator, not prose about the pin.
  if (descriptionX !== null) {
    for (let index = 0; index < cells.length; index += 1) {
      if (cells[index].name.length > 0) continue;
      const own = (rows.get(index) ?? []).filter(
        (item) => Math.abs(item.x - descriptionX) <= COLUMN_TOLERANCE && clean(item.str).length > 0
      );
      if (own.length === 0 || !own.every((item) => NOT_CONNECTED_CELL.test(clean(item.str)))) continue;

      cells[index] = {
        ...cells[index],
        name: "NC",
        // Taken out of the description because it has become the name, and a pin
        // described as `Not connected to the NC dice` reads as a defect.
        description: clean(cells[index].description.replace(/\bN\/?C\b/i, ""))
      };
    }
  }

  // One name, several pins. A device with two grounds prints `GND1` once with
  // its pin numbers stacked above and below it:
  //
  //     2  2  2
  //     GND1   —   Ground connection for V
  //                                        CC1
  //     8  8  8
  //
  // So pin 8 owns no name of its own and pin 2 owns them both. Rather than
  // refuse the table, a nameless pin adopts the whole row of the nearest pin
  // that has one, which is what the stacked layout means. This was the last
  // thing keeping a real 16-pin table unreadable, and it is not, as the earlier
  // guess had it, a table continued onto the next page.
  const named = cells
    .map((cell, index) => ({ cell, index }))
    .filter((entry) => entry.cell.name.length > 0);
  if (named.length === 0) return refuse("no row had a name at all", pageNumber);

  for (let index = 0; index < cells.length; index += 1) {
    if (cells[index].name.length > 0) continue;
    const nearest = named.reduce((best, entry) =>
      Math.abs(numbers[entry.index].y - numbers[index].y) <
      Math.abs(numbers[best.index].y - numbers[index].y)
        ? entry
        : best
    );
    const gap = Math.abs(numbers[nearest.index].y - numbers[index].y);
    // Out of reach means it is not a shared row, it is a missing one.
    if (gap > rowHeight * ROW_REACH) return refuse("a row has no name within reach", pageNumber);
    cells[index] = nearest.cell;
  }

  const pins: GeometryPin[] = [];
  let typed = 0;

  for (let index = 0; index < numbers.length; index += 1) {
    const { name, type, description } = cells[index];
    if (isPinType(type)) typed += 1;

    pins.push({
      number: clean(numbers[index].str),
      name,
      type,
      description,
      start: numbers[index].start
    });
  }

  // The type column is a PROXY for "are these rows really a pin table", and a
  // caption reading `Table 3. Pin Function Descriptions` answers that question
  // outright. Where the vendor said so, the proxy is not needed and is waived:
  // plenty of real pin tables print `Pin No. | Mnemonic | Description` and have
  // no type column at all, and refusing them was refusing the vendor's own word
  // in favour of a guess about it.
  //
  // The waiver is exactly as narrow as the caption. An uncaptioned page still
  // has to prove itself the old way, which is what keeps a pinout figure or a
  // bond-pad coordinate table from being read as a pinout.
  if (!above && typed < pins.length * MIN_TYPED_ROWS)
    return refuse("too few rows have a recognised type", pageNumber);

  return {
    pins,
    page: page.page,
    start: pins[0].start,
    // Nearest-above still decides on a whole page, where every caption is
    // visible. The fallback is for a segmented slice, which excludes the caption
    // line it was cut by and so has nothing left to search.
    device:
      captionDevice(page.items, topmost.y) ??
      (above ? PIN_TABLE_CAPTION.exec(above.text)?.[1] ?? null : null),
    claimed: false,
    captioned: above !== null,
    packageQualifier: above?.packageQualifier ?? null,
    captionLabel: above?.label ?? null
  };
}

/**
 * A header row that declares a NUMBER-FIRST table: pin numbers on the left, names
 * to their right.
 *
 * ISL71001M heads every page of its pinout `Pin Number | Pin Name | Description`
 * and never captions the table, so nothing here could see it. The header row says
 * what a caption says, and says it more precisely: it also gives the x of each
 * column, so the name and description do not have to be guessed at from gaps.
 *
 * The VOCABULARY is wider than that one document, because the words vary and the
 * structure does not. A LIS3DH heads exactly the same table `Pin# | Name |
 * Function`, which is the same three columns in the same order under different
 * words, and matching only ISL71001M's phrasing refused a table this reader was
 * built to handle.
 *
 * `#` and a bare `Name` are loose on their own, which is why two things are still
 * required. At least one heading must say PIN, so the row is about a pinout
 * rather than about any other three-column table. And all three must appear on
 * ONE line in left-to-right order. That pair is what a table of contents cannot
 * produce: a geometric reader without it read a contents page and reported that
 * pin 1 was called `Features`.
 */
/** The number column's heading, in the forms vendors actually print. */
const NUMBER_FIRST_NUMBER_HEADING = /^(?:pin\s*)?(?:numbers?|nos?\.?|#)$|^pin\s*#$/i;

/** The name column's heading. `Symbol` and `Signal` are the common synonyms. */
const NUMBER_FIRST_NAME_HEADING = /^(?:pin\s*)?(?:names?|symbols?|signals?)$/i;

/** The description column's heading, which also closes the name band. */
const NUMBER_FIRST_DESCRIPTION_HEADING = /^(?:pin\s*)?(?:descriptions?|functions?)$/i;

/** A cell holding pin numbers, allowing the trailing comma of a wrapped cell. */
const NUMBER_LIST_CELL = /^\d{1,3}(?:\s*,\s*\d{1,3})*\s*,?$/;

/** Where a number-first table's three columns start, read off its header row. */
interface NumberFirstHeader {
  y: number;
  numberX: number;
  nameX: number;
  descriptionX: number;
}

function numberFirstHeader(items: TextItem[]): NumberFirstHeader | null {
  // Every line is tried. There is no cheap text pre-filter, deliberately: one was
  // written as `\bpin\s*#\b` and never fired, because `#` to a space is not a word
  // boundary. The three item checks below are strictly stronger than any such
  // filter anyway, since they test the heading text, the left-to-right order and
  // the presence of the word PIN.
  for (const line of pageLines(items)) {
    const onLine = items.filter((item) => Math.abs(item.y - line.y) <= LINE_TOLERANCE);
    const at = (pattern: RegExp) => onLine.find((item) => pattern.test(clean(item.str)))?.x;

    const number = onLine.find((item) => NUMBER_FIRST_NUMBER_HEADING.test(clean(item.str)));
    const name = onLine.find((item) => NUMBER_FIRST_NAME_HEADING.test(clean(item.str)));
    const description = onLine.find((item) => NUMBER_FIRST_DESCRIPTION_HEADING.test(clean(item.str)));
    if (!number || !name || !description) continue;

    // At least one heading has to say PIN. Without it `# | Name | Function` is
    // any three-column table, and this reader would be judging a table it cannot
    // see the subject of.
    if (![number, name, description].some((item) => /\bpin\b/i.test(clean(item.str)))) continue;

    const numberX = number.x;
    const nameX = name.x;
    const descriptionX = description.x;
    if (!(numberX < nameX && nameX < descriptionX)) continue;

    return { y: line.y, numberX, nameX, descriptionX };
  }
  return null;
}

/** One cell of a number-first table: the pins it names, and where it sits. */
interface NumberCell {
  numbers: number[];
  y: number;
  start: number;
}

/**
 * The number cells below a number-first header, with wrapped cells joined and
 * glued runs taken apart.
 *
 * Everything above the header is excluded, and that is doing real work rather
 * than being tidy: ISL71001M page 6 prints its pin-assignment FIGURE above this
 * table, and the figure's two number columns are a clean contiguous 1..16 and
 * 32..49. A reader that looked at the whole page would find them.
 */
function numberFirstCells(items: TextItem[], header: NumberFirstHeader): NumberCell[] {
  const inColumn = items.filter(
    (item) =>
      item.y < header.y &&
      item.x >= header.numberX - COLUMN_TOLERANCE &&
      item.x < header.nameX - COLUMN_TOLERANCE &&
      clean(item.str).length > 0
  );

  const listCells = inColumn
    .filter((item) => NUMBER_LIST_CELL.test(clean(item.str)))
    .sort((left, right) => right.y - left.y);

  // A cell too wide for its column wraps onto the next line and keeps its comma:
  // ISL71001M writes one PVINx cell as `24, 25, 36,` / `37, 38, 39,` / `50, 51,
  // 52,` / `53, 62, 63` down four lines. The trailing comma is the vendor saying
  // the cell continues, so it is what joins them.
  const cells: NumberCell[] = [];
  let open: { items: TextItem[] } | null = null;

  for (const item of listCells) {
    const text = clean(item.str);
    if (open) open.items.push(item);
    else open = { items: [item] };

    if (text.endsWith(",")) continue;

    const numbers = open.items.flatMap((part) => expandNumberCell(part.str.replace(/,\s*$/, "")));
    const ys = open.items.map((part) => part.y);
    cells.push({
      numbers,
      // The middle of a wrapped cell, because that is where its name is printed.
      y: (Math.max(...ys) + Math.min(...ys)) / 2,
      start: open.items[0].start
    });
    open = null;
  }

  return cells;
}

/**
 * Reads a number-first table declared by a repeated header row, joining its pages.
 *
 * This is the ISL71001M shape and it needs everything at once: names to the RIGHT
 * of the numbers, a header row instead of a caption, cells wrapped across lines,
 * numbers glued to their names (`1M/S`, `6SS`), and a table spanning pages 6 and 7
 * where neither page is 1..N alone.
 *
 * The proof is the same one as everywhere else, paid on the union of the pages:
 * the numbers must spell exactly 1..N. `EPAD` sits in the number column and is not
 * a number, so it is simply not a pin here, which is correct: it is the thermal pad
 * and this reader numbers leads.
 */
/**
 * The header of a table that numbers one part and NAMES several devices, written
 * as a stacked block rather than as one line.
 *
 * ADS8688's is the shape, and every piece of it sits on its own baseline:
 *
 *     PIN                                      <- spans NO. and NAME
 *          NAME        I/O    DESCRIPTION
 *     NO.
 *       ADS8684  ADS8688                       <- the devices, under NAME
 *
 * `numberFirstHeader` wants `PIN NO.` and `PIN NAME` on a single line and finds
 * nothing here, so the ordinary reader falls through to splitting each row at the
 * number column. With the number FIRST there is nothing to its left, so the row
 * splitter takes the device name as the pin name's type and the table is refused
 * at the type gate. That refusal is the one this exists to remove.
 */
interface DeviceColumnHeader {
  /** Baseline of the lowest header row: the rows start below this. */
  bottom: number;
  numberX: number;
  /** The name band, opening after the number column and closing at the type. */
  nameLo: number;
  nameHi: number;
  /** Centre of the sub-header for the device that was asked about. */
  deviceX: number;
  /** How many devices this table names, which is what makes it ambiguous. */
  devices: number;
}

/** A sub-header naming a device: letters and digits, as a part number is. */
const DEVICE_SUBHEADING = /^[A-Za-z][A-Za-z0-9-]{3,}\d[A-Za-z0-9-]*$/;

function deviceColumnHeader(items: TextItem[], partNumber: string): DeviceColumnHeader | null {
  const at = (pattern: RegExp) => items.filter((item) => pattern.test(clean(item.str)));

  for (const number of at(/^(?:pin\s*)?(?:no\.?|numbers?)$/i)) {
    const rowHeight = Math.max(number.height, 1);

    // `NAME`, `I/O` and `DESCRIPTION` all sit within a couple of lines of `NO.`
    // and to its right. The band is deliberately generous vertically and strict
    // horizontally, because the stacking is the whole difficulty here and the
    // left-to-right order is what actually identifies the columns.
    const near = (pattern: RegExp) =>
      at(pattern)
        .filter((item) => item.x > number.x && Math.abs(item.y - number.y) <= rowHeight * 4)
        .sort((left, right) => left.x - right.x)[0];

    const name = near(/^(?:pin\s*)?names?$/i);
    const description = near(/^(?:descriptions?|functions?)$/i);
    if (!name || !description) continue;

    // The type column closes the name band. Where a table has none, the
    // description closes it instead.
    const type = at(/^(?:i\/o|type)$/i)
      .filter((item) => item.x > name.x && item.x < description.x && Math.abs(item.y - number.y) <= rowHeight * 4)
      .sort((left, right) => left.x - right.x)[0];
    const nameHi = (type ?? description).x;
    if (!(number.x < name.x && name.x < nameHi)) continue;

    // The devices, on the line BELOW the one `NAME` sits on and inside the name
    // band. Two or more is what makes this reader necessary; one is an ordinary
    // table and the ordinary readers already have it.
    const subHeadings = items
      .filter(
        (item) =>
          item.y < name.y &&
          item.y >= name.y - rowHeight * 3 &&
          item.x >= number.x &&
          item.x < nameHi &&
          DEVICE_SUBHEADING.test(clean(item.str))
      )
      .sort((left, right) => left.x - right.x);
    if (subHeadings.length < 2) continue;

    // Which column is the caller's. Exact device match or nothing: this is the
    // point where reading the wrong column would hand back the sibling device's
    // netlist, and on ADS8688 that is eight analog inputs replaced by eight NCs.
    const wanted = normalizeDevice(partNumber);
    const mine = subHeadings.filter((item) => normalizeDevice(clean(item.str)) === wanted);
    if (mine.length !== 1) continue;

    return {
      bottom: Math.min(...subHeadings.map((item) => item.y)),
      numberX: number.x,
      nameLo: number.x,
      nameHi,
      deviceX: mine[0].x + mine[0].width / 2,
      devices: subHeadings.length
    };
  }

  return null;
}

/**
 * A pin table whose rows carry one NAME PER DEVICE, read for the device asked
 * about.
 *
 * The shape `selectVariantColumn` does not cover: that one resolves several
 * NUMBER columns, one per package, and this is a single number column with
 * several NAME columns, one per device. ADS8684 and ADS8688 share a 38-pin
 * package and a datasheet, and differ on eight pins where the 4-channel part
 * reads `NC` and the 8-channel part reads an analog input.
 *
 * A row names the device explicitly or it does not name one at all: pin 27 prints
 * `NC` under ADS8684 and `AIN_5P` under ADS8688, while pin 28 prints one `AGND`
 * centred across both because the devices agree. So a row with several names is
 * resolved by which sub-heading it sits under, and a row with ONE name is shared
 * by every device the table covers. Anything else is refused.
 *
 * Read per page and proved on the UNION, which is what carries a table across a
 * page break without a continuation rule: ADS8688 puts pins 1 to 11 on one page
 * under `Pin Functions` and 12 to 38 on the next under `Pin Functions
 * (continued)`, and both pages repeat the header this keys off.
 */
function readDeviceColumnTable(doc: DatasheetText, partNumber?: string): GeometryPinTable | null {
  if (!partNumber) return null;

  const pins: GeometryPin[] = [];
  let firstPage: number | null = null;

  for (const page of doc.pages) {
    const items = page.items ?? [];
    if (items.length === 0) continue;

    const header = deviceColumnHeader(items, partNumber);
    if (!header) continue;

    // The number column, then its TIGHTEST x alignment.
    //
    // The page furniture is the reason for the second step. A footer page number
    // sits in the same margin as the column and well inside any sensible column
    // tolerance: ADS8688 draws its rows at x=57.0 and the page number at x=54.0,
    // which a 12-unit band happily swallows, and the extra `4` broke the 1..N
    // proof on a table that was otherwise read perfectly.
    //
    // Not separable by vertical gap, which was the first thing tried: the gap
    // above the footer is 24.6 and the gap between rows 3 and 4 is 28.2, because
    // that row's description wraps. Alignment does separate them, and it is the
    // better statement anyway. A column is items sharing an x; a page number is
    // not part of the column and does not share it.
    const candidateNumbers = items.filter(
      (item) =>
        item.y < header.bottom &&
        isInteger(clean(item.str)) &&
        Math.abs(item.x - header.numberX) <= COLUMN_TOLERANCE * 2
    );
    const numbers = cluster(candidateNumbers, (item) => item.x, ALIGNED_TOLERANCE).reduce<TextItem[]>(
      (best, band) => (band.length > best.length ? band : best),
      []
    );
    if (numbers.length === 0) continue;
    if (firstPage === null) firstPage = page.page;

    for (const cell of numbers) {
      const rowHeight = Math.max(cell.height, 1);
      const candidates = items
        .filter(
          (item) =>
            Math.abs(item.y - cell.y) <= rowHeight * 0.75 &&
            item.x > header.nameLo + COLUMN_TOLERANCE &&
            item.x + item.width <= header.nameHi &&
            clean(item.str).length > 0
        )
        .sort((left, right) => left.x - right.x);

      if (candidates.length === 0) return null;

      // A name may arrive in SEVERAL runs, so the row is grouped by adjacency
      // before a column is chosen. `RST/PD` is drawn as `RST/` ending at x=137.7
      // and `PD` beginning at x=137.7, because the overbar splits the run; the
      // two DEVICES' names on the same row sit 38 units apart. Touching runs are
      // one name and separated runs are different columns, and the gap between
      // those two cases is an order of magnitude.
      const groups: TextItem[][] = [];
      for (const item of candidates) {
        const current = groups[groups.length - 1];
        const previous = current?.[current.length - 1];
        if (previous && item.x - (previous.x + previous.width) <= rowHeight * 0.5) current.push(item);
        else groups.push([item]);
      }

      // One name is shared by every device; several are per device and the one
      // under this device's sub-heading is ours.
      const centre = (group: TextItem[]) =>
        (group[0].x + group[group.length - 1].x + group[group.length - 1].width) / 2;
      const chosen =
        groups.length === 1
          ? groups[0]
          : groups.reduce((best, group) =>
              Math.abs(centre(group) - header.deviceX) < Math.abs(centre(best) - header.deviceX)
                ? group
                : best
            );

      const name = chosen.map((item) => clean(item.str)).join("").replace(/\s+/g, "");
      if (name.length === 0 || name.length > MAX_CAPTIONED_NAME_LENGTH) return null;
      if (NUMBER_CELL.test(name)) return null;

      pins.push({
        number: clean(cell.str),
        name,
        type: "",
        description: "",
        start: cell.start
      });
    }
  }

  if (pins.length === 0 || firstPage === null) return null;

  pins.sort((left, right) => Number(left.number) - Number(right.number));
  if (!spellsOneToN(pins.map((pin) => Number(pin.number)))) return null;

  return {
    pins,
    page: firstPage,
    start: pins[0].start,
    // The table named this device in its own header, which is a proof about the
    // DEVICE and not merely about the table; see `GeometryPinTable.claimed`.
    device: partNumber,
    claimed: true,
    captioned: true,
    packageQualifier: null,
    captionLabel: null
  };
}

/** One page carrying a number-first header, and what was read off it. */
interface NumberFirstPage {
  page: PageText;
  header: NumberFirstHeader;
  cells: NumberCell[];
}

function readNumberFirstTable(
  doc: DatasheetText,
  declaredCount?: number | null
): GeometryPinTable | null {
  const pages: NumberFirstPage[] = [];

  for (const page of doc.pages) {
    const header = numberFirstHeader(page.items);
    if (!header) continue;
    const cells = numberFirstCells(page.items, header);
    if (cells.length > 0) pages.push({ page, header, cells });
  }

  if (pages.length === 0) return null;

  // Each page is tried ALONE before the pages are joined, because a document
  // that heads two DIFFERENT tables the same way is common and joining them is
  // wrong. A LIS3DH prints `Pin# | Name | Function` over its pin description on
  // one page and again over `Internal pin status` twenty pages later. Joined,
  // the two tables claim the same numbers, and the run recovered from `8CS` is
  // claimed twice, which refused a document that carries its pinout twice over.
  //
  // A page whose own numbering spells 1..N is a whole table and needs no other.
  // Several such pages must AGREE, pin for pin and name for name: they are the
  // same pinout printed twice, and if they are not then this cannot tell which
  // one the caller wants and does not choose.
  const singles = pages
    .map((entry) => readNumberFirstFrom([entry], declaredCount))
    .filter((table): table is GeometryPinTable => table !== null);

  if (singles.length > 0) {
    const first = singles[0];

    // The NUMBERING has to agree across them, because that is the statement
    // about which device and which package this is. Disagreeing numbers mean the
    // pages are not the same pinout and nothing here can say which is wanted.
    const sameNumbering = (other: GeometryPinTable) =>
      other.pins.length === first.pins.length &&
      other.pins.every((pin, index) => pin.number === first.pins[index].number);
    if (!singles.every(sameNumbering)) return null;

    // The NAMES are not required to agree, and requiring them refused a document
    // that reads correctly. A LIS3DH prints its pinout twice: once as `Pin
    // description` and once as `Internal pin status`, whose extra column runs the
    // name into the text beside it so the same pin comes back as `Vdd_IOPower`.
    // Both readings are of the same pins; one is simply cleaner. The FIRST is
    // taken, because a datasheet states its pinout before elaborating on it, and
    // the names are checked against the hand-read oracle rather than against the
    // document's own second telling.
    return first;
  }

  // No single page is a whole table, so this is one table continued across
  // pages, which is the shape ISL71001M has and the union proof is for.
  return readNumberFirstFrom(pages, declaredCount);
}

function readNumberFirstFrom(
  pages: NumberFirstPage[],
  declaredCount?: number | null
): GeometryPinTable | null {

  const seen = new Set(pages.flatMap((entry) => entry.cells.flatMap((cell) => cell.numbers)));
  const max = Math.max(...seen);

  // Numbers eaten by a glued run, recovered exactly as on a side-by-side table:
  // accepted only where the number is one the table does not already have, so the
  // numbering corroborates the split rather than the text being trusted.
  const glued: { number: number; name: string; item: TextItem; page: PageText }[] = [];
  const claimed = new Set<number>();

  for (const entry of pages) {
    const candidates = entry.page.items.filter(
      (item) =>
        item.y < entry.header.y &&
        item.x >= entry.header.numberX - COLUMN_TOLERANCE &&
        item.x < entry.header.nameX - COLUMN_TOLERANCE
    );
    for (const item of candidates) {
      const filling = gluedSplits(clean(item.str)).filter(
        (split) => split.number >= 1 && split.number <= max && !seen.has(split.number)
      );
      if (filling.length !== 1) continue;
      if (claimed.has(filling[0].number)) return null;
      claimed.add(filling[0].number);
      glued.push({ ...filling[0], item, page: entry.page });
    }
  }

  const all = [...seen, ...claimed];
  if (!spellsOneToN(all)) return null;
  if (declaredCount != null && declaredCount !== all.length) return null;

  const pins: GeometryPin[] = [];

  for (const entry of pages) {
    for (const cell of entry.cells) {
      // The name is the run in the name column nearest this cell's own line.
      const named = entry.page.items
        .filter(
          (item) =>
            item.y < entry.header.y &&
            item.x >= entry.header.nameX - COLUMN_TOLERANCE &&
            item.x < entry.header.descriptionX - COLUMN_TOLERANCE &&
            clean(item.str).length > 0
        )
        .sort((left, right) => Math.abs(left.y - cell.y) - Math.abs(right.y - cell.y));

      const name = named.length > 0 ? clean(named[0].str).replace(/\s+/g, "") : "";
      if (name.length === 0 || name.length > MAX_CAPTIONED_NAME_LENGTH) return null;

      for (const number of cell.numbers) {
        pins.push({ number: String(number), name, type: "", description: "", start: cell.start });
      }
    }
  }

  for (const split of glued) {
    pins.push({
      number: String(split.number),
      name: clean(split.name).replace(/\s+/g, ""),
      type: "",
      description: "",
      start: split.item.start
    });
  }

  pins.sort((left, right) => Number(left.number) - Number(right.number));
  if (!spellsOneToN(pins.map((pin) => Number(pin.number)))) return null;

  return {
    pins,
    page: pages[0].page.page,
    start: pins[0].start,
    device: null,
    claimed: false,
    captioned: true,
    packageQualifier: null,
    captionLabel: null
  };
}

/** A page carrying a caption with a particular label, and that caption. */
interface LabelledPage {
  page: PageText;
  caption: PinTableCaption;
}

/** The pages whose pin-function caption carries this label, in document order. */
function pagesCaptioned(doc: DatasheetText, label: string): LabelledPage[] {
  const found: LabelledPage[] = [];
  for (const page of doc.pages) {
    const caption = pinFunctionCaptions(page.items).find((entry) => entry.label === label);
    if (caption) found.push({ page, caption });
  }
  return found;
}

/**
 * Splits a text run the PDF drew in one operation but the table typeset as
 * several CELLS.
 *
 * An STM32F103C8 hands over `J7    L10    21` as a single run at x=72: two BGA
 * ball designators and the LQFP48 pin number, spanning three columns. Seventeen
 * of that column's forty-eight numbers are locked inside runs like it, so the
 * column reads 31 values and the table is unreadable however the columns are
 * found.
 *
 * TWO spaces are required between parts, which is what separates a column gap
 * from a word space: a description reading `Main function` stays one run, while
 * `J7    L10` does not. Each part is positioned by its share of the run, which is
 * an estimate and only has to be good enough to land within a column tolerance of
 * the truth — measured on that table, the recovered numbers land at x=118 against
 * a column at x=115-119.
 */
export function splitSpacedRun(item: TextItem): TextItem[] {
  if (!/\S\s{2,}\S/.test(item.str)) return [item];

  const parts: TextItem[] = [];
  const pattern = /\S+(?:\s\S+)*?(?=\s{2,}|$)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(item.str)) !== null) {
    if (clean(match[0]).length === 0) continue;
    parts.push({
      ...item,
      str: match[0],
      x: item.x + (match.index / item.str.length) * item.width,
      width: (match[0].length / item.str.length) * item.width
    });
  }

  return parts.length > 1 ? parts : [item];
}

/** One page's contribution to a column that spans several pages. */
interface ColumnPart {
  entry: LabelledPage;
  /** The page's items with merged runs split; see `splitSpacedRun`. */
  items: TextItem[];
  column: TextItem[];
  columns: TextItem[][];
}

/** A number column followed across every page of a continued table. */
interface JoinedColumn {
  x: number;
  parts: ColumnPart[];
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Follows every candidate number column across the pages of a continued table
 * and keeps the ones whose UNION spells 1..N.
 *
 * Shared by both continued readers so that the bare-integer shape and the
 * grouped-cell shape pay the SAME proof at the same scale. `find` says what
 * counts as a column on one page and `values` says how many pins one of its
 * cells names, which is the only thing that differs between them.
 */
function joinColumnsAcrossPages(
  pages: LabelledPage[],
  find: (items: TextItem[]) => TextItem[][],
  values: (item: TextItem) => number[]
): JoinedColumn[] {
  const groups: JoinedColumn[] = [];

  for (const entry of pages) {
    // Split once per page and used for both finding the columns and reading the
    // rows, so the number items the proof ran on are the same objects the row
    // reader matches by identity.
    const items = entry.page.items.flatMap(splitSpacedRun);

    // Bounded to below the caption, which is the vendor's own statement of where
    // the table starts. Without it a running header or a page number can join a
    // band, and the union then has to disprove something that was never a column.
    const below = items.filter((item) => item.y < entry.caption.y);
    const columns = find(below);

    for (const column of columns) {
      const x = medianOf(column.map((item) => item.x));
      const group = groups.find((candidate) => Math.abs(candidate.x - x) <= COLUMN_TOLERANCE);
      if (group) group.parts.push({ entry, items, column, columns });
      else groups.push({ x, parts: [{ entry, items, column, columns }] });
    }
  }

  return groups.filter((group) => {
    // Two bands from ONE page landing in the same group means the group is not a
    // column, it is two columns the tolerance could not separate.
    const pageNumbers = new Set(group.parts.map((part) => part.entry.page.page));
    if (pageNumbers.size !== group.parts.length) return false;
    return spellsOneToN(group.parts.flatMap((part) => part.column.flatMap(values)));
  });
}

/** The pins one column of a continued table names, in the order they were read. */
function columnPins(group: JoinedColumn, values: (item: TextItem) => number[]): number {
  return group.parts.reduce(
    (total, part) => total + part.column.reduce((count, item) => count + values(item).length, 0),
    0
  );
}

/**
 * Picks the one column of a continued table that the document's declared count
 * agrees with.
 *
 * The declared count is used only to SELECT among columns that have each already
 * proved themselves, never to vouch for one. A wrong declared count therefore
 * matches no column and refuses, rather than promoting a bad read.
 *
 * Where the document declares no count, one qualifying column is unambiguous and
 * several is a choice nothing here can make.
 */
function selectJoinedColumn(
  qualifying: JoinedColumn[],
  declaredCount: number | null | undefined,
  values: (item: TextItem) => number[]
): JoinedColumn | null {
  if (qualifying.length === 0) return null;

  let chosen = qualifying;
  if (declaredCount != null) {
    chosen = qualifying.filter((group) => columnPins(group, values) === declaredCount);
  } else if (qualifying.length > 1) {
    return null;
  }

  return chosen.length === 1 ? chosen[0] : null;
}

/** The pin numbers a bare-integer cell names, which is always exactly one. */
function oneNumber(item: TextItem): number[] {
  return [Number(clean(item.str))];
}

/**
 * Reads a table the vendor marked as continued across pages, by joining its
 * fragments and proving 1..N on the UNION.
 *
 * Both halves of such a table used to be DROPPED, and that was right at the time:
 * a page holding half a table still holds a gap-free run, so the proof that makes
 * this reader safe passes on a FRAGMENT. An MSP430F5529 prints `Table 7-1.
 * Terminal Functions` over pins 1 to 11 and `(continued)` over the rest, and the
 * first page on its own reads as a perfectly consistent 11-pin part. It has 80.
 *
 * Joining pays the same proof at the right scale instead of refusing the table.
 * Measured on that part, over pages 16 to 20:
 *
 *     x=169 (PN)   80 values, 80 distinct, exactly 1..80
 *     x=196 (RGC)  64 values, 64 distinct, exactly 1..64
 *
 * Two columns, each internally perfect, describing an 80-pin LQFP and a 64-pin
 * QFN. So the union proof alone cannot choose between them, and what does is the
 * count the document DECLARES. That is deliberately not a package-code map: `PN`
 * and `RGC` mean nothing outside TI's catalogue, and a table of vendor codes is
 * exactly the kind of remembered knowledge this file avoids in favour of
 * something the document itself states.
 *
 * The declared count is used only to SELECT among columns that have each already
 * proved themselves, never to vouch for one. A wrong declared count therefore
 * matches no column and refuses, rather than promoting a bad read.
 */
function readContinuedTable(
  doc: DatasheetText,
  label: string,
  partNumber?: string,
  packageType?: string,
  declaredCount?: number | null
): GeometryPinTable | null {
  const pages = pagesCaptioned(doc, label);
  // A label the vendor marked continued and which appears on one page only is a
  // label this reader has misunderstood, not a table to join.
  if (pages.length < 2) return null;

  // Where the document declares a count, the chosen column must match it, and
  // that holds even when only ONE column qualified. A single qualifying column is
  // not evidence that it is the right one.
  //
  // Measured on STM32F103C8, whose pin table numbers four packages across five
  // pages: its columns yield clean, contiguous runs at N=60 and N=63 for a part
  // with 48 pins, because the text layer merges some cells and drops values out
  // of the columns they belong to. Either would have been reported as a pinout.
  // Disagreement means the column is not the one asked for, so it is refused here
  // rather than reported and then contradicted by the count downstream.
  const chosen = selectJoinedColumn(
    joinColumnsAcrossPages(pages, findIntegerColumns, oneNumber),
    declaredCount,
    oneNumber
  );

  // The GROUPED shape runs only where this one found nothing, which is what makes
  // it additive: a table this reader can already read is never handed to it. See
  // `readContinuedGroupedTable`.
  if (!chosen) return readContinuedGroupedTable(pages, label, declaredCount);

  // Every page of the table has to read, because a page that does not is half a
  // pinout, which is the thing this file refuses everywhere else.
  const pins: GeometryPin[] = [];
  for (const part of chosen.parts) {
    const table = readOneTable(
      part.items,
      part.entry.page.page,
      part.entry.caption,
      partNumber,
      packageType,
      { column: part.column, columns: part.columns }
    );
    if (!table) return null;
    pins.push(...table.pins);
  }

  pins.sort((left, right) => Number(left.number) - Number(right.number));

  // The union was proved on the column; this proves it again on what was actually
  // READ, which is not the same statement. The row reader can refuse a row, and a
  // table missing a row is not the table that was proved.
  if (!spellsOneToN(pins.map((pin) => Number(pin.number)))) return null;

  const first = chosen.parts[0];
  const heading = headingOver(
    first.items.filter((item) => item.y < first.entry.caption.y),
    first.column,
    first.column.reduce((highest, item) => (item.y > highest.y ? item : highest)).y
  );

  return {
    pins,
    page: first.entry.page.page,
    start: pins[0].start,
    device: PIN_TABLE_CAPTION.exec(first.entry.caption.text)?.[1] ?? null,
    claimed: false,
    captioned: true,
    // Where the column is headed with a real family this is the package it
    // numbers, exactly as on a grouped table. A vendor's own package CODE (`PN`,
    // `RGC`) names no family and leaves this null, which is the common case and
    // why no code map is needed.
    packageQualifier: packageFamilies(heading).length > 0 ? clean(heading) : null,
    captionLabel: label
  };
}

/**
 * How far from its pin number a run may sit and still be part of that pin's NAME.
 *
 * Half the tightest row spacing in the table, and the half is the whole argument:
 * a run further from its number than the midpoint between two rows is nearer to
 * the boundary than to its own row, so it is on a line of its own. The TIGHTEST
 * spacing rather than the median because the tightest gap is the vendor's own
 * statement of what it considers one row.
 *
 * Measured on the two shapes this has to separate, which look identical to every
 * other test: both put a run at the name column's x, on a line of its own, with
 * no pin number and nothing in any column to the right.
 *
 *   DRV8825 p3    rows 13.2 apart, names at offset 0.0, the section band rows
 *                 `POWER AND GROUND` / `CONTROL` / `STATUS` at 13.2
 *   MSP430F5529   rows 13.9 apart at their tightest, and pin 47's name wraps as
 *   p19           `P4.2/PM_UCB1SOMI/` over `PM_UCB1SCL` at offset 4.8 either side
 *
 * A section band is a full row away and a wrapped name is a third of one, so the
 * midpoint separates them with room on both sides. It is not a coincidence of
 * these two documents: a table row is at least as tall as the leading inside its
 * own cells, or the rows would collide.
 */
const NAME_REACH = 0.5;

/**
 * The tightest spacing between two rows of a column, or null when the column
 * does not have two rows to measure.
 *
 * Zero gaps are skipped rather than counted. A table that stacks two pin numbers
 * on ONE baseline is a real shape, and it would otherwise report a row spacing of
 * nothing and make every name ambiguous.
 */
function tightestRowGap(column: TextItem[]): number | null {
  const descending = [...column].sort((left, right) => right.y - left.y);
  let tightest = Infinity;
  for (let index = 1; index < descending.length; index += 1) {
    const gap = descending[index - 1].y - descending[index].y;
    if (gap > 0) tightest = Math.min(tightest, gap);
  }
  return Number.isFinite(tightest) ? tightest : null;
}

/**
 * One page of a name-first table whose cells may each name several pins.
 *
 * The name sits LEFT of the number column on the number's own line, which is the
 * layout `readGroupedTable` already reads on a single page. What is different
 * here is that the page is a fragment, so nothing on it proves anything; the
 * proof was paid on the union by `joinColumnsAcrossPages` before this is called.
 *
 * Returns null rather than a partial answer. Half a page of a continued table is
 * half a pinout.
 */
function readGroupedFragment(items: TextItem[], column: TextItem[]): GeometryPin[] | null {
  const gap = tightestRowGap(column);
  if (gap === null) return null;
  const reach = gap * NAME_REACH;

  // The column's left edge, taken over the whole column because a centred column
  // starts its widest cell furthest left. Everything that ends before it is a
  // candidate for the name; everything else is the number, the type or the
  // description.
  const left = Math.min(...column.map((item) => item.x));

  const top = Math.max(...column.map((item) => item.y));
  const bottom = Math.min(...column.map((item) => item.y));

  const candidates = items.filter(
    (item) =>
      !column.includes(item) &&
      clean(item.str).length > 0 &&
      item.x + item.width <= left + COLUMN_TOLERANCE &&
      item.y <= top + reach &&
      item.y >= bottom - reach
  );

  const named = column.map((cell) => {
    const parts: TextItem[] = [];
    for (const item of candidates) {
      const distance = Math.abs(item.y - cell.y);
      if (distance < reach) parts.push(item);
    }
    return { cell, parts };
  });

  // A run inside the table's own rows that is too far from a number to be part of
  // its name and too near to be another row is not a value this can read. It is
  // the one case the midpoint above cannot decide, and a wrong pin name is a
  // wrong netlist, so the table is refused rather than guessed at.
  //
  // A run within a LINE tolerance of a full row away is a full row away. These
  // are measured baselines: DRV8825's heading rows sit 13.199999999999932 from
  // rows the same page spaces 13.200000000000045 apart, and without that the
  // arithmetic alone makes every one of them ambiguous.
  for (const item of candidates) {
    const nearest = Math.min(...column.map((cell) => Math.abs(item.y - cell.y)));
    if (nearest >= reach && nearest < gap - LINE_TOLERANCE) return null;
  }

  const pins: GeometryPin[] = [];

  for (const entry of named) {
    // Reading order, which for a name wrapped onto a second line is DOWN the page
    // and then across, exactly as the centred name column is read elsewhere here.
    const name = entry.parts
      .filter((item) => !FOOTNOTE_MARKER.test(clean(item.str)))
      .sort((first, second) => second.y - first.y || first.x - second.x)
      .map((item) => clean(item.str).replace(/\s+/g, ""))
      .join("");

    if (name.length === 0 || name.length > MAX_CAPTIONED_NAME_LENGTH) return null;

    // A NUMBER left of the column means this is not the leftmost pin-number
    // column, so ANOTHER package's numbering is being read as part of the name.
    // The same rejection `readGroupedTable` makes, for the same reason: a pin
    // name is never a bare number, so one is enough to refuse the column.
    if (entry.parts.some((item) => NUMBER_CELL.test(clean(item.str)))) return null;

    // A run drawn in an order its string does not describe cannot be assembled
    // into a name; see `hasPrintedOrder`.
    if (entry.parts.some((item) => !hasPrintedOrder(item))) return null;

    for (const number of expandNumberCell(entry.cell.str)) {
      pins.push({ number: String(number), name, type: "", description: "", start: entry.cell.start });
    }
  }

  return pins;
}

/**
 * A continued table whose number column holds CELLS rather than bare integers.
 *
 * This is TI's current house style and it is not one datasheet. The table is
 * titled `Pin Functions` with no `Table N.` prefix, continued as `Pin Functions
 * (continued)`, laid out `NAME | NO. | I/O | DESCRIPTION`, and it writes one
 * signal that appears at several positions as one cell: `GND | 14, 28`.
 *
 * Three things had to be true at once, which is why none of the existing readers
 * reached it. `findNumberColumns` accepts only a run whose whole string is one
 * integer, so a multi-pin cell is invisible to it. `readGroupedTable` handles
 * those cells but demands 1..N on ONE page, and this table's numbering is split
 * across two. And the ordinary row reader assembles the name from everything
 * left of the number in the row's band, which on this table glues the section
 * heading rows on: `CONTROL` above `AVREF` came back as `CONTROLAVREF`.
 *
 * So the column is followed across the pages by the same joiner the bare-integer
 * reader uses, and the rows are read by `readGroupedFragment`, whose name rule is
 * built for exactly the ambiguity this table creates. Measured on DRV8825: 28
 * pins, every name checked against the page.
 *
 * No type or description is reported. This reader knows where the name ends and
 * nothing about where the columns to the right begin, and the earlier attempt to
 * infer them is what produced `I/OBridge` for pin 6.
 */
function readContinuedGroupedTable(
  pages: LabelledPage[],
  label: string,
  declaredCount?: number | null
): GeometryPinTable | null {
  const chosen = selectJoinedColumn(
    joinColumnsAcrossPages(pages, findIntegerCellColumns, (item) => expandNumberCell(item.str)),
    declaredCount,
    (item) => expandNumberCell(item.str)
  );
  if (!chosen) return null;

  const pins: GeometryPin[] = [];
  for (const part of chosen.parts) {
    const read = readGroupedFragment(
      part.items.filter((item) => item.y < part.entry.caption.y),
      part.column
    );
    if (!read) return null;
    pins.push(...read);
  }

  pins.sort((left, right) => Number(left.number) - Number(right.number));

  // The union was proved on the column; this proves it again on what was actually
  // READ, which is not the same statement.
  if (!spellsOneToN(pins.map((pin) => Number(pin.number)))) return null;

  const first = chosen.parts[0];

  return {
    pins,
    page: first.entry.page.page,
    start: pins[0].start,
    device: PIN_TABLE_CAPTION.exec(first.entry.caption.text)?.[1] ?? null,
    claimed: false,
    captioned: true,
    packageQualifier: null,
    captionLabel: label
  };
}

/**
 * Reads the pin table from whichever page carries it.
 *
 * Pages are tried in order and the first that yields a complete table wins.
 * There is no heading requirement: a heading is a hint, and the 1..N test is a
 * proof, so the proof is used on its own. That also means a table whose heading
 * this project has never seen is still read.
 */
export function extractPinTableByGeometry(
  doc: DatasheetText,
  partNumber?: string,
  packageType?: string,
  declaredCount?: number | null
): GeometryPinTable | null {
  const split = continuedTableLabels(doc);
  const found: GeometryPinTable[] = [];
  for (const page of doc.pages) {
    for (const table of readPinTablesFromPage(page, partNumber, packageType)) {
      if (table.captionLabel && split.has(table.captionLabel)) continue;
      found.push(table);
    }
  }

  // A table the vendor marked as continued is not a fragment to be thrown away,
  // it is a table to be JOINED. Its pages are still excluded above, because each
  // one alone is half a pinout; see `readContinuedTable` for the proof that
  // replaces the per-page one.
  for (const label of split) {
    const joined = readContinuedTable(doc, label, partNumber, packageType, declaredCount);
    if (joined) found.push(joined);
  }

  // A table declared by a repeated HEADER ROW rather than a caption, which the
  // page readers above cannot see at all.
  if (found.length === 0) {
    const numberFirst = readNumberFirstTable(doc, declaredCount);
    if (numberFirst) found.push(numberFirst);
  }

  // And a table carrying one NAME COLUMN PER DEVICE under a stacked header,
  // which none of the readers above can see either. Last, and only when nothing
  // else produced a table, so it can add parts and cannot take any away.
  if (found.length === 0) {
    const perDevice = readDeviceColumnTable(doc, partNumber);
    if (perDevice) found.push(perDevice);
  }

  if (found.length === 0) return null;

  const narrowed = selectPackageQualifiedTables(found, packageType);
  if (narrowed === null) return null;

  const tables = selectCaptionedTables(narrowed, partNumber);
  if (tables === null) return null;
  if (tables.length === 1) return tables[0];

  // Tables of different lengths mean the document covers more than one device,
  // and nothing here can tell which one the reader asked about. An OPA2277
  // datasheet carries the dual's eight-pin table on page 3 and the quad's
  // fourteen-pin table on page 5; picking the longer one, which is what this did
  // first, silently returns the wrong part's pinout. Refusing is the only honest
  // answer available to a reader that does not know which variant is wanted.
  const lengths = new Set(tables.map((table) => table.pins.length));
  if (lengths.size > 1) return null;

  // `?? null` rather than an index: narrowing can legitimately empty the list,
  // and returning `undefined` from a function declared to return `T | null`
  // typechecks while defeating every `=== null` check downstream.
  return tables[0] ?? null;
}

/**
 * Narrows tables captioned per PACKAGE to the one for the package we are in.
 *
 * ADR4525 prints an `8-Lead SOIC` table and an `8-Lead LCC` table, both eight
 * pins, both numbering 1..8, and they disagree about what sits at pin 3: `NIC`
 * on the SOIC and `GND FORCE` on the LCC. Length cannot choose between them and
 * neither can order. The caption can, because the vendor wrote the package into
 * it.
 *
 * Refuses outright when nothing matches or when several do. A datasheet that
 * bothered to caption its tables per package is a datasheet where picking the
 * wrong one returns another package's pinout, and that is the failure this file
 * exists to prevent, not a tie to break by preference.
 */
function selectPackageQualifiedTables(
  tables: GeometryPinTable[],
  packageType: string | undefined
): GeometryPinTable[] | null {
  const qualified = tables.filter((table) => table.packageQualifier !== null);
  if (qualified.length < 2) return tables;

  const wanted = packageType ? packageFamilies(packageType) : [];
  if (wanted.length === 0) return null;

  const matching = qualified.filter((table) => {
    const families = packageFamilies(table.packageQualifier!);
    return families.some((family) => wanted.includes(family));
  });
  if (matching.length !== 1) return null;

  // The unqualified tables on the same document are left alone: they are not in
  // competition with this one, and the existing device rules still judge them.
  return [...matching, ...tables.filter((table) => table.packageQualifier === null)];
}

/** Uppercase alphanumerics, so `LMP7704-SP` and `LMP7704SP` compare equal. */
function normalizeDevice(text: string): string {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Narrows the document's tables to the ones that belong to the part asked about.
 *
 * This is what resolves a multi-device datasheet, and it resolves it by the only
 * evidence that actually distinguishes the tables: the device each caption
 * names. Pin count cannot do it. An OPA2277 datasheet carries an EIGHT-pin table
 * for the single OPA277 and another eight-pin table for the dual OPA2277, whose
 * pin 1 is `Offset Trim` in one and `Out A` in the other, so a reader choosing by
 * length has a coin-flip between two pinouts that fit the same footprint.
 *
 * Returns null to refuse outright, otherwise the surviving tables for the
 * existing rules to judge.
 */
function selectCaptionedTables(
  tables: GeometryPinTable[],
  partNumber: string | undefined
): GeometryPinTable[] | null {
  const wanted = partNumber ? normalizeDevice(partNumber) : "";
  const labelled = tables.filter((table) => table.device !== null);
  if (!wanted || labelled.length === 0) return tables;

  let claimed = labelled.filter((table) => normalizeDevice(table.device!) === wanted);

  // An ordering part number carries a package and temperature suffix the caption
  // does not (`TLV9061IDBVR` against `TLV9061`), so a caption that PREFIXES the
  // request is the same device. Uniqueness is required, because the same
  // datasheet also captions a `TLV9061S`, and prefix matching without it would
  // hand back the shutdown variant's pinout.
  if (claimed.length === 0) {
    const prefixing = labelled.filter((table) => wanted.startsWith(normalizeDevice(table.device!)));
    const devices = new Set(prefixing.map((table) => normalizeDevice(table.device!)));
    if (devices.size === 1) claimed = prefixing;
  }

  if (claimed.length > 0) {
    // Two tables claiming the same device but disagreeing on length is the
    // document contradicting itself, which is not something to resolve by
    // preference.
    const lengths = new Set(claimed.map((table) => table.pins.length));
    return lengths.size === 1 ? [{ ...claimed[0], claimed: true }] : null;
  }

  // No table claims this part. Any table that names a DIFFERENT device is
  // provably not the answer, so it is dropped rather than left to stand in for
  // one: an OPA333 document captions only `OPA333` and `OPA2333` tables, and
  // with the first unreadable the second would otherwise be returned unopposed
  // as a lone table of consistent length.
  const unlabelled = tables.filter((table) => table.device === null);
  return unlabelled.length > 0 ? unlabelled : null;
}
