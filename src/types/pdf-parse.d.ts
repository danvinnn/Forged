declare module "pdf-parse" {
  import type { Buffer } from "node:buffer";

  /**
   * A single positioned run of text from pdf.js. `transform` is a 6-element
   * affine matrix; elements 4 and 5 are the x and y of the run's origin in PDF
   * user space (origin bottom-left, y increasing upward).
   */
  interface PdfTextItem {
    str: string;
    dir?: string;
    width: number;
    height: number;
    transform: number[];
    fontName?: string;
  }

  interface PdfTextContent {
    items: PdfTextItem[];
  }

  interface PdfTextContentOptions {
    normalizeWhitespace?: boolean;
    disableCombineTextItems?: boolean;
  }

  interface PdfPageProxy {
    pageNumber: number;
    /** [x0, y0, x1, y1] media box in PDF user space. */
    view: number[];
    getTextContent(options?: PdfTextContentOptions): Promise<PdfTextContent>;
  }

  interface PdfParseOptions {
    /**
     * Overrides the default page renderer. The default one discards all
     * positional data and concatenates same-line runs with no separator, which
     * is why words run together. Supply your own to keep coordinates.
     */
    pagerender?: (pageData: PdfPageProxy) => Promise<string> | string;
    /** Maximum pages to render. 0 or less means every page. */
    max?: number;
    version?: string;
  }

  interface PdfParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: Record<string, unknown>;
    version: string;
  }

  export default function pdfParse(dataBuffer: Buffer, options?: PdfParseOptions): Promise<PdfParseResult>;
}
