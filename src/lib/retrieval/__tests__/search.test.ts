import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SearchClient,
  SearchBlockedError,
  extractResultUrls,
  BLOCK_THRESHOLD,
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
