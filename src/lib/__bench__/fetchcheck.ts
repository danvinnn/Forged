/**
 * The gate a fetched PDF has to pass before it is allowed into a corpus cache.
 *
 * `bench:corpus` DETECTS a document that is not the part it is filed under. This
 * stops one being written in the first place, which is the only version of the
 * fix that holds: the three contaminated datasheets found on 2026-08-21 were
 * fetched months apart, and a detector alone means the next one sits in the
 * corpus until somebody happens to run it.
 *
 * The rules are the product's own - `looksLikeWrongDocument` and `namesThePart`
 * out of `pdftext.ts`, the same two `/api/lookup` applies to a user's fetch.
 * Nothing bench-specific, deliberately: a corpus admitting documents the product
 * would reject measures a population no user can produce.
 *
 * `looksLikeWrongDocument` is a WARNING here rather than a rejection. The
 * retrieval corpus deliberately contains vendors that publish no datasheet, and
 * whatever comes back for those is a genuine retrieval result that
 * `bench:extraction` is entitled to score as a miss. Being the wrong DEVICE is
 * different: that scores as a win.
 */

import { extractDatasheetText, looksLikeWrongDocument, namesThePart } from "../pdftext";

export type FetchVerdict =
  | { ok: true; warning?: string }
  | { ok: false; why: string };

export async function checkFetchedDatasheet(bytes: ArrayBuffer, partNumber: string): Promise<FetchVerdict> {
  let doc;
  try {
    doc = await extractDatasheetText(bytes);
  } catch (error) {
    return { ok: false, why: `no text: ${error instanceof Error ? error.message.slice(0, 80) : "unknown"}` };
  }

  if (!namesThePart(doc, partNumber)) {
    const first = (doc.pages[0]?.text ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length >= 4);
    return { ok: false, why: `document does not name ${partNumber} (reads "${(first ?? "").replace(/\s+/g, " ").slice(0, 60)}")` };
  }

  if (looksLikeWrongDocument(doc)) {
    return { ok: true, warning: "too small to be a datasheet" };
  }
  return { ok: true };
}
