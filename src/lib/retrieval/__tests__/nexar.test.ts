import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NexarResolver, SEARCH_QUERY } from "../resolvers/nexar";
import { ResolverError } from "../resolvers/errors";

// The Nexar GraphQL response lives in a committed fixture, not inline here, so the day live
// credentials land the captured response drops into that file (see resolvers/__fixtures__/README.md)
// with no test edit. SEARCH_QUERY is imported from the resolver, never copied, so the query stays
// single-sourced: the fixture is the response to THIS query, and the resolve test proves the
// resolver actually sent it.
const FIXTURE_PATH = join(
  process.cwd(),
  "src",
  "lib",
  "retrieval",
  "resolvers",
  "__fixtures__",
  "nexar-lmp7704.json"
);

interface FixturePart {
  mpn: string;
  manufacturer: { name: string } | null;
  octopartUrl: string | null;
  bestDatasheet: { url: string } | null;
}

interface NexarResponse {
  data?: { supSearchMpn?: { results?: { part: FixturePart }[] } };
}

const NEXAR_RESPONSE = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as NexarResponse;

// The first result carrying a datasheet is what the resolver picks for a single-hit fixture.
// Reading expected values from here (not hardcoding them) is what keeps a live swap edit-free.
function fixturePart(): FixturePart {
  const results = NEXAR_RESPONSE.data?.supSearchMpn?.results ?? [];
  const hit = results.find((r) => r.part?.bestDatasheet?.url);
  if (!hit) throw new Error("nexar fixture has no result with a bestDatasheet.url");
  return hit.part;
}

// A minimal but valid-enough PDF: "%PDF-1.7" header padded past the 64-byte floor that
// finalizeRef enforces, so the resolver produces a real ref rather than rejecting it.
const PDF_BYTES = (() => {
  const header = new TextEncoder().encode("%PDF-1.7\n");
  const body = new Uint8Array(128);
  body.set(header, 0);
  return body;
})();

function setCreds(on: boolean): () => void {
  const prevId = process.env.NEXAR_CLIENT_ID;
  const prevSecret = process.env.NEXAR_CLIENT_SECRET;
  if (on) {
    process.env.NEXAR_CLIENT_ID = "test-id";
    process.env.NEXAR_CLIENT_SECRET = "test-secret";
  } else {
    delete process.env.NEXAR_CLIENT_ID;
    delete process.env.NEXAR_CLIENT_SECRET;
  }
  return () => {
    if (prevId === undefined) delete process.env.NEXAR_CLIENT_ID;
    else process.env.NEXAR_CLIENT_ID = prevId;
    if (prevSecret === undefined) delete process.env.NEXAR_CLIENT_SECRET;
    else process.env.NEXAR_CLIENT_SECRET = prevSecret;
  };
}

interface GraphqlBody {
  query?: string;
  variables?: { q?: string; limit?: number; country?: string };
}

