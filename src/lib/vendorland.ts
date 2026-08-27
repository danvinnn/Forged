/**
 * Reads the land pattern the VENDOR prints in the datasheet, so a computed
 * footprint can be checked against the manufacturer's own recommendation.
 *
 * Why bother when we already compute IPC-7351B: because the two are independent,
 * and a silent disagreement between them is exactly the kind of thing that ends
 * up on a board. TI draws a "LAND PATTERN EXAMPLE" for every package, dimensioned
 * as reference values in parentheses:
 *
 *   8X (1.5)      eight lands, 1.5 mm in one axis
 *   8X (0.45)     eight lands, 0.45 mm in the other
 *   6X (0.65)     six gaps at the 0.65 mm pitch
 *   (5.8)         the centre-to-centre span
 *
 * ## What this reader is, and what it is NOT, since 2026-08-12
 *
 * This is the TEXT reader, and it stays a corroboration. Its limit is real: the
 * drawing is a flattened figure, so which repeated value is the land length and
 * which the land width cannot be recovered from the text with certainty, and a
 * swap would produce a wrong footprint that still looks plausible. Checking
 * whether our numbers appear among the vendor's needs no such assumption.
 *
 * What was wrong was the CONCLUSION drawn from that limit. Because the text
 * could not read the drawing unambiguously, the printed pattern was excluded
 * from the footprint altogether, and the footprint was computed instead from
 * IPC-7351B plus a hand-typed family table. Measured across the hold-out, 36 of
 * 39 datasheets print a recommended footprint and this reader finds 17. So the
 * document stated the answer, the code derived a substitute from outside
 * information, and used the answer only to VETO the substitute.
 *
 * The printed pattern now feeds the footprint directly, read off the RENDERED
 * page into `dimensions.landPad*` and `dimensions.landSpanMm`. A reader that
 * sees the drawing has none of the ambiguity described above, which is what
 * makes it safe there and still unsafe here.
 */

import { type DatasheetText } from "./pdftext";
import { type LandPattern } from "./ipc7351";

/** A dimension the vendor's land pattern drawing carries. */
export interface VendorLandDimension {
  /** Repeat count, e.g. 8 in "8X (1.5)". Null for a bare "(5.8)". */
  repeat: number | null;
  valueMm: number;
}

export interface VendorLandPattern {
  dimensions: VendorLandDimension[];
  /** 1-based page the drawing was read from. */
  page: number;
}

const LAND_PATTERN_HEADING = /LAND PATTERN EXAMPLE/i;

/**
 * Makes a package designator safe to put inside a regular expression.
 *
 * The designator reaches here from a form field on `/api/parse` and from the
 * model's own answer, so it is not ours. `SOIC[` builds `\bSOIC[\b`, which is an
 * unterminated character class: the constructor throws, the throw leaves the
 * route handler, and the caller gets a 500 for a string.
 *
 * The route bounds the designator's LENGTH and cites regex construction as the
 * reason, which addresses a different hazard: length was never the problem, the
 * metacharacters were.
 *
 * Escaping rather than stripping, because the word boundaries around this are
 * load-bearing. `\bSO\b` must not match `SOIC`, and removing the punctuation to
 * sanitise it would remove the boundary with it.
 */
function forRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}
/**
 * "8X (1.5)" or a bare "(5.8)".
 *
 * The leading digits are optional because a dual-dimensioned drawing writes the
 * inch value as `.061` with no zero before the point. That form matched nothing,
 * so every TI drawing dimensioned in inches read as a footprint with no callouts
 * at all - and those are the drawings whose millimetres sit in brackets a few
 * characters later, which is where the number we actually want was.
 */
const DIMENSION = /(?:(\d{1,3})X\s*)?\(\s*(\d{0,3}(?:\.\d{1,4})?)\s*\)/g;

/**
 * The millimetre twin of an inch callout, on a drawing dimensioned in both.
 *
 * TI prints `8X (.061  )` and `[1.55]` on the next line, and the bracketed
 * figure is the one this project works in. Which is which is NOT assumed and no
 * note is parsed for it: 1.55 is 0.061 x 25.4, and that arithmetic identifies
 * the pair on its own. A drawing dimensioned the other way round - millimetres
 * in parentheses, inches in brackets - is recognised by the same test running in
 * the same direction, and its parenthesised value is already what we want.
 *
 * A callout with no twin on an inch-primary drawing is DROPPED rather than
 * converted. Converting would be sound arithmetic on a sound premise, and the
 * premise is what would be doing the work; a bag of land dimensions silently
 * scaled by 25.4 is the worst failure this file could produce.
 */
