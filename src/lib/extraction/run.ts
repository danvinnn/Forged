// The extraction pipeline, in one place.
//
// Before this, the parse route and both benches each repeated the same four
// steps by hand: build a request, render some pages, call the model, merge. They
// drifted, and the drift was expensive. The vendor land-pattern guard was wired
// into the route and not into `extractPartRecord`, so the bench shipped an
// ADS1115 footprint the route would have refused. A pipeline that exists as a
// convention rather than as a function will do that again.
//
// ## Two passes, and why
//
// PASS 1 sends the WHOLE document as text and nothing else. Everything that can
// be read from text is read here, and the model also names the pages it wants to
// LOOK at.
//
// PASS 2 renders only those pages and asks again. A mechanical drawing states
// its dimensions as labels beside dimension lines, and which dimension a label
// belongs to is carried by the arrows, which are graphics. The text layer has
// the numbers without what they measure, so those values are unreadable from
// text and readable from a render.
//
// The model chooses the pages. Every previous attempt to choose them for it lost
// whole parts: TS922 and TSZ121 both had their pinout on a page that was never
// sent, and the model said so in its own notes.
//
// Air-gap safe: no networking here. The model is injected.

import type { ExtractionModel, ExtractionRequest, ExtractionResult } from "./contracts";
import type { DatasheetText } from "../pdftext";
import type { PartRecord } from "../types";
import { buildExtractionRequest, withRenderedPages } from "./request";
import { mergeModelValues, type MergeOutcome } from "./merge";

/** How many pages a model may ask to have rendered. Images are the expensive part. */
const MAX_RENDERED_PAGES = 8;

export interface ExtractionRun extends MergeOutcome {
  /** Pages that were rendered and sent, for the review panel and the record. */
  renderedPages: number[];
  /** Whether a second pass happened at all. False means the text was enough. */
  lookedAtPages: boolean;
}

/**
 * Second-pass values win over first-pass ones for the same field.
 *
 * Not a conflict: it is the same reader answering the same question with more
 * evidence. A dimension guessed from a text fragment and then read off the
 * drawing is not two opinions, it is one opinion improved, and recording it as a
 * disagreement would put a question in front of the user that nobody needs to
 * answer.
 */
function combine(first: ExtractionResult, second: ExtractionResult): ExtractionResult {
  return {
    values: { ...first.values, ...second.values },
    notes: [...(first.notes ?? []), ...(second.notes ?? [])],
    usage:
      first.usage || second.usage
        ? {
            inputTokens: (first.usage?.inputTokens ?? 0) + (second.usage?.inputTokens ?? 0),
            outputTokens: (first.usage?.outputTokens ?? 0) + (second.usage?.outputTokens ?? 0)
          }
        : undefined
  };
}

/** Pages the model asked for, cleaned: real page numbers, in order, no repeats, capped. */
function requestedPages(result: ExtractionResult, doc: DatasheetText): number[] {
  const exists = new Set(doc.pages.map((page) => page.page));
  const asked = result.pagesWorthRendering ?? [];
  const clean = [...new Set(asked)]
    .filter((page) => Number.isInteger(page) && exists.has(page))
    .sort((left, right) => left - right);
  return clean.slice(0, MAX_RENDERED_PAGES);
}

/**
 * Runs extraction end to end and returns the merged record.
 *
 * Throws whatever the model throws. A model failure must never cost the caller
 * the deterministic record it already has, and every caller already handles that
 * by keeping the record it passed in.
 */
