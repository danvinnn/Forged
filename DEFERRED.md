# Deferred work

Known items identified but deliberately not done yet, with enough detail to execute directly. This
is the backlog a future Claude session (or a human) should read before picking up hardening or
Layer 2 work. Nothing here makes CI red; these are scoped tasks, not failing tests.

Each item lists: what, why it was deferred, how to close it, and how to prove it is done. When one is
completed, delete it from this file in the same PR that closes it, so this doc always reflects what
is still open.

Priority key: P1 = do before a real (non-demo) production launch. P2 = do when the relevant layer is
built. P3 = nice to have.

---

## P1: Distributed rate limiting

**What.** `src/lib/retrieval/ratelimit.ts` is an in-process fixed-window limiter. On a serverless or
multi-instance deploy, each instance keeps its own counters, so the effective limit is roughly
(limit x instances), and counters reset on every cold start.

**Why deferred.** Needs external infrastructure (a shared store), which is a deployment decision, not
a code-only change. The per-process limiter still stops single-client hammering, which is the common
abuse case, so this is an upgrade rather than a missing floor.

**How to close.** Back the limiter with shared state: Upstash Redis or Vercel KV are the low-friction
options on a typical Next.js host; the platform's own edge rate limiting is an alternative that needs
no app code. Keep the same `RateLimiter` interface so the routes do not change. The `clientKey`
logic (first `x-forwarded-for` entry, shared fallback bucket) stays as is.

**Proof.** Two instances (or two workers) sharing one limit: a client that exhausts the limit against
instance A is also refused by instance B. A test can assert this against a mocked shared store.

---

## P1: SSRF DNS pinning (rebinding TOCTOU)

**What.** `src/lib/retrieval/resolvers/urlguard.ts` resolves a hostname and checks every returned
address, and re-checks on every redirect hop. But between our DNS check and the actual connection,
the record can change (DNS rebinding), so a hostname that passed the check could still connect to an
internal address.

**Why deferred.** Closing it requires connecting to the specific validated IP rather than
re-resolving the hostname, and Node's global `fetch` does not expose connection-level control. This
is the main residual SSRF risk and it is narrow (the redirect re-check already covers the common
vector), but it is real.

**How to close.** Give `fetchWithTimeout` (in `resolvers/http.ts`) a custom `undici` Agent with a
`connect.lookup` override that returns only the already-validated IP, so the socket connects to the
IP the guard approved, not whatever DNS returns at connect time. Keep `assertFetchableUrl` as the
first gate; this adds the pinning underneath it.

**Proof.** A test where the guard validates a hostname to a public IP, but the connect-time lookup
would return a private IP, and assert the request is refused rather than following DNS to the private
address.

---

## P2: Layer 2 parser resource limits (decompression / content bombs)

**What.** No defense against a small PDF that expands catastrophically when parsed (a zip/PDF bomb),
or one crafted to exhaust CPU or memory during parsing.

**Why deferred.** Layer 1 never opens the PDF; it validates the `%PDF` magic bytes, hashes, and hands
bytes to the parser. This becomes a live denial-of-service vector the moment Layer 2 actually parses,
so it belongs with the parser, not here.

**How to close.** In the Layer 2 parser entrypoint, before and during decode, cap: decompressed
size, page count, object count, and a wall-clock/CPU budget for the parse. Reject anything over the
caps as a bad input, mapped to the same clean error surface the rest of the pipeline uses. If a VLM
fallback is added, give it its own timeout and size ceiling too.

**Proof.** A test that feeds a known-small-but-expands input and asserts the parser rejects it within
the budget instead of hanging or OOMing. This is a good candidate for a real red-until-fixed test at
the point the parser is written, because by then it is enforceable and green on completion.

---

## P2: Verify search behavior from the real production host

**What.** The search backends (`resolvers/search.ts`) degrade gracefully when blocked, but how often
they are actually blocked from our deploy environment is unknown. Search engines block datacenter IP
ranges, and that rate differs between a laptop and a cloud host.

**Why deferred.** It cannot be measured from a dev machine. It needs a real deploy.

**How to close.** After deploying, run `npm run bench:coverage -- --live` from the production host (or
an equivalent environment) and record the per-backend block rate and the overall live hit rate. If
scraped backends are blocked often, that is the signal to enable the paid Brave backend (set
`BRAVE_SEARCH_API_KEY`; it is already wired and inert without a key) or add structured logging plus an
alert when a backend circuit opens.

**Proof.** A recorded live benchmark run from the target host, and a decision (documented) on whether
paid search is needed.

---

## P3: Structured logging and observability

**What.** No structured logs for resolver win rates, search-backend block rates, or latency. The
silent-failure class of bug (a blocked search that used to read as "no datasheet") is exactly the
kind observability would surface early.

**How to close.** Add structured logging at the route boundary and in `SearchClient` (backend
outcomes) and the composite (which resolver won, timing). Emit a warning when a search backend
circuit opens. Wire to whatever the host provides.

**Proof.** Logs show, per lookup, which resolver won and how long it took, and an alert fires when a
backend starts blocking.

---

## Cross-layer note (not a task, context)

The CAD-generation injection (part number breaking out of STEP/KiCad string literals) has been fixed
in `src/lib/exporters.ts` with escapers and is covered by `src/lib/__tests__/cadgen-injection.test.ts`.
When Layer 3 native emitters (Altium, Cadence) are built, apply the same rule: escape or whitelist
every extracted value before interpolating it into generated output. The existing escapers
(`stepString`, `kicadString`) are the pattern to follow; new formats need their own.
