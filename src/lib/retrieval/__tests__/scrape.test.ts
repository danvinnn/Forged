import { test } from "node:test";
import assert from "node:assert/strict";
import { ScrapeResolver } from "../resolvers/scrape";
import { ResolverError } from "../resolvers/errors";

// The scrape resolver is the demoted MVP fallback: brittle by design, last in the composite. Its
// one remaining job is to not regress the TI demo, and it has had no coverage. These lock in the
// three outcomes the composite depends on: a direct TI hit, a clean "nothing found" null, and a
// soft transport failure when the search itself errors (never a hard error, so upload stays open).

const PDF_BYTES = (() => {
  const header = new TextEncoder().encode("%PDF-1.7\n");
  const body = new Uint8Array(128);
  body.set(header, 0);
  return body;
})();

// Serves PDF bytes at exactly one URL (the direct TI symlink candidate), 404 for everything else.
function stubDirectHit(pdfUrl: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === pdfUrl) {
      return new Response(PDF_BYTES, { status: 200, headers: { "content-type": "application/pdf" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// Search returns a valid but empty page (no links), so nothing resolves and locatePdf yields null.
function stubEmptySearch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("duckduckgo")) {
      return new Response("<html><body>no results here</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("isConfigured is always true (no credentials, which is also why it is last resort)", () => {
  assert.equal(new ScrapeResolver().isConfigured(), true);
});

test("resolves a TI part via the direct symlink candidate (keeps the TI demo alive)", async () => {
  const pdfUrl = "https://www.ti.com/lit/ds/symlink/lmp7704-sp.pdf";
  const restore = stubDirectHit(pdfUrl);
  try {
    const ref = await new ScrapeResolver().resolve("LMP7704-SP", { manufacturer: "Texas Instruments" });
    assert.ok(ref);
    assert.equal(ref!.fileName, "LMP7704-SP.pdf");
    assert.equal(ref!.pdfUrl, pdfUrl);
    const head = new Uint8Array(ref!.bytes, 0, 5);
    assert.deepEqual([...head], [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
  } finally {
    restore();
  }
});

test("a rad-hard part with no direct candidate and no search hit resolves to null", async () => {
  // VORAGO VA10820 is not a TI part, so there is no direct URL candidate; the empty search then
  // yields nothing. This is the expected miss the composite turns into the upload prompt.
  const restore = stubEmptySearch();
  try {
    const ref = await new ScrapeResolver().resolve("VA10820", { manufacturer: "VORAGO" });
    assert.equal(ref, null);
  } finally {
    restore();
  }
});

test("a search-engine error surfaces as a SOFT transport error, never a hard one", async () => {
  // Every request fails. The direct candidates 404 (returned as not-found), then the first search
  // fetch throws, which scrape wraps as a soft transport ResolverError so the user can still upload.
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("blocked", { status: 503 })) as typeof fetch;
  try {
    await assert.rejects(
      () => new ScrapeResolver().resolve("VA10820", { manufacturer: "VORAGO" }),
      (err: unknown) => err instanceof ResolverError && err.kind === "transport" && err.hard === false
    );
  } finally {
    globalThis.fetch = original;
  }
});
