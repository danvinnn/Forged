import { parseDatasheetPdf } from "./datasheet";
import { type PartRecord } from "./types";

const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Forge/1.0";

export interface DatasheetLookupResult {
  part: PartRecord;
  pdfUrl: string;
  sourcePageUrl: string;
  searchQuery: string;
  candidateUrls: string[];
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizePartNumber(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

function buildPartVariants(partNumber: string): string[] {
  const normalized = normalizePartNumber(partNumber);
  const variants = new Set<string>([normalized]);

  // Remove package/ordering suffix after a dash, like LMP7704-SP -> LMP7704.
  variants.add(normalized.replace(/[-_].*$/, ""));

  // Remove trailing option code after numeric family, like INA240A1 -> INA240.
  const familyTrimmed = normalized.replace(/(.*\d)[A-Z]+\d*$/, "$1");
  variants.add(familyTrimmed);

  return [...variants].filter(Boolean);
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
  if (/ti\.com|mouser\.com|digikey\.com|onsemi\.com|microchip\.com|renesas\.com/.test(lowerUrl)) score += 4;

  return score;
}

async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string; contentType: string }> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": userAgent,
      Accept: "text/html,application/xhtml+xml"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`Search request failed for ${url}: ${response.status}`);
  }

  return {
    html: await response.text(),
    finalUrl: response.url,
    contentType: response.headers.get("content-type")?.toLowerCase() || ""
  };
}

async function inspectCandidate(url: string): Promise<{ pdfUrl: string; sourcePageUrl: string } | null> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": userAgent,
      Accept: "application/pdf,application/octet-stream,text/html;q=0.9,*/*;q=0.8"
    },
    redirect: "follow"
  });

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
    const pdfResponse = await fetch(pdfLink, {
      headers: { "User-Agent": userAgent, Accept: "application/pdf,*/*;q=0.8" },
      redirect: "follow"
    });

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

export async function lookupDatasheetPdf(partNumber: string, manufacturer?: string): Promise<{ pdfUrl: string; sourcePageUrl: string; searchQuery: string; candidateUrls: string[] }> {
  const directCandidates = buildDirectCandidates(partNumber, manufacturer);
  for (const candidate of directCandidates) {
    const resolved = await inspectCandidate(candidate);
    if (resolved) {
      return {
        ...resolved,
        searchQuery: "direct-manufacturer-candidate",
        candidateUrls: directCandidates
      };
    }
  }

  const queries = buildSearchQueries(partNumber, manufacturer);

  for (const query of queries) {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const searchPage = await fetchHtml(searchUrl);
    const rankedCandidates = extractSearchResultUrls(searchPage.html)
      .sort((left, right) => scoreCandidate(right, partNumber, manufacturer) - scoreCandidate(left, partNumber, manufacturer));

    for (const candidate of rankedCandidates.slice(0, 12)) {
      const resolved = await inspectCandidate(candidate);
      if (resolved) {
        return { ...resolved, searchQuery: query, candidateUrls: rankedCandidates };
      }
    }
  }

  throw new Error(`Unable to locate a datasheet PDF for ${partNumber}. Try adding a manufacturer hint or upload the PDF directly.`);
}

export async function lookupAndParseDatasheet(partNumber: string, manufacturer?: string): Promise<DatasheetLookupResult> {
  const resolution = await lookupDatasheetPdf(partNumber, manufacturer);
  const response = await fetch(resolution.pdfUrl, {
    headers: {
      "User-Agent": userAgent,
      Accept: "application/pdf,*/*;q=0.8"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`Failed to download datasheet PDF from ${resolution.pdfUrl}`);
  }

  const buffer = await response.arrayBuffer();
  const part = await parseDatasheetPdf(`${partNumber}.pdf`, buffer, resolution.pdfUrl);
  const requestedPart = normalizePartNumber(partNumber);
  const parsedPart = normalizePartNumber(part.partNumber || "");

  // Keep the user-requested part when parser captures an unrelated token from the PDF text.
  if (!parsedPart || (!parsedPart.includes(requestedPart) && !requestedPart.includes(parsedPart))) {
    part.partNumber = requestedPart;
  }

  if (manufacturer && part.manufacturer === "Unknown") {
    part.manufacturer = manufacturer;
  }

  part.sourceUrl = resolution.pdfUrl;
  part.notes = [`Web lookup resolved ${resolution.pdfUrl}.`, ...part.notes];

  return {
    part,
    pdfUrl: resolution.pdfUrl,
    sourcePageUrl: resolution.sourcePageUrl,
    searchQuery: resolution.searchQuery,
    candidateUrls: resolution.candidateUrls
  };
}