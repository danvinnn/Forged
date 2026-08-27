/**
 * A SECOND, INDEPENDENT READING OF THE PINOUT, taken from the text layer's
 * geometry.
 *
 * ## Why this exists
 *
 * The product's rule is that no value ships silently unless two independent
 * sources agree on it. For every dimension there is a second source already in
 * hand - IPC-7351B arithmetic, the printed footprint, the neighbouring numbers
 * on the same drawing. For the PINOUT there was none. One model read produced
 * the names, nothing checked them, and they were emitted as a netlist.
 *
 * Every wrong netlist this project has shipped was of that shape: LT1013's
 * names, OPA2277's swapped 7 and 8, STM32F407VG's twenty-two pins shifted by
 * one. In each case the datasheet stated the right answer in the text layer and
 * nothing looked.
 *
 * ## Independent means read by different MEANS
 *
 * A second model call is not a second source: a model that misreads a figure
 * misreads it the same way twice. This reads no semantics at all. It finds runs
 * of pin numbers drawn along a line, and asks whether the claimed name is drawn
 * at a CONSTANT OFFSET from every one of them. That fails differently from a
 * model by construction, which is the only property that makes agreement mean
 * anything.
 *
 * ## One rule covers every layout a datasheet uses
 *
 * A pinout is drawn as sequences of numbers along a line, and it is drawn that
 * way whether it is a table or a figure:
 *
 *     a table column      numbers down one x, the name column beside them
 *     a dual figure       numbers down each side, names outboard of them
 *     a quad figure       numbers along the bottom edge, names stacked above
 *
 * All three are "numbers collinear, name at a fixed vector from its number", so
 * all three are read by the same code. The offset is a VECTOR rather than a
 * horizontal distance for exactly this reason: STM32F407VG draws `VCAP_1` two
 * hundred points above the `49` it belongs to, and a reader that only looked
 * along the line could not see the one pin in that document that is wrong.
 *
 * ## It VERIFIES rather than competing
 *
 * It does not try to decide where a pin name begins and ends, which is the part
 * of reading a pinout that is genuinely hard: `V` and `CCA` are two runs on two
 * baselines, `IN1` and its minus sign are two more. It takes the claim and asks
 * whether the page draws that text there. A verification needs no name
 * boundaries, so it has none of the failure modes finding them would add.
 *
 * ## What it can and cannot catch
 *
 * CATCHES: a name that is not on the page at all; a numbering shifted by one or
 * more; a reading assembled from two different tables; a reading taken from a
 * SIBLING DEVICE's figure, which is what the pin-count bound is for.
 *
 * DOES NOT CATCH: a coherent read of the WRONG package's column in a table that
 * prints several of the same length. Both columns are on the page and both are
 * real pinouts, so geometry cannot choose between them - only the package header
 * can, which is what `packagesInThisDocument` is for. This is stated rather than
 * papered over: a check that claims more than it does is worse than no check.
 */

import type { DatasheetText, PageText, TextItem } from "./pdftext";
import type { PinRecord } from "./types";

/** Normalised for comparison: case, spacing and dash style are typography. */
export function normalizePinName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, "");
}

/**
 * The alternative names one pin is printed under, as a set.
 *
 * A pin has one net and a datasheet may print several names for it. ST is the
 * standing example and it prints them three ways in one document: Table 5 calls
 * pin 12 `PH0`, Figure 8 calls it `PH0-OSC_IN`, and the model returns
 * `PH0/OSC_IN (PH0)` having read both. Those are the same copper.
 *
 * So a name is split into its alternatives and two names AGREE when they share
 * one. That is not a softening of the comparison: `VSS` and `VCAP_1` share
 * nothing and are still a contradiction, which is the real defect this shape of
 * false conflict was hiding.
 *
 * A hyphen separates alternatives only between two substantial tokens. `V-` and
 * `IN1-` end in a SIGN, and splitting those would leave a bare `V` free to agree
 * with `V+`, which is the one comparison that must never pass.
 */
