import { findPackageDrawing, type PackageDrawing } from "./packagedrawing";
import { findUnreadableFootprint, findVendorLandPattern } from "./vendorland";
import { collectReviewItems, reviewPages, type ReviewItem } from "./review";
import { renderPages, type RenderedPage } from "./pagerender";
import { packageOptions, type PackageChoice, type RequiredInput } from "./exporters";
import { confidenceChecks, type ConfidenceCheck } from "./confidence";
import { resolveForExport, type PartRecord } from "./types";
import type { DatasheetText } from "./pdftext";

/**
 * Everything a person needs to act on a reading, beside the record itself.
 *
 * ## Why this is a module and not a block inside a route
 *
 * Two routes read a datasheet and answer about it. `/api/parse` takes an upload
 * and `/api/lookup` resolves a part number, and past the point where the bytes
 * are in hand they are the same operation. Only `/api/parse` did the second
 * half.
 *
 * Measured 2026-08-16 by reading both handlers: `/api/lookup` returned the bare
 * record. No package chooser, no confidence checks, no review panel, no rendered
 * pages, and no repair of `vendorLandPattern`. The UI's `absorb` then blanked
 * all of them, so a looked-up part reached the user with the questions answered
 * and none of the answers shown.
 *
 * The worst of it is not cosmetic. `resolveForExport` refuses a model value with
 * no citation, and confirming one in the REVIEW PANEL is the only thing that
 * clears it. With no review panel there is no way to confirm, so a looked-up
 * part carrying an uncited geometry value could not be exported at all, by any
 * route the user has.
 *
 * Extracting rather than copying, because a second copy is how the two drifted
 * in the first place: `findPackageDrawing` was added to one handler, then the
 * `vendorLandPattern` repair beside it, and the other never got either.
 *
 * Air-gap safe: renders and reads local bytes, makes no request.
 */
export interface Readout {
  /** The record, with anything this pass could repair already applied. */
  part: PartRecord;
  packageDrawing: PackageDrawing | null;
  packageChoice: PackageChoice;
  checks: ConfidenceCheck[];
  review: ReviewItem[];
  /** Pages the panel shows: every page a question or a review item points at. */
  reviewPages: RenderedPage[];
}

/** How many pages may be rasterised for the panel. Images are the expensive part. */
const MAX_PANEL_PAGES = 8;

