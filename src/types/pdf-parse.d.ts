declare module "pdf-parse" {
  import type { Buffer } from "node:buffer";

  interface PdfParseResult {
    text: string;
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: Record<string, unknown>;
    version: string;
  }

  export default function pdfParse(dataBuffer: Buffer): Promise<PdfParseResult>;
}