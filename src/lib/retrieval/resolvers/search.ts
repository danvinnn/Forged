// Search backends for the scrape resolver, behind one interface with health tracking.
//
// NETWORK MODULE. Only ever loaded through the commercial branch of makeResolver.
//
// Why this exists: the scrape resolver used to call DuckDuckGo's HTML endpoint directly and treat
// it as infallible. That is fine from a laptop and wrong in production, because search engines
// block datacenter IP ranges aggressively. On a cloud host the single hardcoded backend becomes a
// single point of failure, and the failure mode is bad: a challenge page returns HTTP 200 with HTML
// that contains no results, so the old code saw "search succeeded, zero hits" and reported a clean
// DATASHEET_NOT_FOUND. The user is told their part does not exist when the truth is that we were
// blocked. Silently wrong beats loudly broken only if you never find out.
//
// Note on why there is no free API backend here: as of mid-2026 the free search API market is gone.
// Brave retired its free tier in February 2026 (metered, card required, attribution mandatory),
// Microsoft shut down the Bing Search API, and Google's Custom Search JSON API is discontinued with
// a January 2027 end date. So the practical options are scraping several engines and degrading
// honestly, or paying. BraveSearchBackend below is wired but inert unless a key is configured, so
// adding paid search later is an env var rather than a rewrite.

import { fetchWithTimeout, SEARCH_TIMEOUT_MS } from "./http";

export interface SearchBackend {
  readonly name: string;
  isConfigured(): boolean;
  // Returns candidate result URLs. Throws SearchBlockedError when the backend refused us, which is
  // deliberately distinct from returning an empty array: "blocked" and "no results" must never be
  // conflated, because only one of them means the part has no datasheet.
  search(query: string): Promise<string[]>;
}

export class SearchBlockedError extends Error {
  constructor(backend: string, detail: string) {
    super(`Search backend ${backend} refused the request: ${detail}`);
    this.name = "SearchBlockedError";
  }
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Markers that mean "you are being challenged", not "no results". Checked against the body because
// engines commonly serve these with a 200 status, which is exactly what made the old failure silent.
const BLOCK_MARKERS = [
  "captcha",
  "unusual traffic",
  "are you a robot",
  "verify you are human",
  "automated queries",
  "access denied",
  "rate limit",
  "too many requests",
  "cf-browser-verification",
  "challenge-platform"
];

function looksBlocked(html: string): boolean {
  const head = html.slice(0, 4000).toLowerCase();
  return BLOCK_MARKERS.some((marker) => head.includes(marker));
}

// Pulls absolute URLs out of result HTML, unwrapping the redirect hops engines use.
export function extractResultUrls(html: string): string[] {
  const urls = new Set<string>();

  for (const match of html.matchAll(/href="([^"]+)"/gi)) {
    let href = match[1].replace(/&amp;/g, "&");

    // DuckDuckGo wraps results as /l/?uddg=<encoded>. Mojeek uses /out?u=<encoded>.
    try {
      const parsed = new URL(href, "https://duckduckgo.com");
      const wrapped = parsed.searchParams.get("uddg") ?? parsed.searchParams.get("u");
      if (wrapped) href = decodeURIComponent(wrapped);
    } catch {
      continue;
    }

    if (href.startsWith("//")) href = `https:${href}`;
    if (/^https?:\/\//i.test(href)) urls.add(href);
  }

  return [...urls];
}

// Shared implementation for the engines we reach by scraping their HTML endpoint.
class HtmlSearchBackend implements SearchBackend {
  constructor(
    readonly name: string,
    private readonly buildUrl: (query: string) => string
  ) {}

  isConfigured(): boolean {
    return true; // no credentials
  }

  async search(query: string): Promise<string[]> {
    const response = await fetchWithTimeout(
      this.buildUrl(query),
      { headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" } },
      SEARCH_TIMEOUT_MS
    );

    // An explicit refusal. 403 and 429 are the honest ones.
    if (response.status === 403 || response.status === 429) {
      throw new SearchBlockedError(this.name, `HTTP ${response.status}`);
    }
    if (!response.ok) {
      throw new SearchBlockedError(this.name, `HTTP ${response.status}`);
    }

    const html = await response.text();
    // The dishonest refusal: 200 OK with a challenge page. This is the case that used to be
    // reported to the user as "no datasheet found".
    if (looksBlocked(html)) {
      throw new SearchBlockedError(this.name, "challenge or rate-limit page returned with HTTP 200");
    }

    return extractResultUrls(html);
  }
}

// Optional paid backend. Inert unless BRAVE_SEARCH_API_KEY is set, so it costs nothing to carry and
// turning on paid search later is a config change rather than a code change. Note Brave requires
// visible attribution in the UI on every plan; wire that before enabling this in a shipped product.
class BraveSearchBackend implements SearchBackend {
  readonly name = "brave";