export async function runExtraction(
  part: PartRecord,
  doc: DatasheetText,
  pdfBytes: ArrayBuffer,
  model: ExtractionModel,
  fileName: string,
  partNumber?: string
): Promise<ExtractionRun | null> {
  const request = buildExtractionRequest(part, doc, fileName, partNumber);
  if (!request) return null;

  // Pass 1: the whole document, as text.
  const first = await model.extract(request);

  // Pass 2: the pages it asked to see.
  //
  // Skipped, rather than returned from, when it asks for none. It used to return
  // here, and that was a defect: a model that refuses the pin table AND wants no
  // drawing rendered would never reach the pin question below, which is exactly
  // the shape of the parts that question exists to rescue.
  //
  // A render failure is not an extraction failure. `renderPages` returns fewer
  // pages rather than throwing, and a host with no working renderer produces
  // exactly the first-pass answer, which is a supported deployment rather than
  // an error.
  const pages = requestedPages(first, doc);
  let second: ExtractionResult = { values: {} };
  let rendered: number[] = [];
  if (pages.length > 0) {
    try {
      const withImages = await withRenderedPages(request, pdfBytes, pages);
      rendered = withImages.images.map((image) => image.page);
      if (rendered.length > 0) second = await model.extract(withImages);
    } catch {
      // Fall through with the first pass, which is a complete answer on its own.
    }
  }

  let combined = combine(first, second);

  // Pass 3: the pin table, asked ALONE on the page the model said it was on.
  //
  // Only when the two passes above left `pins` unanswered, which is not an edge
  // case: measured on 2026-08-13 over 14 parts, asking the whole document for
  // pins produced an answer on 2 of them. The other 12 were REFUSALS, and the
  // model gave its reason each time, e.g. INA240: "available in both TSSOP-8
  // (PW) and SOIC-8 (D) packages, which have differing pin assignments". A
  // document offering several packages has several pinouts, and the model is
  // told not to guess between them, so it correctly declines.
  //
  // One page does not have that ambiguity, because one page is one package's
  // pin table. The same model, same prompt, asked about a single page, answered
  // 10 of 13 exactly against the hand-read oracle, including SN65HVD230, which
  // the whole-document pass got WRONG rather than merely missing.
  //
  // So this is a coverage fix that happens to be cheap, not a cost optimisation:
  // ~1,700 input and ~470 output tokens, against ~21,000 and ~940 for a
  // whole-document pass.
  //
  // The page comes from the MODEL, never from a locator. Two attempts to find it
  // any other way both failed on this same corpus: a heading regex sent AD590 to
  // a mechanical drawing, and `pagesWorthRendering` sent INA240 to one, because
  // that list means "render these", not "the pinout is here".
  // Taken from the FIRST pass, not from `combined`. `combine` keeps values,
  // notes and usage and drops everything else, and the page request is only ever
  // asked on pass 1, so reading it off the combined result would silently find
  // nothing and this pass would never fire.
  const pinPages = pinTablePages(first, doc);
  if (combined.values.pins === undefined && pinPages.length > 0 && request.fields.includes("pins")) {
    try {
      const third = await model.extract({
        ...request,
        fields: ["pins", "pinCount"].filter((field) =>
          request.fields.includes(field as (typeof request.fields)[number])
        ) as typeof request.fields,
        images: [],
        pages: request.pages.filter((page) => pinPages.includes(page.page))
      });
      // Fills gaps only. A narrow answer must not displace one the wider passes
      // already gave, because they saw the whole document and this one did not.
      combined = combine(third, combined);
    } catch {
      // A refused or failed pin question costs nothing already read.
    }
  }

  return { ...mergeModelValues(part, doc, combined, model.name, rendered), renderedPages: rendered, lookedAtPages: rendered.length > 0 };
}

/**
 * Pin-table pages the model named, filtered to pages the document really has.
 *
 * Capped, because this feeds a request: a model that answers with fifty pages
 * would otherwise rebuild the whole-document question this pass exists to avoid.
 */
const MAX_PIN_TABLE_PAGES = 3;

function pinTablePages(result: ExtractionResult, doc: DatasheetText): number[] {
  const exists = new Set(doc.pages.map((page) => page.page));
  return [...new Set(result.pinTablePages ?? [])]
    .filter((page) => Number.isInteger(page) && exists.has(page))
    .sort((left, right) => left - right)
    .slice(0, MAX_PIN_TABLE_PAGES);
}

export { type ExtractionRequest };
