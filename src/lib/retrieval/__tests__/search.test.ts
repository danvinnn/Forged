import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SearchClient,
  SearchBlockedError,
  extractResultUrls,
  BLOCK_THRESHOLD,
  defaultBackends,
  type SearchBackend
} from "../resolvers/search";

// The failure this whole module exists to prevent: a search engine serves a challenge page with
// HTTP 200 and no results. The old code read that as "search succeeded, zero hits" and told the
// user their part has no datasheet. Being blocked and having no datasheet are different facts and
// must never be conflated.

function stub(name: string, behavior: () => Promise<string[]>, configured = true): SearchBackend {
  return { name, isConfigured: () => configured, search: behavior };
}

test("extractResultUrls unwraps DuckDuckGo and Mojeek redirect wrappers", () => {
  const html = `
    <a href="/l/?uddg=https%3A%2F%2Fwww.ti.com%2Flit%2Fds%2Fsymlink%2Flmp7704-sp.pdf">TI</a>
    <a href="/out?u=https%3A%2F%2Fwww.mouser.com%2Fpdfdocs%2FVA10820.pdf">Mouser</a>
  `;
  const urls = extractResultUrls(html);
  assert.ok(urls.includes("https://www.ti.com/lit/ds/symlink/lmp7704-sp.pdf"));
  assert.ok(urls.includes("https://www.mouser.com/pdfdocs/VA10820.pdf"));
});

test("an empty result from a HEALTHY backend is a real answer, not a block", async () => {
  const client = new SearchClient([stub("a", async () => [])]);
  const outcome = await client.search("VA10820 datasheet");
  assert.equal(outcome.blocked, false, "a genuine zero-hit search must not be reported as blocked");
  assert.deepEqual(outcome.urls, []);
});

test("falls over to the next backend when the first is blocked", async () => {
  const client = new SearchClient([
    stub("blocked", async () => {
      throw new SearchBlockedError("blocked", "HTTP 429");
    }),
    stub("healthy", async () => ["https://www.ti.com/lit/ds/symlink/lmp7704-sp.pdf"])
  ]);
  const outcome = await client.search("LMP7704-SP datasheet");
  assert.equal(outcome.backend, "healthy");
  assert.equal(outcome.blocked, false);
  assert.equal(outcome.urls.length, 1);
});

test("reports blocked when EVERY backend refuses", async () => {
  const client = new SearchClient([
    stub("a", async () => {
      throw new SearchBlockedError("a", "captcha");
    }),
    stub("b", async () => {
      throw new SearchBlockedError("b", "HTTP 403");
    })
  ]);
  const outcome = await client.search("LMP7704-SP");
  assert.equal(outcome.blocked, true, "this is what stops a false DATASHEET_NOT_FOUND");
  assert.deepEqual(outcome.urls, []);
});

test("a transport failure is not treated as a block", async () => {
  // The engine did not refuse us, the network did. Do not penalize the backend's health for it.
  const client = new SearchClient([
    stub("flaky", async () => {
      throw new Error("ECONNRESET");
    }),
    stub("healthy", async () => ["https://x.test/a.pdf"])
  ]);
  const outcome = await client.search("q");
  assert.equal(outcome.backend, "healthy");
  assert.equal(outcome.blocked, false);
});

test("circuit breaker stops hammering a backend that keeps blocking", async () => {
  let calls = 0;
  const client = new SearchClient([
    stub("blocked", async () => {
      calls++;
      throw new SearchBlockedError("blocked", "HTTP 429");
    })
  ]);

  for (let i = 0; i < BLOCK_THRESHOLD; i++) await client.search(`q${i}`);
  const callsAtTrip = calls;

  // Circuit is open now. Further searches must not touch it: a blocked engine stays blocked, and
  // retrying just burns the chain budget and deepens the block.
  await client.search("after");
  assert.equal(calls, callsAtTrip, "an open circuit must not call the backend");

  const outcome = await client.search("after2");
  assert.equal(outcome.blocked, true, "an open circuit still counts as unavailable, not empty");
});

test("a success resets the failure count", async () => {
  let shouldBlock = true;
  let calls = 0;
  const client = new SearchClient([
    stub("flappy", async () => {
      calls++;
      if (shouldBlock) throw new SearchBlockedError("flappy", "HTTP 429");
      return ["https://x.test/ok.pdf"];
    })
  ]);

  await client.search("q1");
  shouldBlock = false;
  await client.search("q2"); // success resets
  shouldBlock = true;

  // Two more blocks should not trip the breaker, because the counter was reset by the success.
  await client.search("q3");
  const before = calls;
  await client.search("q4");
  assert.ok(calls > before, "the breaker should still be closed after a reset");
});