  isConfigured(): boolean {
    return Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim());
  }

  async search(query: string): Promise<string[]> {
    const key = process.env.BRAVE_SEARCH_API_KEY?.trim();
    if (!key) throw new SearchBlockedError(this.name, "no API key configured");

    const response = await fetchWithTimeout(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`,
      { headers: { Accept: "application/json", "X-Subscription-Token": key } },
      SEARCH_TIMEOUT_MS
    );

    if (response.status === 401 || response.status === 403) {
      throw new SearchBlockedError(this.name, `auth rejected (HTTP ${response.status})`);
    }
    if (response.status === 429) {
      throw new SearchBlockedError(this.name, "quota or rate limit reached");
    }
    if (!response.ok) throw new SearchBlockedError(this.name, `HTTP ${response.status}`);

    const json = (await response.json()) as { web?: { results?: { url?: string }[] } };
    return (json.web?.results ?? []).map((r) => r.url).filter((u): u is string => Boolean(u));
  }
}

// Ordered cheapest and most permissive first. Independent indexes sit alongside DuckDuckGo so a
// block on one does not take out the others: they are genuinely different infrastructure, unlike
// stacking several Google front-ends which would all fail together.
export function defaultBackends(): SearchBackend[] {
  return [
    new HtmlSearchBackend("ddg-html", (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`),
    new HtmlSearchBackend("ddg-lite", (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`),
    new HtmlSearchBackend("mojeek", (q) => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`),
    new BraveSearchBackend()
  ];
}

interface BackendHealth {
  consecutiveBlocks: number;
  openUntil: number;
}

export const BLOCK_THRESHOLD = 3;
export const COOLDOWN_MS = 10 * 60 * 1000;

// Result of a search attempt across all backends. `blocked` is the field that matters: it lets the
// caller distinguish "we searched and this part has no datasheet" from "we could not search at
// all", so the second case is reported as a soft failure instead of a confident not-found.
export interface SearchOutcome {
  urls: string[];
  blocked: boolean;
  backend: string | null;
}

export class SearchClient {
  private readonly health = new Map<string, BackendHealth>();

  constructor(private readonly backends: SearchBackend[] = defaultBackends()) {}

  private isOpen(name: string): boolean {
    const h = this.health.get(name);
    return Boolean(h && h.openUntil > Date.now());
  }

  private recordBlock(name: string): void {
    const h = this.health.get(name) ?? { consecutiveBlocks: 0, openUntil: 0 };
    h.consecutiveBlocks++;
    // Circuit breaker. A blocked engine stays blocked for a while, so hammering it just burns the
    // chain budget and deepens the block. Back off instead.
    if (h.consecutiveBlocks >= BLOCK_THRESHOLD) {
      h.openUntil = Date.now() + COOLDOWN_MS;
      h.consecutiveBlocks = 0;
    }
    this.health.set(name, h);
  }

  private recordSuccess(name: string): void {
    this.health.set(name, { consecutiveBlocks: 0, openUntil: 0 });
  }

  async search(query: string): Promise<SearchOutcome> {
    let anyBlocked = false;
    let anyAttempted = false;

    for (const backend of this.backends) {
      if (!backend.isConfigured()) continue;
      if (this.isOpen(backend.name)) {
        anyBlocked = true; // counts as unavailable, not as a clean empty result
        continue;
      }

      anyAttempted = true;
      try {
        const urls = await backend.search(query);
        this.recordSuccess(backend.name);
        // An empty result from a healthy backend is a real answer; stop and report it.
        return { urls, blocked: false, backend: backend.name };
      } catch (error) {
        if (error instanceof SearchBlockedError) {
          this.recordBlock(backend.name);
          anyBlocked = true;
          continue;
        }
        // Transport failure or timeout. Try the next backend but do not count it as a block,
        // since the engine did not refuse us.
        continue;
      }
    }

    // Nothing usable. blocked=true tells the caller not to claim the part has no datasheet.
    return { urls: [], blocked: anyBlocked || !anyAttempted, backend: null };
  }
}