export function pinNameAlternatives(name: string): Set<string> {
  const parts = normalizePinName(name)
    .split(/[/,()[\]]+/)
    .flatMap((piece) => piece.split(/(?<=[A-Z0-9_]{2})-(?=[A-Z0-9_]*[A-Z][A-Z0-9_]{1,})/))
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
  return new Set(parts.length > 0 ? parts : [normalizePinName(name)]);
}

/** Two printed names that name the same pin share at least one alternative. */
export function namesAgree(left: string, right: string): boolean {
  if (normalizePinName(left) === normalizePinName(right)) return true;
  const mine = pinNameAlternatives(left);
  for (const alternative of pinNameAlternatives(right)) {
    if (mine.has(alternative)) return true;
  }
  return false;
}

/**
 * Whether two names differ enough to accuse the record of being wrong.
 *
 * Deliberately weaker than `namesAgree`, and used only to WITHHOLD an
 * accusation. Confirmation still requires the exact name to be drawn in the
 * exact place; this decides whether a name drawn there that does not match is
 * evidence of a defect or evidence of typography.
 *
 * CONTAINMENT is the shape that keeps appearing. `CCA` is what survives when the
 * `V` of `VCCA` is drawn in a different font; `CAP_1` is `VCAP_1` with its first
 * glyph in another run; `Driver` is the head of `Driver Collector` where the
 * page wraps the cell. Every one of those is the same pin, and every one of them
 * would otherwise be shown to a user as a contradiction on a reading that is
 * right. `VSS` against `VCAP_1` still contradicts, which is the case that
 * matters.
 */
function contradicts(printed: string, claimed: string): boolean {
  if (namesAgree(printed, claimed)) return false;
  const left = normalizePinName(printed);
  const right = normalizePinName(claimed);
  if (left.length === 0 || right.length === 0) return false;
  return !left.includes(right) && !right.includes(left);
}

/**
 * The one shape of disagreement worth putting in words: this pin is drawn under
 * ANOTHER pin's name.
 *
 * A pin the page draws nothing legible for is unconfirmed either way, and the
 * record is flagged for it regardless - the invariant asks for agreement, and
 * absent evidence is not agreement. So the only thing a dissent adds is a
 * sentence the user can act on, and it earns that only when the page names the
 * conflict: a swap, or a numbering off by one.
 *
 * The alternative was to report every unmatched position, which on a rotated
 * figure means reporting glue artifacts like `VSSPA4PA5PA6PA7VDD` as the name
 * the vendor printed. That is a false accusation dressed as a citation, and the
 * user cannot tell it from a real one.
 */
function namesAnotherPin(printed: string, number: number, claimed: ReadonlyMap<number, string>): boolean {
  for (const [other, name] of claimed) {
    if (other !== number && namesAgree(printed, name)) return true;
  }
  return false;
}

/** Numbers whose centres sit within this of each other are collinear. */
const COLLINEAR_TOLERANCE_PT = 4;

/**
 * How far a name may sit from where its neighbours put theirs.
 *
 * Looser across the page than along it: a name column is set flush at one edge
 * and its runs begin wherever their glyphs do, so `OUT1` and `IN1+` start a few
 * points apart where two numbers never would. Tight across the other axis,
 * because a row is a row.
 */
const OFFSET_TOLERANCE_X_PT = 12;
const OFFSET_TOLERANCE_Y_PT = 3;

/**
 * A sequence needs this many numbers to be worth evaluating at all.
 *
 * Two, because a five-pin SOT-23 figure draws three numbers down one side and
 * TWO down the other, and a floor of four found nothing on any of them. Every
 * ST five-pin part in the corpus came back silent for that reason alone.
 *
 * The strength is not recovered by making one sequence prove itself; it is
 * recovered at the PAGE, where all of a page's sequences are judged together
 * against `MIN_PAGE_AGREEMENTS`. That is the right unit anyway: a figure's two
 * sides are one drawing.
 */
const MIN_SEQUENCE_ENTRIES = 2;

/**
 * How many pins a page must agree on before it counts as having read the pinout.
 *
 * Bounded by the part, so a three-pin regulator is not asked for four.
 */
