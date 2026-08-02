import type { DatasheetText } from "../pdftext";
import type { PartRecord } from "../types";
import type { ExtractionRequest } from "./contracts";
import { unresolvedFields } from "./merge";
import { selectPages } from "./pageselect";

/**
 * Builds the request handed to a model. Air-gap safe: no networking.
 *
 * Pages are passed individually rather than as one flattened blob. That is what
 * makes a model answer citable at all: it can name the page it read a value
 * from, and `verifyCitation` can then check the claim. The previous Gemini call
 * passed `pdfParse(...).text`, which has no page boundaries, so nothing it
 * returned could ever be traced.
 *
 * Which pages go in is decided by `pageselect.ts`, on relevance to the fields
 * still missing rather than on position. That is a measured fix, not a tidy-up:
 * a real local model returns nothing usable on a whole-document prompt and
 * answers the same contract correctly on a short one.
 */

/**
 * Size ceiling on what is sent to a model.
 *
 * These are much tighter than the positional limits they replace (40 pages,
 * 180k characters), because selecting the right pages is only worth doing if
 * the budget is then small enough to matter. A model that cannot answer from
 * eight relevant pages will not be rescued by forty irrelevant ones.
 */
const MAX_PAGES_TO_MODEL = 8;
const MAX_CHARS_PER_PAGE = 6000;
const MAX_TOTAL_CHARS = 24_000;

export function buildExtractionRequest(
  part: PartRecord,
  doc: DatasheetText,
  fileName: string,
  partNumber?: string
): ExtractionRequest | null {
  const fields = unresolvedFields(part);
  if (fields.length === 0) return null;

  const selection = selectPages(doc.pages, fields, {
    maxPages: MAX_PAGES_TO_MODEL,
    maxCharsPerPage: MAX_CHARS_PER_PAGE,
    maxTotalChars: MAX_TOTAL_CHARS
  });

  if (selection.pages.length === 0) return null;

  return { pages: selection.pages, fileName, partNumber, fields, selection };
}
