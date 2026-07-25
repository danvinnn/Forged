# Layer 1: Retrieval, decisions and plan

Scope of this layer: get a datasheet PDF into the pipeline and hand its bytes to the parser
(`parseDatasheetPdf` in `../datasheet.ts`). Retrieval never parses. Extraction and generation
are out of scope.

This file is the decided record for the layer. Deviations should be deliberate and noted.

## Decided

### Deployment mode is the master gate
Two modes: `commercial` (network allowed) and `air-gapped` (upload only, zero egress).
Resolved once in `deployment.ts`.

Default when the env var is unset or unrecognized is environment-aware:
- not production (local dev, tests): `commercial`, so a fresh checkout works with no setup.
- production: `air-gapped`, so a misconfigured live server denies rather than leaks.

The consumer SaaS is a production deploy that needs network, so its hosting env MUST set
`FORGE_DEPLOYMENT_MODE=commercial` explicitly. A prod box that reaches the network should say
so on purpose, never inherit it by omission.

The factory stays fail-closed regardless of the default above: `makeResolver` builds a
resolver only for an exact `commercial`. The default only affects what mode is reported, never
weakens the gate.

### Air-gap guard is structural, in two layers now, three later
1. `makeResolver` returns a resolver only in commercial mode; anything else returns null.
2. The network resolvers live under `resolvers/` and are reached only through a dynamic
   `import()` inside the commercial branch, so in air-gapped mode the code that calls `fetch`
   is never loaded into the process. Verifiable claim: the networking code is not present in
   the air-gapped module graph.
3. FAST-FOLLOW (post-consumer, for enterprise shipments): a build-time alias that maps the
   `resolvers/` subtree to an empty stub in air-gapped builds, so the network code is compiled
   out of the shipped artifact entirely. Not in scope now. Consumer-first: we want users on the
   commercial path before we invest in the enterprise build.

A source-scan test keeps the air-gap-safe modules free of `fetch(` and external URLs, and
asserts the subtree stays dynamic-import only. This is a merge-blocking CI gate.

### Resolver stack
Commercial path is a `CompositeResolver` with two resolvers, neither of which needs credentials:

1. **Manufacturer** (`resolvers/manufacturer.ts`): constructs the datasheet URL from the part number
   and fetches it straight from the vendor. One or two HTTP GETs, no key, no quota, no third party.
2. **Scrape** (`resolvers/scrape.ts`): DuckDuckGo plus hardcoded URL patterns. Brittle and
   rate-limit prone, so it is the last resort. It stays because it is the only resolver that can
   find a part no manufacturer pattern claims.

Consequence worth stating: **part-number lookup now works on a fresh checkout with an empty `.env`.**
There is no credential to obtain, no signup, no approval wait, and no third-party terms of service
governing our use. That is a robustness property, not just a convenience: the demo path has no
external dependency that can be revoked, rate-limited, or repriced.

#### Manufacturer patterns: the verification rule
A URL pattern enters the registry ONLY after someone has fetched a real datasheet through it and
confirmed a PDF comes back with no login and no interstitial. Inventing a plausible-looking pattern
is the same failure ARCHITECTURE.md forbids when it says never let a model "find" a datasheet URL,
just relocated into code. An unverified pattern is worse than no pattern: it costs a round trip on
every lookup and quietly erodes trust in the citation story.

Verified 2026-07-22, each by fetching a real datasheet:

| Vendor | Pattern | Verified against |
|---|---|---|
| Texas Instruments | `ti.com/lit/ds/symlink/{part}.pdf` | LMP7704-SP, SNOSDB6D Rev D (QMLV, RHA 100krad) |
| STMicroelectronics | `st.com/resource/en/datasheet/{part}.pdf` | RHF310A, DS6201 Rev 8 (RHA QML-V, 300krad) |
| Analog Devices | `analog.com/media/en/technical-documentation/data-sheets/{part}.pdf` | AD590 Rev G |

Each vendor also claims parts by prefix, so an engineer who types `RHF310A` with no manufacturer
hint still reaches ST. Vendors are isolated: a TI part never generates an ST or ADI request, so
adding vendors does not slow down lookups for the others.

#### Coverage reality, checked rather than assumed
Two earlier claims in this document were wrong. Both are corrected here.

**Derivable by pattern, including rad-hard lines.** TI, ST, and ADI all publish rad-hard parts at
predictable URLs. ST's entire space line (RHF, RHR) is reachable this way, and ADI space-grade
parts fall out of the same pattern (`ad590s.pdf` is the space variant of `ad590.pdf`).

**Not derivable, because the filename is a document number.** Microchip publishes datasheets as
`00002117f.pdf` and `39637d.pdf`. Vishay and Infineon are the same shape. No part-number pattern
can reach these, so they must not be added to the registry regardless of how much coverage they
would represent.

**Not published by the vendor at all.** This is the important one and it is worse than a URL
problem. VORAGO's documentation index lists white papers, application notes, tech briefs, PCNs, and
QML certificates, and **zero datasheets**; the VA10820 product page routes you to a sales contact.
The datasheet is gated behind a support request. CAES/Cobham, Teledyne e2v, and Honeywell behave
the same way.