const MIN_PAGE_AGREEMENTS = 4;

/**
 * Runs closer than this fraction of their own height are one name.
 *
 * A space is drawn at roughly a third of the font size, and `renderPage` uses
 * the same ratio to decide where to insert one. Kept below that so this glues
 * only runs the renderer would not have separated.
 */
const GLUE_RATIO = 0.3;

/**
 * How far the search for a claimed name may reach across a word space.
 *
 * A PIN NAME MAY CONTAIN A SPACE, and until this existed none of them could ever
 * be found. TI writes `OUTPUT 2` and `VOS TRIM` on its connection diagrams and
 * Analog writes `Driver Collector`; `normalizePinName` strips the space, so the
 * claim is `OUTPUT2`, and a search that stopped at every space could never reach
 * the `2`. Every part whose pins are named that way came back with no evidence
 * at all.
 *
 * One word space and no more - a hair over a full em, which is wide enough for a
 * justified line and far short of a table's column gutter. Only the SEARCH is
 * widened: `printedAt`, which reads a cell back without being told what to look
 * for, still stops at the first space, because there it would have no way to
 * know where the name ended.
 */
const WORD_SPACE_RATIO = 1.2;

/** Names spanning more runs than this are not names. Bounds the index below. */
const MAX_RUNS_PER_NAME = 6;

/**
 * How much of a sequence's own pins must line up before its disagreements are
 * believed.
 *
 * Below this the sequence is a different table that happens to share some names,
 * and its "disagreements" would be noise. Above it the sequence is demonstrably
 * the same pinout, so a pin that does not match is a real contradiction.
 *
 * Three quarters rather than a bare majority: a sequence supporting half the
 * claim is as consistent with the claim being half invented as with the sequence
 * being the wrong one, and neither reading earns the right to accuse.
 */
const SAME_PINOUT_THRESHOLD = 0.75;

/** A run that is a bare number and nothing else. */
function asNumber(item: TextItem): number | null {
  const trimmed = item.str.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 1 ? value : null;
}

function centreOf(item: TextItem): number {
  return item.x + item.width / 2;
}

/** The runs of one page in reading order, which is what `renderPage` recorded. */
function runsOf(page: PageText): TextItem[] {
  return [...page.items].sort((left, right) => left.start - right.start);
}

/**
 * Every place a name could be drawn on a page, indexed by the name.
 *
 * Built once per page over whole runs. A name is a cell and a cell is drawn as
 * whole runs, so a match must start and end on a run boundary: without that,
 * `IN` would be found inside `MAIN` and `PC7` inside `PC7PC6`.
 */
function nameIndex(runs: readonly TextItem[]): Map<string, TextItem[]> {
  const index = new Map<string, TextItem[]>();
  for (let start = 0; start < runs.length; start += 1) {
    let text = "";
    for (let end = start; end < runs.length && end < start + MAX_RUNS_PER_NAME; end += 1) {
      // A name is drawn as one uninterrupted piece. Crossing a real gap means
      // crossing into the next cell, so the chain stops there.
      if (end > start) {
        const previous = runs[end - 1];
        const gap = runs[end].x - (previous.x + previous.width);
        if (Math.abs(runs[end].y - previous.y) > COLLINEAR_TOLERANCE_PT) break;
        if (gap > previous.height * WORD_SPACE_RATIO) break;
      }
      text += normalizePinName(runs[end].str);
      if (text.length === 0) continue;
      const found = index.get(text);
      if (found) found.push(runs[start]);
      else index.set(text, [runs[start]]);
    }
  }
  return index;
}

/**
 * The name the page draws at a position, read forward from the run that starts
 * there.
 *
 * Used ONLY to decide whether a disagreement is real. Confirmation is the exact
 * match through `nameIndex`, so a name this reads wrongly can withhold an
 * accusation but can never manufacture agreement.
 */
