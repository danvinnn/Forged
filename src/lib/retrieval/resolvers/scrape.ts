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

  return [...candidates];
}

function decodeDuckDuckGoRedirect(href: string): string | null {
  try {
    const normalized = href.replace(/&amp;/g, "&");
    if (normalized.startsWith("//")) {
      return `https:${normalized}`;
    }

    if (/^https?:\/\//i.test(normalized)) {
      const parsed = new URL(normalized);
      const redirected = parsed.searchParams.get("uddg");
      return redirected ? decodeURIComponent(redirected) : normalized;
    }

    const parsed = new URL(normalized, "https://duckduckgo.com");
    const redirected = parsed.searchParams.get("uddg");
    if (redirected) {
      return decodeURIComponent(redirected);
    }

    return /^https?:\/\//i.test(parsed.href) ? parsed.href : null;
  } catch {
    return null;
  }
}

function extractSearchResultUrls(html: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/href="([^"]+)"/gi)) {
    const candidate = decodeDuckDuckGoRedirect(match[1]);
    if (candidate && /^https?:\/\//i.test(candidate)) {
      urls.add(candidate);
    }
  }

  return [...urls];
}

function extractPdfLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>();
  for (const match of html.matchAll(/href="([^"]+)"/gi)) {
    const href = match[1].replace(/&amp;/g, "&");
    if (!/\.pdf(\?|#|$)/i.test(href) && !/download.*pdf/i.test(href)) {
      continue;
    }

    try {
      links.add(new URL(href, baseUrl).href);
    } catch {
      continue;
    }
  }

  return [...links];
}

function scoreCandidate(url: string, partNumber: string, manufacturer?: string): number {
  const lowerUrl = url.toLowerCase();
  const lowerParts = buildPartVariants(partNumber).map((value) => value.toLowerCase());
  let score = 0;

  if (/\.pdf(\?|#|$)/i.test(lowerUrl)) score += 100;
  if (lowerParts.some((part) => lowerUrl.includes(part))) score += 20;
  if (manufacturer && lowerUrl.includes(slugify(manufacturer))) score += 8;
  // A known datasheet host, manufacturer or distributor, beats a random aggregator or forum. This
  // is what steers us toward the distributor-hosted copy for parts whose vendor publishes nothing.
  if (DATASHEET_HOSTS.some((host) => lowerUrl.includes(host))) score += 12;
  // Aggregators that wrap datasheets in interstitials and ads. Not banned, since sometimes they are
  // the only hit, but ranked below a first-party or distributor copy.
  if (/alldatasheet|datasheetcatalog|digchip|elcodis|datasheets\.com|scribd/.test(lowerUrl)) score -= 30;

  return score;
}

async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string; contentType: string }> {
  const response = await fetchWithTimeout(
    url,
    { headers: { "User-Agent": userAgent, Accept: "text/html,application/xhtml+xml" }, redirect: "follow" },
    SEARCH_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error(`Search request failed for ${url}: ${response.status}`);
  }

  return {
    html: await response.text(),
    finalUrl: response.url,
    contentType: response.headers.get("content-type")?.toLowerCase() || ""
  };
}

// Returns null for anything unusable so the caller simply tries the next candidate. These URLs come
// from search-result HTML, which we do not control, so one hostile or broken entry must never abort
// the whole lookup: that would be a trivial denial of service via a single poisoned result.
async function inspectCandidate(url: string): Promise<{ pdfUrl: string; sourcePageUrl: string } | null> {
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
  const pdfLinks = extractPdfLinks(html, finalUrl);

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

    const pdfType = pdfResponse.headers.get("content-type")?.toLowerCase() || "";
    if (pdfType.includes("pdf") || /\.pdf(\?|#|$)/i.test(pdfResponse.url)) {
      return { pdfUrl: pdfResponse.url, sourcePageUrl: finalUrl };
    }
  }

  return null;
}

// Result of the location phase. `searchBlocked` is the important part: it distinguishes "we
// searched and found nothing" from "we could not search", so the caller never tells a user their
// part has no datasheet when the truth is that every search backend refused us.
interface LocateOutcome {
  found: { pdfUrl: string; sourcePageUrl: string } | null;
  searchBlocked: boolean;
}

async function locatePdf(
  partNumber: string,
  manufacturer: string | undefined,
  search: SearchClient
): Promise<LocateOutcome> {
  // Deterministic candidates first: no search engine involved, so these keep working even when
  // every engine is blocking us. This is the tier that makes production degradation graceful
  // rather than total.
  const directCandidates = buildDirectCandidates(partNumber, manufacturer);
  for (const candidate of directCandidates) {
    const resolved = await inspectCandidate(candidate);
    if (resolved) return { found: resolved, searchBlocked: false };
  }

  let blocked = false;
  const queries = buildSearchQueries(partNumber, manufacturer);
  for (const query of queries) {
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
      const resolved = await inspectCandidate(candidate);
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
    let located: { pdfUrl: string; sourcePageUrl: string } | null;
    let response: Response;
    try {
      const outcome = await locatePdf(partNumber, opts?.manufacturer, this.search);

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

      response = await fetchWithTimeout(
        located.pdfUrl,
        { headers: { "User-Agent": userAgent, Accept: "application/pdf,*/*;q=0.8" }, redirect: "follow" },
        DOWNLOAD_TIMEOUT_MS
      );
    } catch (error) {
      // An already-typed failure (notably the search-blocked case above) passes through with its
      // kind intact, so a block is not silently relabelled as a generic transport error.
      if (error instanceof ResolverError) throw error;
      // Scraping is brittle by nature: search-engine hiccups, dead hosts, timeouts. All soft, so
      // the user degrades to the upload path rather than seeing a hard operator error.
      const message = error instanceof Error ? error.message : String(error);
      throw new ResolverError("transport", "scrape", message);
    }

    // A dead download link is "not found", not a failure: fall through to the next resolver.
    if (!response.ok) return null;

    let bytes: ArrayBuffer;
    try {
      bytes = await readBodyWithLimit(response, located.pdfUrl);
    } catch (error) {
      // An oversized body is not a datasheet. Not found, so the user can still upload.
      if (error instanceof ResponseTooLargeError) return null;
      throw error;
    }

    try {
      return finalizeRef({
        fileName: `${normalizePartNumber(partNumber)}.pdf`,
        pdfUrl: located.pdfUrl,
        sourcePageUrl: located.sourcePageUrl,
        bytes
      });
    } catch (error) {
      // The link served something that was not a real PDF. Treat as not found.
      if (error instanceof PdfValidationError) return null;
      throw error;
    }
  }
}
