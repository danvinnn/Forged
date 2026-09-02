// Last-resort commercial fallback: search-engine scraping plus hardcoded manufacturer URL
// patterns. This is the old MVP retrieval approach, refactored to sit behind the resolver
// interface and demoted below the manufacturer-direct resolver. It is brittle across vendors and rate-limit
// prone; it exists only so the commercial path still returns something when the API misses.
//
// NETWORK MODULE. Only ever loaded through the commercial branch of makeResolver. Never
// imported in air-gapped mode.
//
// Refactored from the previous src/lib/datasheet-web.ts. The parsing step that file used to
// do is gone: a resolver's job ends at the downloaded PDF bytes (Layer 1). Parsing is Layer 2.

import type { DatasheetRef, DatasheetResolver, ResolveOptions } from "../resolver";
import { SearchClient } from "./search";
import { finalizeRef } from "../ref";
import { documentNamesPart } from "../identity";
import { PdfValidationError } from "../pdf";
import { ResolverError } from "./errors";
import {
  fetchWithTimeout,
  readBodyWithLimit,
  BlockedUrlError,
  ResponseTooLargeError,
  SEARCH_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS
} from "./http";
import { buildPartVariants, normalizePartNumber } from "../partnumber";
import { buildProductPageUrls } from "./manufacturer";
import { logger } from "../logging";

/**
 * How many PDF links to try on one scraped page.
 *
 * A page we did not write decides what this server connects to, so the number of
 * connections it can cause has to be ours. Eight is well past what a real
 * datasheet landing page carries and far short of what a link farm does.
 */
const MAX_PDF_LINKS_PER_PAGE = 8;

/**
 * Ceiling on links harvested from one page BEFORE ranking.
 *
 * Distinct from the cap above and needed because of it: ranking has to see the whole list to pick
 * the best eight out of it, so the list itself now needs its own bound. A real vendor product page
 * carries tens of PDF links (Microchip's ATMEGA328P page has 92); a link farm carries thousands.
 */
const MAX_PDF_LINKS_HARVESTED = 200;

const userAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Forge/1.0";

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isTexasInstruments(manufacturer?: string): boolean {
  if (!manufacturer) return false;
  const normalized = manufacturer.trim().toLowerCase();
  return normalized.includes("texas instruments") || normalized === "ti" || normalized.includes("ti ");
}

function buildSearchQueries(partNumber: string, manufacturer?: string): string[] {
  const variants = buildPartVariants(partNumber);
  const normalizedPart = variants[0];
  const queries = [
    `${normalizedPart} datasheet pdf`,
    `${normalizedPart} filetype:pdf`,
    `${normalizedPart} PDF`
  ];

  for (const variant of variants.slice(1)) {
    queries.push(`${variant} datasheet pdf`, `${variant} filetype:pdf`);
  }

  if (manufacturer) {
    queries.unshift(`${manufacturer} ${normalizedPart} datasheet pdf`, `${manufacturer} ${normalizedPart} pdf`);
  }

  if (isTexasInstruments(manufacturer)) {
    queries.unshift(
      `site:ti.com ${normalizedPart} datasheet`,
      `site:ti.com/lit ${normalizedPart} pdf`,
      `ti ${normalizedPart} datasheet pdf`
    );
    for (const variant of variants.slice(1)) {
      queries.unshift(`site:ti.com ${variant} datasheet`, `ti ${variant} datasheet pdf`);
    }
  }

  return [...new Set(queries.map(normalizeText))];
}

// Known hosts that serve datasheet PDFs at a stable path. Distributors matter here for a specific
// reason discovered on 2026-07-22: the pure-play rad-hard vendors do not publish datasheets on
// their own websites at all. VORAGO's documentation index lists white papers, app notes, tech
// briefs, and PCNs, but zero datasheets; the product page routes you to a sales contact. The only
// public copies of VA10820_DS_12.pdf are distributor-hosted. So for exactly the parts that define
// this product, a distributor-hosted PDF is the ONLY reachable source, and reading a PDF a
// distributor serves publicly to any browser needs no API key and no terms acceptance.
const DATASHEET_HOSTS = [
  "ti.com",
  "st.com",
  "analog.com",
  "microchip.com",
  "renesas.com",
  "infineon.com",
  "onsemi.com",
  "nxp.com",
  "vishay.com",
  "nexperia.com",
  "diodes.com",
  "rohm.com",
  "toshiba.com",
  "mouser.com",
  "digikey.com",
  "arrow.com",
  "farnell.com",
  "rs-online.com"
];