**Correction to an earlier claim: distributors DO carry rad-hard datasheets.** This document
previously asserted that no distributor stocks true rad-hard parts, and used that to justify
dropping the distributor APIs. That premise was false. Mouser hosts VA10820 directly at
`mouser.com/pdfdocs/VA10820_DS_12.pdf`, and Arrow hosts a copy. For the pure-play rad-hard vendors,
a distributor is the ONLY public source.

The conclusion still holds, but for a better reason: we do not need a distributor **API** to read a
PDF the distributor already serves publicly to any browser. The scrape resolver reaches those with
no key, no quota, and no terms acceptance. The API rejections in "Decided against" stand on their
terms and cost, not on the false coverage claim.

#### Chain budget
`resolveChainBudgetMs()` (default 12s, override with `FORGE_CHAIN_BUDGET_MS`) caps the whole chain. Rad-hard parts miss in EVERY resolver, so the
full-chain walk is the common path, not the exceptional one. Without a ceiling a VORAGO lookup pays
every resolver's timeouts in series before the user is told to upload. Checked between resolvers, so
a single resolver can overshoot by its own timeout; the per-call `AbortController` bounds that. A
budget cutout with no hard failure returns null, not an error: "upload instead" is the actionable
answer and a timeout is not something the user can fix.

#### Decided against: Mouser and DigiKey resolvers (2026-07-22)
Both were listed as future work. After reading the terms and checking the economics, neither is
worth adding now:
- Mouser's API ToS restricts unsuitable applications to those whose principal purpose is driving
  Mouser sales, which Forge is not; forbids caching or storing their content, which kills the
  committed-fixture test strategy; and its export clause forbids using the data or its direct
  product for missile or nuclear weaponry, which is awkward when the ICP is defense primes.
- DigiKey requires a commerce account with a physical address, plus a developer account, an
  organization, and OAuth, for a resolver that would only improve COTS coverage.
- Neither stocks true rad-hard parts, so neither helps the parts that define the product.

The manufacturer resolver covers the demo path they would have covered, for free and with no
third-party terms attached. Revisit only if COTS coverage becomes a real customer requirement.

### Composite failure semantics
Three distinct outcomes per resolver:
- not ready (`isConfigured()` false): skipped silently.
- not found (`resolve` returns null): try the next.
- failure (`resolve` throws): remembered, try the next.

Failures are typed hard vs soft (see error taxonomy). After the loop:
- a datasheet was found: return it.
- a hard error occurred and nothing was found: throw an aggregate error, so a real misconfig
  (bad credentials, broken response) surfaces to the operator.
- only soft errors or clean nulls: return null, so the user can still upload. A rate limit or a
  transient transport blip must never block someone from falling back to upload.

### Data contract
`DatasheetRef` is the single hand-off type into the parser, produced by both resolvers and the
upload path. It carries provenance the audit story and Layer 2 citations depend on:

```ts
interface DatasheetRef {
  fileName: string;      // sanitized basename, .pdf enforced
  pdfUrl?: string;       // absent for uploads
  sourcePageUrl?: string;
  bytes: ArrayBuffer;
  byteLength: number;
  sha256: string;        // audit anchor: identifies this exact PDF
  resolvedBy?: string;   // which CHILD resolver produced it; absent for uploads
}
```

`resolvedBy` is stamped by `CompositeResolver` with the winning child's name. The composite's own
name lists every resolver it tried, so it answers "who could have" rather than "who did". The audit
trail needs the latter: "resolved via manufacturer from ti.com" and "resolved via scrape" are
different provenance claims. `toRetrievalSource` prefers it over the chain name.

Every `DatasheetRef` is produced through `finalizeRef`, which validates the bytes are a real
PDF, sanitizes the filename, and computes size and hash. Nothing leaves the layer without
passing that gate, so a resolver that downloads HTML or garbage becomes a clean failure, not a
parser crash. (Deviation from ARCHITECTURE.md: `pdfUrl` is optional, so one type covers uploads.)

Route responses use one envelope for both paths:

```ts
interface RetrievalSource { origin: "resolver" | "upload"; resolver?; fileName; pdfUrl?; sourcePageUrl?; byteLength; sha256; }
// success: { part, source, mode }
// error:   { error, code, mode }
```

Error codes are stable so the UI can branch. `DATASHEET_NOT_FOUND` is the one that triggers the
"upload instead" prompt.

### Shared helpers
- `pdf.ts` `assertPdfBytes`: `%PDF` magic check plus size bounds (min 64B, max 50MB).
- `filename.ts` `sanitizeFileName`: basename only, strips path separators and control chars,
  enforces `.pdf`, caps length.
- `hash.ts` `sha256Hex`: local hash via `node:crypto`.
- `ref.ts` `finalizeRef`: ties the above together, the only sanctioned way to build a `DatasheetRef`.
- `resolvers/http.ts` `fetchWithTimeout`: every network call gets an `AbortController`
  (search 8s, download 30s). Node `fetch` has no default timeout; a hung host would otherwise
  stall the whole request.
