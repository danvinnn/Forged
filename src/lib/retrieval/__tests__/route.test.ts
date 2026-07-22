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

// Mocks the commercial Nexar path: token, a GraphQL result (or empty), and the datasheet bytes.
function mockNexarFetch(opts: { datasheetUrl?: string; pdfBytes?: Uint8Array }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("identity.nexar.com")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("api.nexar.com/graphql")) {
      const results = opts.datasheetUrl
        ? [
            {
              part: {
                mpn: "LMP7704-SP",
                manufacturer: { name: "Texas Instruments" },
                octopartUrl: "https://octopart.com/lmp7704-sp",
                bestDatasheet: { url: opts.datasheetUrl }
              }
            }
          ]
        : [];
      return new Response(JSON.stringify({ data: { supSearchMpn: { results } } }), { status: 200 });
    }
    if (opts.datasheetUrl && url === opts.datasheetUrl && opts.pdfBytes) {
      return new Response(opts.pdfBytes as BodyInit, { status: 200, headers: { "content-type": "application/pdf" } });
    }
    // Everything else (scrape fallback hitting the network) is a dead end.
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
  const restoreEnv = setEnv({
    FORGE_DEPLOYMENT_MODE: "commercial",
    NEXAR_CLIENT_ID: "id",
    NEXAR_CLIENT_SECRET: "secret"
  });
  const datasheetUrl = "https://www.ti.com/lit/ds/symlink/lmp7704-sp.pdf";
  const restoreFetch = mockNexarFetch({ datasheetUrl, pdfBytes: new Uint8Array(REAL_PDF) });
  try {
    const res = await lookupPOST(jsonRequest({ partNumber: "LMP7704-SP", manufacturer: "Texas Instruments" }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.part.partNumber.toUpperCase(), /LMP7704/);
    assert.equal(body.source.origin, "resolver");
    assert.match(body.source.resolver, /nexar/);
    assert.match(body.source.sha256, /^[0-9a-f]{64}$/);
    assert.equal(body.mode, "commercial");
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test("commercial lookup of a rad-hard part Nexar misses degrades to DATASHEET_NOT_FOUND", async () => {
  const restoreEnv = setEnv({
    FORGE_DEPLOYMENT_MODE: "commercial",
    NEXAR_CLIENT_ID: "id",
    NEXAR_CLIENT_SECRET: "secret"
  });
  // No datasheetUrl: Nexar returns empty, scrape hits 404s. The user should be told to upload,
  // not shown a hard error.
  const restoreFetch = mockNexarFetch({});
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
