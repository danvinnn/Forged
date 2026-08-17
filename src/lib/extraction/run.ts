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
    // Read once, in the pass that already had the whole document. Carried through
    // so a later package choice selects a table instead of paying for another call.
    pinTablesByPackage: second.pinTablesByPackage ?? first.pinTablesByPackage,
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

// TWO WAYS OF CHOOSING PAGES FOR THE MODEL WERE MEASURED AND REJECTED, both on
// 2026-08-17, both aimed at the datasheet's printed land pattern. Recorded so
// neither is rebuilt on the same reasoning.
//
// The premise was that the model names the package OUTLINE page while the
// printed footprint sits one page later, so the three land values were being
// asked for and never shown. The number that killed it: of 53 cached answers
// carrying both a land page and a page request, the land page was ALREADY among
// the pages the model asked for in 49.
//
//   ADDING THE PAGE AFTER each page the model named. Covered 4 of those 53 while
//   roughly doubling render cost on the 18 of 46 documents with no heading.
//
//   ADDING ANY PAGE WHOSE TEXT ANNOUNCES A LAND PATTERN. Cheaper, but measurably
//   tailored to one vendor: over 46 documents the heading pattern finds 20 of 21
//   Texas Instruments and 0 of 6 Analog Devices. Its wording names no vendor and
//   its behaviour does, which is the test RULES.md rule 4 actually applies.
//
// The heading pattern itself survives in `sections.ts`, where the focused local
// model uses it to pick the page for ONE narrow question. That is a different
// job: there it selects among pages already being sent, rather than adding cost
// to every part on a yield nobody has demonstrated.

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
  // Skipped, rather than returned from, when it asks for none.
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

  const combined = combine(first, second);

  return { ...mergeModelValues(part, doc, combined, model.name, rendered), renderedPages: rendered, lookedAtPages: rendered.length > 0 };
}


export { type ExtractionRequest };