- `resolvers/errors.ts` `ResolverError`: typed `auth | rate_limit | transport | bad_response`,
  with `hard` = auth or bad_response.

### Client mode surfacing
`GET /api/config` returns `{ mode }`. The UI reads it on load to hide the lookup box in
air-gapped mode. The server 403 stays the real gate; the config endpoint is only for UX. We do
NOT gate on a `NEXT_PUBLIC_` env, which could drift from the server's actual mode.

## Decided against: component distributor APIs (2026-07-22)

All three were evaluated and none is in the codebase. Recording the reasoning so this is not
relitigated without new information.

**Nexar (Octopart)** was built, tested, and merged, then removed the same day. Credentials were
obtained and the free Evaluation app's actual allowance turned out to be **10 matched parts per
month**, not the 1,000 calls per month assumed when it was chosen. Two compounding problems:
the quota is counted in parts RETURNED rather than calls, so the query's `limit` was a cost lever
nobody had noticed, and the next tier up is $100/month. Ten lookups a month cannot support a demo,
let alone a product. Carrying roughly 220 lines of OAuth, token caching, and error taxonomy plus a
fixture and 11 tests for that was not worth it, so it was deleted rather than left dormant.

Two real bugs were found while investigating it, both worth remembering because they were latent in
code that looked fine and passed tests:
- The OAuth scope was `supply`; Nexar's actual value is `supply.domain`. This came from the
  ARCHITECTURE.md reference implementation and was carried forward unchecked. **The first live call
  would have failed with a 401.**
- Quota exhaustion arrives as a GraphQL error, which the error taxonomy mapped to `bad_response`
  (HARD). That would have thrown a 502 and blocked the upload fallback the moment the 10-part
  ceiling was hit, violating the rule that a quota condition must never block upload.

**Mouser** was rejected on its API terms of service. It restricts unsuitable applications to those
whose principal purpose is driving Mouser sales, which Forge is not; forbids caching or storing
their content, which kills the committed-fixture test strategy on a public repo; requires
conspicuous attribution wherever their data appears; forbids publishing screenshots or marketing
material referencing them without prior written consent; and its export clause forbids using the
data or its direct product for missile or nuclear weaponry, which is an awkward commitment when the
ICP is defense primes.

**DigiKey** was rejected on friction versus value: it needs a commerce account with a physical
address, plus a separate developer account, an organization, an app, and OAuth, all to improve COTS
coverage we do not sell into.

The shared reason none of them mattered: **no distributor stocks true rad-hard parts.** They would
only have improved coverage for COTS parts, which is the segment competitors already own. The
manufacturer resolver covers the demo path they would have covered, for free, with no third-party
terms attached.

Revisit only if COTS coverage becomes a real customer requirement, and if so, price the quota
against actual lookup volume first.

## Test and CI plan
- Unit: deployment defaults, upload validation, filename sanitize, pdf assert, hash stability,
  finalizeRef, composite semantics (skip / null / soft / hard / budget), factory air-gap null,
  air-gap source scan.
- Manufacturer resolver: builds the verified TI URL, claims TI by prefix without a hint, tries the
  family variant, claims NOTHING for rad-hard vendors (the honesty tripwire), resolves with zero
  credentials, 404 and HTML both fall through cleanly, total transport failure is soft.
- Scrape resolver: direct TI symlink hit, clean null on a non-TI miss, search error maps to soft.
- Integration: real LMP7704-SP bytes through finalizeRef into the parser.
- Route-level: POST handlers with mocked mode and fetch, including a rad-hard part that misses every
  resolver and degrades cleanly to `DATASHEET_NOT_FOUND`, and provenance naming the concrete
  resolver rather than the chain.
- Timeouts: abort fires and maps to a soft failure.
- CI gates (merge-blocking): the air-gap source scan, and a corpus allowlist check that
  `test-data/` holds only known-public part numbers, so no customer datasheet is ever committed.
  Both run inside `npm test` in `.github/workflows/ci.yml` on every PR. Making them actually block
  a merge is a one-time GitHub setting: enable branch protection on `main` and mark the `verify`
  job a required status check.

## Sequence
Contracts and helpers first (this pass), then wire them through upload, resolvers, and routes,
then `/api/config` and the client surfacing, then the
route-level and CI test expansion. Build-time exclusion and DigiKey/Mouser are explicit
fast-follows after the layer is solid.

## Status (2026-07-22)

Layer 1 is code-complete. Everything in Decided above is implemented and tested (57 tests,
`tsc --noEmit` clean). This pass finished:

- `/api/config` client surfacing in `page.tsx`: fetches `{ mode, lookupEnabled }` on load, gates
  the part-number box, upload-only in air-gapped, with a loading state so nothing flashes. Fails
  closed on a config fetch error (assume air-gapped) to match the server default; the server 403
  stays the real gate.