function printedAt(
  runs: readonly TextItem[],
  x: number,
  y: number,
  window: { dx: number; dy: number }
): string {
  let index = -1;
  let closest = Infinity;
  for (let step = 0; step < runs.length; step += 1) {
    const dx = Math.abs(runs[step].x - x);
    const dy = Math.abs(runs[step].y - y);
    if (dx > window.dx || dy > window.dy) continue;
    const distance = dx + dy;
    if (distance < closest) {
      closest = distance;
      index = step;
    }
  }
  if (index < 0) return "";
  let text = runs[index].str;
  for (let step = index + 1; step < runs.length && step < index + MAX_RUNS_PER_NAME; step += 1) {
    if (asNumber(runs[step]) !== null) break;
    const previous = runs[step - 1];
    if (Math.abs(runs[step].y - previous.y) > COLLINEAR_TOLERANCE_PT) break;
    if (runs[step].x - (previous.x + previous.width) > previous.height * GLUE_RATIO) break;
    text += runs[step].str;
  }
  // ONE CELL, OR NOTHING.
  //
  // A rotated figure label reports a width its glyphs do not occupy, so the gap
  // to the next label computes as zero and the glue runs straight through it.
  // That produced `VSSPA4PA5PA6PA7VDD` as the "name" drawn at one pin and an
  // accusation against a reading that was right. A cell that swallowed its
  // neighbours shows it: the space between them survives in the runs.
  //
  // Refusing to read those is the correct outcome. It costs a confirmation this
  // never had - the exact match through `nameIndex` is what confirms - and it
  // buys back every false accusation of that shape.
  const cell = text.trim();
  return /\s/.test(cell) ? "" : cell;
}

export interface PinDissent {
  number: number;
  /** The name the record claims for this pin. */
  claimed: string;
  /** The name the page draws in its place, as printed. */
  printed: string;
  /** The page this number was read on. */
  page: number;
}

export interface PinoutEvidence {
  /** Pages carrying the sequences this was read from, in order. */
  pages: number[];
  /** Claimed pins whose name the page draws at their number's offset. */
  agreeing: number[];
  /**
   * Positions where a name was drawn and it was not the claimed one.
   *
   * INTERNAL EVIDENCE, NOT A FINDING. It decides whether a page is the same
   * pinout at all, and it is deliberately never put in front of a user.
   *
   * Measured over the tuned corpus on 2026-08-27: all four conflicts it produced
   * were artifacts of reading a ROTATED figure, where a label's reported width
   * does not cover its glyphs so neighbouring labels glue into one string. Every
   * one of the four named a pin the datasheet agrees with the record about, and
   * every one of those parts was already flagged for incomplete agreement. So it
   * would have cost four false accusations and changed no outcome.
   *
   * The invariant does not need it: it asks for agreement, and a pin with no
   * legible name is not agreed either way.
   */
  conflicts: PinDissent[];
}

interface Numbered {
  number: number;
  item: TextItem;
}

/** Which way a sequence of numbers runs across the page. */
type Axis = "x" | "y";

interface Sequence {
  /** The axis the numbers advance along. */
  axis: Axis;
  entries: Numbered[];
}

interface SequenceMatch {
  page: number;
  agreeing: number[];
  dissenting: PinDissent[];
}

/**
 * The numbers of one sequence, judged against the claim at one constant offset.
 */
