import { renderPages, type RenderLimits } from "../pagerender";
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

  const selection = selectPages(
    doc.pages,
    fields,
    {
      maxPages: MAX_PAGES_TO_MODEL,
      maxCharsPerPage: MAX_CHARS_PER_PAGE,
      maxTotalChars: MAX_TOTAL_CHARS
    },
    // What the deterministic pass already settled. On a family datasheet this is
    // what separates this part's package drawing from a sibling's.
    { packageType: part.packageType.value, pinCount: part.pinCount.value }
  );

  if (selection.pages.length === 0) return null;

  return {
    pages: selection.pages,
    images: [],
    fileName,
    partNumber,
    packageType: part.packageType.value,
    fields,
    selection
  };
}

/**
 * The same request, with the selected pages rendered.
 *
 * Separate from `buildExtractionRequest` rather than folded into it because
 * rendering needs the original PDF bytes, which `DatasheetText` does not carry,
 * and because it is the one part of building a request that can be slow. A
 * caller that has the bytes should use this; one that does not still gets a
 * valid text-only request from the function above.
 *
 * Failure to render is not failure to extract. `renderPages` returns fewer
 * pages rather than throwing, so a host with no working renderer produces
 * exactly the request it produced before images existed.
 */
export async function withRenderedPages(
  request: ExtractionRequest,
  pdfBytes: ArrayBuffer,
  limits: Partial<RenderLimits> = {}
): Promise<ExtractionRequest> {
  const images = await renderPages(
    pdfBytes,
    request.pages.map((page) => page.page),
    { maxPages: MAX_PAGES_TO_MODEL, ...limits }
  );
  return { ...request, images };
}