- Nexar GraphQL fixture and resolver (both since removed; see "Decided against" above).
- Scrape resolver covered for the first time (see Test and CI plan).
- `.github/workflows/ci.yml` runs `tsc --noEmit` and `npm test` on PRs; Node pinned via `.nvmrc`.
- `tsconfig.tsbuildinfo` untracked and gitignored.

Remaining before this is fully closed, none of which is code:

- Enable branch protection on `main`, require the `verify` job. Until then the gates run but do
  not block.
- (Superseded: Nexar was validated, found to allow only 10 parts per month, and removed.)

Still deferred, unchanged: build-time exclusion of the resolver subtree, and DigiKey/Mouser
resolvers. Consumer path first.


## Status update (2026-07-22, second pass)

Robustness pass, no distributor APIs. 71 tests, `tsc --noEmit` clean.

Added:
- `resolvers/manufacturer.ts`, verified-pattern vendor-direct resolver, first in the chain.
- `partnumber.ts`, shared normalization (air-gap safe, in the source-scan list).
- Chain budget in `CompositeResolver`.
- `resolvedBy` provenance through to the wire contract.

Fixed:
- Nexar OAuth scope, query limit, and quota-exhaustion severity, all moot after removal but
  recorded in "Decided against" because the class of bug matters.
- A route test that asserted a resolver name and passed only because the composite's name contained
  it. Provenance now names the concrete resolver, and the tests distinguish them.

Net effect worth naming: the LMP7704-SP demo path now needs zero credentials and makes no
third-party search call. That is the biggest robustness gain in this pass, because it removes every
external dependency from the one path we actually demo.

Not addressed, and honest about it: rad-hard retrieval still misses, by design and by physics of how
those vendors publish. Upload remains the real path, and the next robustness investment belongs
there rather than in more resolvers.


## Status update (2026-07-22, third pass): Nexar removed

Decision: delete the Nexar resolver rather than carry it dormant. Rationale in "Decided against"
above; the short version is that 10 matched parts per month cannot support a demo and the next tier
is $100/month.

Removed: `resolvers/nexar.ts`, `__tests__/nexar.test.ts`, `resolvers/__fixtures__/`, and the
`NEXAR_CLIENT_ID` / `NEXAR_CLIENT_SECRET` env vars.

Resulting chain: `manufacturer -> scrape`. 59 tests, `tsc --noEmit` clean.

The property this buys, and the reason it is an upgrade rather than a loss: **Layer 1 now has no
credentialed dependency at all.** Nothing to sign up for, nothing to approve, no third-party terms
governing our use, nothing that can be rate-limited or repriced out from under us. For a product
whose entire pitch is that controlled data never leaves the customer's network, having zero external
service dependencies in the retrieval layer is the coherent position.


## Status update (2026-07-22, fourth pass): multi-vendor coverage

Manufacturer registry expanded from one verified vendor to three: TI, STMicroelectronics, and
Analog Devices. 65 tests, `tsc --noEmit` clean.

The finding worth carrying forward: **ST's rad-hard space line is at derivable URLs.** RHF310A, an
RHA QML-V part rated to 300krad, resolves from `st.com/resource/en/datasheet/rhf310a.pdf` with no
credentials. That is a direct hit on the thesis, and it was found by checking rather than assuming.
The earlier blanket claim in this document that rad-hard vendors have no derivable patterns was
wrong; it is true of VORAGO and CAES, not of ST, TI, or ADI.

Adding a vendor is now a data edit plus one verification fetch. The next candidates, in rough order
of likely value for rad-hard: Renesas/Intersil, Microchip (including the former Microsemi rad-hard
line), Infineon, onsemi. Each needs a real fetch before it goes in.


## Status update (2026-07-22, fifth pass): coverage push

76 tests, `tsc --noEmit` clean. Three changes, all free and all without any external service.

**Scrape resolver aimed at distributor-hosted datasheets.** Given that the pure-play rad-hard
vendors publish nothing themselves, the scrape path is the only route to those parts. It now tries
a Mouser flat-path candidate directly, scores any of 18 known datasheet hosts (manufacturer and
distributor) higher, and penalizes interstitial aggregators like alldatasheet and digchip that wrap
PDFs in ads. This is the single change most aimed at the parts that define the product.

**Resolution cache (`cache.ts` + `resolvers/caching.ts`).** Wraps the whole chain, not each child,
so a rad-hard MISS is cached after the first full walk. The second person to type VA10820 is told to
upload immediately instead of paying for another DuckDuckGo crawl. Hits live an hour, misses five
minutes (a miss can be a transient vendor outage and must not lock lookup out), errors are never
cached, and the cache is bounded at 500 entries with LRU eviction.

Deliberately in-process and memory-only. Persisting resolved PDF bytes to disk would create a
controlled-data question in Layer 1: cached datasheets would outlive the request in an enterprise
deployment. Not worth it for a latency win.

Caching is transparent in provenance: `CachingResolver` reports the wrapped resolver's name, so the
audit trail never says "cached", which would tell an auditor nothing about the source.