const TWIN = /\[\s*(\d{0,3}(?:\.\d{1,4})?)\s*\]/;

/** How far past a callout its bracketed twin may sit, in characters. */
const TWIN_WINDOW = 48;

/** Millimetres per inch, and the ratio that identifies a dual-dimensioned pair. */
const MM_PER_INCH = 25.4;

/**
 * Every land dimension in one drawing block, in millimetres.
 *
 * Returns an empty list where the block is dimensioned in inches and its
 * millimetre twins could not be paired up, which is the honest outcome: the
 * caller treats no callouts as a footprint it could not read, and
 * `findUnreadableFootprint` still reports the page.
 */
function dimensionsIn(block: string): VendorLandDimension[] {
  const found: Array<{ repeat: number | null; parenMm: number; twinMm: number | null }> = [];
  for (const match of block.matchAll(DIMENSION)) {
    const parenMm = Number(match[2]);
    if (!Number.isFinite(parenMm) || parenMm <= 0) continue;
    const ahead = block.slice(match.index + match[0].length, match.index + match[0].length + TWIN_WINDOW);
    const twin = TWIN.exec(ahead);
    const twinMm = twin ? Number(twin[1]) : null;
    found.push({ repeat: match[1] ? Number(match[1]) : null, parenMm, twinMm: Number.isFinite(twinMm) ? twinMm : null });
  }

  // IS THIS DRAWING DIMENSIONED IN INCHES? The pairs say so themselves.
  const inchPrimary = found.some(
    (entry) => entry.twinMm !== null && entry.parenMm > 0 && Math.abs(entry.twinMm - entry.parenMm * MM_PER_INCH) <= entry.twinMm * 0.02
  );

  const dimensions: VendorLandDimension[] = [];
  for (const entry of found) {
    const valueMm = inchPrimary ? entry.twinMm : entry.parenMm;
    if (valueMm === null) continue;
    // Radii and solder-mask slivers are not land dimensions.
    if (!Number.isFinite(valueMm) || valueMm <= 0.1 || valueMm > 100) continue;
    dimensions.push({ repeat: entry.repeat, valueMm });
  }
  return dimensions;
}

/** How far back from the heading the dimension callouts sit, in characters. */
const DRAWING_WINDOW = 1200;

/**
 * Extracts the vendor's land pattern callouts for a given package family.
 *
 * The family filter is not optional in practice. A datasheet prints one drawing
 * per package it offers, and UCC27524 offers three: taking the first heading
 * compared a SOIC footprint against the WSON land pattern and reported a
 * disagreement that did not exist. Each drawing names its package in the header
 * line above the callouts, so that is what selects the right one.
 */
/**
 * A drawing title token, with trademark decoration removed.
 *
 * TI sets a superscript trademark beside the family word and the text layer
 * folds it back in, so `VSSOP` arrives as `TMVSSOP` and an equality test against
 * the package family fails on a drawing that is the right one. Measured on
 * LM358, whose DGK drawing is titled `DGK0008A TMVSSOP`.
 *
 * The literal `TM` is stripped only when something substantial is left, so a
 * family whose own name begins with those letters is not truncated.
 */
function withoutTrademark(token: string): string {
  const bare = token.toUpperCase().replace(/[^A-Z0-9-]/g, "");
  const stripped = bare.replace(/^TM/, "");
  return stripped.length >= 4 ? stripped : bare;
}

/**
 * Does this drawing's title name the package we are asking about?
 *
 * THE OUTLINE CODE FIRST, because it is the drawing's own identity and the one
 * thing that does not drift: `PWP0028C` is `PWP0028C` whatever the caption calls
 * it. The caption does drift, and it drifts between the ordering table and the
 * drawing in the same document: DRV8825's ordering guide says `HTSSOP` and its
 * drawing is titled `PowerPAD TSSOP`, so a family comparison rejected the right
 * drawing for a package whose code was sitting on the record.
 *
 * The family word is the fallback for a record with no code, and it is compared
 * against every token of the title rather than the second one alone.
 */
function titleNames(block: string, wanted: string | undefined, outlineCode: string | undefined): boolean {
  const header = /EXAMPLE BOARD LAYOUT\s*\n\s*(\S+)\s+([^\n]*)/i.exec(block);
  const key = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (outlineCode && header && key(header[1]) === key(outlineCode)) return true;
  if (!wanted) return header ? !outlineCode : true;
  if (header) {
    const tokens = `${header[1]} ${header[2]}`.split(/\s+/).map(withoutTrademark);
    if (tokens.includes(withoutTrademark(wanted))) return true;
    // A code we know about that this title does not carry means this is another
    // package's drawing, whatever its caption says.
    if (outlineCode) return false;
    return false;
  }
  return new RegExp(`\\b${forRegex(wanted)}\\b`, "i").test(block);
}

