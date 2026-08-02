import pdfParse from "pdf-parse";
import { decodeShiftedFonts } from "./fontdecode";

/**
 * Page and position aware text extraction.
 *
 * pdf-parse's default renderer flattens the whole document into one string and
 * throws away every coordinate, so there is no way to say which page a value
 * came from. Traceability (IPC Class 3, QML/QPL) needs exactly that, so this
 * module keeps the positional data pdf.js already hands us.
 *
 * Coordinates are PDF user space: origin at the bottom-left of the page, y
 * increasing upward. They are page-relative, not document-relative.
 */

export interface TextRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A positioned run of text, with its offset into the combined document text. */
export interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  start: number;
  end: number;
}

/**
 * Whether a run's characters are in the order they are PRINTED in.
 *
 * pdf.js reports a run's `width` as its total advance from the origin. That is
 * normally positive, because text advances rightwards. A NEGATIVE advance means
 * the glyphs were individually positioned leftwards, so the run's string is the
 * order the content stream drew them in and not the order a reader sees.
 *
 * An RHF310A prints pin 4 as `VCC-` and hands the run over as `"-VCC"` with an
 * advance of -1.1 for four characters at 12 point. Its origin, 194.7, sits at the
 * RIGHT edge of the column its three sibling names are right-aligned to, which is
 * the corroboration: the first character of the string is the last one on the
 * page. Rendering the page is what settled it.
 *
 * Nothing here tries to put such a run back in order. One sample does not
 * establish how the glyphs were placed, and a name is a netlist. Callers that
 * assemble names refuse them instead.
 *
 * Measured over the benchmark cache: 24 runs in 5 documents, and exactly one of
 * them, RHF310A's, ever reached a pin name. The rest are on mechanical drawing
 * pages, where they were already unusable.
 */
export function hasPrintedOrder(item: TextItem): boolean {
  return item.width >= 0;
}

export interface PageText {
  page: number;
  text: string;
  items: TextItem[];
  /** Offsets of this page's text within the combined document text. */
  start: number;
  end: number;
  width: number;
  height: number;
}

/** Where a value was read from, for the audit trail. */
export interface Citation {
  /** 1-indexed page number. */
  page: number;
  /** The text actually matched, normalized for display. */
  snippet: string;
  /** Bounding box in PDF user space, or null when it could not be recovered. */
  region: TextRegion | null;
}

export interface DatasheetText {
  /** All pages joined by a blank line. Regex offsets index into this. */
  text: string;
  pages: PageText[];
  pageCount: number;
  /** True when maxPages stopped rendering before the end of the document. */
  truncated: boolean;
}

export type PdfLimitKind = "pages" | "text" | "objects" | "time";

/**
 * Raised when a document exceeds a parse resource limit. Carries the specific
 * limit so the route can tell the user what was too large rather than failing
 * with a generic error.
 */
export class PdfExtractionError extends Error {
  readonly kind: PdfLimitKind;
  readonly limit: number;

  constructor(kind: PdfLimitKind, limit: number, message: string) {
    super(message);
    this.name = "PdfExtractionError";
    this.kind = kind;
    this.limit = limit;
  }
}

export interface ExtractTextOptions {
  /** Hard cap on pages rendered. Guards against page-count bombs. */
  maxPages?: number;
  /** Hard cap on total extracted characters. Guards against decompression bombs. */
  maxTextChars?: number;
  /** Hard cap on text runs on a single page. Guards against object-count bombs. */
  maxItemsPerPage?: number;
  /** Wall-clock ceiling for the whole extraction. */
  budgetMs?: number;
}

const DEFAULT_MAX_TEXT_CHARS = 5_000_000;
const DEFAULT_MAX_ITEMS_PER_PAGE = 100_000;
const DEFAULT_BUDGET_MS = 20_000;

/** Pages are joined by a blank line so page breaks read as paragraph breaks. */
const PAGE_SEPARATOR = "\n\n";

/**
 * Runs on the same text line are separated by a space when the horizontal gap
 * between them exceeds this fraction of the font size. Glyph-by-glyph PDFs emit
 * gaps near zero and must not gain spaces; genuine word breaks are wider.
 */
const SPACE_GAP_RATIO = 0.2;

/** Two runs belong to the same line when their baselines are within this many points. */
const LINE_TOLERANCE = 2;

function fontSizeOf(item: { height: number; transform: number[] }): number {
  if (item.height > 0) return item.height;
  const scaleY = Math.abs(item.transform[3] ?? 0);
  return scaleY > 0 ? scaleY : 1;
}

interface RawItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * The PDF font resource this run was drawn with. Carried only so a font with
   * a broken encoding can be identified and decoded; see fontdecode.ts. It is
   * the right unit for that because the encoding belongs to the font, and a
   * single page mixes healthy and broken fonts freely.
   */
  fontName?: string;
}