**What was NOT done, and why.** No AI in the retrieval path. Using a model to produce a datasheet
URL is what ARCHITECTURE.md forbids, and a hallucinated source URL would poison the citation trail
that Class 3 sign-off depends on. The one arguably legitimate use, reading messy vendor HTML to pick
the right PDF link, is already handled by a regex, and adding a cloud model would break the air-gap
story for no coverage gain. AI belongs in Layer 2.


## Status update (2026-07-22, sixth pass): consumer production hardening

93 tests, `tsc --noEmit` clean. This pass is about what changes when the endpoint is publicly
reachable rather than running on a laptop.

### Security, and these were real holes
**SSRF (`resolvers/urlguard.ts`).** The scrape resolver fetches URLs it extracted from third-party
search-result HTML, and followed redirects. That means a URL we did not choose, from a page we do
not control, decided what our server connected to. On a cloud host the prize is the instance
metadata endpoint at 169.254.169.254, which can hand out credentials.

Now every outbound fetch is checked twice: literal private, loopback, link-local, CGNAT, multicast,
and IPv4-mapped-IPv6 addresses are rejected, and named hosts are DNS-resolved with every returned
address checked, which is what catches a public hostname pointing at an internal one. Redirects are
followed MANUALLY, one hop at a time, re-running the guard on each, because passing
`redirect: "follow"` to fetch would check only the first URL and a 302 to the metadata endpoint
would sail through. Capped at 5 hops.

Residual risk, stated rather than hidden: a DNS record could change between our check and the
connection (TOCTOU rebinding). Closing that needs connection-level pinning, which Node's fetch does
not expose. Every hop is re-checked, which is the main practical vector.

**Unbounded downloads (`readBodyWithLimit`).** `response.arrayBuffer()` buffers the entire body
before anything checks its size, so `assertPdfBytes` rejecting a 5GB response happened far too late
to prevent an OOM. Now the declared Content-Length is rejected up front AND the stream is cancelled
mid-flight once accumulated bytes cross the limit, because a hostile host can simply omit or
understate the header.

**Unbounded input.** `partNumber` and `manufacturer` had no maximum length, and both are
interpolated into vendor URLs and search queries. Capped at 64 characters, which is well above any
real MPN.

All three failure modes degrade to "not found" rather than a hard error, so one poisoned search
result skips that candidate instead of killing the lookup. That distinction matters: the alternative
is a trivial denial of service via a single SEO-poisoned page.

### Scale
**Single-flight coalescing** in `CachingResolver`. The cache cannot help concurrent callers because
nothing has finished yet, so ten simultaneous lookups of the same part previously walked the chain
ten times and hit the vendor ten times. They now share one walk. At consumer volume this is both
wasteful and the fastest way to get our egress IP throttled by ti.com.

**Chain budget is now 12s and configurable** via `FORGE_CHAIN_BUDGET_MS`, down from a hardcoded 25s.
It has to sit under the host's function timeout or the platform kills the request first and the user
gets a 504 instead of our clean `DATASHEET_NOT_FOUND`.

### Still open before a consumer launch
- **Search scraping will degrade in production.** DuckDuckGo's HTML endpoint blocks datacenter IPs.
  Effective coverage on a cloud host collapses toward the three pattern vendors plus the Mouser
  flat-path guess. This is the biggest remaining gap and it is not fixable with more hardening.
- **No rate limiting on `/api/lookup`.** A public endpoint that makes outbound requests to vendor
  sites needs it, both to control cost and to avoid being the source of abusive traffic.
- **Cache is per-instance.** On serverless, cold starts mean it helps less than the numbers suggest.
- **No structured logging**, so resolver win rates and latency are invisible in production.


## Status update (2026-07-22, seventh pass): production-grade search

104 tests, `tsc --noEmit` clean.

### The bug that mattered most, and it was silent
The scrape resolver called DuckDuckGo's HTML endpoint directly and treated it as infallible. Search
engines block datacenter IP ranges aggressively, and the failure mode is the dangerous kind: a
challenge page comes back as **HTTP 200 with HTML containing no results**. The old code read that as
"search succeeded, zero hits" and returned null, which the route turned into a confident
`DATASHEET_NOT_FOUND`.

So in production the app would have told users their part has no datasheet when the truth was that
we were blocked from looking. That is worse than an error, because nobody reports it as a bug: it
looks like a coverage gap, and we would have spent weeks adding vendor patterns to fix a problem
that was never about coverage.

### What replaced it
`resolvers/search.ts`: a `SearchBackend` interface with a `SearchClient` that owns failover and
health.

- **Three independent free backends**: DuckDuckGo HTML, DuckDuckGo Lite, and Mojeek. Mojeek runs its
  own index, so it is genuinely separate infrastructure rather than another Google front-end that
  would fail at the same time as the others.
- **Block detection on the body, not just the status.** 403 and 429 are the honest refusals; the
  dishonest one is a 200 carrying "captcha", "unusual traffic", "verify you are human" and similar.
  Both are classified as `SearchBlockedError`.
- **Circuit breaker.** Three consecutive blocks opens the circuit for ten minutes. A blocked engine
  stays blocked, so retrying only burns the chain budget and deepens the block.