function evaluateSequence(
  page: number,
  sequence: Sequence,
  claimed: ReadonlyMap<number, string>,
  index: ReadonlyMap<string, TextItem[]>,
  runs: readonly TextItem[]
): SequenceMatch | null {
  const mine = sequence.entries.filter((entry) => claimed.has(entry.number));
  if (mine.length < Math.min(MIN_SEQUENCE_ENTRIES, claimed.size)) return null;

  // THE TOLERANCE CANNOT REACH THE NEXT PIN.
  //
  // A quad figure draws a hundred numbers along one edge less than nine points
  // apart. A fixed twelve-point window then spans three pin positions, so a name
  // two pins away counts as agreement and the check confirms a pinout it has not
  // read. That is exactly how STM32F407VG's one wrong pin survived: `VSS` really
  // is drawn near `49`, over the top of `50`.
  //
  // So the window along the sequence's own axis is set from the sequence's own
  // spacing and can never reach halfway to a neighbour. Across the other axis it
  // is left alone: nothing there competes for the match.
  const along = sequence.entries.map((entry) => (sequence.axis === "x" ? centreOf(entry.item) : entry.item.y)).sort((a, b) => a - b);
  const gaps = along.slice(1).map((value, at) => value - along[at]).filter((gap) => gap > 0);
  const spacing = gaps.length > 0 ? Math.min(...gaps) : Infinity;
  const window = {
    dx: sequence.axis === "x" ? Math.min(OFFSET_TOLERANCE_X_PT, spacing * 0.45) : OFFSET_TOLERANCE_X_PT,
    dy: sequence.axis === "y" ? Math.min(OFFSET_TOLERANCE_Y_PT, spacing * 0.45) : OFFSET_TOLERANCE_Y_PT
  };

  const candidates = mine.map((entry) => {
    const drawn = index.get(normalizePinName(claimed.get(entry.number)!)) ?? [];
    return {
      entry,
      offsets: drawn.map((run) => ({ dx: run.x - entry.item.x, dy: run.y - entry.item.y }))
    };
  });

  const all = candidates.flatMap((candidate) => candidate.offsets);
  if (all.length === 0) return null;

  const supports = (candidate: (typeof candidates)[number], offset: { dx: number; dy: number }) =>
    candidate.offsets.some(
      (own) => Math.abs(own.dx - offset.dx) <= window.dx && Math.abs(own.dy - offset.dy) <= window.dy
    );

  let best = all[0];
  let bestSupport = -1;
  for (const offset of all) {
    const support = candidates.filter((candidate) => supports(candidate, offset)).length;
    if (support > bestSupport) {
      bestSupport = support;
      best = offset;
    }
  }

  const agreeing: number[] = [];
  const dissenting: PinDissent[] = [];
  for (const candidate of candidates) {
    const claim = claimed.get(candidate.entry.number)!;
    if (supports(candidate, best)) {
      agreeing.push(candidate.entry.number);
      continue;
    }
    const printed = printedAt(runs, candidate.entry.item.x + best.dx, candidate.entry.item.y + best.dy, window);
    // NOTHING LEGIBLE THERE IS NOT A DISAGREEMENT. A pin whose name is drawn as
    // artwork, or whose glyphs came back through a broken font encoding, leaves
    // this position empty. Calling that a contradiction would put the user in
    // front of a page that agrees with the record.
    if (printed.length === 0) continue;
    if (namesAgree(printed, claim)) {
      agreeing.push(candidate.entry.number);
      continue;
    }
    if (!contradicts(printed, claim)) continue;
    if (!namesAnotherPin(printed, candidate.entry.number, claimed)) continue;
    dissenting.push({ number: candidate.entry.number, claimed: claim, printed, page });
  }

  if (agreeing.length === 0) return null;
  return { page, agreeing, dissenting };
}

/**
 * Maximal groups of numbers drawn along one line, down a column or across a row.
 *
 * A number belongs to both groupings and is offered to both, because a table
 * column and a figure edge are the same shape rotated and nothing on the page
 * says which one is being looked at.
 */
function sequences(numbers: readonly Numbered[], pinCount: number): Sequence[] {
  // Grouped by the coordinate they SHARE, so a group sharing an x advances along
  // y and a group sharing a y advances along x.
  const group = (shared: (entry: Numbered) => number, axis: Axis): Sequence[] => {
    const out: Sequence[] = [];
    for (const entry of [...numbers].sort((left, right) => shared(left) - shared(right))) {
      const last = out[out.length - 1];
      if (last && Math.abs(shared(last.entries[last.entries.length - 1]) - shared(entry)) <= COLLINEAR_TOLERANCE_PT) {
        last.entries.push(entry);
      } else {
        out.push({ axis, entries: [entry] });
      }
    }
    return out;
  };

  const groups = [...group((entry) => centreOf(entry.item), "y"), ...group((entry) => entry.item.y, "x")];

  return groups.filter(({ entries: sequence }) => {
    // A NUMBER THIS PACKAGE DOES NOT HAVE means the sequence is not about it.
    // OPA2189 is the case: the 8-pin part's names were measured against the
    // 14-pin OPA4189's figure on the same page, and two pins that are correct
    // came back wrong.
    if (sequence.some((entry) => entry.number > pinCount)) return false;
    // A number drawn twice in one sequence is a page number, a figure caption or
    // a footnote marker rather than a pin.
    const counts = new Map<number, number>();
    for (const entry of sequence) counts.set(entry.number, (counts.get(entry.number) ?? 0) + 1);
    return [...counts.values()].every((count) => count === 1) && sequence.length >= MIN_SEQUENCE_ENTRIES;
  });
}