export async function buildReadout(
  part: PartRecord,
  doc: DatasheetText,
  pdfBytes: ArrayBuffer,
  /**
   * Pages the extraction pass already rasterised, so the panel does not pay to
   * render a page twice. Empty is fine and simply means everything is rendered
   * here.
   */
  alreadyRendered: readonly RenderedPage[] = []
): Promise<Readout> {
  // Where the mechanical drawing is, so a value we could not read can be asked
  // for with that page in front of the user. Nothing is READ off the drawing
  // here; this is only its location.
  const packageDrawing = findPackageDrawing(doc, part.packageType.value ?? undefined);

  // WHERE THE PRINTED FOOTPRINT IS, for the package the READING settled on.
  //
  // Has to happen after the model, not in `buildPartRecord`, where the only
  // package name in existence is one the user clicked. On the ordinary path
  // nothing was found there and two things went wrong at once: the land-pattern
  // questions had no page, so the UI fell back to showing the package OUTLINE,
  // which dimensions the body and not the lands; and `contradictsPrintedLand`
  // received null and returned false for every part, so the check that catches a
  // correct-inputs-wrong-lead-form footprint never ran.
  //
  // A package the CALLER named still wins: their choice is a statement, and an
  // inference must not overwrite it.
  let resolved = part;
  if (!resolved.vendorLandPattern && resolved.packageType.value) {
    const printed = findVendorLandPattern(doc, resolved.packageType.value);
    if (printed) {
      resolved = {
        ...resolved,
        vendorLandPattern: {
          page: printed.page,
          valuesMm: printed.dimensions.map((dimension) => dimension.valueMm)
        }
      };
    } else {
      // A DRAWING WE CAN SEE BUT CANNOT READ, which is a different answer from
      // no drawing, and the user can act on it.
      //
      // The callout reader above is built on TI's conventions: a heading reading
      // `LAND PATTERN EXAMPLE` and reference dimensions in parentheses. ST
      // prints the same information as `Figure 48. LQFP64 - Footprint example`
      // with bare numbers, which it cannot parse.
      //
      // `findUnreadableFootprint` was written to stop us telling a user their
      // datasheet prints no footprint when it prints one on a numbered page. Its
      // only caller was `crossCheckLandPattern`, which nothing has called since
      // the family table was deleted, so the promise was never kept: the refusal
      // in `askForLandPattern` says verbatim "This datasheet does not print a
      // recommended footprint", which is the exact sentence the function exists
      // to prevent.
      //
      // Recorded with NO values, which is what we actually know. Everything that
      // reads the callouts guards on the list being non-empty
      // (`contradictsPrintedLand` returns false for it, so nothing is vetoed by
      // a drawing we could not read), and everything that wants the PAGE gets
      // it. The field already means "where this datasheet prints its footprint,
      // plus whatever callouts we could read off it", and this is that page with
      // none of them.
      const unreadable = findUnreadableFootprint(doc, resolved.packageType.value);
      if (unreadable !== null) {
        resolved = { ...resolved, vendorLandPattern: { page: unreadable, valuesMm: [] } };
      }
    }
  }

  // What clicking each offered package would actually do. Computed here, where
  // the record is complete, because the chooser is shown before any export is
  // attempted and a dropdown that cannot say which of its entries work is the
  // failure `packageOptions` exists to end. It runs the real generator, so it
  // costs one footprint build per package and can never disagree with the export.
  const packageChoice = packageOptions(resolved);

  // What the record checks out against, from evidence already in hand. Runs on
  // the resolved projection because every check is about geometry, and a record
  // too incomplete to resolve has nothing to check yet.
  const forChecks = resolveForExport(resolved);
  const checks: ConfidenceCheck[] = forChecks.ok ? confidenceChecks(forChecks.part) : [];

  // WHERE TO LOOK, attached to every question that has an answer in the document.
  //
  // The exporter fills the page for a land-pattern ask, because the record knows
  // which page the printed footprint is on. Everything else it asks for is on the
  // package outline, and only this pass knows where that is.
  //
  // Deliberately not applied to `formedLeadSpanMm`. No datasheet contains it, so
  // pointing at a page would be a lie about where to look, and the exporter
  // leaves its page null for exactly that reason.
  const withPages = (needs: RequiredInput[]): RequiredInput[] =>
    needs.map((need) =>
      need.page || need.field === "formedLeadSpanMm" || !packageDrawing
        ? need
        : { ...need, page: packageDrawing.page, pageLabel: "Package outline drawing" }
    );
  const located: PackageChoice = packageChoice.ok
    ? { ok: true, options: packageChoice.options.map((option) => ({ ...option, needs: withPages(option.needs) })) }
    : packageChoice;

  const review = collectReviewItems(resolved);

  // Every page the user might be shown: the ones review cites, plus the ones the
  // questions point at, plus the drawing. Rendered together because a second
  // endpoint would have to re-retrieve the document to rasterise one page, which
  // on the commercial path means fetching a vendor PDF again to answer something
  // answerable now.
  const asked = located.ok
    ? located.options
        .flatMap((option) => option.needs.map((need) => need.page))
        .filter((page): page is number => Boolean(page))
    : [];
  const wanted = [
    ...new Set([...reviewPages(review), ...asked, ...(packageDrawing ? [packageDrawing.page] : [])])
  ];

  const have = new Map(alreadyRendered.map((image) => [image.page, image]));
  const missing = wanted.filter((page) => !have.has(page));
  // Only the pages nothing has rasterised yet. A renderer failure degrades the
  // panel to page numbers without pictures, which is still better than nothing,
  // so this is never allowed to fail the request.
  const extra =
    missing.length > 0 ? await renderPages(pdfBytes, missing, { maxPages: Math.min(missing.length, MAX_PANEL_PAGES) }) : [];
  for (const image of extra) have.set(image.page, image);

  return {
    part: resolved,
    packageDrawing,
    packageChoice: located,
    checks,
    review,
    reviewPages: wanted.map((page) => have.get(page)).filter((image): image is RenderedPage => Boolean(image))
  };
}
