/**
 * Recovers text from embedded fonts whose encoding is a constant offset.
 *
 * ## The problem, measured
 *
 * Some datasheets embed a subset font with a custom encoding and no ToUnicode
 * map. pdf.js then reports the raw glyph codes, so the text layer of the page
 * is real, present, and unreadable. LD1117 page 6 carries its whole pin
 * configuration this way:
 *
 *     $'-*1'   1&   9287 9287   9,1
 *     ADJ/GND  NC   VOUT VOUT   VIN
 *
 * Every character is displaced by exactly the same amount: `'9'`(57) to
 * `'V'`(86), `'2'`(50) to `'O'`(79), `','`(44) to `'I'`(73), all +29. This is
 * not mojibake to be given up on, it is a shift to be undone with arithmetic.
 *
 * That page was previously written off as needing a vision model, because
 * neither a parser nor a text prompt can read it. It needs neither.
 *
 * ## Why the FONT is the unit, not the page or the item
 *
 * A page mixes encodings freely: LD1117 page 6 has normal body text
 * ("Pin configuration LD1117") beside the broken figure, and shifting the good
 * text destroys it. Per-ITEM detection is unsafe in the other direction, since
 * a short run like `9,1` is indistinguishable from a European decimal.
 *
 * The encoding is a property of the FONT RESOURCE, so that is the unit that is
 * tested and the unit that is corrected. Every item sharing a broken font is
 * decoded; every item in a healthy font is untouched.
 *
 * ## Corpus
 *
 * 4 of 39 cached datasheets have at least one affected page: LD1117,
 * RTAX2000S, STM32H743ZI and TLV9061. Three of them are blocked on pin data.
 */

/**
 * Vocabulary used to decide whether a candidate shift produced real text.
 *
 * A word list is the wrong instrument for "which page is this" and the right
 * one here, because this is not a classification: it is testing a decode
 * against known plaintext. These are the tokens a pin figure is made of, and a
 * wrong shift produces none of them.
 */
const PLAINTEXT = /\b(?:V(?:IN|OUT|CC|DD|SS|REF)|GND|ADJ|NC|OUT|IN|EN|CLK|SDA|SCL|RESET|TOP\s?VIEW|PIN)\b/g;

/** Shifts to consider. Wide enough to cover the offsets seen, bounded to stay cheap. */
const MIN_SHIFT = 1;
const MAX_SHIFT = 64;

/**
 * How decisively a shift must win before it is applied.
 *
 * Both bars matter. The absolute floor stops a single incidental `IN` from
 * rewriting a whole font, and the margin over the unshifted text is what keeps
 * healthy fonts untouched: correct text already scores, and no shift of it
 * scores better.
 */
const MIN_HITS = 3;
const MIN_MARGIN = 2;

/**
 * Letter-ratio bounds, measured on the corpus.
 *
 * LD1117's broken figure font is 0.02 letters before the shift and 0.86 after.
 * Healthy fonts sit at 0.6 and up already. The gap between those is wide, so
 * these bounds sit inside it rather than being tuned to an edge.
 */
const MAX_ENCODED_LETTER_RATIO = 0.4;
const MIN_DECODED_LETTER_RATIO = 0.6;

/** Printable ASCII, the range a decoded datasheet label has to land in. */
const LOW = 33;
const HIGH = 126;

/**
 * Applies the shift, or returns null when this shift cannot be the encoding.
 *
 * **All or nothing, and this is the correction that made detection work at
 * all.** The first version left a character alone when shifting it would leave
 * printable ASCII, which sounds like a safety guard and destroys the test: at
 * shift 59 the uppercase letters overflow and are skipped, so a HEALTHY font's
 * `VDD` and `GND` survive untouched, keep scoring, and let a nonsense shift
 * beat the unshifted text. Measured cost of that mistake: fields 41% to 33%,
 * bundles 7 to 5, because good fonts across the corpus were being mangled.
 *
 * A real constant-offset encoding maps the whole alphabet consistently. If any
 * character will not survive the shift, this is not that encoding.
 *
 * Whitespace is preserved rather than shifted: it separates the labels and a
 * shifted space is not a space.
 */
