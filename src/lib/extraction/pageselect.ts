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
 * One cue, and how much it is worth.
 *
 * Weighting exists because counting cues equally let PROSE ABOUT a drawing beat
 * the drawing. An STM32F407VG's `Table 93. LQFP100 - Mechanical data`, the page
 * with the actual Min/Typ/Max columns, matched three cues; the notes page facing
 * it, which carries no dimension at all, matched four and won on `ASME Y14.5`,
 * `seating plane` and `millimeters`. Those three phrases say a drawing is nearby,
 * not that one is here.
 *
 * So a cue that can only appear on the page itself is worth three, and a cue
 * that merely accompanies the page is worth one.
 */
interface Cue {
  pattern: RegExp;
  weight: number;
}

const STRONG_WEIGHT = 3;

/**
 * Weight for a cue naming the package this part was actually resolved to.
 *
 * Above `strong`, because on a document with several package drawings every one
 * of them scores full marks on the generic cues: they all say PACKAGE OUTLINE,
 * they all carry an outline code, they all tag a pitch. An LM358 prints five,
 * and the only thing separating the SOIC this part is in from the TSSOP, VSSOP,
 * CDIP and SOT-23 it is not is the family name itself. Ranked merely `strong`,
 * the right drawing tied with four wrong ones and lost on incidental density,
 * so we sent three drawings for packages this part does not come in and the
 * model correctly answered null for every dimension.
 */
const DECISIVE_WEIGHT = 6;

/** A cue naming this part's own resolved package. */
function decisive(pattern: RegExp): Cue {
  return { pattern, weight: DECISIVE_WEIGHT };
}

/** A cue that can only really appear on the page carrying the answer. */
function strong(pattern: RegExp): Cue {
  return { pattern, weight: STRONG_WEIGHT };
}