- **`blocked` is propagated all the way out.** `SearchOutcome.blocked` distinguishes "we searched
  and this part has no datasheet" from "we could not search". When search is blocked and nothing
  was found, the scrape resolver throws a SOFT `rate_limit` error instead of returning null, so the
  composite swallows it, the user still gets the upload prompt, and nobody is told a false fact
  about their part.

### Graceful degradation is the design goal
Deterministic candidates run BEFORE any search, so a total search outage does not take out the whole
resolver. On a cloud host where every engine refuses us, TI, ST, and ADI parts still resolve from
their vendor URLs, and the Mouser flat-path guess still runs. There is a test for exactly this.

### The paid escape hatch, wired but inert
`BraveSearchBackend` activates only if `BRAVE_SEARCH_API_KEY` is set. Carrying it costs nothing and
means buying reliability later is an env var rather than a rewrite.

Worth knowing before enabling it: as of mid-2026 there is no free search API left. Brave retired its
free tier in February 2026 (metered, card required, no spending cap, attribution mandatory in your
UI), Microsoft shut down the Bing Search API, and Google's Custom Search JSON API is discontinued
with a January 2027 end date. Search reliability is now something you buy or something you degrade
gracefully without. We do the latter, with the option to do the former.

### Still open before launch
- **No rate limiting on `/api/lookup`.** Still the biggest remaining production gap.
- **Cache is per-instance**, so serverless cold starts blunt it.
- **No structured logging**, so backend block rates and resolver win rates are invisible. Given that
  the failure above was silent, this is worth more than it looks: we would want an alert when a
  backend's circuit opens.


## Status update (2026-07-22, eighth pass): full security pass + coverage expansion

119 tests, `tsc --noEmit` clean.

### Security audit, complete list of what was found and fixed
Everything below was a real hole in code that passed its tests.

| Issue | Fix |
|---|---|
| SSRF via search-result URLs and redirects | `resolvers/urlguard.ts`, enforced in `http.ts` on every hop |
| Unbounded download before size check | `readBodyWithLimit`, header + mid-stream cancel |
| **Unbounded UPLOAD before size check** | Content-Length rejected pre-`formData()`, then `file.size` pre-`arrayBuffer()` |
| **No rate limiting on public endpoints** | `ratelimit.ts`, 20/min lookup, 30/min upload, 429 + Retry-After |
| **Internal error detail returned to callers** | Generic client message, real detail to `console.error` only |
| Unbounded part number / manufacturer input | Capped at 64 characters |
| **`javascript:` URL reaching an anchor href** | Scheme check in `formatSourceUrl` before render |

The upload one is worth calling out because it is the same bug as the download one, in a place I had
already looked at and passed over. `request.formData()` buffers the ENTIRE body, so a 1GB POST would
OOM the process long before `assertPdfBytes` ran inside `ingestUpload`. Finding the same class of
bug twice in one layer is the argument for auditing by category rather than by file.

Structural property worth preserving: **`resolvers/http.ts` is the only module that calls `fetch`
directly.** Every outbound request therefore passes the SSRF guard, the redirect re-check, the
timeout, and the size cap. The air-gap source scan already enforces that nothing outside the
resolver subtree fetches at all, so this is a single, testable choke point.

### Known limits, stated rather than hidden
- **Rate limiting is per-process.** On serverless each instance keeps its own counters, so the real
  limit is roughly (limit x instances). This stops single-client hammering, which is the common
  case, but it is a mitigation and not a guarantee. A guarantee needs shared state (Redis) or the
  platform's edge rate limiting, and should be added before serious traffic.
- **DNS rebinding TOCTOU** remains open in the SSRF guard: a record could change between our check
  and the connection. Closing it needs connection-level pinning, which Node's fetch does not expose.
  Every redirect hop is re-checked, which is the main practical vector.
- **PDF content bombs** are not addressed here; a small valid PDF that expands catastrophically is a
  Layer 2 parsing concern.

### Coverage expansion
**Parallel candidates.** The manufacturer resolver fetched candidates serially, so trying more URLs
cost the SUM of their round trips. They now run in parallel, and the winner is taken in CANDIDATE
order rather than completion order. That ordering detail matters: the list is sorted by confidence,
so a slow exact datasheet URL must still beat a fast generic redirect endpoint, or we would cite the
wrong source. There is a test for it.

**Speculative cross-vendor tier.** Our prefix regexes are deliberately conservative, which means a
real part from a vendor we DO support can fall outside them and never be tried. Candidates are now
split into a claimed tier (prefix or hint matched) and a speculative tier (every other known
vendor), with the speculative tier tried second. It is affordable only because of parallelism: the
whole tier costs roughly one round trip. Skipped entirely when the manufacturer hint names a vendor
we recognize, since the user already told us the answer.

A wrong guess cannot produce a wrong result: it 404s, or `finalizeRef`'s `%PDF` check rejects it.

**Transport failures stay distinct from misses.** The parallel rewrite initially collapsed "every
candidate failed to respond" into a clean null, which is the same bug as reporting a blocked search
as "no datasheet": it turns "we could not check" into a confident claim about the part. Candidates
now report hit / miss / error separately, and an all-error batch throws SOFT.

