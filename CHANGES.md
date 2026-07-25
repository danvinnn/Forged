# Layer 1 (Retrieval) change set, merged against current main (includes dvinn's Gemini path)

This set is reconciled with the Gemini work already on main. It adds the retrieval layer,
gates the existing Gemini calls behind commercial mode, and preserves datasheet-gemini.ts.

    npm install        # picks up tsx (added) alongside @google/generative-ai (already present)
    npm test           # 57 retrieval tests via tsx + node:test
    npx tsc --noEmit   # typechecks the whole repo, Gemini included

## Added (clean, no conflicts)
- src/lib/retrieval/**            the whole layer, including __tests__ and LAYER1.md
- src/app/api/config/route.ts     GET /api/config for client mode surfacing
- test-data/ALLOWLIST.txt         corpus CI gate allowlist
- .env.example                    documents FORGE_DEPLOYMENT_MODE, Nexar, and the Gemini key

## Modified (merged, do not blind-overwrite yours if you changed them since)
- src/app/api/lookup/route.ts     mode-gated resolver retrieval; Gemini extraction preserved but
                                  gated to commercial mode via dynamic import; the forbidden
                                  "Gemini finds the datasheet URL" path is removed
- src/app/api/parse/route.ts      ingestUpload (Layer 1) + Gemini extraction gated to commercial
- package.json                    added tsx devDep and test scripts; keeps @google/generative-ai

## NOT deleted (correction from the earlier standalone set)
- src/lib/datasheet-web.ts        KEEP IT. datasheet-gemini.ts imports lookupDatasheetPdf from it.
                                  The routes no longer import it, so it is inert from the retrieval
                                  path, but deleting it breaks the Gemini build. Retire it later
                                  when Layer 2 rewires Gemini behind the ExtractionModel interface.

## Air-gap note
In air-gapped mode the routes never load datasheet-gemini.ts: it is reached only through a
dynamic import inside a `mode === "commercial" && GOOGLE_GEMINI_API_KEY` branch. Verified: no
static import of the cloud module in either route.

## Architecture flag for dvinn
The Gemini path on main called Google's cloud API whenever the key was set, in ANY mode, with no
deployment-mode gate. In air-gapped mode that ships controlled datasheets to Google, which is the
core air-gap defect. This merge gates it. Also removed lookupAndParseDatasheetWithGemini from the
route path: using a model to FIND the datasheet URL is the hallucination pattern ARCHITECTURE.md
forbids. Proper Gemini extraction belongs in Layer 2 behind ExtractionModel, commercial-only, with
a local open-weight model for air-gapped.

## Follow-up pass (2026-07-22): Layer 1 finalized

Config surfacing, Nexar fixture, CI, and the coverage gaps that were left open.

### Added
- src/app/... page.tsx now consumes GET /api/config (mode-gated lookup box, loading state,
  fail-closed on config error)
- src/lib/retrieval/resolvers/__fixtures__/nexar-lmp7704.json + README.md  (GraphQL response
  fixture; SEARCH_QUERY exported and asserted so a live capture swaps in with no test edit)
- src/lib/retrieval/__tests__/scrape.test.ts   (first coverage for the demoted scrape resolver)
- .github/workflows/ci.yml                      (tsc + npm test on PRs; air-gap scan + corpus
  allowlist gates run here)
- .nvmrc                                        (Node pinned to 22; local dev is on 21)

### Modified
- src/lib/retrieval/resolvers/nexar.ts          (export SEARCH_QUERY only; no behavior change)
- src/lib/retrieval/__tests__/nexar.test.ts     (load the fixture; add the error-taxonomy suite)
- src/app/globals.css                           (loading placeholder + air-gap notice styles)
- .gitignore                                    (ignore *.tsbuildinfo)

### Removed from tracking
- tsconfig.tsbuildinfo                          (git rm --cached; build artifact, now gitignored)

### Not code, needs a human
- Branch protection on main requiring the `verify` job (otherwise the gates do not block merges).
- Nexar live validation with the free Welcome 1K credentials, then swap the fixture.

## Layer 1 robustness pass + Nexar removal (2026-07-22)

Retrieval now has NO credentialed dependency. Part-number lookup works on a fresh checkout with an
empty .env. 59 tests, `tsc --noEmit` clean.

### Added
- src/lib/retrieval/resolvers/manufacturer.ts   vendor-direct resolver, first in the chain. Ships
  three empirically VERIFIED patterns, each confirmed by fetching a real datasheet on 2026-07-22:
    TI    ti.com/lit/ds/symlink/{part}.pdf                      LMP7704-SP (QMLV, RHA 100krad)
    ST    st.com/resource/en/datasheet/{part}.pdf               RHF310A (RHA QML-V, 300krad)
    ADI   analog.com/media/.../data-sheets/{part}.pdf           AD590 Rev G
  New patterns require a real fetch before being added; guessing URLs in code is the same failure
  ARCHITECTURE.md forbids from a model.
- src/lib/retrieval/partnumber.ts               shared normalization (air-gap safe)
- src/lib/retrieval/__tests__/manufacturer.test.ts
- Chain budget in CompositeResolver (DEFAULT_CHAIN_BUDGET_MS, 25s), because rad-hard parts miss in
  every resolver so the full-chain walk is the COMMON path.
- `resolvedBy` on DatasheetRef: the composite stamps the winning CHILD, so provenance records who
  actually resolved it rather than which chain was configured.

### Removed
- src/lib/retrieval/resolvers/nexar.ts, its tests, and resolvers/__fixtures__/
- NEXAR_CLIENT_ID / NEXAR_CLIENT_SECRET from .env.example
  Reason: the free Evaluation app allows 10 matched parts per MONTH (not the 1,000 calls assumed),
  and the next tier is $100/month. See LAYER1.md "Decided against: component distributor APIs" for
  the full reasoning, including why Mouser (terms of service) and DigiKey (friction) were also
  rejected.

### Resulting chain
  manufacturer -> scrape        (neither needs credentials)

### Coverage reality (corrected: it is vendor by vendor)
DERIVABLE, including rad-hard: TI, ST, and ADI all publish rad-hard parts at predictable URLs. ST's
entire space line (RHF/RHR) resolves this way, and ADI space-grade parts fall out of the same
pattern (ad590s.pdf is the space variant of ad590.pdf). Better thesis coverage than expected, free.

NOT DERIVABLE: the pure-play rad-hard houses use document-numbered filenames. VORAGO publishes
VA10820 as "VA10820_DS_12.pdf", hosted by distributors rather than at a predictable vendor path;
CAES, Teledyne e2v, and Honeywell are the same. A test asserts we claim nothing for these rather
than guess. They remain upload-only, exactly as ARCHITECTURE.md says.

### Flag for dvinn
ARCHITECTURE.md is NOT in the repo, so its now-known-wrong claims (Nexar "1,000 calls per month",
the `supply` OAuth scope, DigiKey "requires a credit account") could not be corrected here. Worth
committing that file so it cannot drift from the code.

## Layer 1 coverage push (2026-07-22)

76 tests, `tsc --noEmit` clean. No external service, no credentials, no terms accepted.

### Added
- src/lib/retrieval/cache.ts              TTL + LRU resolution cache (air-gap safe, memory only)
- src/lib/retrieval/resolvers/caching.ts  CachingResolver, wraps the whole chain
- src/lib/retrieval/__tests__/cache.test.ts

### Changed
- resolvers/scrape.ts   tries a Mouser flat-path candidate; scores 18 known datasheet hosts
                        (manufacturer + distributor) higher; penalizes interstitial aggregators;
                        now uses the shared partnumber helpers instead of local duplicates
- resolvers/commercial.ts  chain is now CachingResolver(composite(manufacturer, scrape))

### Two corrections to earlier claims in this file
1. "No distributor stocks true rad-hard parts" was FALSE. Mouser hosts VA10820 at
   mouser.com/pdfdocs/VA10820_DS_12.pdf; Arrow hosts a copy. For pure-play rad-hard vendors a
   distributor is the ONLY public source. The decision to skip their APIs still stands, but on
   terms and cost, not on coverage: we do not need an API to read a PDF served publicly to any
   browser.
2. VORAGO is worse than "no derivable URL": they publish NO datasheets on their site at all. Their
   documentation index has white papers, app notes, tech briefs, PCNs, QML certs, and zero
   datasheets. The datasheet is gated behind a sales contact.

### Not derivable, do not add to the manufacturer registry
Microchip (00002117f.pdf), Vishay, Infineon all use document-numbered filenames. No part-number
pattern reaches them.

### Not done deliberately
No AI in the retrieval path. Model-generated datasheet URLs are what ARCHITECTURE.md forbids, and a
hallucinated source URL poisons the citation trail. AI belongs in Layer 2.

## Layer 1 consumer production hardening (2026-07-22)

93 tests, `tsc --noEmit` clean. What changes when the endpoint is publicly reachable.

### Security fixes (these were real holes, not hypotheticals)
- src/lib/retrieval/resolvers/urlguard.ts   SSRF guard. The scrape resolver fetched URLs extracted
  from third-party search HTML and followed redirects, so an attacker-influenced URL decided what
  our server connected to. Blocks private/loopback/link-local/CGNAT/multicast and IPv4-mapped-IPv6,
  resolves named hosts and checks every returned address, and re-checks on EVERY redirect hop
  (manual redirects, max 5) because redirect:"follow" would only check the first URL.
- resolvers/http.ts  readBodyWithLimit. arrayBuffer() buffered the whole body before any size check,
  so a huge response could OOM the process before assertPdfBytes ever ran. Now rejects an oversized
  Content-Length up front and cancels the stream mid-flight if the header lies or is missing.
- api/lookup/route.ts  partNumber and manufacturer capped at 64 chars. Both are interpolated into
  vendor URLs and search queries; unbounded input was a memory and outbound-abuse vector.

All three degrade to "not found", never a hard error, so one poisoned search result skips that
candidate rather than killing the lookup.

### Scale
- resolvers/caching.ts  single-flight coalescing. Ten concurrent lookups of the same part now share
  one chain walk instead of hitting the vendor ten times.
- resolvers/composite.ts  chain budget now 12s default and configurable via FORGE_CHAIN_BUDGET_MS.
  It must sit under the host's function timeout or the platform 504s before our clean
  DATASHEET_NOT_FOUND can fire.

### Still open before a consumer launch (NOT addressed here)
1. DuckDuckGo scraping degrades on cloud IPs. Production coverage collapses toward the three
   pattern vendors plus the Mouser flat-path guess. Biggest remaining gap; not fixable by hardening.
2. No rate limiting on /api/lookup.
3. Cache is per-instance, so serverless cold starts blunt it.
4. No structured logging: resolver win rates and latency are invisible in production.

## Layer 1 production-grade search (2026-07-22)

104 tests, `tsc --noEmit` clean.

### The silent bug this fixes
The scrape resolver called DuckDuckGo's HTML endpoint directly and assumed it always works. Search
engines block datacenter IPs, and a challenge page comes back as HTTP 200 with no results. The old
code read that as "search succeeded, zero hits" and the route reported DATASHEET_NOT_FOUND. In
production the app would have told users their part has no datasheet when we were simply blocked.
That reads as a coverage gap, not a bug, so it could have cost weeks of adding vendor patterns to
fix something that was never about coverage.

### Added
- src/lib/retrieval/resolvers/search.ts   SearchBackend interface + SearchClient
    * three independent free backends: DuckDuckGo HTML, DuckDuckGo Lite, Mojeek (own index)
    * block detection on the BODY, not just status (captcha / unusual traffic / verify-you-are-human
      served with HTTP 200), classified as SearchBlockedError
    * circuit breaker: 3 consecutive blocks opens for 10 minutes
    * SearchOutcome.blocked distinguishes "no datasheet" from "could not search"
    * BraveSearchBackend, inert unless BRAVE_SEARCH_API_KEY is set
- src/lib/retrieval/__tests__/search.test.ts

### Changed
- resolvers/scrape.ts   uses SearchClient; when search is blocked and nothing was found it throws a
  SOFT rate_limit error instead of returning null, so the user is never told a false fact about
  their part. Deterministic candidates still run BEFORE any search, so TI/ST/ADI parts keep
  resolving during a total search outage.

### Free search API landscape as of mid-2026 (relevant if revisiting this)
Brave retired its free tier Feb 2026 (metered, card required, no spending cap, attribution
mandatory). Microsoft shut down the Bing Search API. Google Custom Search JSON API is discontinued,
closing Jan 2027. SerpAPI is under DMCA litigation from Google. There is no free search API to swap
in; reliability is either bought or degraded gracefully. We do the latter with an option for the
former.

### Still open before launch
1. No rate limiting on /api/lookup. Biggest remaining gap.
2. Cache is per-instance; serverless cold starts blunt it.
3. No structured logging. Given the failure above was silent, an alert when a backend circuit opens
   is worth more than it sounds.

## Layer 1 security pass + coverage expansion (2026-07-22)

119 tests, `tsc --noEmit` clean.

### Security fixes (all real holes in code that passed its tests)
- ratelimit.ts (NEW)        20/min lookup, 30/min upload, 429 + Retry-After. /api/lookup makes
                            outbound requests for anonymous callers, so an unlimited endpoint is a
                            traffic amplifier aimed at the vendors we depend on. Key map bounded
                            against source-address rotation; clientKey uses the FIRST
                            x-forwarded-for entry and a SHARED fallback bucket so stripping headers
                            cannot mint a fresh allowance.
- api/parse/route.ts        Upload size rejected on Content-Length BEFORE request.formData(), then
                            on file.size BEFORE arrayBuffer(). formData() buffers the whole body, so
                            a 1GB POST would OOM before assertPdfBytes ever ran. Same bug class as
                            the download path, in a file I had already reviewed once.
- api/lookup/route.ts       Resolver errors no longer returned raw. The composite's aggregate
                            message names internal resolvers, hosts, and upstream detail; that goes
                            to console.error, and the client gets a generic message.
- app/page.tsx              formatSourceUrl now rejects non-http(s) schemes. new URL() parses
                            "javascript:..." happily and the value lands in an anchor href.

Structural property: resolvers/http.ts is the ONLY module that calls fetch directly, so every
outbound request passes the SSRF guard, redirect re-check, timeout, and size cap.

### Known limits (documented, not fixed)
- Rate limiting is per-process; on serverless the real limit is (limit x instances). Needs shared
  state for a guarantee.
- DNS rebinding TOCTOU remains open; Node's fetch exposes no connection pinning.
- PDF content bombs are a Layer 2 concern.

### Coverage
- Manufacturer candidates now fetched in PARALLEL, winner taken in CANDIDATE order (confidence)
  rather than completion order, so a slow exact URL still beats a fast generic redirect.
- NEW speculative cross-vendor tier: parts whose prefix our conservative regexes miss now get tried
  against every known vendor pattern. Affordable only because of parallelism. Skipped when the hint
  names a known vendor.
- Transport failures stay distinct from misses (hit / miss / error), so "we could not check" is
  never reported as "this part has no datasheet".

### Vendors checked and REJECTED for the registry
Microchip, NXP, Vishay, Infineon: all name datasheets by document number, not part number.


## Layer 1 coverage benchmark (2026-07-22)

122 tests, `tsc --noEmit` clean.

### Added
- src/lib/retrieval/__bench__/corpus.ts     67 real, public part numbers across 8 categories
- src/lib/retrieval/__bench__/coverage.ts   report runner, static (no network) and --live modes
- package.json                              "bench:coverage" script

Run: npm run bench:coverage            (static, CI-safe)
     npm run bench:coverage -- --live  (real chain; run from the TARGET HOST, since search block
                                        rates differ in a datacenter vs a laptop)

### First static result
radhard-major 8/8, analog 14/14, logic-interface 4/8, mcu 4/10, power-discrete 4/10,
connector 0/6, memory-fpga 0/5, radhard-specialist 0/6.  TOTAL 34/67 = 51%.

### Bug it caught immediately
282836-2 (TE Connectivity connector) was being CLAIMED by Texas Instruments and sent to ti.com,
because the manufacturer hint match was a substring test and "connecTIvity" contains "ti". Short
aliases now require whole-string match; corporate suffixes ("Texas Instruments Inc.") are stripped.
This had been live through several passes and passed every test run. It took a measurement to see.

### What the miss list says about next steps
The largest miss categories (Microchip, NXP) are NOT addressable by URL pattern, since both are
document-numbered. Closing them needs vendor product-page parsing or an accepted limit. Connectors
remain 0% and are the most valuable gap.


## Layer 1 remaining security pass (2026-07-22)

126 tests, `tsc --noEmit` clean. Prompted by "can someone make us download a virus" (answer: no,
verified: magic-byte check, bytes never reach the browser, no code execution on any input).

### Fixed
- api/export/route.ts     Content-Disposition header injection: part number was interpolated with a
                          weak sanitizer, allowing CR/LF and quote injection. Now sanitizeFileName +
                          ASCII quoted token + RFC 5987 filename*. Also added rate limit, body-size
                          cap, and maxDuration to match the other routes.
- next.config.ts          App-wide security headers: CSP (script-src self, connect-src self),
                          X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy.
- api/lookup, api/parse   maxDuration cap so a slow request cannot pin a serverless function open.

### Flagged for Layer 3 (NOT fixed, out of scope)
partNumber flows UNSANITIZED into generated STEP/KiCad files in lib/exporters.ts (FILE_NAME,
PRODUCT, KiCad property s-expressions). A crafted part number could inject content into a generated
CAD file. Belongs with Layer 3 hardening; sanitize at the boundary before writing, same principle
as finalizeRef.

### Still open (documented tradeoffs)
Per-process rate limiting, DNS-rebinding TOCTOU, PDF/zip bombs (a Layer 2 parse concern).


## Layer 1 audit close-out (2026-07-22)

130 tests, `tsc --noEmit` clean. Answering "is Layer 1 done" by verifying rather than asserting.

### Gap closed: the ITAR invariant was untested
The parse route's cloud-extractor (Gemini) gate was correct but had NO test. Added:
- air-gapped upload WITH a key set asserts method="regex" and zero network calls (mode wins over key)
- commercial-without-key falls back to local parser (gate is commercial AND key)
- structural test: parse route reaches Gemini only via dynamic import in a commercial branch, so the
  cloud module never loads in air-gapped mode

### Gap closed: the air-gap scan could rot
AIR_GAP_SAFE was hand-maintained. Added a test that enumerates every .ts in the retrieval root and
fails if one is not covered, so the scan cannot silently fall out of date.

### Audited clean (no change): config route (mode only, not sensitive), no CORS (same-origin),
POST-only mutating routes, zod validation on all body routes, no secrets in logs.

### Remaining (documented tradeoffs, not oversights)
Per-process rate limiting, DNS-rebinding TOCTOU, zip/PDF bombs (Layer 2). Cross-layer flags:
partNumber into generated CAD files (Layer 3), parser/VLM resource limits (Layer 2).


## Layer 1: close the CAD injection, move deferrals to a planning doc (2026-07-22)

134 tests, all green, `tsc --noEmit` clean.

### Fixed (real security hole)
- src/lib/exporters.ts   A crafted part number (from a Layer 1 lookup) could break out of the quoted
  string literals in generated STEP (single-quote) and KiCad (double-quote) files, injecting
  structure into a CAD file. Added format-correct escapers (stepString doubles quotes; kicadString
  backslash-escapes and strips newlines) at every raw sink.
- src/lib/__tests__/cadgen-injection.test.ts   real break-out payloads for each format, green.

### Deferred items now live in DEFERRED.md, not in tests
An earlier attempt enforced deferrals with tests. That was wrong: the goal is green CI on every
merge, and a test meant to nag about future work fights that and adds noise. Removed that mechanism
(deferred-obligations.test.ts) and wrote DEFERRED.md at the repo root instead: a scoped backlog with
what/why/how-to-close/proof for each item, which a future session reads and acts on. Nothing turns
CI red.

DEFERRED.md covers: distributed rate limiting (P1), SSRF DNS pinning (P1), Layer 2 parser resource
limits (P2), live production search-block measurement (P2), and observability (P3).

## Layer 1: fix a flaky-test race found during final verification (2026-07-22)

134 tests, stable across repeated runs (was intermittently reporting cancellations).

### The defect
The rate limiters are module singletons. node:test runs test FILES in parallel, so the rate-limit
route tests in route.test.ts consumed (and were consumed by) the same limiter state as any other
file's route calls. Result: occasional "cancelled" tests, i.e. a flaky suite. Flaky tests are worse
than a missing test, because they train a team to ignore red CI.

### The fix (dependency injection, not a band-aid)
Added a test-only override seam to ratelimit.ts (__setLimiterOverrides + activeLookupLimiter /
activeUploadLimiter accessors). Production always uses the singletons; tests inject isolated
RateLimiter instances so no state is shared across files. Verified stable over 5 consecutive full
runs.
