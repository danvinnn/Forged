import { test } from "node:test";
import assert from "node:assert/strict";
import { ScrapeResolver } from "../resolvers/scrape";
import { ResolverError } from "../resolvers/errors";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

/**
 * Is this one of the search backends rather than a datasheet candidate?
 *
 * Matched on the SHAPE of a search URL, not on a list of engine names. The name list broke twice as
 * backends were added (brave-html, then bing): a stub that only answered DuckDuckGo left the rest
 * to 404, which reads as a refusal, so tests asserting a clean miss threw instead. Every engine
 * carries the query in `?q=` or `?query=`; no vendor candidate URL does.
 */
function isSearchUrl(url: string): boolean {
  return /[?&](q|query)=/.test(url);
}

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
    // Every backend must answer, not just the first. An empty answer now falls THROUGH to the next
    // backend rather than ending the search, so a stub that only serves DuckDuckGo leaves the rest
    // to 404, which reads as a refusal and throws instead of reporting the clean miss under test.
    if (isSearchUrl(url)) {
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

// --- Product-page harvesting -------------------------------------------------------------------
// Two defects, both found on 2026-09-01 while measuring why Microchip parts were reported as having
// no datasheet at all. Neither was visible from the resolver's outside: the page WAS fetched, the
// harvest WAS attempted, and the answer was still "not found".

// A vendor product page in the shape that broke the harvester: every PDF URL lives in embedded
// JSON, and NOT ONE of them is inside an href attribute. Microchip's real ATMEGA328P page carries
// 92 PDF URLs and zero hrefs, so the old href-only scan found nothing on it.
function microchipStylePage(pdfUrls: string[]): string {
  const payload = pdfUrls.map((url) => `{"mchp:Link":"${url}","mchp:Title":"doc"}`).join(",");
  return `<html><body><div id="app"></div><script>window.__DATA__=[${payload}]</script></body></html>`;
}

// Serves the product page, PDF bytes for the URLs named in `servesPdf`, and 404 for everything else
// including every search backend.
function stubProductPage(pageUrl: string, html: string, servesPdf: string[]): () => void {
  const original = globalThis.fetch;
  const pdfSet = new Set(servesPdf);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === pageUrl) {
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (pdfSet.has(url)) {
      return new Response(PDF_BYTES, { status: 200, headers: { "content-type": "application/pdf" } });
    }
    // Search must answer 200 with no results. A 404 would be read as a BLOCK, which is the
    // distinction `search.ts` exists to preserve, and the resolver would correctly throw rather
    // than report a miss. That would make these tests pass or fail for the wrong reason.
    if (isSearchUrl(url)) {
      return new Response("<html><body>no results</body></html>", {
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

const MICROCHIP_PAGE = "https://www.microchip.com/en-us/product/ATMEGA328P";
const MICROCHIP_DATASHEET =
  "https://ww1.microchip.com/downloads/aemDocuments/documents/MCU08/ProductDocuments/DataSheets/Atmel-7810-ATmega328P_Datasheet.pdf";

test("harvests a PDF whose URL is in embedded JSON rather than an href", async () => {
  const restore = stubProductPage(
    MICROCHIP_PAGE,
    microchipStylePage([MICROCHIP_DATASHEET]),
    [MICROCHIP_DATASHEET]
  );
  try {
    const ref = await new ScrapeResolver().resolve("ATMEGA328P", { manufacturer: "Microchip" });
    assert.ok(ref, "the page names the datasheet; an href-only scan is what could not see it");
    assert.equal(ref!.pdfUrl, MICROCHIP_DATASHEET);
    assert.equal(ref!.sourcePageUrl, MICROCHIP_PAGE);
  } finally {
    restore();
  }
});

test("ranks the datasheet above other documents before applying the eight-link cap", async () => {
  // Eleven documents, datasheet LAST in document order. The cap is eight, so an unranked harvest
  // drops the only link that matters. This is the case the code's own comment claimed to handle
  // for months while no sort existed: a real vendor product page lists app notes, errata and white
  // papers for the same part, so "the first eight" is close to a random eight.
  const appNotes = Array.from(
    { length: 10 },
    (_, i) => `https://ww1.microchip.com/downloads/ApplicationNotes/AN${1000 + i}.pdf`
  );
  const restore = stubProductPage(
    MICROCHIP_PAGE,
    microchipStylePage([...appNotes, MICROCHIP_DATASHEET]),
    // Only the datasheet is fetchable. If ranking failed to promote it, the eight app notes tried
    // instead all 404 and the resolver reports not found.
    [MICROCHIP_DATASHEET]
  );
  try {
    const ref = await new ScrapeResolver().resolve("ATMEGA328P", { manufacturer: "Microchip" });
    assert.ok(ref, "the datasheet is 11th of 11 and must be promoted past the cap by ranking");
    assert.equal(ref!.pdfUrl, MICROCHIP_DATASHEET);
  } finally {
    restore();
  }
});

test("a product page carrying no usable PDF is a miss, not an error", async () => {
  const restore = stubProductPage(MICROCHIP_PAGE, microchipStylePage([]), []);
  try {
    assert.equal(await new ScrapeResolver().resolve("ATMEGA328P", { manufacturer: "Microchip" }), null);
  } finally {
    restore();
  }
});

// --- A rejected candidate must not end the resolver ---------------------------------------------
// `identity.ts` states the rule in its own words: "A rejected candidate has to mean 'try the next
// URL', not 'this resolver failed'." The manufacturer resolver had always worked that way. This one
// had not: it committed to the first candidate that looked like a PDF, and the caller identity-
// checked it afterwards, so one wrong-device copy at the top of the ranking lost the part outright.
//
// Measured 2026-09-01: three FPGA parts were reported as having no datasheet, and all three were
// `resolver_wrong_part` rejections of a single first candidate.
//
// Real PDFs, because the check being exercised parses the document.
const RIGHT_PART_PDF = readFileSync(join(process.cwd(), "test-data", "LMP7704-SP.pdf"));
const UNREADABLE_PDF = readFileSync(join(process.cwd(), "test-data", "scanned-no-text-layer.pdf"));

test("keeps going when the top-ranked candidate is not the part we asked for", async () => {
  // The scanned PDF parses to a text layer that does not name LMP7704-SP, so it is correctly
  // rejected. Ranked first because its URL carries both the part number and the word "datasheet".
  // The real LMP7704-SP datasheet is second and must still be reached.
  const rejectedUrl = "https://www.mouser.com/datasheet/lmp7704-sp.pdf";
  const acceptedUrl = "https://www.analog.com/media/en/technical-documentation/data-sheets/lmp7704-sp.pdf";
  const page = `<html><body><a href="${rejectedUrl}">a</a><a href="${acceptedUrl}">b</a></body></html>`;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (isSearchUrl(url)) {
      return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url === rejectedUrl) {
      return new Response(UNREADABLE_PDF, { status: 200, headers: { "content-type": "application/pdf" } });
    }
    if (url === acceptedUrl) {
      return new Response(RIGHT_PART_PDF, { status: 200, headers: { "content-type": "application/pdf" } });
    }
    // Everything else, including every direct candidate, misses. So this exercises the search path.
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const ref = await new ScrapeResolver().resolve("LMP7704-SP");
    assert.ok(ref, "the first candidate is not this part; the second one must still be tried");
    assert.equal(ref!.pdfUrl, acceptedUrl);
  } finally {
    globalThis.fetch = original;
  }
});

// --- The chain budget has to reach INSIDE this resolver -----------------------------------------
// Measured 2026-09-02 on a clean live run: a MISS took a median of 12.8s and hit the 30s ceiling,
// against a 12s chain budget. The budget was only checked BETWEEN resolvers, on the reasoning that
// one resolver could overshoot by at most its own per-call timeout. That stopped being true as this
// resolver grew: direct candidates, then several queries across several backends, then up to twelve
// ranked results each of which can be a page fetch plus further downloads.
//
// It is not only slow. The budget exists to sit UNDER the host's function timeout so a miss produces
// our own "upload instead" answer; a 30s miss on a 10-to-15-second serverless function produces the
// platform 504 the whole design is built to avoid.

test("stops starting new work once the deadline has passed", async () => {
  let requests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests++;
    const url = typeof input === "string" ? input : input.toString();
    if (isSearchUrl(url)) {
      return new Response("<html><body>no results</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    // A deadline already in the past: nothing new may be started.
    const ref = await new ScrapeResolver().resolve("VA10820", {
      manufacturer: "VORAGO",
      deadlineAt: Date.now() - 1
    });
    assert.equal(ref, null, "an expired deadline still reports a clean miss, not an error");
    assert.equal(requests, 0, "no candidate and no query may be started past the deadline");
  } finally {
    globalThis.fetch = original;
  }
});

test("a deadline in the future does not change the outcome", async () => {
  // The guard must bound time, not behaviour. Same lookup, generous deadline, normal result.
  const mouserUrl = "https://www.mouser.com/pdfdocs/VA10820.pdf";
  const restore = stubDirectHit(mouserUrl);
  try {
    const ref = await new ScrapeResolver().resolve("VA10820", {
      manufacturer: "VORAGO",
      deadlineAt: Date.now() + 60_000
    });
    assert.ok(ref);
    assert.equal(ref!.pdfUrl, mouserUrl);
  } finally {
    restore();
  }
});