/**
 * A run is a superscript of the line below it when it is materially smaller and
 * sits only slightly above that line's baseline. Normal line spacing is roughly
 * 1.2x the font size, so a genuine preceding line rises well past this bound.
 */
const SUPERSCRIPT_MAX_HEIGHT_RATIO = 0.85;
const SUPERSCRIPT_MAX_RISE_RATIO = 0.7;

function dominantHeight(line: RawItem[]): number {
  return Math.max(...line.map((item) => item.height));
}

function topBaseline(line: RawItem[]): number {
  return Math.max(...line.map((item) => item.y));
}

/**
 * Folds superscript runs into the line they belong to.
 *
 * Superscripts sit above the baseline by more than the line tolerance, so pure
 * baseline grouping puts them on their own line. That split the "+" and "-" off
 * pin names and turned the exponent in "85MeV·cm²/mg" into a stray space. Once
 * folded back in at their x position, both read correctly with no special case
 * downstream.
 */
function mergeSuperscripts(lines: RawItem[][]): RawItem[][] {
  const out: RawItem[][] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const next = lines[index + 1];

    if (next && line.length > 0 && next.length > 0) {
      const nextHeight = dominantHeight(next);
      const rise = topBaseline(line) - topBaseline(next);
      const isSmaller = dominantHeight(line) < nextHeight * SUPERSCRIPT_MAX_HEIGHT_RATIO;
      const sitsJustAbove = rise > 0 && rise <= nextHeight * SUPERSCRIPT_MAX_RISE_RATIO;

      if (isSmaller && sitsJustAbove) {
        lines[index + 1] = [...line, ...next];
        continue;
      }
    }

    out.push(line);
  }

  return out;
}

/** Groups runs into lines by baseline, top to bottom, then left to right. */
function groupIntoLines(items: RawItem[]): RawItem[][] {
  const sorted = [...items].sort((left, right) => {
    if (Math.abs(left.y - right.y) > LINE_TOLERANCE) return right.y - left.y;
    return left.x - right.x;
  });

  const lines: RawItem[][] = [];
  let current: RawItem[] = [];

  for (const item of sorted) {
    if (current.length === 0) {
      current.push(item);
      continue;
    }
    const baseline = current[current.length - 1].y;
    if (Math.abs(item.y - baseline) <= LINE_TOLERANCE) {
      current.push(item);
    } else {
      lines.push(current);
      current = [item];
    }
  }
  if (current.length > 0) lines.push(current);

  // Fold superscripts in before ordering, so they land at their x position
  // within the line they modify rather than as a line of their own.
  return mergeSuperscripts(lines).map((line) => [...line].sort((left, right) => left.x - right.x));
}

/**
 * Renders one page's runs into text, recording each run's offset. `offset` is
 * where this page's text begins in the combined document text.
 */
function renderPage(
  raw: RawItem[],
  offset: number,
  deadline?: { at: number }
): { text: string; items: TextItem[] } {
  const items: TextItem[] = [];
  const lines = groupIntoLines(raw.filter((item) => item.str.length > 0));
  let text = "";

  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) text += "\n";

    // Checked mid-page as well as between pages: a single page dense enough to
    // blow the budget on its own must not run to completion first.
    if (deadline && lineIndex % 64 === 0 && Date.now() > deadline.at) {
      throw new PdfExtractionError("time", 0, "Parsing exceeded its time budget while rendering a page.");
    }

    line.forEach((item, itemIndex) => {
      if (itemIndex > 0) {
        const previous = line[itemIndex - 1];
        const gap = item.x - (previous.x + previous.width);
        // previous.height already holds the resolved font size.
        const threshold = previous.height * SPACE_GAP_RATIO;
        const alreadySpaced = /\s$/.test(text) || /^\s/.test(item.str);
        if (gap > threshold && !alreadySpaced) text += " ";
      }

      const start = offset + text.length;
      text += item.str;
      items.push({
        str: item.str,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        start,
        end: offset + text.length
      });
    });
  });

  return { text, items };
}