export function findVendorLandPattern(
  doc: DatasheetText,
  family?: string,
  /** The vendor's own code for this package's outline drawing, where one is known. */
  outlineCode?: string
): VendorLandPattern | null {
  const headings = [...doc.text.matchAll(new RegExp(LAND_PATTERN_HEADING.source, "gi"))];
  if (headings.length === 0) return null;

  // "SOIC narrow" and "TSSOP" both have to match a header reading "D0008A SOIC"
  // or "PW0008A TSSOP", so compare on the first word only.
  const wanted = family?.trim().split(/\s+/)[0]?.toUpperCase();

  for (const heading of headings) {
    const windowStart = Math.max(0, heading.index - DRAWING_WINDOW);
    // Bound the lookback at the NEAREST drawing title. Scanning a flat window
    // backwards reaches into the previous package's drawing, and then the header
    // check reads that package's name and rejects a drawing that was correct.
    const window = doc.text.slice(windowStart, heading.index + 80);
    const titles = [...window.matchAll(/EXAMPLE BOARD LAYOUT/gi)];
    const block = titles.length > 0 ? window.slice(titles[titles.length - 1].index) : window;

    // The package header sits just after the "EXAMPLE BOARD LAYOUT" title. Any
    // other package named there means this drawing is for a different one.
    if ((wanted || outlineCode) && !titleNames(block, wanted, outlineCode)) continue;

    const dimensions = dimensionsIn(block);
    if (dimensions.length === 0) continue;

    const page = doc.pages.find((candidate) => heading.index < candidate.end)?.page ?? 1;
    return { dimensions, page };
  }

  return null;
}

/**
 * A vendor footprint drawing this reader can SEE but cannot READ.
 *
 * The callout reader above is built on TI's conventions: a heading reading
 * `LAND PATTERN EXAMPLE` and reference dimensions in parentheses (`80X (0.3)`).
 * ST prints the same information as `Figure 48. LQFP64 - Footprint example`
 * with bare numbers, which this cannot parse.
 *
 * That distinction has to reach the user, because the alternative message is
 * false: saying a datasheet "does not print a land pattern" about a document
 * that prints one on a numbered page is worse than saying nothing. It sends
 * somebody looking for a comparison that is sitting in front of them.
 *
 * Deliberately NOT extended into a bare-number reader, and that is still right
 * FOR THIS READER: every number on a page would be a candidate, and a
 * coincidental match reporting `agrees` would claim the vendor endorses a
 * pattern they do not print.
 *
 * It is no longer a reason to leave the drawing unread. ST's bare numbers are
 * perfectly legible to a reader that SEES the page, which is how the footprint
 * now gets them; this function's job is only to say "there is one here that the
 * text layer cannot parse" so the user is never told a datasheet prints no
 * footprint when it prints one on a numbered page.
 *
 * ## The vocabulary, widened on evidence 2026-08-25
 *
 * `footprint example` alone is ST's phrasing. Scanned over every line of the 57
 * tuned datasheets, it matched 19 and MISSED 126. A user reported the failure
 * it caused: an LTC6563 prints "RECOMMENDED SOLDER PAD PITCH AND DIMENSIONS" on
 * page 33, dimensioned, and the screen showed them that page while saying the
 * datasheet printed no footprint.
 *
 * The additions are the headings the corpus actually prints: TI's `LAND PATTERN
 * EXAMPLE` (39 lines), `RECOMMENDED LAND PATTERN`, `RECOMMENDED FOOTPRINT`,
 * `RECOMMENDED SOLDER PAD`. Adding TI's is safe because this function is only
 * consulted when the callout reader, which is built on TI's conventions,
 * already came back with nothing.
 *
 * Three near misses are deliberately EXCLUDED, because each names a footprint
 * without being a drawing of one: `TABLE N. FOOTPRINT DATA`, the ordering
 * table's `IPC FOOTPRINT TYPE PACKAGE CODE`, and revision-history lines reading
 * `MECHANICAL DATA UPDATED AND ADDED FOOTPRINT DATA`. Pointing a user at a
 * revision history is the same defect as pointing them at nothing.
 */
const UNREADABLE_FOOTPRINT_HEADING =
  /\b(?:land pattern example|footprint example|recommended land pattern|recommended footprint|recommended solder pad|solder pad pitch and dimensions)\b/i;