// Stub of global fetch that routes by URL: identity -> token, graphql -> the committed fixture,
// datasheet url (read from the fixture) -> PDF bytes. Captures the GraphQL request body so the
// test can assert, at the test level (not inside the stub, where a throw would be swallowed by the
// resolver's transport handling), that the resolver sent exactly SEARCH_QUERY.
function stubFetch() {
  const original = globalThis.fetch;
  const datasheetUrl = fixturePart().bestDatasheet!.url;
  let graphqlBody: GraphqlBody | null = null;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("identity.nexar.com")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("api.nexar.com/graphql")) {
      graphqlBody = JSON.parse(String(init?.body ?? "{}")) as GraphqlBody;
      return new Response(JSON.stringify(NEXAR_RESPONSE), { status: 200 });
    }
    if (url === datasheetUrl) {
      return new Response(PDF_BYTES, { status: 200, headers: { "content-type": "application/pdf" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = original;
    },
    graphqlRequest: (): GraphqlBody | null => graphqlBody
  };
}

test("isConfigured is false without credentials", () => {
  const restore = setCreds(false);
  try {
    assert.equal(new NexarResolver().isConfigured(), false);
  } finally {
    restore();
  }
});

test("isConfigured is true with credentials", () => {
  const restore = setCreds(true);
  try {
    assert.equal(new NexarResolver().isConfigured(), true);
  } finally {
    restore();
  }
});

test("resolves LMP7704-SP to a downloaded datasheet ref (commercial path)", async () => {
  const restoreCreds = setCreds(true);
  const stub = stubFetch();
  try {
    const part = fixturePart();
    const ref = await new NexarResolver().resolve("LMP7704-SP", { manufacturer: "Texas Instruments" });
    assert.ok(ref);

    // Provenance is taken from the fixture, so a same-shape live capture needs no edit here.
    assert.equal(ref!.pdfUrl, part.bestDatasheet!.url);
    assert.equal(ref!.sourcePageUrl, part.octopartUrl ?? undefined);
    // fileName derives from the MPN; assert loosely so casing/suffix in a live capture is tolerated.
    assert.match(ref!.fileName, /\.pdf$/);
    assert.ok(ref!.fileName.toUpperCase().includes("LMP7704"));
    const head = new Uint8Array(ref!.bytes, 0, 5);
    assert.deepEqual([...head], [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

    // Single source of truth: the resolver sent exactly the SEARCH_QUERY it exports, so the
    // committed fixture is known to be the response to this query.
    const sent = stub.graphqlRequest();
    assert.equal(sent?.query, SEARCH_QUERY);
    assert.equal(sent?.variables?.q, "LMP7704-SP");
    assert.equal(sent?.variables?.country, "US");
  } finally {
    stub.restore();
    restoreCreds();
  }
});

test("resolve throws a clean error when credentials are missing", async () => {
  const restore = setCreds(false);
  try {
    await assert.rejects(() => new NexarResolver().resolve("LMP7704-SP"), /NEXAR_CLIENT_ID/);
  } finally {
    restore();
  }
});

// --- Error taxonomy ---------------------------------------------------------------------------
// These pin down the hard/soft mapping the CompositeResolver relies on. They matter most for the
// day live credentials land: a 429, an anti-bot HTML interstitial, or an auth failure must each
// be classified correctly, or a transient blip turns into a hard operator error (or worse, a real
// misconfig gets silently swallowed as "not found"). Driven through resolve() so we test the
// resolver's actual behavior, not a restated table.

// Lets each test override just the identity and/or graphql response; other URLs 404.
function stubResponses(opts: {
  identity?: () => Response;
  graphql?: () => Response;
  datasheet?: { url: string; response: () => Response };
}): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("identity.nexar.com")) {
      return opts.identity
        ? opts.identity()
        : new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("api.nexar.com/graphql")) {
      return opts.graphql ? opts.graphql() : new Response(JSON.stringify(NEXAR_RESPONSE), { status: 200 });
    }
    if (opts.datasheet && url === opts.datasheet.url) {
      return opts.datasheet.response();
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function isResolverError(kind: ResolverError["kind"], hard: boolean) {
  return (err: unknown): boolean => err instanceof ResolverError && err.kind === kind && err.hard === hard;
}

test("token 401 surfaces as a HARD auth error", async () => {
  const restoreCreds = setCreds(true);
  const restore = stubResponses({ identity: () => new Response("nope", { status: 401 }) });
  try {
    await assert.rejects(() => new NexarResolver().resolve("LMP7704-SP"), isResolverError("auth", true));
  } finally {
    restore();
    restoreCreds();
  }
});

test("graphql 429 surfaces as a SOFT rate_limit error", async () => {
  const restoreCreds = setCreds(true);
  const restore = stubResponses({ graphql: () => new Response("slow down", { status: 429 }) });
  try {
    await assert.rejects(() => new NexarResolver().resolve("LMP7704-SP"), isResolverError("rate_limit", false));
  } finally {
    restore();
    restoreCreds();
  }
});

test("a graphql errors array surfaces as a HARD bad_response error", async () => {
  const restoreCreds = setCreds(true);
  const restore = stubResponses({
    graphql: () => new Response(JSON.stringify({ errors: [{ message: "unknown field" }] }), { status: 200 })
  });
  try {
    await assert.rejects(() => new NexarResolver().resolve("LMP7704-SP"), isResolverError("bad_response", true));
  } finally {
    restore();
    restoreCreds();
  }
});

test("a non-JSON graphql body surfaces as a HARD bad_response error", async () => {
  const restoreCreds = setCreds(true);
  const restore = stubResponses({
    graphql: () => new Response("<html>maintenance</html>", { status: 200, headers: { "content-type": "text/html" } })
  });
  try {
    await assert.rejects(() => new NexarResolver().resolve("LMP7704-SP"), isResolverError("bad_response", true));
  } finally {
    restore();
    restoreCreds();
  }
});

test("a graphql timeout surfaces as a SOFT transport error", async () => {
  const restoreCreds = setCreds(true);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("identity.nexar.com")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }
    // Simulate the AbortController firing without waiting the real 8s: fetchWithTimeout converts an
    // AbortError into a TimeoutError, which the resolver maps to a soft transport failure.
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }) as typeof fetch;
  try {
    await assert.rejects(() => new NexarResolver().resolve("LMP7704-SP"), isResolverError("transport", false));
  } finally {
    globalThis.fetch = original;
    restoreCreds();
  }
});

test("empty results resolve to null so the caller can fall back to upload", async () => {
  const restoreCreds = setCreds(true);
  const restore = stubResponses({
    graphql: () => new Response(JSON.stringify({ data: { supSearchMpn: { results: [] } } }), { status: 200 })
  });
  try {
    assert.equal(await new NexarResolver().resolve("LMP7704-SP"), null);
  } finally {
    restore();
    restoreCreds();
  }
});

test("a datasheet URL that serves HTML (anti-bot interstitial) resolves to null, not a hard error", async () => {
  const restoreCreds = setCreds(true);
  const dsUrl = fixturePart().bestDatasheet!.url;
  // Padded past the 64-byte floor so it fails the %PDF magic check specifically, not the size check:
  // this is the "URL resolved but served a captcha/HTML page" case, which must degrade to upload.
  const html = `<html><body>${"verify you are human ".repeat(8)}</body></html>`;
  const restore = stubResponses({
    datasheet: {
      url: dsUrl,
      response: () => new Response(html, { status: 200, headers: { "content-type": "text/html" } })
    }
  });
  try {
    const ref = await new NexarResolver().resolve("LMP7704-SP", { manufacturer: "Texas Instruments" });
    assert.equal(ref, null);
  } finally {
    restore();
    restoreCreds();
  }
});