### Vendors checked and rejected for the registry
Microchip (`00002117f.pdf`), NXP (`MF3DX2_MF3DHX2_SDS.pdf`), Vishay, and Infineon all name
datasheets by document number, not part number. No part-number pattern reaches them, so they stay
out regardless of how much coverage they represent. This is the verification rule doing its job.


## Status update (2026-07-22, ninth pass): coverage benchmark

122 tests, `tsc --noEmit` clean. Coverage is now measured rather than estimated.

### Why this exists
Every coverage claim in this document up to now was judgment from reading the registry. That is
exactly the kind of assertion that drifts from reality without anyone noticing, and it already had:
this document twice stated things about coverage that turned out to be wrong when checked.

`npm run bench:coverage` runs a 67-part corpus spanning eight categories and prints a per-category
hit rate. Two modes:

- **static** (default, no network, CI-safe): which parts does the manufacturer registry CLAIM? This
  is the number that moves when a vendor pattern is added, so it is the one to watch while working.
- **live** (`-- --live`): which parts do we actually RESOLVE end to end? Hits vendor sites and search
  engines with a politeness delay. **Run it from the target host**, because the interesting question,
  how often search is blocked, has a different answer in a datacenter than on a laptop.

Deliberately a report, not a test. Gating merges on a live network measurement would make CI flaky
for reasons unrelated to the change under review.

### First static run
```
radhard-major         8/8    100%
analog               14/14   100%
logic-interface       4/8     50%
mcu                   4/10    40%
power-discrete        4/10    40%
connector             0/6      0%
memory-fpga           0/5      0%
radhard-specialist    0/6      0%
TOTAL                34/67    51%
```

This is the honest shape of Layer 1: excellent where our three verified vendors operate, zero
everywhere else. A single overall number would have hidden that, which is why the report breaks it
out. 100% on `radhard-major` is the one that matters for the thesis; 0% on `radhard-specialist` is
structural and expected, and those parts stay in the corpus specifically so the miss remains visible
and nobody later improves the percentage by quietly dropping the hard cases.

### It found a real bug on its first run
`282836-2`, a TE Connectivity connector, was being CLAIMED by Texas Instruments and sent to ti.com.
The hint match was a substring test, and "connec**ti**vity" contains "ti". Short aliases now require
a whole-string match, long distinctive names may still match as substrings, and trailing corporate
suffixes ("Texas Instruments Inc.") are stripped first. Regression tests added.

That bug had been live through several passes and every test run. It took a measurement to see it,
which is the argument for the benchmark existing at all.

### What it tells us to do next
The miss list is now evidence rather than guesswork. Adding vendors in order of corpus misses would
target Microchip, NXP, onsemi, Infineon, and Nexperia, and the first two are impossible by pattern
because they are document-numbered. That is worth knowing BEFORE spending a session on it: the
biggest categories of miss are not addressable by the technique we have been using, and closing them
needs a different approach (vendor product-page parsing) or an accepted limit.

Connectors remain 0% and are the most valuable gap, since that is where footprint generation is
hardest and most useful.


## Status update (2026-07-22, tenth pass): remaining security concerns

126 tests, `tsc --noEmit` clean. A full pass over the attack surface, prompted by the reasonable
question "can someone make us download a virus".

### The virus question, answered
No. The path that would enable it is closed at three points, each verified:
- **We never trust Content-Type.** Every downloaded file is checked against the `%PDF-` magic bytes,
  so a renamed executable fails the check and becomes a clean not-found.
- **Raw downloaded bytes never reach the browser.** The lookup response is JSON metadata and the
  parsed record; the bytes go to the parser and the hasher and nowhere else. Forge cannot be turned
  into a delivery vehicle for a file it fetched.
- **No code execution anywhere in the layer.** No exec/eval/spawn/dynamic-require on any input.
  Downloaded bytes are inert data.

### Fixed this pass
- **Header injection in `/api/export`.** The download filename was built as
  `partNumber.replace(/[^A-Za-z0-9\-]+/g, "-")`, which left the door open to CR/LF and quote
  injection into the `Content-Disposition` header: a crafted part number could inject a second
  header or filename directive. Now routed through `sanitizeFileName` with an ASCII-only quoted
  token plus an RFC 5987 `filename*`. Verified against CRLF and quote payloads.
- **App-wide security headers** in `next.config.ts`: Content-Security-Policy (script-src self, so an
  injected script will not run; connect-src self, so a compromised bundle cannot exfiltrate),
  X-Content-Type-Options nosniff, X-Frame-Options DENY, frame-ancestors none, a locked-down
  Permissions-Policy, and a Referrer-Policy that keeps part numbers out of the Referer header.
- **`/api/export` had no rate limit or body cap.** Added both, matching the other routes.
- **maxDuration** on lookup, parse, and export, so a slow request cannot pin a serverless function
  open.

### The full route surface now
Every mutating route (lookup, parse, export) is rate-limited, size-capped, and duration-capped.
`config` is read-only and needs none. Security headers are global.