/** Dotted leaders, the signature of a table-of-contents entry. */
const TOC_LEADER = /\.{4,}|(?:\.\s){4,}/;

/** Page of a footprint drawing for this family that cannot be parsed, if any. */
export function findUnreadableFootprint(doc: DatasheetText, family?: string): number | null {
  const wanted = family?.trim().split(/\s+/)[0]?.toUpperCase();
  const headings = [...doc.text.matchAll(new RegExp(UNREADABLE_FOOTPRINT_HEADING.source, "gi"))];

  /**
   * Candidates that are drawings rather than contents lines, kept so the family
   * gate can be relaxed when there is only ONE of them.
   *
   * The gate exists so a multi-package datasheet does not point at another
   * package's footprint, which is right. On a document that draws exactly one,
   * it is pure loss: page 33 of an LTC6563 does not repeat "24-Lead QFN" above
   * its solder pad drawing, so the only footprint in the document failed a check
   * written for documents with several.
   *
   * One candidate is not a choice, so there is nothing to guess between. Two or
   * more and the gate still decides, because then picking would be a guess.
   */
  const drawings: number[] = [];

  for (const heading of headings) {
    // The CONTENTS names every figure before the document draws any of them, so
    // the first match is routinely a contents line pointing at a page number
    // rather than the drawing itself. Dotted leaders are what distinguish the
    // two, the same signature `findPinSection` uses for the same reason: without
    // this the reported page is the contents page, which sends the user to a
    // list of figures instead of the figure.
    const after = doc.text.slice(heading.index, heading.index + 80);
    if (TOC_LEADER.test(after)) continue;
    const page = doc.pages.find((candidate) => heading.index < candidate.end)?.page ?? null;
    if (page !== null && !drawings.includes(page)) drawings.push(page);

    // The caption names the package immediately before the phrase, as in
    // `LQFP64 - Footprint example`. Punctuation is stripped so `LQFP-64`,
    // `LQFP64` and `LQFP 64` all compare equal to the family's first word.
    const caption = doc.text.slice(Math.max(0, heading.index - 60), heading.index);
    if (wanted) {
      const bare = wanted.replace(/[^A-Z0-9]/g, "");
      const seen = caption.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!seen.includes(bare)) continue;
    }
    return page;
  }

  // Nothing named the family, but the document drew exactly one footprint. See
  // `drawings`.
  return drawings.length === 1 ? drawings[0]! : null;
}

/** Whether any vendor dimension sits within tolerance of a computed value. */
function matched(values: readonly number[], value: number, toleranceMm: number): boolean {
  return values.some((printed) => Math.abs(printed - value) <= toleranceMm);
}

/**
 * How far a computed land may sit from the vendor's printed one, in mm.
 *
 * No longer exported. `crossCheckLandPattern` was the only caller outside this
 * file, and it was deleted on 2026-08-16: it had no production caller at all,
 * and had not had one since the hand-typed family table went, while carrying 7
 * tests that read as coverage of a live comparison.
 */
const LAND_AGREEMENT_TOLERANCE_MM = 0.12;

/**
 * The three numbers a printed land pattern has to account for, unmatched ones
 * first. Empty means the computed land agrees with the page.
 *
 * Used by `contradictsPrintedLand` in the generator, at EXPORT time, to refuse a
 * land pattern derived from a package drawing that the vendor's own printed page
 * contradicts. That is the check which caught the ADS1115 with correct inputs
 * and the wrong lead form.
 */
export function landDisagreements(
  printedMm: readonly number[],
  computed: LandPattern,
  toleranceMm = LAND_AGREEMENT_TOLERANCE_MM
): string[] {
  const checks: Array<{ what: string; value: number }> = [
    { what: "land length", value: computed.padLengthMm },
    { what: "land width", value: computed.padWidthMm },
    { what: "centre-to-centre span", value: computed.padCentreMm * 2 },
    // AND THE OTHER AXIS, where the computed pattern has one. A rectangular
    // quad's printed drawing carries both spans, and checking one left the
    // second free to disagree with the page unchallenged. Absent on every
    // two-sided package and every square quad, which is why the list is built
    // rather than fixed.
    ...(computed.padCentreCrossMm !== undefined
      ? [{ what: "cross-axis centre-to-centre span", value: computed.padCentreCrossMm * 2 }]
      : [])
  ];
  return checks
    .filter((check) => !matched(printedMm, check.value, toleranceMm))
    .map((check) => `${check.what} ${check.value.toFixed(3)} mm`);
}
