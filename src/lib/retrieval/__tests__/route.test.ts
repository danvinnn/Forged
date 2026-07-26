import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POST as lookupPOST } from "../../../app/api/lookup/route";
import { POST as parsePOST } from "../../../app/api/parse/route";

const REAL_PDF = readFileSync(join(process.cwd(), "test-data", "LMP7704-SP.pdf"));

function setEnv(vars: Record<string, string | undefined>): () => void {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function jsonRequest(body: unknown): Request {
  return new Request("http://test/api/lookup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

// Mocks the commercial network path. The chain is manufacturer then scrape, so the only thing that
// matters is which URLs serve a PDF: serve the vendor URL and manufacturer wins, serve nothing and
// the chain misses cleanly.
function mockVendorFetch(opts: { datasheetUrl?: string; pdfBytes?: Uint8Array }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (opts.datasheetUrl && url === opts.datasheetUrl && opts.pdfBytes) {
      return new Response(opts.pdfBytes as BodyInit, { status: 200, headers: { "content-type": "application/pdf" } });
    }
    // Everything else, including the scrape fallback's search and candidates, is a dead end.
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("air-gapped lookup returns 403 and never touches the network", async () => {
  const restoreEnv = setEnv({ FORGE_DEPLOYMENT_MODE: "air-gapped" });
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    return new Response("", { status: 200 });
  }) as typeof fetch;
  try {
    const res = await lookupPOST(jsonRequest({ partNumber: "LMP7704-SP" }));
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, "AIRGAP_LOOKUP_DISABLED");
    assert.equal(body.mode, "air-gapped");
    assert.equal(fetchCalled, false); // structural: no resolver, no fetch
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("commercial lookup resolves LMP7704-SP end to end", async () => {
  // No credentials of any kind. That is the point of this test: the demo path is credential-free.
  const restoreEnv = setEnv({ FORGE_DEPLOYMENT_MODE: "commercial" });
  const datasheetUrl = "https://www.ti.com/lit/ds/symlink/lmp7704-sp.pdf";
  const restoreFetch = mockVendorFetch({ datasheetUrl, pdfBytes: new Uint8Array(REAL_PDF) });
  try {
    const res = await lookupPOST(jsonRequest({ partNumber: "LMP7704-SP", manufacturer: "Texas Instruments" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(String(body.part.partNumber.value).toUpperCase(), /LMP7704/);
    assert.equal(body.source.origin, "resolver");
    // The manufacturer resolver wins, with an empty .env and no third-party search call.
    // Provenance names the concrete resolver rather than the chain.
    assert.equal(body.source.resolver, "manufacturer");
    assert.match(body.source.pdfUrl, /ti\.com/);
    assert.match(body.source.sha256, /^[0-9a-f]{64}$/);
    assert.equal(body.mode, "commercial");
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test("a rad-hard part misses every resolver and degrades to DATASHEET_NOT_FOUND", async () => {
  const restoreEnv = setEnv({ FORGE_DEPLOYMENT_MODE: "commercial" });
  // VORAGO has no derivable URL pattern, so manufacturer claims nothing, and scrape hits 404s.
  // The user must be told to upload, not shown a hard error. This is the COMMON path for our
  // actual target parts, which is why it gets a route-level test.
  const restoreFetch = mockVendorFetch({});
  try {
    const res = await lookupPOST(jsonRequest({ partNumber: "VA10820", manufacturer: "VORAGO" }));
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "DATASHEET_NOT_FOUND");
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test("lookup with no part number returns 400 PART_NUMBER_REQUIRED", async () => {
  const restoreEnv = setEnv({ FORGE_DEPLOYMENT_MODE: "commercial" });
  try {
    const res = await lookupPOST(jsonRequest({ manufacturer: "TI" }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "PART_NUMBER_REQUIRED");
  } finally {
    restoreEnv();
  }
});

test("upload route parses a valid PDF and reports upload provenance", async () => {
  const restoreEnv = setEnv({ FORGE_DEPLOYMENT_MODE: "air-gapped" }); // works with zero network
  try {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(REAL_PDF)], "LMP7704-SP.pdf", { type: "application/pdf" }));
    const req = new Request("http://test/api/parse", { method: "POST", body: form });
    const res = await parsePOST(req);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source.origin, "upload");
    assert.equal(body.source.pdfUrl, undefined);
    assert.match(body.source.sha256, /^[0-9a-f]{64}$/);
  } finally {
    restoreEnv();
  }
});

test("upload route rejects a non-PDF with 400 UPLOAD_INVALID", async () => {
  const restoreEnv = setEnv({ FORGE_DEPLOYMENT_MODE: "air-gapped" });
  try {
    const form = new FormData();
    form.set("file", new File([new TextEncoder().encode("not a pdf at all, just text")], "fake.pdf"));
    const req = new Request("http://test/api/parse", { method: "POST", body: form });
    const res = await parsePOST(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "UPLOAD_INVALID");
  } finally {
    restoreEnv();
  }
});

test("upload provenance carries no resolver name", async () => {
  const restoreEnv = setEnv({ FORGE_DEPLOYMENT_MODE: "air-gapped" });
  try {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(REAL_PDF)], "LMP7704-SP.pdf", { type: "application/pdf" }));
    const res = await parsePOST(new Request("http://test/api/parse", { method: "POST", body: form }));
    const body = await res.json();
    assert.equal(body.source.origin, "upload");
    assert.equal(body.source.resolver, undefined); // uploads were not resolved by anything
  } finally {
    restoreEnv();
  }
});

// --- Security at the route boundary -----------------------------------------------------------
import { RateLimiter, __setLimiterOverrides } from "../ratelimit";

test("lookup refuses past the rate limit with 429 and Retry-After", async () => {
  const restoreEnv = setEnv({ FORGE_DEPLOYMENT_MODE: "commercial" });
  // Isolated limiter so this assertion does not consume, and is not consumed by, other test files
  // running in parallel. 5/min makes the loop below deterministic.
  __setLimiterOverrides({ lookup: new RateLimiter(5, 60_000) });
  const restoreFetch = mockVendorFetch({});
  try {
    let sawLimit = false;
    for (let i = 0; i < 20; i++) {
      const req = new Request("http://test/api/lookup", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.50" },
        body: JSON.stringify({ partNumber: "LMP7704-SP" })
      });
      const res = await lookupPOST(req);
      if (res.status === 429) {
        const body = await res.json();
        assert.equal(body.code, "RATE_LIMITED");
        assert.ok(res.headers.get("retry-after"), "a 429 must tell the client when to retry");
        sawLimit = true;
        break;
      }
    }
    assert.ok(sawLimit, "an unlimited lookup endpoint is a traffic amplifier");
  } finally {
    restoreFetch();
    restoreEnv();
    __setLimiterOverrides({});
  }
});

test("a resolver failure does not leak internal detail to the client", async () => {
  const restoreEnv = setEnv({ FORGE_DEPLOYMENT_MODE: "commercial" });
  __setLimiterOverrides({ lookup: new RateLimiter(1000, 60_000) });
  const original = globalThis.fetch;
  // Force a hard failure carrying operator-only detail.
  globalThis.fetch = (async () => {
    throw new Error("connect ECONNREFUSED 10.0.0.7:5432 internal-resolver-db");
  }) as typeof fetch;
  try {
    const res = await lookupPOST(jsonRequest({ partNumber: "LMP7704-SP" }));
    const body = await res.json();
    // The composite's aggregate message names internal resolvers and hosts. That is operator
    // information; handing it to an anonymous caller maps out our internals for them.
    assert.doesNotMatch(JSON.stringify(body), /ECONNREFUSED|10\.0\.0\.7|internal-resolver-db/);
  } finally {
    globalThis.fetch = original;
    restoreEnv();
    __setLimiterOverrides({});
  }
});

test("lookup rejects an absurdly long part number", async () => {
  const restoreEnv = setEnv({ FORGE_DEPLOYMENT_MODE: "commercial" });
  __setLimiterOverrides({ lookup: new RateLimiter(1000, 60_000) });
  try {
    const res = await lookupPOST(jsonRequest({ partNumber: "A".repeat(5000) }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "PART_NUMBER_REQUIRED");
  } finally {
    restoreEnv();
    __setLimiterOverrides({});
  }
});

test("upload rejects an oversized declared Content-Length before parsing the body", async () => {
  const restoreEnv = setEnv({ FORGE_DEPLOYMENT_MODE: "air-gapped" });
  __setLimiterOverrides({ upload: new RateLimiter(1000, 60_000) });
  try {
    // request.formData() buffers the whole body, so this must be refused on the header alone.
    const req = new Request("http://test/api/parse", {
      method: "POST",
      headers: { "content-length": String(200 * 1024 * 1024), "content-type": "multipart/form-data; boundary=x" },
      body: "x"
    });
    const res = await parsePOST(req);
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.code, "UPLOAD_INVALID");
  } finally {
    restoreEnv();
    __setLimiterOverrides({ upload: new RateLimiter(1000, 60_000) });
  }
});

test("upload refuses past the rate limit", async () => {
  const restoreEnv = setEnv({ FORGE_DEPLOYMENT_MODE: "air-gapped" });
  __setLimiterOverrides({ upload: new RateLimiter(5, 60_000) });
  try {
    let sawLimit = false;
    for (let i = 0; i < 20; i++) {
      const form = new FormData();
      form.set("file", new File([new Uint8Array(REAL_PDF)], "LMP7704-SP.pdf", { type: "application/pdf" }));
      const req = new Request("http://test/api/parse", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.77" },
        body: form
      });
      const res = await parsePOST(req);
      if (res.status === 429) {
        sawLimit = true;
        break;
      }
    }
    assert.ok(sawLimit, "each upload buffers and hashes megabytes, so it needs a ceiling");
  } finally {
    restoreEnv();
    __setLimiterOverrides({});
  }
});

// --- Air-gap: the core ITAR invariant, tested at the route ------------------------------------
// The whole enterprise thesis is "your controlled datasheet never leaves your network". The parse
// route can call a CLOUD model (Gemini) for extraction, gated on commercial mode. If that gate ever
// regressed, an air-gapped deploy would ship a controlled PDF to Google and nobody would notice
// until an auditor did. This is the most important test in the layer, so it is explicit.

test("air-gapped upload NEVER invokes the cloud extractor, even with a key present", async () => {
  // Set the Gemini key AND air-gapped mode: the key must be irrelevant, the mode must win.
  const restoreEnv = setEnv({
    FORGE_DEPLOYMENT_MODE: "air-gapped",
    GOOGLE_GEMINI_API_KEY: "test-key-that-must-never-be-used",
    FORGE_LOCAL_MODEL_URL: undefined
  });
  // Any outbound fetch during an air-gapped parse is a failure by definition.
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async (...args: unknown[]) => {
    fetchCalled = true;
    return originalFetch(...(args as Parameters<typeof fetch>));
  }) as typeof fetch;
  try {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(REAL_PDF)], "LMP7704-SP.pdf", { type: "application/pdf" }));
    const res = await parsePOST(new Request("http://test/api/parse", { method: "POST", body: form }));
    assert.equal(res.status, 200);
    const body = await res.json();
    // Asserted structurally rather than as an exact string, so a future rename
    // of the deterministic pass cannot quietly weaken the ITAR invariant.
    assert.match(body.method, /^deterministic/, "air-gapped MUST run the deterministic parser");
    assert.doesNotMatch(body.method, /gemini/i, "no cloud model may appear in an air-gapped extraction");
    assert.equal(fetchCalled, false, "air-gapped parse must make no network call whatsoever");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("commercial upload without a Gemini key falls back to the local parser", async () => {
  // The gate is (commercial AND key). Commercial alone must not force a cloud call.
  const restoreEnv = setEnv({ FORGE_DEPLOYMENT_MODE: "commercial", GOOGLE_GEMINI_API_KEY: undefined, FORGE_LOCAL_MODEL_URL: undefined });
  try {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(REAL_PDF)], "LMP7704-SP.pdf", { type: "application/pdf" }));
    const res = await parsePOST(new Request("http://test/api/parse", { method: "POST", body: form }));
    const body = await res.json();
    assert.match(body.method, /^deterministic/);
    assert.doesNotMatch(body.method, /gemini/i);
  } finally {
    restoreEnv();
  }
});
