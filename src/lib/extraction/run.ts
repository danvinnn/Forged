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

import { MAX_PAGES_TO_MODEL } from "./contracts";
import type { ExtractionModel, ExtractionRequest, ExtractionResult } from "./contracts";
import type { DatasheetText } from "../pdftext";
import type { PartRecord } from "../types";
import { buildExtractionRequest, withRenderedPages } from "./request";
import type { RenderedPage } from "../pagerender";
import { mergeModelValues, type MergeOutcome } from "./merge";

// One budget, defined in `contracts.ts` beside the prompt that has to state it.
const MAX_RENDERED_PAGES = MAX_PAGES_TO_MODEL;

export interface ExtractionRun extends MergeOutcome {
  /** Pages that were rendered and sent, for the review panel and the record. */
  renderedPages: number[];
  /**
   * The RENDERS themselves, so a caller that wants to show the user the page a
   * value came from does not pay to rasterise it a second time.
   *
   * Both routes rendered these pages here, kept only the page NUMBERS, and then
   * called `renderPages` again on the same pages for the review panel, each with
   * a comment saying that re-rendering a page already rasterised for the model
   * would be pure waste. It is the plainest form of "we had it and threw it
   * away", and it spent the route's own 30 second budget on every part.
   */
  renderedImages: RenderedPage[];
  /** Whether a second pass happened at all. False means the text was enough. */
  lookedAtPages: boolean;
}

/**
 * Second-pass values win over first-pass ones, EXCEPT for a pin list the first
 * pass already read.
 *
 * For a dimension, pass 2 is the same reader answering with more evidence. A
 * value guessed from a text fragment and then read off the drawing is one
 * opinion improved, not two opinions, and recording it as a disagreement would
 * put a question in front of the user that nobody needs to answer. Measured on
 * the 2026-08-17 corpus run, this is not a nicety: RHF1201's front page implies
 * `gullwing` and its package drawing on page 33 shows `straight`, and REF5025's
 * page-1 prose says 6.9mm where the drawing says 7.035mm. The drawing is right
 * both times. Pass 2 must keep winning these.
 *
 * A PIN LIST is different, and the rule for it is about WHERE pass 2 answered
 * from. `withRenderedPages` sends only the rendered pages, so pass 2 often
 * cannot see the pin table pass 1 used and answers from a pinout FIGURE
 * instead. That is not the same evidence at higher resolution, it is a
 * different and poorer source: a figure carries no electrical types and no
 * descriptions, and its labels have to be matched to positions by eye.
 *
 * So pass 2 may improve a pin list only where it cites THE SAME PAGE pass 1
 * did. Measured over the three parts where the passes disagree, and it is right
 * on all three:
 *
 *   RHF310A   both page 2   pass 2 corrects `-VCC` to `VCC-`
 *   RHF1201   6 then 5      pass 2 breaks `D11(MSB)` into `(MSB)D11`, 48 types lost
 *   LIS3DH    9 then 8      pass 2 rotates the labels one position
 *
 * Two narrower rules were tried first and measured worse, both recorded so they
 * are not retried. Holding pass 1 for EVERY field whose page was not rendered
 * scores 20/21 on pin names but drops fields-complete from 53% to 39%, because
 * pass 1 answers dimensions from front-page prose and pass 2 answers them from
 * the drawing: it re-broke RHF1201's `leadForm` back to `gullwing` and REF5025's
 * body length to the page-1 6.9mm over the drawing's 7.035mm. Always keeping
 * pass 1's pins is dominated by both, 18/20 and 49%, because it throws away
 * RHF310A's correction.
 *
 * Pass 2 still fills pins the first pass did not read at all, which is most of
 * what the pin pass is for.
 */
/**
 * Two passes' views of the same package, joined on the designator.
 *
 * Matched on a letters-and-digits key so `VQFN (RGE)` from one pass and
 * `VQFN-RGE` from the other are one package. A designator only one pass mentions
 * keeps its own entry: a document can tabulate a pinout for a package whose
 * drawing it does not print, and the reverse, and neither is a reason to drop
 * what was read.
 *
 * Field by field rather than object by object, because the halves do not
 * overlap: whichever pass answered a field is the one that could read it.
 */
