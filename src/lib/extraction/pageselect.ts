import type { ExtractionField } from "./contracts";

/**
 * Chooses which pages of a datasheet to put in front of a model.
 *
 * ## Why this exists
 *
 * It was measured, not guessed. A real local model (`qwen2.5:1.5b`, air-gapped,
 * over ollama) answers our exact contract correctly on a short prompt and
 * returns nothing usable on a ~50k-character one built from a whole document.
 * The bottleneck is prompt size, not model size, so the fix is to stop sending
 * the whole document.
 *
 * The previous selection was positional: the first 40 pages, up to 180k
 * characters. Position is not relevance. A rad-hard datasheet puts the radiation
 * table two thirds of the way in and the package drawing last, so the leading
 * pages are the ones least likely to hold what the deterministic pass could not
 * read.
 *
 * ## What it does not claim
 *
 * This can drop the page carrying an answer, and when it does the model returns
 * null for that field. Two things make that acceptable and one makes it visible:
 * a model answer is only ever a fallback for what code could not read; every
 * answer is citation-verified against the document afterwards, so a wrong one is
 * discarded rather than merged; and the selection is reported on the request so
 * a partial view is recorded rather than silent.
 *
 * If nothing matches, it falls back to the leading pages. A datasheet written in
 * vocabulary we do not recognise should still get looked at.
 *
 * Air-gap safe: string matching, no networking, no model call.
 */

/** A page as the selector sees it. */
export interface SelectablePage {
  page: number;
  text: string;
}

export interface PageSelection {
  pages: SelectablePage[];
  /** How the pages were chosen, for the record and for logs. */
  reason: "relevance" | "leading";
  /** Pages the whole document had, before selection. */
  totalPages: number;
  /** Characters the whole document had, before selection and truncation. */
  totalChars: number;
}

/**
 * Cues per field, as case-insensitive patterns.
 *
 * These are section headings and unit vocabulary, not values: a page is chosen
 * because it looks like the page that would carry the field, not because it
 * appears to contain an answer. Matching on candidate values would bias the
 * model toward whatever our regexes already found, which is the opposite of why
 * the model is being asked.
 */
const CUES: Record<ExtractionField, RegExp[]> = {
  partNumber: [/ordering\s+information/i, /orderable\s+part/i, /device\s+information/i],
  manufacturer: [/ordering\s+information/i, /trademarks?\b/i],
  packageType: [
    /package\s+(outline|option|information|drawing|type)/i,
    /ordering\s+information/i,
    /\b(QFN|BGA|SOIC|TSSOP|CFP|LCC|DIP|SSOP|QFP|WSON|LFCSP)\b/
  ],
  pinCount: [/pin\s+(configuration|functions?|description|assignment)/i, /terminal\s+functions?/i, /connection\s+diagram/i],
  pins: [
    /pin\s+(configuration|functions?|description|assignment)/i,
    /terminal\s+functions?/i,
    /connection\s+diagram/i,
    /\bpin\s*(no\.?|number|#)\b/i,
    /\b(I\/O|input\/output)\b.*\bdescription\b/i
  ],
  "dimensions.bodyLengthMm": DIMENSION_CUES(),
  "dimensions.bodyWidthMm": DIMENSION_CUES(),
  "dimensions.bodyHeightMm": DIMENSION_CUES(),
  "dimensions.pitchMm": [...DIMENSION_CUES(), /\bpitch\b/i, /\blead\s+spacing\b/i],
  "dimensions.leadLengthMm": [...DIMENSION_CUES(), /\blead\s+length\b/i],
  "dimensions.leadCount": [...DIMENSION_CUES(), /pin\s+(configuration|functions?)/i],
  "radiation.tid": RADIATION_CUES(),
  "radiation.see": RADIATION_CUES(),
  "radiation.sel": [...RADIATION_CUES(), /latch-?up/i],
  "radiation.qmlClass": [...RADIATION_CUES(), /\bQML\b/, /\bMIL-PRF-38535\b/i, /class\s+[QVK]\b/i]
};

function DIMENSION_CUES(): RegExp[] {
  return [
    /mechanical\s+(data|drawing|information)/i,
    /package\s+(outline|drawing|dimensions)/i,
    /dimensions?\s+are\s+in/i,
    /\bmillimet(er|re)s?\b/i,
    // The JEDEC outline codes, not the word "JEDEC". Bare "JEDEC" pulled in
    // every page citing an ESD standard, which on the LMP7704-SP outscored the
    // package drawing itself.
    /\bM[OS]-\d{3}\b/,
    /\bASME\s+Y14\.5/i
  ];
}

function RADIATION_CUES(): RegExp[] {
  return [
    /total\s+ionizing\s+dose/i,
    /\bTID\b/,
    /\bkrad\b/i,
    /single[- ]event/i,
    /\bSE[ELUT]\b/,
    /radiation\s+(hardness|performance|specifications?)/i
  ];
}

/**
 * The identity page. Page 1 carries the part number, the manufacturer and
 * usually the package, and it is what tells the model which device the rest of
 * the document is about when several are mentioned. It is always included.
 */
const ALWAYS_INCLUDE = 1;

/** How many pages one field may pull in on its own. */
const PAGES_PER_FIELD = 3;

export interface PageSelectLimits {
  maxPages: number;
  maxCharsPerPage: number;
  maxTotalChars: number;
}

export function selectPages(
  pages: SelectablePage[],
  fields: ExtractionField[],
  limits: PageSelectLimits
): PageSelection {
  const totalPages = pages.length;
  const totalChars = pages.reduce((sum, page) => sum + page.text.length, 0);

  const scores = new Map<number, number>();
  for (const field of fields) {
    const ranked = pages
      .map((page) => ({ page: page.page, score: cueScore(page.text, CUES[field] ?? []) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.page - b.page)
      .slice(0, PAGES_PER_FIELD);

    for (const entry of ranked) {
      scores.set(entry.page, (scores.get(entry.page) ?? 0) + entry.score);
    }
  }

  const reason: PageSelection["reason"] = scores.size > 0 ? "relevance" : "leading";

  // Page 1 first, then by score, then by position. Taking the best-scoring
  // pages before applying the budget means the budget cuts the least relevant
  // page rather than the last one in the document.
  const order =
    reason === "relevance"
      ? [...pages]
          .sort((a, b) => {
            if (a.page === ALWAYS_INCLUDE) return -1;
            if (b.page === ALWAYS_INCLUDE) return 1;
            return (scores.get(b.page) ?? 0) - (scores.get(a.page) ?? 0) || a.page - b.page;
          })
          .filter((page) => page.page === ALWAYS_INCLUDE || (scores.get(page.page) ?? 0) > 0)
      : [...pages];

  const chosen: SelectablePage[] = [];
  let used = 0;
  for (const page of order) {
    if (chosen.length >= limits.maxPages) break;
    const text = page.text.slice(0, limits.maxCharsPerPage);
    if (used + text.length > limits.maxTotalChars) continue;
    used += text.length;
    chosen.push({ page: page.page, text });
  }

  // Reading order, whatever order they were chosen in. A model asked to cite a
  // page should see the document the way the document is written.
  chosen.sort((a, b) => a.page - b.page);

  return { pages: chosen, reason, totalPages, totalChars };
}

function cueScore(text: string, cues: RegExp[]): number {
  let score = 0;
  for (const cue of cues) {
    const matches = text.match(new RegExp(cue.source, cue.flags.includes("g") ? cue.flags : `${cue.flags}g`));
    if (matches) score += Math.min(matches.length, 5);
  }
  return score;
}