/** A cue consistent with the page, and with its neighbours. */
function weak(pattern: RegExp): Cue {
  return { pattern, weight: 1 };
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
const CUES: Record<ExtractionField, Cue[]> = {
  partNumber: [strong(/ordering\s+information/i), strong(/orderable\s+part/i), weak(/device\s+information/i)],
  manufacturer: [weak(/ordering\s+information/i), weak(/trademarks?\b/i)],
  packageType: [
    strong(/package\s+(outline|option|information|drawing|type)/i),
    weak(/ordering\s+information/i),
    weak(/\b(QFN|BGA|SOIC|TSSOP|CFP|LCC|DIP|SSOP|QFP|WSON|LFCSP)\b/)
  ],
  pinCount: [
    strong(/pin\s+(configuration|functions?|description|assignment)/i),
    strong(/terminal\s+functions?/i),
    weak(/connection\s+diagram/i)
  ],
  pins: [
    strong(/pin\s+(configuration|functions?|description|assignment)/i),
    strong(/terminal\s+functions?/i),
    strong(/\bpin\s*(no\.?|number|#)\b/i),
    weak(/connection\s+diagram/i),
    weak(/\b(I\/O|input\/output)\b.*\bdescription\b/i)
  ],
  "dimensions.bodyLengthMm": DIMENSION_CUES(),
  "dimensions.bodyWidthMm": DIMENSION_CUES(),
  "dimensions.bodyHeightMm": DIMENSION_CUES(),
  "dimensions.pitchMm": [...DIMENSION_CUES(), strong(/\bpitch\b/i), weak(/\blead\s+spacing\b/i)],
  "dimensions.leadLengthMm": [...DIMENSION_CUES(), weak(/\blead\s+length\b/i)],
  "dimensions.leadCount": [...DIMENSION_CUES(), weak(/pin\s+(configuration|functions?)/i)],
  "dimensions.leadWidthMm": [...DIMENSION_CUES(), weak(/\blead\s+width\b/i)],
  "dimensions.leadSpanMm": [...DIMENSION_CUES(), weak(/\blead\s+span\b/i), weak(/\btip\s+to\s+tip\b/i)],
  "dimensions.leadContactMm": [...DIMENSION_CUES(), weak(/\bdetail\s+[A-Z]\b/i), weak(/\bgage\s+plane\b/i)],
  "radiation.tid": RADIATION_CUES(),
  "radiation.see": RADIATION_CUES(),
  "radiation.sel": [...RADIATION_CUES(), strong(/latch-?up/i)],
  "radiation.qmlClass": [...RADIATION_CUES(), strong(/\bQML\b/), strong(/\bMIL-PRF-38535\b/i), weak(/class\s+[QVK]\b/i)]
};

/**
 * Cues for the page that carries package dimensions.
 *
 * These matter more than the other groups now that pages are RENDERED and put
 * in front of a model: a drawing is the one thing the model reads far better
 * than the text pass, so a selector that drops the drawing page wastes the
 * capability entirely.
 *
 * ## The defect this set was rewritten to fix
 *
 * The previous cues were prose about a drawing rather than the drawing itself,
 * and a package drawing's NOTES are prose while the drawing is numbers. On an
 * STM32G071RB, page 131 is `Table 84. LQFP64 - Mechanical data` with the actual
 * Min/Typ/Max columns and matched two cues; page 132 is the facing notes page,
 * carries no dimension at all, and matched three. The notes page won and the
 * data page was never sent.
 *
 * It was invisible on TI documents because TI prints the notes ON the drawing
 * page, so both scored the same page. One vendor's layout was standing in for a
 * rule.
 *
 * So the strong cues below are things printed on the DRAWING: the vendor's
 * outline code, the dimension table's own column header, and the furniture of a
 * mechanical drawing. The prose cues are kept, because a page describing itself
 * as mechanical data usually is, but they no longer decide the contest alone.
 */
function DIMENSION_CUES(): Cue[] {
  return [
    strong(/mechanical\s+(data|drawing|information)/i),
    strong(/package\s+(outline|drawing|dimensions)/i),

    // A vendor package outline code: TI's `PW0008A`, `DGK0008A`, `PWP0028C`.
    // The highest-precision marker there is, because it is printed on the
    // drawing and essentially nowhere else in the document.
    strong(/\b[A-Z]{2,4}\d{4}[A-Z]\b/),

    // The dimension TABLE's own header, but only under a package heading.
    //
    // `Symbol | Min | Typ | Max` alone is NOT a package cue: it is the header of
    // every electrical-characteristics table ever printed, and unqualified it
    // matched 33 pages of an STM32G071RB and buried the one that mattered. The
    // package context in front of it is what makes it mean anything.
    strong(/(?:mechanical|package)[\s\S]{0,200}?\bsymbol\b[\s\S]{0,60}\bmin\b[\s\S]{0,40}\b(?:typ|nom)\b/i),

    // A repeat-count tag, `6X 0.65` or `26X 0.65`, which is how a vendor states
    // a pitch on a drawing. Anchored to a decimal so it does not match prose.
    strong(/\b\d{1,3}X\s+\d+\.\d/),

    // A body outline named with its lead count, which is how Linear and older
    // ADI documents head a package page: `S8 Package 8-Lead Plastic Small
    // Outline`. Those pages carry no TI-style outline code and their heading is
    // often mangled in the text layer, so this is the only structural marker
    // they offer.
    strong(/\b\d{1,3}-lead\s+(?:plastic|ceramic|molded)/i),

    // Weak: true of the drawing page and of the notes page facing it. `seating
    // plane` reads like drawing furniture and is not, because ST's notes
    // describe the seating plane in prose.
    weak(/\bseating\s+plane\b/i),
    weak(/\bpin\s*1\s+(?:index|id)\b/i),
    // `are` optional: Linear writes `Dimensions in inches (millimeters)`. A unit
    // is required after it so this stays a statement about dimensions.
    weak(/dimensions?\s+(?:are\s+)?in\s+(?:inch|millimet)/i),
    weak(/\bmillimet(er|re)s?\b/i),
    // The JEDEC outline codes, not the word "JEDEC". Bare "JEDEC" pulled in
    // every page citing an ESD standard, which on the LMP7704-SP outscored the
    // package drawing itself.
    weak(/\bM[OS]-\d{3}\b/),
    weak(/\bASME\s+Y14\.5/i)
  ];
}

function RADIATION_CUES(): Cue[] {
  return [
    strong(/total\s+ionizing\s+dose/i),
    strong(/radiation\s+(hardness|performance|specifications?)/i),
    weak(/\bTID\b/),
    weak(/\bkrad\b/i),
    weak(/single[- ]event/i),
    weak(/\bSE[ELUT]\b/)
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

/**
 * The concerns a page can be selected FOR, and the reason they get separate
 * budgets rather than competing in one pool.
 *
 * Fields were previously summed into a single ranking, so on a long document
 * one concern could crowd every other one out. An STM32G071RB has 143 pages and
 * dozens that mention pins; those out-scored the single page carrying the LQFP64
 * dimensions, so the model was shown eight pin-ish pages and no drawing.
 *
 * Reserving a slot per concern is the difference between "the eight best pages"
 * and "the best pages for each thing we still need", and only the second is
 * useful when the thing we still need is one page in a hundred and forty.
 */
const CONCERNS = ["identity", "pins", "dimensions", "radiation"] as const;
type Concern = (typeof CONCERNS)[number];

function concernOf(field: ExtractionField): Concern {
  if (field.startsWith("dimensions.")) return "dimensions";
  if (field.startsWith("radiation.")) return "radiation";
  if (field === "pins" || field === "pinCount") return "pins";
  return "identity";
}

/**
 * Pages guaranteed to each concern that still has an unresolved field.
 *
 * Three, because a dimension answer is regularly split across a drawing and the
 * notes facing it, because on a family datasheet the right package's table and a
 * sibling's look identical to a text scan, and because a document that prints
 * five package drawings puts several plausible pages in front of any ranking.
 * Sending a few beats guessing between them.
 */
const RESERVED_PER_CONCERN = 3;

export interface PageSelectLimits {
  maxPages: number;
  maxCharsPerPage: number;
  maxTotalChars: number;
}

/**
 * What the deterministic pass already worked out about this part.
 *
 * The selector used to know nothing about the record it was selecting for,
 * which on a family datasheet is the difference between the right page and a
 * sibling's. An STM32G071RB is in an LQFP64 and its document prints mechanical
 * data for LQFP32, LQFP48, LQFP64, UFBGA64 and more, every one of which looks
 * identical to a vocabulary scan. An OPA333 document carries five package
 * drawings and only one is the SOIC the record resolved.
 *
 * So the resolved designator is passed in and used as a cue. This is the same
 * rule the pin readers already apply when choosing among per-package pinouts:
 * where the document offers several packages, prefer the one this part is in.
 */
export interface PageSelectHints {
  packageType?: string | null;
  pinCount?: number | null;
}

/** Package families, for pulling a family token out of a designator. */
const FAMILY_TOKEN = /\b(?:H?[TLVWUXP]?[QS]?(?:SOP|FN|FP)|SOIC|SOP|SON|DFN|QFN|QFP|BGA|LGA|CFP|DIP|LCC|SOT|SOD|TSSOP|VSSOP|MSOP|SSOP|WSON|VSON|LFCSP|FLATPACK|DSBGA|WCSP)\d*\b/gi;

/**
 * Cues built from the package this part was resolved to.
 *
 * Deliberately additive: these run alongside the generic dimension cues rather
 * than replacing them, so a part whose package could not be resolved selects
 * exactly as it did before.
 */
function packageCues(hints: PageSelectHints): Cue[] {
  const designator = hints.packageType?.trim();
  if (!designator) return [];

  const cues: Cue[] = [];
  const seen = new Set<string>();

  for (const match of designator.matchAll(FAMILY_TOKEN)) {
    const family = match[0].replace(/\d+$/, "").toUpperCase();
    if (family.length < 2 || seen.has(family)) continue;
    seen.add(family);

    // The family with this part's lead count glued or separated: `LQFP64`,
    // `LQFP-64`, `LQFP 64`. This is the page heading ST prints, and it is the
    // one signal that separates the right table from a sibling's.
    if (hints.pinCount) {
      cues.push(decisive(new RegExp(`\\b${family}\\W{0,2}${hints.pinCount}\\b`, "i")));
    }
    // The family alone. Enough on a document whose packages are different
    // families, which is the common case: an OPA333 prints VSON, SOT, SOIC,
    // SOT-23 and VSSOP drawings, and only one of them is a SOIC.
    cues.push(decisive(new RegExp(`\\b${family}\\b`, "i")));
  }

  return cues;
}

export function selectPages(
  pages: SelectablePage[],
  fields: ExtractionField[],
  limits: PageSelectLimits,
  hints: PageSelectHints = {}
): PageSelection {
  // Applied only to the dimension fields. A package designator on a page is
  // evidence about which DRAWING it is, and says nothing about whether the page
  // carries a pin table or a radiation rating.
  const fromPackage = packageCues(hints);
  const totalPages = pages.length;
  const totalChars = pages.reduce((sum, page) => sum + page.text.length, 0);

  const scores = new Map<number, number>();
  // Kept per concern as well as pooled, so a slot can be reserved for each.
  const byConcern = new Map<Concern, Map<number, number>>();

  for (const field of fields) {
    const ranked = pages
      .map((page) => ({
        page: page.page,
        score: cueScore(
          page.text,
          field.startsWith("dimensions.") ? [...(CUES[field] ?? []), ...fromPackage] : CUES[field] ?? []
        )
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.page - b.page)
      .slice(0, PAGES_PER_FIELD);

    const concern = concernOf(field);
    const pool = byConcern.get(concern) ?? new Map<number, number>();
    for (const entry of ranked) {
      scores.set(entry.page, (scores.get(entry.page) ?? 0) + entry.score);
      pool.set(entry.page, Math.max(pool.get(entry.page) ?? 0, entry.score));
    }
    byConcern.set(concern, pool);
  }

  // The reservation. Each concern with an unresolved field gets its best pages
  // before the pooled ranking spends the budget, so a concern that matches one
  // page in a long document is not outvoted by one that matches forty.
  // ROUND ROBIN, not concern by concern. Every concern gets its best page before
  // any concern gets its second.
  //
  // Taking all of one concern's pages first looks equivalent and is not. The
  // character budget admits roughly four dense pages, so filling it in concern
  // order meant identity and pins consumed it and the dimension pages, ranked
  // fifth and sixth, were cut every time on a long document. An STM32F407VG has
  // 202 pages and its LQFP100 table never survived.
  const ranked = new Map<Concern, number[]>();
  for (const concern of CONCERNS) {
    const pool = byConcern.get(concern);
    if (!pool) continue;
    ranked.set(
      concern,
      [...pool.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([page]) => page)
    );
  }

  const reserved: number[] = [];
  for (let round = 0; round < RESERVED_PER_CONCERN; round += 1) {
    for (const concern of CONCERNS) {
      const page = ranked.get(concern)?.[round];
      if (page !== undefined && !reserved.includes(page)) reserved.push(page);
    }
  }

  const reason: PageSelection["reason"] = scores.size > 0 ? "relevance" : "leading";

  // Page 1 first, then each concern's reserved pages, then the pooled ranking,
  // then position. Taking the best-scoring pages before applying the budget
  // means the budget cuts the least relevant page rather than the last one in
  // the document.
  const reservedRank = new Map(reserved.map((page, index) => [page, index]));
  const rank = (page: number): number =>
    page === ALWAYS_INCLUDE ? -1 : (reservedRank.get(page) ?? Number.MAX_SAFE_INTEGER);

  const order =
    reason === "relevance"
      ? [...pages]
          .sort((a, b) => {
            const byReservation = rank(a.page) - rank(b.page);
            if (byReservation !== 0) return byReservation;
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

/**
 * Scores a page against a cue set.
 *
 * Strong cues count PRESENCE; weak cues count frequency, capped.
 *
 * The distinction is the fix for a real defect. Counting frequency everywhere
 * meant repetition read as strength, and the pages that repeat a package name
 * are ordering tables and package-option lists, not drawings. On an
 * STM32F407VG, the two pages listing every orderable package scored 24 and 21
 * on `LQFP` alone, while `Table 93. LQFP100 - Mechanical data`, the page with
 * the actual dimensions, scored 10 and ranked fourth.
 *
 * A structural marker is not more true for being repeated: a page either
 * carries an outline code or it does not. Density is only evidence for the
 * vocabulary cues, where a page thick with millimetre talk really is more
 * likely to be the one.
 */
function cueScore(text: string, cues: Cue[]): number {
  let score = 0;
  for (const { pattern, weight } of cues) {
    if (weight >= STRONG_WEIGHT) {
      if (pattern.test(text)) score += weight;
      continue;
    }
    const matches = text.match(
      new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)
    );
    if (matches) score += Math.min(matches.length, 5) * weight;
  }
  return score;
}
