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
    const body = await res.json();
    // RETRIEVAL IS WHAT THIS TEST GUARDS, and it is credential-free as it always
    // was: the manufacturer resolver wins from an empty .env, with no
    // third-party search call.
    //
    // Reading is a different job and it needs a reader. With none configured the
    // route now refuses instead of answering 200 with a record of nulls
    // (2026-08-29), so the retrieval facts are asserted on whichever answer came
    // back. They are true either way, which is why the refusal carries them.
    assert.ok(res.status === 200 || res.status === 503, `unexpected status ${res.status}`);
    if (res.status === 503) assert.equal(body.code, "MODEL_UNAVAILABLE");
    else assert.match(String(body.part.partNumber.value).toUpperCase(), /LMP7704/);
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
    // 503 WITH THE PROVENANCE INTACT. No reader is configured in this
    // environment, and since 2026-08-29 the route refuses rather than handing
    // back a record of nulls with a 200 on it; see the MODEL_UNAVAILABLE branch.
    // The upload itself still happened, so what is asserted here - that the file
    // was received, hashed and reported as an upload rather than a fetch - is
    // asserted unchanged.
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, "MODEL_UNAVAILABLE");
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
    // Air-gapped with no local reader refuses since 2026-08-29 rather than
    // returning a record of nulls with a 200 on it. The INVARIANT under test is
    // untouched and is checked below: no cloud model is reached and no fetch
    // leaves the process, whatever the answer turns out to be.
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, "MODEL_UNAVAILABLE");
    // The INVARIANT is that no cloud model appears, not that a particular word
    // does. This asserted `/^deterministic/`, which named a 7,500-line reader
    // deleted on 2026-08-14: it pinned a label rather than the property, so
    // renaming the label to what the route actually does looked like a breach.
    // ASSERTED ON THE METHOD, not on the whole body. The refusal's own text
    // names the credentials a deployment could configure, which is advice to an
    // operator rather than evidence a model ran, and matching the body wholesale
    // reads one as the other.
    assert.ok(
      body.method === undefined || !/gemini|vertex/i.test(String(body.method)),
      "no cloud model may appear in an air-gapped extraction"
    );
    assert.equal(fetchCalled, false, "air-gapped parse must make no network call whatsoever");
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv();
  }
});

test("commercial upload without any credential reaches no cloud model", async () => {
  // The gate is (commercial AND key). Commercial alone must not force a cloud call.
  // EVERY credential, not just the API key. `factory.ts` prefers Vertex where
  // `GOOGLE_APPLICATION_CREDENTIALS` and `FORGE_VERTEX_PROJECT` are set, and
  // this list was written before Vertex existed. Left as it was, the test
  // passed on a clean machine and failed on a developer who had sourced
  // `.env.local`, which `LEARNINGS.md` tells them to do before a bench. A test
  // whose answer depends on whose laptop it runs on is not evidence.
  const restoreEnv = setEnv({
    FORGE_DEPLOYMENT_MODE: "commercial",
    GOOGLE_GEMINI_API_KEY: undefined,
    FORGE_LOCAL_MODEL_URL: undefined,
    GOOGLE_APPLICATION_CREDENTIALS: undefined,
    FORGE_VERTEX_PROJECT: undefined,
    FORGE_VERTEX_LOCATION: undefined
  });
  try {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(REAL_PDF)], "LMP7704-SP.pdf", { type: "application/pdf" }));
    const res = await parsePOST(new Request("http://test/api/parse", { method: "POST", body: form }));
    const body = await res.json();
    // The gate is (commercial AND a credential). Commercial alone must not
    // produce a cloud call, and that is the property, not the label.
    //
    // The route now REFUSES here rather than returning a blank record with a 200
    // on it: with no credential and no local endpoint there is no reader, and
    // `bench:holdout` measures a reader-less parse at READ 0 of 59. The name of
    // this test used to be "falls back to the local parser", which named a
    // 7,500-line reader deleted on 2026-08-14 and a fallback that no longer
    // exists.
    assert.equal(res.status, 503);
    assert.equal(body.code, "MODEL_UNAVAILABLE");
    assert.ok(body.method === undefined || !/gemini|vertex/i.test(String(body.method)));
  } finally {
    restoreEnv();
  }
});

