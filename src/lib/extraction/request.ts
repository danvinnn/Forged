import type { DatasheetText } from "../pdftext";
import type { PartRecord } from "../types";
import type { ExtractionRequest } from "./contracts";
import { unresolvedFields } from "./merge";

/**
 * Builds the request handed to a model. Air-gap safe: no networking.
 *
 * Pages are passed individually rather than as one flattened blob. That is what
 * makes a model answer citable at all: it can name the page it read a value
 * from, and `verifyCitation` can then check the claim. The previous Gemini call
 * passed `pdfParse(...).text`, which has no page boundaries, so nothing it
 * returned could ever be traced.
 */

/**
 * Size ceiling on what is sent to a model. This is a resource limit, not a
 * formatting choice: an unbounded prompt is a cost and latency bomb on the
 * cloud path and an out-of-memory risk on a local one. Truncation is recorded
 * so a partial view is visible rather than silent.
 */
const MAX_PAGES_TO_MODEL = 40;
const MAX_CHARS_PER_PAGE = 6000;
const MAX_TOTAL_CHARS = 180_000;

export function buildExtractionRequest(
  part: PartRecord,
  doc: DatasheetText,
  fileName: string,
  partNumber?: string
): ExtractionRequest | null {
  const fields = unresolvedFields(part);
  if (fields.length === 0) return null;

  const pages: ExtractionRequest["pages"] = [];
  let total = 0;

  for (const page of doc.pages.slice(0, MAX_PAGES_TO_MODEL)) {
    const text = page.text.slice(0, MAX_CHARS_PER_PAGE);
    if (total + text.length > MAX_TOTAL_CHARS) break;
    total += text.length;
    pages.push({ page: page.page, text });
  }

  if (pages.length === 0) return null;

  return { pages, fileName, partNumber, fields };
}
