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
Commercial path is a `CompositeResolver`: Nexar primary, Scrape fallback.
- Nexar (`resolvers/nexar.ts`): primary, adapted from ARCHITECTURE.md. `isConfigured()` gates
  on credentials; with none set it reports not-ready and the composite skips it.
- Scrape (`resolvers/scrape.ts`): the old MVP DuckDuckGo + TI-URL logic, demoted to last resort.
  Its only job is to not regress the TI demo. It will mostly miss on the real rad-hard vendors
  (Cobham, Teledyne e2v, VORAGO, Microchip rad-hard); that is expected and fine, the real paths
  are Nexar and upload.
- FUTURE: DigiKey and Mouser resolvers drop into the composite behind the same interface. Not
  in scope now.

### Composite failure semantics
Three distinct outcomes per resolver:
- not ready (`isConfigured()` false): skipped silently.
- not found (`resolve` returns null): try the next.
- failure (`resolve` throws): remembered, try the next.

Failures are typed hard vs soft (see error taxonomy). After the loop:
- a datasheet was found: return it.
- a hard error occurred and nothing was found: throw an aggregate error, so a real misconfig
  (bad Nexar creds, broken response) surfaces to the operator.
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
}
```

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

## Blocked on Nexar credentials
Cannot confirm until the free Welcome 1K account exists: that `supSearchMpn` and
`bestDatasheet.url` are present on that plan tier, whether datasheet URLs are directly fetchable
or sit behind an Octopart redirect with anti-bot, and the exact 429 response shape. Plan: build
against a committed fixture of the GraphQL response, keep the query isolated so a field rename is
one line, and validate live the day creds land. See the "verify in Nitro IDE" checklist below.

Nitro IDE checklist:
1. `supSearchMpn(q, limit, country)` exists and returns `results[].part`.
2. `part.bestDatasheet.url` is populated for LMP7704-SP.
3. The datasheet URL is directly fetchable (no login, no anti-bot interstitial).
4. Rate-limit responses: status code and body shape (for the 429 -> soft mapping).
5. OAuth2 client-credentials token endpoint and `supply` scope behave as in the reference impl.

## Test and CI plan
- Unit: deployment defaults, upload validation, filename sanitize, pdf assert, hash stability,
  finalizeRef, composite semantics (skip / null / soft / hard), Nexar isConfigured + resolve via
  stubbed fetch, factory air-gap null, air-gap source scan.
- Integration: real LMP7704-SP bytes through finalizeRef into the parser.
- Route-level: POST handlers with mocked mode and fetch, including a rad-hard part Nexar misses
  degrading cleanly to `DATASHEET_NOT_FOUND`.
- Timeouts: abort fires and maps to a soft failure.
- CI gates (merge-blocking): the air-gap source scan, and a corpus allowlist check that
  `test-data/` holds only known-public part numbers, so no customer datasheet is ever committed.

## Sequence
Contracts and helpers first (this pass), then wire them through upload, resolvers, and routes,
then Nexar hardening as far as creds allow, then `/api/config` and the client surfacing, then the
route-level and CI test expansion. Build-time exclusion and DigiKey/Mouser are explicit
fast-follows after the layer is solid.