/**
 * The independent support the text layer offers for a claimed pinout.
 *
 * Returns null when no sequence of pin numbers on any page lines up with the
 * claim. That is not a criticism of the document and not a defect: a pinout
 * drawn as artwork has no text layer to read. It means only that this source has
 * nothing to say, and the caller must not treat silence as agreement.
 */
export function pinoutEvidence(
  doc: DatasheetText,
  pins: readonly PinRecord[],
  pinCount: number
): PinoutEvidence | null {
  const claimed = new Map<number, string>();
  for (const pin of pins) {
    const number = Number(pin.number);
    if (Number.isInteger(number) && number >= 1 && number <= pinCount && pin.name.trim().length > 0) {
      claimed.set(number, pin.name);
    }
  }
  if (claimed.size === 0) return null;

  const matches: SequenceMatch[] = [];
  for (const page of doc.pages) {
    const runs = runsOf(page);
    const numbers: Numbered[] = [];
    for (const item of runs) {
      const number = asNumber(item);
      if (number !== null) numbers.push({ number, item });
    }
    if (numbers.length < MIN_SEQUENCE_ENTRIES) continue;
    const found = sequences(numbers, pinCount);
    if (found.length === 0) continue;
    const index = nameIndex(runs);
    const onThisPage: SequenceMatch[] = [];
    for (const sequence of found) {
      const match = evaluateSequence(page.page, sequence, claimed, index, runs);
      if (match) onThisPage.push(match);
    }

    // IS THIS PAGE EVEN THE SAME PINOUT? Judged at the page rather than the
    // sequence, because a figure's four sides are four sequences of one drawing
    // and none of them is convincing alone.
    //
    // Judged on the pins the page has an OPINION about: a table three quarters
    // of which is unreadable typography is still the right table for the quarter
    // that reads.
    const agreed = new Set(onThisPage.flatMap((match) => match.agreeing));
    const denied = new Set(onThisPage.flatMap((match) => match.dissenting.map((item) => item.number)));
    for (const number of agreed) denied.delete(number);
    const decided = agreed.size + denied.size;
    if (agreed.size < Math.min(MIN_PAGE_AGREEMENTS, claimed.size)) continue;
    if (agreed.size / decided < SAME_PINOUT_THRESHOLD) continue;
    matches.push(...onThisPage);
  }

  if (matches.length === 0) return null;

  // EVERY SUPPORTING SEQUENCE COUNTS, not just the best one. A figure draws pins
  // 1 to 4 down its left side and 5 to 8 down its right, which is two sequences
  // of four, and taking only one of them would confirm half a pinout and call it
  // whole.
  const agreeing = new Set<number>();
  const dissent = new Map<number, PinDissent>();
  const pages = new Set<number>();
  for (const match of matches) {
    pages.add(match.page);
    for (const number of match.agreeing) agreeing.add(number);
    for (const item of match.dissenting) dissent.set(item.number, item);
  }
  if (process.env.FORGE_KEEP_DISSENT !== "1") for (const number of agreeing) dissent.delete(number);

  return {
    pages: [...pages].sort((left, right) => left - right),
    agreeing: [...agreeing].sort((left, right) => left - right),
    conflicts: [...dissent.values()].sort((left, right) => left.number - right.number)
  };
}
