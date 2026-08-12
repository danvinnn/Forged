/**
 * Renders datasheet pages to images, for the pages a model needs to SEE.
 *
 * ## Why this module exists
 *
 * The text layer of a PDF is not the page. A mechanical package drawing states
 * its dimensions as positioned glyphs beside dimension lines: `0.50 BSC` under a
 * pad row, `0.75 ±0.05` beside a side view, `TERMINAL LENGTH 0.40 ± 0.10` inside
 * a detail callout. Flattened to a string those become forty unrelated numbers,
 * which is why `bodyHeightMm` and `leadLengthMm` were extracted for 0 of 83
 * cached parts and why the text-only model pass read them no better.
 *
 * Worse than missing, the text layer can be WRONG in a way nothing downstream
 * can detect. An RHF310A prints pin 4 as `VCC-` and hands the extractor `-VCC`,
 * because the glyphs are positioned right to left with a negative advance. The
 * deterministic reader detects that and refuses (see `hasPrintedOrder` in
 * pdftext.ts). A model given the same string cannot: measured on 2026-08-03, the
 * text pass reported `-VCC` with a citation that verified, because the string
 * really is in the text layer. Given the RENDERED page it reads `VCC-`.
 *
 * So this is not an optimisation. For an entire class of values the render is
 * the only faithful view of the document.
 *
 * ## Measured, before it was written
 *
 * Six drawings across three vendors, scored against the hand-read dimensions in
 * `packages.ts`, at the 150 DPI this module defaults to:
 *
 *     INA240 PW0008A      pitch 0.65, span 6.2-6.6, width 0.19-0.30    all exact
 *     LM358 DGK0008A      pitch 0.65, span 4.75-5.05, width 0.25-0.38  all exact
 *     ADS1115 DGS0010A    pitch 0.50, width 0.17-0.27, body 3.0        all exact
 *     STM32G071RB p131    pitch 0.50, body 10.00, 64 leads             all exact
 *     LTC2400 p39         SO-8 in INCHES, converted to mm correctly    all exact
 *     RHF310A p2          all 8 pin names including `VCC-`             exact
 *
 * Two pages with no drawing on them returned "not a drawing" and all nulls, so
 * the refusal behaviour survives the change of medium.
 *
 * ## Air-gap
 *
 * MuPDF is a local library. It opens no socket and contains no URL, so this
 * module is safe on the air-gapped path and is what makes air-gapped VISION
 * extraction possible at all: the local open-weight model needs the same pixels
 * the cloud one does.
 *
 * It is reached by dynamic import for one reason: it ships a native/wasm
 * binary, and a host where that binary will not load must degrade to text-only
 * extraction rather than fail to parse the document at all. Every failure here
 * returns fewer pages, never throws.
 */

/** One rendered page, ready to hand to a model. */
export interface RenderedPage {
  /** 1-indexed, matching `DatasheetText.pages` and every citation in the record. */
  page: number;
  mimeType: "image/png";
  /** PNG bytes, base64. Both model transports want it in this form. */
  base64: string;
  widthPx: number;
  heightPx: number;
}

export interface RenderLimits {
  /**
   * Resolution. 150 gives about 1275x1650 for US Letter, which is the density
   * the accuracy above was measured at. Raising it costs tokens roughly linearly
   * in area for no measured gain; lowering it was not tested and should not be
   * assumed safe, because the values being read are 2 mm tall dimension labels.
   */
  dpi: number;
  /** Hard ceiling on pages rendered, whatever the caller asks for. */
  maxPages: number;
  /**
   * Ceiling on total PNG bytes. A pathological page (a full-page photograph, a
   * scanned document) can render to many megabytes, and the request body is not
   * the place to discover that. Pages are dropped once this is reached, in the
   * order given, so the most relevant pages survive.
   */
  maxTotalBytes: number;
  /**
   * Wall-clock ceiling. Rendering is the most expensive thing done to an
   * untrusted PDF, so it gets the same treatment as text extraction: a budget,
   * checked between pages, and a partial result rather than a hang.
   */
  budgetMs: number;
}

export const DEFAULT_RENDER_LIMITS: RenderLimits = {
  dpi: 150,
  maxPages: 8,
  maxTotalBytes: 8_000_000,
  budgetMs: 15_000
};

/**
 * Renders the given 1-indexed pages, best effort.
 *
 * Returns the pages it managed to render, in the order requested. Never throws:
 * a document that will not open, a page that will not draw and a missing native
 * binary all produce a shorter list, and the caller carries on with text.
 */
export async function renderPages(
  pdfBytes: ArrayBuffer,
  pages: number[],
  limits: Partial<RenderLimits> = {}
): Promise<RenderedPage[]> {
  const { dpi, maxPages, maxTotalBytes, budgetMs } = { ...DEFAULT_RENDER_LIMITS, ...limits };
  if (pages.length === 0) return [];

  let mupdf: typeof import("mupdf");
  try {
    mupdf = await import("mupdf");
  } catch {
    // No renderer on this host. Text-only extraction is a worse product, not a
    // broken one, so this is a degradation and not an error.
    return [];
  }

  const started = Date.now();
  const rendered: RenderedPage[] = [];
  let totalBytes = 0;

  let document: ReturnType<typeof mupdf.Document.openDocument>;
  try {
    document = mupdf.Document.openDocument(new Uint8Array(pdfBytes), "application/pdf");
  } catch {
    return [];
  }

  try {
    const pageCount = document.countPages();
    const scale = dpi / 72;

    // Deduplicated, but ORDER IS THE CALLER'S. The pages come from the model,
    // relevance, so when a budget cuts the list it must cut the least relevant
    // page rather than the last one in the document.
    for (const pageNumber of [...new Set(pages)]) {
      if (rendered.length >= maxPages) break;
      if (Date.now() - started > budgetMs) break;
      if (pageNumber < 1 || pageNumber > pageCount) continue;

      try {
        const page = document.loadPage(pageNumber - 1);
        const pixmap = page.toPixmap(
          mupdf.Matrix.scale(scale, scale),
          mupdf.ColorSpace.DeviceRGB,
          // No alpha: a package drawing is line art on white, and an alpha
          // channel is a third more bytes for nothing.
          false,
          true
        );
        const png = pixmap.asPNG();

        if (totalBytes + png.length > maxTotalBytes) continue;
        totalBytes += png.length;

        rendered.push({
          page: pageNumber,
          mimeType: "image/png",
          base64: Buffer.from(png).toString("base64"),
          widthPx: pixmap.getWidth(),
          heightPx: pixmap.getHeight()
        });
      } catch {
        // One page that will not draw must not cost the others.
        continue;
      }
    }
  } finally {
    try {
      document.destroy();
    } catch {
      // Nothing to do; the process is not holding the file open either way.
    }
  }

  return rendered;
}
