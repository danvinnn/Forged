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

test("a search-engine error surfaces as a SOFT error, never a hard one", async () => {
  // Every request fails. Direct candidates 404 (not-found), then every search backend returns 503,
  // which the SearchClient classifies as a refusal. The resulting error is SOFT either way, so the
  // user degrades to upload rather than seeing a hard operator error. The kind is now the more
  // precise rate_limit rather than a generic transport failure, because "the engine refused us" is
  // a different fact from "the network broke".
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("blocked", { status: 503 })) as typeof fetch;
  try {
    await assert.rejects(
      () => new ScrapeResolver().resolve("VA10820", { manufacturer: "VORAGO" }),
      (err: unknown) => err instanceof ResolverError && err.hard === false
    );
  } finally {
    globalThis.fetch = original;
  }
});

// --- Distributor-hosted fallback --------------------------------------------------------------
// The finding this exists for, checked 2026-07-22: VORAGO does not publish datasheets on its own
// site at all. Its documentation index lists white papers, app notes, tech briefs, and PCNs, and
// zero datasheets; the product page routes to a sales contact. The only public copies of
// VA10820_DS_12.pdf are distributor-hosted. So for exactly the parts that define this product, a
// distributor-hosted PDF is the only reachable source, and reading one a distributor serves
// publicly to any browser needs no API key and no terms acceptance.

test("tries a Mouser-hosted path for a part no manufacturer pattern claims", async () => {
  const mouserUrl = "https://www.mouser.com/pdfdocs/VA10820.pdf";
  const restore = stubDirectHit(mouserUrl);
  try {
    const ref = await new ScrapeResolver().resolve("VA10820", { manufacturer: "VORAGO" });
    assert.ok(ref, "a distributor-hosted datasheet should still resolve");
    assert.equal(ref!.pdfUrl, mouserUrl);
    assert.equal(ref!.fileName, "VA10820.pdf");
  } finally {
    restore();
  }
});

test("still resolves TI directly, unaffected by the distributor additions", async () => {
  const tiUrl = "https://www.ti.com/lit/ds/symlink/lmp7704-sp.pdf";
  const restore = stubDirectHit(tiUrl);
  try {
    const ref = await new ScrapeResolver().resolve("LMP7704-SP", { manufacturer: "Texas Instruments" });
    assert.ok(ref);
    assert.equal(ref!.pdfUrl, tiUrl);
  } finally {
    restore();
  }
});

// --- Blocked search must not become a false "not found" ---------------------------------------
import { SearchClient, SearchBlockedError } from "../resolvers/search";

test("a blocked search throws SOFT instead of claiming the part has no datasheet", async () => {
  // The production failure this prevents: on a cloud host every engine may refuse us. Returning
  // null would make the route answer DATASHEET_NOT_FOUND, telling the user their part does not
  // exist when we simply could not look. Soft means the composite swallows it, the user still gets
  // the upload prompt, and the operator sees the real cause in the message.
  const blockedClient = new SearchClient([
    {
      name: "all-blocked",
      isConfigured: () => true,
      search: async () => {
        throw new SearchBlockedError("all-blocked", "captcha");
      }
    }
  ]);
  const restore = stubDirectHit("https://nothing.test/never.pdf"); // every direct candidate 404s
  try {
    await assert.rejects(
      () => new ScrapeResolver(blockedClient).resolve("VA10820", { manufacturer: "VORAGO" }),
      (err: unknown) =>
        err instanceof ResolverError && err.hard === false && /refused/i.test(err.message)
    );
  } finally {
    restore();
  }
});

test("deterministic candidates still resolve even when every search backend is blocked", async () => {
  // The graceful-degradation property: TI parts keep working on a cloud host that search engines
  // refuse to serve, because the direct vendor URL never touches a search engine.
  const blockedClient = new SearchClient([
    {
      name: "all-blocked",
      isConfigured: () => true,
      search: async () => {
        throw new SearchBlockedError("all-blocked", "HTTP 429");
      }
    }
  ]);
  const tiUrl = "https://www.ti.com/lit/ds/symlink/lmp7704-sp.pdf";
  const restore = stubDirectHit(tiUrl);
  try {
    const ref = await new ScrapeResolver(blockedClient).resolve("LMP7704-SP", { manufacturer: "TI" });
    assert.ok(ref, "direct vendor candidates must survive a total search outage");
    assert.equal(ref!.pdfUrl, tiUrl);
  } finally {
    restore();
  }
});