function buildDirectCandidates(partNumber: string, manufacturer?: string): string[] {
  const candidates = new Set<string>();
  const variants = buildPartVariants(partNumber);
  const upperPart = variants[0];

  if (isTexasInstruments(manufacturer) || /^INA|^LM|^LMP|^TPS|^TLV/i.test(upperPart)) {
    for (const variant of variants) {
      const lowerPart = variant.toLowerCase();
      candidates.add(`https://www.ti.com/lit/ds/symlink/${lowerPart}.pdf`);
      candidates.add(`https://www.ti.com/lit/gpn/${lowerPart}`);
      candidates.add(`https://www.ti.com/product/${variant}`);
    }
  }

  // Mouser serves datasheets from a flat, part-named path and is the observed public host for
  // orphan rad-hard datasheets. Cheap to try: one GET that 404s harmlessly when the guess is wrong,
  // and the %PDF check in finalizeRef catches anything that is not really a PDF.
  for (const variant of variants) {
    candidates.add(`https://www.mouser.com/pdfdocs/${variant}.pdf`);
  }

  // Vendor PRODUCT PAGES, last among the direct candidates because they are the expensive ones: a
  // page fetch, a parse, then up to eight downloads, versus one GET that either is a PDF or is not.
  //
  // They belong HERE rather than in the manufacturer resolver because this is the only place that
  // knows what to do with an HTML answer. `inspectCandidate` already fetches a URL, harvests its
  // PDF links, ranks them and tries the best. So a vendor that files its datasheets under document
  // numbers needs no new code path at all, only a page to point at. See `manufacturer.ts`.
  for (const url of buildProductPageUrls(partNumber, manufacturer)) {
    candidates.add(url);
  }

  return [...candidates];
}

/**
 * Every PDF this page points at.
 *
 * TWO SCANS, because one of them was missing an entire class of page. The href scan finds links in
 * markup and is the only one that can resolve a RELATIVE path, so it stays. But a modern vendor
 * page renders its document list from embedded JSON, and those URLs are never inside an `href`
 * attribute. Microchip's ATMEGA328P page is the standing example: it carries 92 PDF URLs and
 * ZERO of them are in an href, so the harvester returned nothing and the part was reported as
 * having no datasheet. The second scan takes absolute PDF URLs from anywhere in the body.
 *
 * Bounded, like every other reach in this file. A hostile or link-farm page must not be able to
 * hand us an unbounded list to score and slice.
 */
function extractPdfLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>();

  const add = (value: string) => {
    if (links.size >= MAX_PDF_LINKS_HARVESTED) return;
    try {
      links.add(new URL(value, baseUrl).href);
    } catch {
      // Not a URL we can resolve. Skip it rather than abort the page.
    }
  };

  for (const match of html.matchAll(/href="([^"]+)"/gi)) {
    const href = match[1].replace(/&amp;/g, "&");
    if (!/\.pdf(\?|#|$)/i.test(href) && !/download.*pdf/i.test(href)) {
      continue;
    }
    add(href);
  }

  for (const match of html.matchAll(/https?:\/\/[^"'\s<>\\)]+?\.pdf/gi)) {
    add(match[0].replace(/&amp;/g, "&"));
  }

  return [...links];
}

/** The path and query of a URL, or the whole string when it will not parse. */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function scoreCandidate(url: string, partNumber: string, manufacturer?: string): number {
  const lowerUrl = url.toLowerCase();
  const lowerParts = buildPartVariants(partNumber).map((value) => value.toLowerCase());
  let score = 0;

  if (/\.pdf(\?|#|$)/i.test(lowerUrl)) score += 100;
  if (lowerParts.some((part) => lowerUrl.includes(part))) score += 20;
  // A PATH or filename that says "datasheet". Worth its own points because the close competition on
  // a vendor product page is other documents ABOUT THE SAME PART: without this, ATMEGA328P's
  // datasheet ties exactly with an app note titled "Differences between ATmega328P and ATmega328PB",
  // and a tie is decided by document order, which is what we are trying to stop relying on.
  //
  // The PATH and not the whole URL, because a vendor puts the word in the path
  // (`/data-sheets/`, `/ProductDocuments/DataSheets/`) while an aggregator puts it in the HOSTNAME
  // (`datasheetspdf.com`). Scoring the whole string handed those sites a bonus meant for
  // first-party documents. Measured over seven representative URLs this changes exactly one, so it
  // is a small correction rather than a big one: it is here because the rule should mean what it
  // says, not because it moved a number.
  if (/data.?sheet/.test(pathOf(lowerUrl))) score += 15;
  if (manufacturer && lowerUrl.includes(slugify(manufacturer))) score += 8;
  // A known datasheet host, manufacturer or distributor, beats a random aggregator or forum. This
  // is what steers us toward the distributor-hosted copy for parts whose vendor publishes nothing.
  if (DATASHEET_HOSTS.some((host) => lowerUrl.includes(host))) score += 12;
  // Aggregators that wrap datasheets in interstitials and ads. Not banned, since sometimes they are
  // the only hit, but ranked below a first-party or distributor copy.
  if (/alldatasheet|datasheetcatalog|digchip|elcodis|datasheets\.com|scribd/.test(lowerUrl)) score -= 30;

  return score;
}

// Returns null for anything unusable so the caller simply tries the next candidate. These URLs come
// from search-result HTML, which we do not control, so one hostile or broken entry must never abort
// the whole lookup: that would be a trivial denial of service via a single poisoned result.
async function inspectCandidate(
  url: string,
  partNumber: string,
  manufacturer?: string
): Promise<{ pdfUrl: string; sourcePageUrl: string } | null> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
    url,
      {
        headers: { "User-Agent": userAgent, Accept: "application/pdf,application/octet-stream,text/html;q=0.9,*/*;q=0.8" },
        redirect: "follow"
      },
      SEARCH_TIMEOUT_MS
    );
  } catch (error) {
    // BlockedUrlError (SSRF guard) and ResponseTooLargeError both land here, alongside ordinary
    // dead hosts and timeouts. All of them mean "this candidate is unusable", nothing more.
    if (error instanceof BlockedUrlError || error instanceof ResponseTooLargeError) return null;
    throw error;
  }

  if (!response.ok) {
    return null;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  const finalUrl = response.url || url;

  if (contentType.includes("pdf") || /\.pdf(\?|#|$)/i.test(finalUrl)) {
    return { pdfUrl: finalUrl, sourcePageUrl: url };
  }

  if (!contentType.includes("html")) {
    return null;
  }

  const html = await response.text();
  // BOUNDED, like every other reach in this file. The search-result list is
  // capped at 12 candidates, the redirect chain at 5 and the body at 50MB, and
  // this one was not: a link-heavy or hostile page turned one lookup into an
  // unbounded outbound fan-out from a public endpoint, each hop carrying a 30
  // second download timeout.
  //
  // RANKED HIGHEST FIRST so the cap drops the least likely link rather than the
  // last one on the page. This comment claimed the ranking before the sort below
  // existed, which is the exact shape of defect this project keeps finding: a
  // check that documents behaviour it does not have. It mattered here. A vendor
  // product page lists app notes, errata, white papers and selection guides
  // alongside the datasheet, so "the first eight in document order" is close to
  // a random eight, and the datasheet does not reliably survive the cut.
  const pdfLinks = extractPdfLinks(html, finalUrl)
    .sort((left, right) => scoreCandidate(right, partNumber, manufacturer) - scoreCandidate(left, partNumber, manufacturer))
    .slice(0, MAX_PDF_LINKS_PER_PAGE);

  for (const pdfLink of pdfLinks) {
    let pdfResponse: Response;
    try {
      pdfResponse = await fetchWithTimeout(
        pdfLink,
        { headers: { "User-Agent": userAgent, Accept: "application/pdf,*/*;q=0.8" }, redirect: "follow" },
        DOWNLOAD_TIMEOUT_MS
      );
    } catch (error) {
      // Same reasoning: these links were scraped out of a third-party page.
      if (error instanceof BlockedUrlError || error instanceof ResponseTooLargeError) continue;
      throw error;
    }

    if (!pdfResponse.ok) {
      continue;
    }

    // Fall back to the link we asked for when the response carries no url of its own, the same way
    // `finalUrl` does above. The two lines were inconsistent: this one trusted `response.url` alone,
    // so a response without one produced an EMPTY pdfUrl that the caller then tried to fetch and
    // the SSRF guard rejected as "not a valid URL". The redirected url still wins when present,
    // because that is the address the bytes actually came from and the citation has to say so.
    const resolvedPdfUrl = pdfResponse.url || pdfLink;
    const pdfType = pdfResponse.headers.get("content-type")?.toLowerCase() || "";
    if (pdfType.includes("pdf") || /\.pdf(\?|#|$)/i.test(resolvedPdfUrl)) {
      return { pdfUrl: resolvedPdfUrl, sourcePageUrl: finalUrl };
    }
  }

  return null;
}

/** A candidate that was downloaded AND confirmed to be the requested part. */
interface LocatedPdf {
  pdfUrl: string;
  sourcePageUrl: string;
  bytes: ArrayBuffer;
}

// Result of the location phase. `searchBlocked` is the important part: it distinguishes "we
// searched and found nothing" from "we could not search", so the caller never tells a user their
// part has no datasheet when the truth is that every search backend refused us.
interface LocateOutcome {
  found: LocatedPdf | null;
  searchBlocked: boolean;
}

/**
 * How many real PDFs we will download and identity-check before giving up.
 *
 * Verification costs a full download, so this cannot be unbounded. Six is well past the point
 * where a search result list stops being about the part you asked for.
 */
const MAX_VERIFIED_DOWNLOADS = 6;

/**
 * Downloads a located candidate and returns it only if the document names the part.
 *
 * Null means "try the next candidate", for every reason: a dead link, an oversized body, a blocked
 * URL, or a perfectly good datasheet for a DIFFERENT device.
 */
async function downloadIfItNamesThePart(
  located: { pdfUrl: string; sourcePageUrl: string },
  partNumber: string
): Promise<LocatedPdf | null> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      located.pdfUrl,
      { headers: { "User-Agent": userAgent, Accept: "application/pdf,*/*;q=0.8" }, redirect: "follow" },
      DOWNLOAD_TIMEOUT_MS
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;

  let bytes: ArrayBuffer;
  try {
    bytes = await readBodyWithLimit(response, located.pdfUrl);
  } catch {
    return null;
  }

  // Search ranks by URL text and host, which says nothing about what is INSIDE the document. Asked
  // for TPS7A4700 it returned TPS7A20's datasheet: same vendor, same family prefix, a real PDF, and
  // completely the wrong chip.
  if (!(await documentNamesPart(bytes, partNumber))) {
    logger.info({ event: "resolver_wrong_part", resolver: "scrape", partNumber, url: located.pdfUrl });
    return null;
  }

  return { ...located, bytes };
}

async function locatePdf(
  partNumber: string,
  manufacturer: string | undefined,
  search: SearchClient,
  deadlineAt?: number
): Promise<LocateOutcome> {
  // Checked before each new candidate and each new query, which is where this resolver's time
  // actually goes. Anything already in flight finishes; we simply stop STARTING work.
  const outOfTime = () => deadlineAt !== undefined && Date.now() >= deadlineAt;

  // VERIFICATION HAPPENS HERE, not after this function returns, and that is the whole point of the
  // shape. It used to commit to the first candidate that looked like a PDF, and the caller then
  // identity-checked it and returned null on failure, throwing away every remaining candidate. So
  // one aggregator copy of the wrong device at the top of the ranking lost the part outright.
  //
  // `identity.ts` already says this is wrong, in its own words: "A rejected candidate has to mean
  // 'try the next URL', not 'this resolver failed'." The manufacturer resolver had always worked
  // that way. This one did not, and the comment acknowledging the gap sat here instead of a fix.
  let verified = 0;
  const consider = async (candidate: string): Promise<LocatedPdf | null> => {
    if (verified >= MAX_VERIFIED_DOWNLOADS || outOfTime()) return null;
    const located = await inspectCandidate(candidate, partNumber, manufacturer);
    if (!located) return null;
    verified++;
    return downloadIfItNamesThePart(located, partNumber);
  };

  // Deterministic candidates first: no search engine involved, so these keep working even when
  // every engine is blocking us. This is the tier that makes production degradation graceful
  // rather than total.
  const directCandidates = buildDirectCandidates(partNumber, manufacturer);
  for (const candidate of directCandidates) {
    const resolved = await consider(candidate);
    if (resolved) return { found: resolved, searchBlocked: false };
  }

  let blocked = false;
  const queries = buildSearchQueries(partNumber, manufacturer);
  for (const query of queries) {
    // A part with a manufacturer hint generates a dozen query variants. Without this the resolver
    // would keep asking new questions long after the answer stopped being wanted.
    if (outOfTime()) break;
    const outcome = await search.search(query);
    if (outcome.blocked) {
      blocked = true;
      // Every backend is refusing us. Further queries will not fare better and would just burn the
      // chain budget, so stop and report the block.
      break;
    }

    const ranked = outcome.urls.sort(
      (left, right) =>
        scoreCandidate(right, partNumber, manufacturer) - scoreCandidate(left, partNumber, manufacturer)
    );

    for (const candidate of ranked.slice(0, 12)) {
      const resolved = await consider(candidate);
      if (resolved) return { found: resolved, searchBlocked: false };
    }
  }

  return { found: null, searchBlocked: blocked };
}

export class ScrapeResolver implements DatasheetResolver {
  readonly name = "scrape";

  // Held on the instance so circuit-breaker state survives across lookups within a process. A
  // backend that blocked us thirty seconds ago is still blocking us now.
  constructor(private readonly search: SearchClient = new SearchClient()) {}

  // No credentials to check. Scraping is always technically available, which is also why it
  // is the last resort rather than the primary: available is not the same as reliable.
  isConfigured(): boolean {
    return true;
  }

  async resolve(partNumber: string, opts?: ResolveOptions): Promise<DatasheetRef | null> {
    let located: LocatedPdf;
    try {
      const outcome = await locatePdf(partNumber, opts?.manufacturer, this.search, opts?.deadlineAt);

      if (!outcome.found) {
        // The distinction this whole file exists to preserve. If search was blocked we do NOT know
        // that the part has no datasheet, so returning null would let the route report a confident
        // DATASHEET_NOT_FOUND that is simply false. Throw a SOFT error instead: the composite
        // swallows it, the user still gets the upload prompt, and the operator sees the real cause.
        if (outcome.searchBlocked) {
          throw new ResolverError(
            "rate_limit",
            "scrape",
            "All search backends refused the request, so no conclusion can be drawn about this part"
          );
        }
        return null;
      }

      located = outcome.found;
    } catch (error) {
      // An already-typed failure (notably the search-blocked case above) passes through with its
      // kind intact, so a block is not silently relabelled as a generic transport error.
      if (error instanceof ResolverError) throw error;
      // Scraping is brittle by nature: search-engine hiccups, dead hosts, timeouts. All soft, so
      // the user degrades to the upload path rather than seeing a hard operator error.
      const message = error instanceof Error ? error.message : String(error);
      throw new ResolverError("transport", "scrape", message);
    }

    // Downloaded and identity-checked inside `locatePdf`, so that a rejection could try the next
    // candidate instead of ending the resolver. Nothing left to do but package it.
    try {
      return finalizeRef({
        fileName: `${normalizePartNumber(partNumber)}.pdf`,
        pdfUrl: located.pdfUrl,
        sourcePageUrl: located.sourcePageUrl,
        bytes: located.bytes
      });
    } catch (error) {
      // The link served something that was not a real PDF. Treat as not found.
      if (error instanceof PdfValidationError) return null;
      throw error;
    }
  }
}
