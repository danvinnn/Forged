import { renderPages, type RenderLimits } from "../pagerender";
import type { DatasheetText } from "../pdftext";
import type { PartRecord } from "../types";
import { extractionFields, type ExtractionRequest, type PageSelection } from "./contracts";
import { unresolvedFields } from "./merge";

/**
 * The packages this document names, as the record already recorded them.
 *
 * `packageVariants` is used rather than a fresh scan because the scan has
 * already happened: `buildPartRecord` runs it once, preferring the vendor's own
 * ordering table where the document has one, which is the only source here that
 * can tell this part's packages from its siblings'.
 *
 * NOT narrowed to the packages that fit this part. This said it was, and nothing
 * has narrowed it since the deterministic parser was deleted on 2026-08-14; the
 * claim was a leftover describing a filter that used to exist. It cannot be true
 * at this point in any case: the narrowing it described needs a pin count, and
 * the whole reason this request is being built is that the pin count is one of
 * the things nobody has read yet.
 *
 * So this is the list of packages the document NAMES, and that is all it claims
 * to be. The model is told they are candidates from the document rather than
 * answers, and is told to refuse where the part number does not decide between
 * them.
 *
 * Capped, because this is prompt text and a family datasheet can name a dozen.
 * The front-matter ones come first: a package printed on page 1 is the one the
 * document is about, and the tail is siblings and ordering-table rows.
 */
const MAX_PACKAGE_CANDIDATES = 8;

function candidateDesignators(part: PartRecord): string[] | undefined {
  const ranked = [...part.packageVariants].sort(
    (left, right) => Number(right.inFrontMatter) - Number(left.inFrontMatter)
  );
  const seen = new Set<string>();
  for (const variant of ranked) {
    if (seen.size >= MAX_PACKAGE_CANDIDATES) break;
    seen.add(variant.designator);
  }
  // One candidate is not a choice, and zero is nothing to say.
  return seen.size > 1 ? [...seen] : undefined;
}

/**
 * Every page, in order, up to the safety ceiling.
 *
 * Truncation drops WHOLE PAGES from the end rather than trimming each page to a
 * character budget, which is what the old per-page cap did. A half page is worse
 * than no page: it can cut a pin table in the middle, and the model then reads a
 * complete-looking table that is missing its last rows.
 */
function wholeDocument(doc: DatasheetText): PageSelection {
  const totalPages = doc.pages.length;
  const totalChars = doc.pages.reduce((sum, page) => sum + page.text.length, 0);

  if (totalChars <= MAX_TOTAL_CHARS) {
    return {
      pages: doc.pages.map((page) => ({ page: page.page, text: page.text })),
      reason: "whole-document",
      totalPages,
      totalChars
    };
  }

  const pages: Array<{ page: number; text: string }> = [];
  let used = 0;
  for (const page of doc.pages) {
    if (used + page.text.length > MAX_TOTAL_CHARS) break;
    pages.push({ page: page.page, text: page.text });
    used += page.text.length;
  }
  return { pages, reason: "truncated", totalPages, totalChars };
}

/**
 * Builds the request handed to a model. Air-gap safe: no networking.
 *
 * Pages are passed individually rather than as one flattened blob. That is what
 * makes a model answer citable at all: it can name the page it read a value
 * from, and `verifyCitation` can then check the claim. The previous Gemini call
 * passed `pdfParse(...).text`, which has no page boundaries, so nothing it
 * returned could ever be traced.
 *
 * Every page goes in; see the note on the ceiling below for why selection was
 * removed rather than tuned.
 */

/**
 * The WHOLE document goes to the model. Measured 2026-08-11, across all 85
 * cached datasheets:
 *
 * ```
 * largest document   STM32H743ZI, 357pp, 569k chars  ~142k tokens
 * median document              39pp,  68k chars   ~17k tokens
 * model accepts                              1,048,576 tokens
 * what we used to send                            ~6k tokens
 * ```
 *
 * Every datasheet in the corpus fits whole, with seven times headroom on the
 * worst one, and we were sending 0.6% of capacity.
 *
 * Page selection was not wrong when it was written. It was built for a local
 * `qwen2.5:1.5b`, which returns nothing usable on a long prompt, and the note in
 * the deleted `pageselect.ts` said so. Nobody revisited it when the model became a
 * million-token one, so a workaround for a constraint that no longer exists went
 * on quietly deciding which 8 of 357 pages the model was allowed to see, ranked
 * by the deterministic parser's own opinion. It cost whole parts: TS922 and
 * TSZ121 both had their pinout on a page that was never sent, and the model said
 * so in its notes.
 *
 * The ceiling below is a safety rail for a pathological document, not a budget.
 * At roughly four characters per token it is about 500k tokens, three and a half
 * times the largest datasheet we have and half the model's limit. A document
 * that exceeds it is TRUNCATED and says so, rather than being silently sampled.
 */
