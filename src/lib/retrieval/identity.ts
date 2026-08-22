// Is the PDF we just downloaded actually the part we asked for?
//
// Air-gap safety: no network. Reads bytes we already hold.
//
// ## The hole this closes
//
// Every resolver checked exactly one thing about a candidate: that the bytes
// begin with %PDF. Nothing ever compared the DOCUMENT to the REQUEST. So a
// search-driven resolver returning the best-scoring PDF it could find would
// happily return a complete, well-formed datasheet for a different device, and
// every layer above it would do its job perfectly on the wrong chip.
//
// Measured 2026-08-21. TI retired the literature name `tps7a4700` - the symlink
// now redirects to a product-category page - so the constructed URL missed and
// the chain fell through to search, which returned TPS7A20's datasheet. It
// scored well: same vendor, same family prefix, a real PDF. Three cached corpus
// datasheets had been the wrong device for months on exactly this path, and one
// of them was in the hold-out, where it scored as a WIN.
//
// ## Why it belongs at the candidate level and not at the chain's edge
//
// A rejected candidate has to mean "try the next URL", not "this resolver
// failed". `ManufacturerResolver` tries several constructed URLs and `Scrape`
// ranks a list of search hits; rejecting at the boundary would throw away every
// remaining candidate the moment the first one was wrong, which is how a real
// hit gets lost. So each resolver calls this where it decides a candidate is a
// hit, and a rejection is reported as a MISS.
//
// The rule itself is `namesThePart` from `pdftext.ts` - the same one
// `/api/lookup` applies to whatever the user ends up with, and the same one
// `bench:corpus` audits the caches with. One rule in one place, because when
// this test was duplicated between the hold-out bench and the route they had
// already drifted apart once.

import { extractDatasheetText, namesThePart } from "../pdftext";

// Front matter only, which is all `namesThePart` looks at anyway. Parsing two
// pages of a 40-page datasheet keeps this off the chain's 12s budget; parsing
// the whole thing for every candidate would not.
//
// Measured 2026-08-21 on four real cached datasheets of 2.2 to 5.0 MB:
// 21, 44, 45 and 248 ms. Against a 12s chain budget and a 30s per-candidate
// download timeout that is noise, and it only runs on candidates that already
// returned real PDF bytes.
const PAGES_TO_READ = 2;

/**
 * True when the document identifies itself as the requested part, or when we
 * cannot tell.
 *
 * **Unreadable means ACCEPT, deliberately.** A PDF whose text layer will not
 * parse is common and legitimate - scanned rad-hard datasheets are the whole
 * reason the renderer exists downstream - and refusing those would turn a
 * reading limitation into a retrieval failure, losing documents the extractor
 * can still handle from the rendered page. This check exists to catch a
 * confident wrong answer, not to demand a readable one.
 */
export async function documentNamesPart(bytes: ArrayBuffer, partNumber: string): Promise<boolean> {
  try {
    const doc = await extractDatasheetText(bytes, { maxPages: PAGES_TO_READ });
    return namesThePart(doc, partNumber, PAGES_TO_READ);
  } catch {
    return true;
  }
}