function mergePackageEntries(
  first: ExtractionResult["packagesInThisDocument"],
  second: ExtractionResult["packagesInThisDocument"]
): ExtractionResult["packagesInThisDocument"] {
  if (!first && !second) return undefined;
  const key = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const byKey = new Map<string, NonNullable<ExtractionResult["packagesInThisDocument"]>[number]>();
  for (const entry of [...(first ?? []), ...(second ?? [])]) {
    const existing = byKey.get(key(entry.packageType));
    if (!existing) {
      byKey.set(key(entry.packageType), { ...entry });
      continue;
    }
    // WHICHEVER PASS COULD ACTUALLY SEE THE THING WINS, per half.
    //
    // Pass 1 has the whole document and is the authority on PIN TABLES: pass 2
    // sees only a handful of rendered pages and cannot know it is looking at a
    // partial table. Pass 2 has the drawings and is the authority on
    // DIMENSIONS, for the reason the second pass exists at all, which is that a
    // dimension line's meaning is carried by arrows and not by text.
    //
    // Written out rather than left to iteration order. The order happens to give
    // the right answer today only because pass 1 is not asked for per-package
    // dimensions, and a rule that holds by accident stops holding silently.
    const fromFirst = first?.some((row) => key(row.packageType) === key(entry.packageType))
      ? existing
      : entry;
    const fromSecond = fromFirst === existing ? entry : existing;
    const pins = fromFirst.pins ?? fromSecond.pins;
    const dimensions = { ...(fromFirst.dimensions ?? {}), ...(fromSecond.dimensions ?? {}) };
    byKey.set(key(entry.packageType), {
      packageType: existing.packageType,
      ...(pins ? { pins } : {}),
      ...(Object.keys(dimensions).length > 0 ? { dimensions } : {})
    });
  }
  return byKey.size > 0 ? [...byKey.values()] : undefined;
}

/** Exported for the tests that pin the two-pass join. */
export const combineForTest = (first: ExtractionResult, second: ExtractionResult): ExtractionResult =>
  combine(first, second);

function combine(first: ExtractionResult, second: ExtractionResult): ExtractionResult {
  const values = { ...first.values, ...second.values };
  const firstPins = first.values.pins;
  const secondPins = second.values.pins;
  if (
    firstPins !== undefined &&
    secondPins !== undefined &&
    firstPins.page !== secondPins.page &&
    !samePinNames(firstPins.value, secondPins.value)
  ) {
    values.pins = firstPins;
  }
  // A DECLINE from either pass is a decline, and it was being dropped here.
  //
  // `declined` exists to tell "the model looked and the document is silent" from
  // "nobody asked", and its own contract note names the investigation that cost:
  // `leadForm` came back empty for 37 of 81 parts because the prompt offered two
  // of the three values, and there was no way to see it. This function built a
  // result without the field, so `mergeModelValues` read `result.declined ?? []`
  // as empty on every real run and the note was never written. Only a direct
  // call to merge, which is tests, ever saw one.
  const declined = [...new Set([...(first.declined ?? []), ...(second.declined ?? [])])].filter(
    // A field pass 2 ANSWERED is not declined, whatever pass 1 said about it.
    (field) => values[field] === undefined
  );

  return {
    values,
    ...(declined.length > 0 ? { declined } : {}),
    notes: [...(first.notes ?? []), ...(second.notes ?? [])],
    // MERGED BY PACKAGE, not replaced.
    //
    // The two passes answer different halves of the same question. Pass 1 has
    // the whole text and reports each package's PIN TABLE; pass 2 has the
    // rendered drawings and reports each package's MEASUREMENTS, which is the
    // only pass that can read them. Taking pass 2's list whole, as this did,
    // threw away every pin table the moment the second half started arriving.
    packagesInThisDocument: mergePackageEntries(first.packagesInThisDocument, second.packagesInThisDocument),
    // Same reasoning as the tables above: read once, by the pass that had the
    // whole document. Pass 2 sees only the rendered pages, so it cannot know
    // which drawings the rest of the document contains and must not overwrite a
    // complete answer with a partial one.
    drawnPackages: first.drawnPackages ?? second.drawnPackages,
    usage:
      first.usage || second.usage
        ? {
            inputTokens: (first.usage?.inputTokens ?? 0) + (second.usage?.inputTokens ?? 0),
            outputTokens: (first.usage?.outputTokens ?? 0) + (second.usage?.outputTokens ?? 0)
          }
        : undefined,
    // EVERY BILLED ATTEMPT, both passes. `usage` was summed here and `attempts`
    // was dropped beside it, so a caller counting spend through `runExtraction`
    // saw undefined. That is the same under-report `attempts` was added to close:
    // a 503 retried twice is three charges and one answer.
    ...(first.attempts !== undefined || second.attempts !== undefined
      ? { attempts: (first.attempts ?? 0) + (second.attempts ?? 0) }
      : {})
  };
}