const MAX_TOTAL_CHARS = 2_000_000;

/**
 * Rendered pages are still capped, and for a real reason rather than an obsolete
 * one: an image costs far more than the text of the same page, and most pages
 * have nothing to look at. Which pages get rendered is chosen by the MODEL in a
 * second pass; see `pagesWorthRendering` in the contract.
 */
const MAX_PAGES_TO_MODEL = 8;

export function buildExtractionRequest(
  part: PartRecord,
  doc: DatasheetText,
  fileName: string,
  partNumber?: string
): ExtractionRequest | null {
  const unresolved = unresolvedFields(part);

  // Asked about the GAPS, and only the gaps.
  //
  // This asked about every field for a while, so that a model answer could be
  // compared against the deterministic parser's and a confidently wrong reading
  // become visible. That comparison is gone with the parser: the only fields
  // still arriving filled are the ones the USER supplied, `mergeModelValues`
  // will not overwrite those, and asking about them buys an answer that is
  // discarded on arrival. See the note above `alreadyAnswered` in `merge.ts`.
  //
  // Kept as a filter over `extractionFields` rather than using `unresolved`
  // directly, because the contract's order is what the prompt is written in.
  const fields = extractionFields.filter((field) => unresolved.includes(field));
  if (fields.length === 0) return null;

  const selection = wholeDocument(doc);
  if (selection.pages.length === 0) return null;

  return {
    pages: selection.pages,
    images: [],
    fileName,
    // Falls back to the part number the RECORD carries, which the text pass read
    // off the front page with a citation.
    //
    // Without this the caller had to supply one, and the benches and the parse
    // route did not, so the prompt's "the requested part number is X, data for
    // other devices is not relevant" line was omitted entirely. On a datasheet
    // covering ONE device that costs nothing. On a family datasheet it is the
    // whole question: OPA2189's document is 58 pages covering OPA189, OPA2189
    // and OPA4189, page 5 prints `Pin Functions: OPA189` above `Pin Functions:
    // OPA2189`, and a model never told which device to read took the first one
    // and returned the single op-amp's pinout for the dual. That is the right
    // answer to the question it was asked, which is what made it hard to see.
    partNumber: partNumber ?? part.partNumber.value ?? undefined,
    packageType: part.packageType.value,
    // ALWAYS sent, not only when nothing was settled.
    //
    // While the resolved package was an instruction, naming alternatives beside
    // it would have reintroduced the ambiguity it existed to remove. Now that it
    // is a suggestion the model may reject, the model needs to see what it can
    // reject it IN FAVOUR OF, and the list is the document's own.
    packageCandidates: candidateDesignators(part),
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
  /**
   * Which pages to render. Named by the MODEL after it has read the text, which
   * is the whole point of the second pass: it has seen the document and knows
   * where the drawings are, and nothing else in the system does.
   *
   * Defaulting to `request.pages` would now mean "the first eight pages of the
   * document", since the request carries all of them. That is worse than the
   * selection it replaced, so the pages are required rather than defaulted.
   */
  pages: readonly number[],
  limits: Partial<RenderLimits> = {}
): Promise<ExtractionRequest> {
  if (pages.length === 0) return { ...request, images: [], pages: [] };
  const images = await renderPages(pdfBytes, [...pages], { maxPages: MAX_PAGES_TO_MODEL, ...limits });

  // The second pass carries ONLY the pages being looked at, not the document
  // again. The model read the whole text in the first pass and is now being
  // asked to read arrows off a drawing; resending 16k tokens it has already seen
  // doubled the input cost of every part with a second pass and bought nothing.
  //
  // The text of those pages still goes, because it is the drawing's own callouts
  // and captions, and because a page claim is checked against the document
  // server-side regardless of what was sent.
  const shown = new Set(images.map((image) => image.page));
  return { ...request, images, pages: request.pages.filter((page) => shown.has(page.page)) };
}