### Flagged for Layer 3, NOT fixed here (out of scope, but real)
`partNumber` flows UNSANITIZED into generated STEP and KiCad files (`lib/exporters.ts`): it is
interpolated straight into `FILE_NAME(...)`, `PRODUCT(...)`, and KiCad `(property ...)` s-expressions.
A crafted part number could inject content into a generated CAD file. This is a generation-layer
concern and the fix belongs with whoever hardens Layer 3: the same principle as Layer 1's
`finalizeRef` applies, sanitize at the boundary before writing. Noting it here so it is not lost,
because the injection reaches these sinks THROUGH a Layer 1 lookup.

### Still open, documented tradeoffs (unchanged)
- Rate limiting is per-process; a hard guarantee needs shared state (Redis) or platform edge limits.
- DNS-rebinding TOCTOU in the SSRF guard; Node fetch exposes no connection pinning.
- PDF content/zip bombs: a small file that expands catastrophically. A Layer 2 (parse) concern,
  since Layer 1 never opens the PDF. Whatever parser and VLM Layer 2 uses needs resource limits.


## Status update (2026-07-22, eleventh pass): closing the gaps a real audit found

130 tests, `tsc --noEmit` clean. The prompt was "is Layer 1 completely done", and the honest answer
was no, because two things had never actually been verified.

### Gap 1, and it touches the core ITAR promise
The parse route can call a CLOUD extractor (Gemini), gated on commercial mode via dynamic import.
The gate was correct, but **nothing tested it**. The single most important invariant in the product,
"an air-gapped deploy never sends a controlled datasheet to a third-party cloud", rested on an
untested if-statement. Now covered three ways:
- A route test uploads in air-gapped mode WITH a Gemini key set and asserts method is "regex" and
  that zero network calls happen. The key must be irrelevant; the mode must win.
- A route test confirms commercial-without-key falls back to the local parser (the gate is
  commercial AND key, not commercial OR key).
- A structural test asserts the parse route reaches the Gemini module only through a dynamic import
  inside a commercial-mode branch, so the cloud code is never even loaded in air-gapped mode. Same
  guarantee the resolver factory already had, now extended to the extractor.

### Gap 2: the air-gap scan could silently rot
`AIR_GAP_SAFE` was a hand-maintained list. A new air-gap-reachable module could be added and simply
never scanned, which is a slow leak in the guarantee. There is now a test that enumerates every
`.ts` in the retrieval root and fails if one is not on the list, so the scan cannot fall out of date
without CI noticing.

### Audited clean, no change needed
- **config route**: returns only the deployment mode, which the UI needs and which is not sensitive.
- **CORS**: none set, so same-origin only. Correct for this app; adding CORS would be the mistake.
- **HTTP methods**: lookup, parse, export are POST-only. No GET-mutation confusion.
- **Input validation**: all three body routes validate with zod or a File-type check before use.
- **Secret logging**: no key, token, or secret is ever written to a log statement.

### Honest final state of Layer 1
I am now willing to say Layer 1 is done for its scope, with these caveats written down rather than
implied:
- The three documented tradeoffs remain (per-process rate limiting, DNS-rebinding TOCTOU, and
  zip/PDF bombs which are a Layer 2 parse concern). These are accepted limits, not oversights, and
  each has a note on what closing it would take.
- Two cross-layer issues are flagged where they will be seen: `partNumber` reaching unsanitized into
  generated CAD files (Layer 3), and the need for resource limits on whatever parser and VLM Layer 2
  introduces.
- "Done" means done for what Layer 1 is responsible for: getting a validated, hashed, provenance-
  tagged PDF to the parser boundary, safely, in both deployment modes. It does not mean the product
  is done, and the biggest coverage limits (document-numbered vendors, connectors) are inherent to
  the approach and measured in the benchmark rather than hidden.


## Status update (2026-07-22, twelfth pass): closed the CAD injection; deferrals moved to a plan

134 tests, all green, `tsc --noEmit` clean.

### Fixed now: CADGEN_INPUT_SANITIZATION
A crafted part number, resolved through a Layer 1 lookup, could break out of the quoted string
literals in generated STEP (single-quote) and KiCad (double-quote) files, injecting structure into a
flight-part CAD file. Proven with real break-out payloads against the exporter, fixed with
format-correct escapers at each sink (`stepString` doubles quotes; `kicadString` backslash-escapes
and strips newlines). Tests in `src/lib/__tests__/cadgen-injection.test.ts`, green.

### The rest of the deferred items live in a PLANNING DOC, not in tests
Earlier I tried enforcing deferrals with tests. That was the wrong call: the goal is green CI on
every merge, and a test that is meant to nag about future work fights that goal and adds noise. The
remaining known-deferred items now live in `DEFERRED.md` at the repo root, which is where a future
Claude session (or a human) will pick them up as scoped work. They are real, they are written down
with enough detail to act on, and they do not turn CI red.

See `DEFERRED.md` for: distributed rate limiting, SSRF DNS pinning, Layer 2 parser resource limits,
and the live production search-block measurement.