/**
 * Both routes read a datasheet and answer about it, so both must answer with
 * the same thing.
 *
 * ## The defect
 *
 * Past the point where the PDF bytes are in hand, an upload and a part-number
 * lookup are the same operation. `/api/parse` did the whole job; `/api/lookup`
 * returned the bare record and stopped. No package chooser, no confidence
 * checks, no review panel, no rendered pages, and no repair of
 * `vendorLandPattern`, which is what `contradictsPrintedLand` needs to catch a
 * correct-inputs-wrong-lead-form footprint.
 *
 * The UI's `absorb` reads those keys off the payload and blanks whatever is
 * absent, so a looked-up part reached the user with the questions answered and
 * none of the answers shown.
 *
 * The worst of it is not cosmetic. `resolveForExport` refuses a model value
 * carrying no citation, and confirming one in the REVIEW PANEL is the only
 * thing that clears it. No panel means no way to confirm, so a looked-up part
 * with an uncited geometry value could not be exported by any route the user
 * has.
 *
 * Asserted as a SHAPE COMPARISON rather than a checklist of keys, because the
 * failure was never a specific missing field. It was two copies of one job
 * drifting apart, and the next field added to one of them would drift the same
 * way. Both now call `buildReadout`, and this fails if either stops.
 */
test("lookup answers with the same shape as parse, not a bare record", async () => {
  const restoreEnv = setEnv({ FORGE_DEPLOYMENT_MODE: "commercial", FORGE_LOG_LEVEL: "error" });
  const url = "https://www.ti.com/lit/ds/symlink/lmp7704-sp.pdf";
  const restoreFetch = mockVendorFetch({ datasheetUrl: url, pdfBytes: new Uint8Array(REAL_PDF) });
  try {
    const looked = await lookupPOST(jsonRequest({ partNumber: "LMP7704-SP", manufacturer: "Texas Instruments" }));
    const lookedBody = await looked.json();

    const form = new FormData();
    form.set("file", new File([new Uint8Array(REAL_PDF)], "LMP7704-SP.pdf", { type: "application/pdf" }));
    const parsed = await parsePOST(new Request("http://test/api/parse", { method: "POST", body: form }));
    const parsedBody = await parsed.json();

    // PARITY IS THE POINT, AND IT NOW BINDS THE REFUSALS TOO.
    //
    // No reader is configured in this environment, so since 2026-08-29 both
    // routes refuse rather than returning a record of nulls with a 200 on it.
    // This test is what CAUGHT the second half of that: the guard was added to
    // `/api/parse` alone and the two routes immediately disagreed, which is the
    // third time a guard on one has had to be repeated on the other. Past the
    // point where the bytes are in hand they are the same operation.
    assert.equal(looked.status, parsed.status, "the same document must get the same answer whichever route read it");
    assert.equal(lookedBody.code, parsedBody.code);

    if (parsed.status !== 200) {
      assert.equal(parsedBody.code, "MODEL_UNAVAILABLE");
      return;
    }

    // Everything the panel is built from. A key present on one and absent on the
    // other is the drift this exists to catch.
    for (const key of ["packageChoice", "checks", "review", "reviewPages", "packageDrawing"]) {
      assert.ok(key in lookedBody, `lookup must answer with ${key}, as parse does`);
      assert.ok(key in parsedBody, `parse must answer with ${key}`);
    }

    // And the same document read two ways must reach the same verdict about
    // which packages it offers. This is the assertion that would fail if one
    // route were quietly given a different pipeline.
    assert.equal(
      lookedBody.packageChoice?.ok,
      parsedBody.packageChoice?.ok,
      "the same document must offer the same chooser whichever route read it"
    );
    assert.equal(
      Array.isArray(lookedBody.review),
      true,
      "the review panel is what makes an uncited value confirmable, so it cannot be absent"
    );
  } finally {
    restoreFetch();
    restoreEnv();
  }
});