export async function extractDatasheetText(
  pdfBuffer: ArrayBuffer,
  options: ExtractTextOptions = {}
): Promise<DatasheetText> {
  const pages: PageText[] = [];
  let combined = "";

  const maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
  const maxItemsPerPage = options.maxItemsPerPage ?? DEFAULT_MAX_ITEMS_PER_PAGE;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = Date.now();

  // pdf-parse catches whatever pagerender throws and carries on to the next
  // page, so a limit cannot be enforced by throwing from inside it. Instead the
  // breach is recorded and every later page short-circuits before calling
  // getTextContent, which is the expensive step. That bounds the work; the
  // error is then raised once pdf-parse resolves.
  //
  // Residual limit, stated rather than hidden: a single call to getTextContent
  // happens inside pdf.js and cannot be interrupted, so one pathological page
  // can overshoot the budget by the cost of that call. maxItemsPerPage bounds
  // its output, and the budget is checked both between pages and while
  // rendering one, which covers the rest.
  let breach: PdfExtractionError | null = null;

  const parsed = await pdfParse(Buffer.from(pdfBuffer), {
    max: options.maxPages && options.maxPages > 0 ? options.maxPages : 0,
    pagerender: async (pageData) => {
      if (breach) return "";

      if (Date.now() - startedAt > budgetMs) {
        breach = new PdfExtractionError(
          "time",
          budgetMs,
          `Parsing exceeded the ${budgetMs}ms budget. The document is too complex to process.`
        );
        return "";
      }

      const content = await pageData.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false
      });

      if (content.items.length > maxItemsPerPage) {
        breach = new PdfExtractionError(
          "objects",
          maxItemsPerPage,
          `A page contains more than ${maxItemsPerPage} text objects.`
        );
        return "";
      }

      // Decoded BEFORE anything reads the text, so every downstream reader (pin
      // table, pin figure, package drawing) sees the recovered characters. A
      // font whose encoding is a constant offset is otherwise real, present and
      // unreadable text: LD1117 draws its whole pin configuration that way.
      const raw: RawItem[] = decodeShiftedFonts(
        content.items.map((item) => ({
          str: item.str,
          x: item.transform[4] ?? 0,
          y: item.transform[5] ?? 0,
          width: item.width ?? 0,
          height: fontSizeOf(item),
          fontName: (item as { fontName?: string }).fontName
        }))
      );

      const offset = combined.length === 0 ? 0 : combined.length + PAGE_SEPARATOR.length;

      let rendered;
      try {
        rendered = renderPage(raw, offset, { at: startedAt + budgetMs });
      } catch (error) {
        if (error instanceof PdfExtractionError) {
          breach = new PdfExtractionError(
            "time",
            budgetMs,
            `Parsing exceeded the ${budgetMs}ms budget. The document is too complex to process.`
          );
          return "";
        }
        throw error;
      }
      const { text, items } = rendered;

      if (offset + text.length > maxTextChars) {
        breach = new PdfExtractionError(
          "text",
          maxTextChars,
          `Extracted text exceeded ${maxTextChars} characters. The document may be a decompression bomb.`
        );
        return "";
      }

      const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = pageData.view ?? [];
      pages.push({
        page: pageData.pageNumber,
        text,
        items,
        start: offset,
        end: offset + text.length,
        width: Math.abs(x1 - x0),
        height: Math.abs(y1 - y0)
      });

      combined = combined.length === 0 ? text : `${combined}${PAGE_SEPARATOR}${text}`;

      // pdf-parse concatenates whatever we return; we build `combined`
      // ourselves so the offsets stay exact, so the return value is unused.
      return text;
    }
  });

  if (breach) throw breach;

  pages.sort((left, right) => left.page - right.page);

  return {
    text: combined,
    pages,
    pageCount: parsed.numpages,
    truncated: pages.length < parsed.numpages
  };
}

/**
 * Builds a DatasheetText from plain page strings, for tests and for callers
 * that already hold text. Carries no positional data, so citations resolve to a
 * page with a null region, which is exactly what an honest citation looks like
 * when the geometry is genuinely unavailable.
 */
export function datasheetTextFromPages(pageTexts: string[]): DatasheetText {
  const pages: PageText[] = [];
  let combined = "";

  pageTexts.forEach((text, index) => {
    const start = combined.length === 0 ? 0 : combined.length + PAGE_SEPARATOR.length;
    pages.push({
      page: index + 1,
      text,
      items: [],
      start,
      end: start + text.length,
      width: 0,
      height: 0
    });
    combined = combined.length === 0 ? text : `${combined}${PAGE_SEPARATOR}${text}`;
  });

  return { text: combined, pages, pageCount: pages.length, truncated: false };
}

/** Finds the page containing a character offset in the combined text. */
export function pageAt(doc: DatasheetText, index: number): PageText | null {
  for (const page of doc.pages) {
    if (index >= page.start && index <= page.end) return page;
  }
  return null;
}

function unionRegion(items: TextItem[]): TextRegion | null {
  if (items.length === 0) return null;
  const minX = Math.min(...items.map((item) => item.x));
  const maxX = Math.max(...items.map((item) => item.x + item.width));
  const minY = Math.min(...items.map((item) => item.y));
  const maxY = Math.max(...items.map((item) => item.y + item.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Builds a citation for the span [index, index + length) of the combined text.
 * Returns null when the offset does not land on a rendered page, so a caller
 * that cannot cite a value records null rather than inventing a location.
 */
export function citationAt(doc: DatasheetText, index: number, length: number): Citation | null {
  if (index < 0 || length <= 0) return null;
  const page = pageAt(doc, index);
  if (!page) return null;

  const end = index + length;
  const covering = page.items.filter((item) => item.end > index && item.start < end);
  const snippet = doc.text.slice(index, end).replace(/\s+/g, " ").trim();

  return {
    page: page.page,
    snippet,
    region: unionRegion(covering)
  };
}
