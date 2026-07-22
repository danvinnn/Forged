import { test } from "node:test";
import assert from "node:assert/strict";
import { NexarResolver } from "../resolvers/nexar";

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

// Minimal stub of global fetch that routes by URL: identity -> token, graphql -> a canned
// LMP7704-SP result, datasheet url -> PDF bytes.
function stubFetch(datasheetUrl: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("identity.nexar.com")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }
    if (url.includes("api.nexar.com/graphql")) {
      const body = {
        data: {
          supSearchMpn: {
            results: [
              {
                part: {
                  mpn: "LMP7704-SP",
                  manufacturer: { name: "Texas Instruments" },
                  octopartUrl: "https://octopart.com/lmp7704-sp",
                  bestDatasheet: { url: datasheetUrl }
                }
              }
            ]
          }
        }
      };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url === datasheetUrl) {
      return new Response(PDF_BYTES, { status: 200, headers: { "content-type": "application/pdf" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
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
  const datasheetUrl = "https://www.ti.com/lit/ds/symlink/lmp7704-sp.pdf";
  const restoreFetch = stubFetch(datasheetUrl);
  try {
    const ref = await new NexarResolver().resolve("LMP7704-SP", { manufacturer: "Texas Instruments" });
    assert.ok(ref);
    assert.equal(ref!.fileName, "LMP7704-SP.pdf");
    assert.equal(ref!.pdfUrl, datasheetUrl);
    assert.equal(ref!.sourcePageUrl, "https://octopart.com/lmp7704-sp");
    const head = new Uint8Array(ref!.bytes, 0, 5);
    assert.deepEqual([...head], [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
  } finally {
    restoreFetch();
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