export function shiftText(text: string, by: number): string | null {
  let out = "";
  for (const character of text) {
    if (/\s/.test(character)) {
      out += character;
      continue;
    }
    // The constraint belongs on the OUTPUT only. Encoded glyph codes are not
    // required to be printable and on this corpus they are not: LD1117's digits
    // and slash encode to 18 and 20-24, i.e. down in the control range, because
    // `'1'`(49) - 29 = 20. Requiring printable INPUT rejected every real case.
    const shifted = character.charCodeAt(0) + by;
    if (shifted < LOW || shifted > HIGH) return null;
    out += String.fromCharCode(shifted);
  }
  return out;
}

function score(text: string): number {
  return (text.match(PLAINTEXT) ?? []).length;
}

/**
 * Share of non-space characters that are letters.
 *
 * The structural half of the test, and the half that does not depend on a word
 * list. A font with a broken encoding is drawing letters and reporting glyph
 * codes, so its text is mostly digits and punctuation; the correct shift turns
 * that into mostly letters. A healthy font is already mostly letters and no
 * shift improves it.
 */
function letterRatio(text: string): number {
  const visible = text.replace(/\s/g, "");
  if (visible.length === 0) return 0;
  return (visible.match(/[A-Za-z]/g) ?? []).length / visible.length;
}

/**
 * The shift that decodes this font's text, or null when it is already fine.
 *
 * Returns null rather than a best guess. A font that does not decode decisively
 * is left exactly as the document supplied it, because a wrongly "corrected"
 * pin name is worse than an unreadable one: unreadable is visibly a gap, and
 * wrong is not.
 */
export function detectShift(sample: string): number | null {
  // A font that already reads as text is not encoded, whatever any shift
  // scores. This is checked first because it is the cheap, decisive case: it
  // exempts every healthy font in the corpus before any shift is tried.
  if (letterRatio(sample) >= MAX_ENCODED_LETTER_RATIO) return null;

  const plain = score(sample);

  let best: { shift: number; hits: number } | null = null;
  for (let shift = MIN_SHIFT; shift <= MAX_SHIFT; shift++) {
    const decoded = shiftText(sample, shift);
    // Null means this shift pushes some character out of printable ASCII, so it
    // cannot be the encoding.
    if (decoded === null) continue;
    if (letterRatio(decoded) < MIN_DECODED_LETTER_RATIO) continue;
    const hits = score(decoded);
    if (!best || hits > best.hits) best = { shift, hits };
  }

  if (!best || best.hits < MIN_HITS) return null;
  if (best.hits < plain + MIN_MARGIN) return null;
  return best.shift;
}

export interface FontScopedItem {
  str: string;
  fontName?: string;
}

/**
 * Decodes every item whose font is shifted, leaving the rest untouched.
 *
 * Items with no font name are never touched: without the font there is no unit
 * to test, and guessing per item is the unsafe direction.
 */
export function decodeShiftedFonts<T extends FontScopedItem>(items: T[]): T[] {
  const byFont = new Map<string, string[]>();
  for (const item of items) {
    if (!item.fontName || !item.str.trim()) continue;
    const bucket = byFont.get(item.fontName);
    if (bucket) bucket.push(item.str);
    else byFont.set(item.fontName, [item.str]);
  }
  if (byFont.size === 0) return items;

  const shifts = new Map<string, number>();
  for (const [fontName, strings] of byFont) {
    // Joined with spaces so the vocabulary check sees word boundaries: a figure
    // emits one item per label, and `VIN` alone in an item still has to match.
    const shift = detectShift(strings.join(" "));
    if (shift !== null) shifts.set(fontName, shift);
  }
  if (shifts.size === 0) return items;

  return items.map((item) => {
    const shift = item.fontName ? shifts.get(item.fontName) : undefined;
    if (shift === undefined) return item;
    const decoded = shiftText(item.str, shift);
    // A single item that will not survive the font's shift is left as it was.
    // The font is decoded, this run of it is not, and an untouched run is a
    // visible gap rather than a wrong value.
    return decoded === null ? item : { ...item, str: decoded };
  });
}