test("unconfigured backends are skipped without counting as blocked", async () => {
  const client = new SearchClient([
    stub("keyed", async () => ["https://never.test"], false),
    stub("healthy", async () => [])
  ]);
  const outcome = await client.search("q");
  assert.equal(outcome.backend, "healthy");
  assert.equal(outcome.blocked, false);
});

test("no usable backends at all reports blocked, not empty", async () => {
  const client = new SearchClient([stub("keyed", async () => [], false)]);
  const outcome = await client.search("q");
  assert.equal(outcome.blocked, true);
});

// --- The third kind of refusal (2026-09-02) ----------------------------------------------------
// This file already handled two: an honest 403/429, and a 200 carrying a challenge marker. A third
// showed up in live measurement and neither caught it. A degraded DuckDuckGo answered HTTP 200,
// carried no challenge markers, and returned ten links that were all duckduckgo.com chrome and zero
// results. The client recorded a healthy backend with a real answer and stopped.
//
// Measured cost: live coverage fell from 95% to 69%, every miss a part that needs search, while
// brave-html sat next in the list holding the correct PDF.

function backendReturning(name: string, urls: string[]): SearchBackend {
  return { name, isConfigured: () => true, search: async () => urls };
}

test("a page of only self-links counts as no results, not as an answer", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      `<html><body><a href="https://duckduckgo.com/">home</a><a href="https://duckduckgo.com/about">about</a></body></html>`,
      { status: 200, headers: { "content-type": "text/html" } }
    )) as typeof fetch;
  try {
    // defaultBackends()[0] is ddg-html. Its own chrome must not be reported as results.
    const urls = await defaultBackends()[0].search("AD8628 datasheet pdf");
    assert.deepEqual(urls, [], "links back to the engine itself are chrome, not results");
  } finally {
    globalThis.fetch = original;
  }
});

test("an empty backend falls through to the next instead of ending the search", async () => {
  // The behaviour change. An engine genuinely having zero results for a real part number is far
  // less likely than an engine being degraded, and other engines are sitting right there.
  const client = new SearchClient([
    backendReturning("degraded", []),
    backendReturning("healthy", ["https://www.analog.com/media/en/technical-documentation/data-sheets/ad8628-8629-8630.pdf"])
  ]);
  const outcome = await client.search("AD8628 datasheet pdf");
  assert.equal(outcome.backend, "healthy", "the second backend must be asked");
  assert.equal(outcome.urls.length, 1);
  assert.equal(outcome.blocked, false);
});

test("every backend empty is a real miss, not a block", async () => {
  // The other direction: if they all answer cleanly with nothing, the caller may report a miss.
  // Reporting blocked here would turn every genuinely absent part into a soft error.
  const client = new SearchClient([backendReturning("a", []), backendReturning("b", [])]);
  const outcome = await client.search("NOSUCHPART999");
  assert.deepEqual(outcome.urls, []);
  assert.equal(outcome.blocked, false);
});

test("a blocked backend still falls through and still reports blocked when nothing answers", async () => {
  const client = new SearchClient([
    {
      name: "blocked",
      isConfigured: () => true,
      search: async () => {
        throw new SearchBlockedError("blocked", "captcha");
      }
    },
    backendReturning("also-empty", [])
  ]);
  const outcome = await client.search("AD8628");
  assert.equal(outcome.blocked, true, "one refusal means we cannot claim the part has no datasheet");
});

test("unwraps Bing's base64 redirect, which is its ONLY link format", () => {
  // Bing emits no absolute result URL at all: every result is /ck/a?...&u=a1<base64url>. That is why
  // it measured useless on first inspection (102 links extracted, zero of them results).
  const target = "https://www.analog.com/media/en/technical-documentation/data-sheets/ad8628-8629-8630.pdf";
  const encoded = "a1" + Buffer.from(target).toString("base64url");
  // &amp; as a real Bing page emits it. Decoding that FIRST is load-bearing: otherwise the query
  // parameter is named `amp;u` and every result is silently dropped.
  const html = `<html><body><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=${encoded}">r</a></body></html>`;
  assert.deepEqual(extractResultUrls(html), [target]);
});

test("Mojeek's plain redirect still unwraps alongside Bing's", () => {
  // Both engines name the parameter `u`, so the Bing decoder must decline anything that is not its
  // own encoding rather than mangling Mojeek's.
  const target = "https://www.ti.com/lit/ds/symlink/lmp7704-sp.pdf";
  const html = `<html><body><a href="https://www.mojeek.com/out?u=${encodeURIComponent(target)}">r</a></body></html>`;
  assert.deepEqual(extractResultUrls(html), [target]);
});