/**
 * Whether two pin lists say the same thing about the pins.
 *
 * There is nothing to choose between readings that agree, and choosing anyway
 * has a cost. MSP430F5529's pin table is not verifiable from the text layer on
 * ANY page: `locatePinTable` scans the whole document and finds nothing, so
 * pass 1's list carries no citation and `isUntraceable` refuses the export.
 * Pass 2's identical list is citable purely because page 10 was rendered and
 * sent. Preferring pass 1 there swapped a shipping part for the same answer
 * nobody could check.
 *
 * So the pass-1 preference applies only where the two actually DISAGREE. Names
 * and numbers only: pass 2 routinely drops electrical types and descriptions
 * because a figure does not carry them, and that is not a disagreement about
 * the pinout.
 */
function samePinNames(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const key = (pin: unknown) => {
    const row = pin as { number?: unknown; name?: unknown };
    return `${String(row.number ?? "")}\u0000${String(row.name ?? "")}`;
  };
  return left.every((pin, index) => key(pin) === key(right[index]));
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
  partNumber?: string,
  /**
   * How long RENDERING may take, when the caller is working to a deadline.
   *
   * The page budget was raised from 8 to 16 on 2026-08-18, and the render
   * ceiling is sized from it, so the default is now about 24 seconds. A route
   * with `maxDuration = 30` that let rendering run to that default would have
   * about six seconds left for two model calls. `renderPages` does not throw
   * when it runs out of time, it returns FEWER PAGES, so the failure would have
   * been a quietly thinner second pass rather than an error anyone could see.
   *
   * Passed by the caller that HAS a deadline rather than hardcoded low, because
   * capping it here would make the benches render fewer pages than the product
   * is capable of, and a bench that measures a product that does not exist is
   * the exact mistake `shipOutcome` was making this morning.
   */
  renderBudgetMs?: number
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
  let images: RenderedPage[] = [];
  if (pages.length > 0) {
    try {
      // Pass 1's own package answer goes with it. See `withRenderedPages`: the
      // second pass sees only the drawing pages, and a pass asked to measure a
      // package nobody has named refuses the whole document and says so.
      const chosen = typeof first.values.packageType?.value === "string" ? first.values.packageType.value : null;
      const withImages = await withRenderedPages(
        request,
        pdfBytes,
        pages,
        renderBudgetMs !== undefined ? { budgetMs: renderBudgetMs } : {},
        chosen
      );
      images = withImages.images;
      rendered = images.map((image) => image.page);
      if (rendered.length > 0) second = await model.extract(withImages);
    } catch {
      // Fall through with the first pass, which is a complete answer on its own.
    }
  }

  const combined = combine(first, second);

  return {
    ...mergeModelValues(part, doc, combined, model.name, rendered),
    renderedPages: rendered,
    renderedImages: images,
    lookedAtPages: rendered.length > 0
  };
}


export { type ExtractionRequest };
