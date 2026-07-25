import { test } from "node:test";
import assert from "node:assert/strict";
import { ManufacturerResolver, buildCandidateUrls } from "../resolvers/manufacturer";
import { ResolverError } from "../resolvers/errors";

// Candidates are now split into a CLAIMED tier (vendors whose prefix or manufacturer hint matched)
// and a SPECULATIVE tier (every other known vendor, tried only when no hint named a vendor). Most
// assertions below are about the claimed tier, so this keeps them readable.
function claimedUrls(part: string, manufacturer?: string): string[] {
  return buildCandidateUrls(part, manufacturer).claimed;
}

const PDF_BYTES = (() => {
  const header = new TextEncoder().encode("%PDF-1.7\n");
  const body = new Uint8Array(128);
  body.set(header, 0);
  return body;
})();

// The URL this asserts against is not a guess. It was fetched live on 2026-07-22 and returned the
// real LMP7704-SP datasheet (SNOSDB6D). If TI ever changes this scheme, this test is the tripwire.
const VERIFIED_TI_URL = "https://www.ti.com/lit/ds/symlink/lmp7704-sp.pdf";

function stubFetch(handler: (url: string) => Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test("isConfigured is always true: no credentials means no setup prerequisite", () => {
  assert.equal(new ManufacturerResolver().isConfigured(), true);
});

test("builds the verified TI symlink URL for LMP7704-SP", () => {
  const urls = claimedUrls("LMP7704-SP", "Texas Instruments");
  assert.ok(urls.includes(VERIFIED_TI_URL), `expected the verified TI URL, got:\n${urls.join("\n")}`);
});

test("claims TI parts by prefix even with no manufacturer hint", () => {
  // A user typing just "LMP7704-SP" with no hint should still hit the TI path.
  assert.ok(claimedUrls("LMP7704-SP").length > 0);
});

test("tries the family variant so an ordering suffix does not cause a miss", () => {
  const urls = claimedUrls("LMP7704-SP", "Texas Instruments");
  assert.ok(urls.some((u) => u.includes("lmp7704.pdf")), "expected a bare LMP7704 candidate");
});

test("claims nothing for a rad-hard vendor with no derivable pattern", () => {
  // VORAGO's datasheet is published as VA10820_DS_12.pdf with an embedded doc revision, which
  // cannot be built from the part number. Claiming it would mean guessing, so we claim nothing and
  // let the chain fall through to upload. This asserts the KNOWN LIMIT stays honest.
  assert.deepEqual(claimedUrls("VA10820", "VORAGO"), []);
  assert.deepEqual(claimedUrls("UT32M0R500", "CAES"), []);
});

test("resolves LMP7704-SP from the manufacturer with zero credentials", async () => {
  const restore = stubFetch((url) =>
    url === VERIFIED_TI_URL
      ? new Response(PDF_BYTES, { status: 200, headers: { "content-type": "application/pdf" } })
      : new Response("not found", { status: 404 })
  );
  try {
    const ref = await new ManufacturerResolver().resolve("LMP7704-SP", { manufacturer: "Texas Instruments" });
    assert.ok(ref);
    assert.equal(ref!.fileName, "LMP7704-SP.pdf");
    assert.equal(ref!.pdfUrl, VERIFIED_TI_URL);
    assert.match(ref!.sha256, /^[0-9a-f]{64}$/);
  } finally {
    restore();
  }
});

test("an unclaimed part still resolves to null, via the speculative tier", async () => {
  // Behavior change, deliberate: an unclaimed part now DOES get speculative requests, because our
  // prefix regexes are conservative and a real part from a vendor we support can fall outside them.
  // Speculation is affordable only because candidates run in parallel, so the whole tier costs
  // roughly one round trip. The answer for a genuinely unsupported vendor is unchanged: null.
  const restore = stubFetch(() => new Response("not found", { status: 404 }));
  try {
    assert.equal(await new ManufacturerResolver().resolve("VA10820", { manufacturer: "VORAGO" }), null);
  } finally {
    restore();
  }
});

test("a hint naming a known vendor skips speculation entirely", async () => {
  // The user told us who makes it, so trying other vendors' URL shapes is pure waste.
  const requested: string[] = [];
  const restore = stubFetch((url) => {
    requested.push(url);
    return new Response("not found", { status: 404 });
  });
  try {
    await new ManufacturerResolver().resolve("LMP7704-SP", { manufacturer: "Texas Instruments" });
    assert.ok(requested.length > 0);
    assert.ok(
      requested.every((u) => u.includes("ti.com")),
      `speculation should be skipped, got: ${requested.join(", ")}`
    );
  } finally {
    restore();
  }
});

test("speculation finds a part whose prefix our conservative regex misses", async () => {
  // ADG5412F is a real ADI part. If it did not match the AD prefix rule it would previously never
  // have been tried at all; the speculative tier is exactly what recovers this case.
  const adiUrl = "https://www.analog.com/media/en/technical-documentation/data-sheets/zz9000.pdf";
  const restore = stubFetch((url) =>
    url === adiUrl
      ? new Response(PDF_BYTES, { status: 200, headers: { "content-type": "application/pdf" } })
      : new Response("not found", { status: 404 })
  );
  try {
    // ZZ9000 matches no vendor prefix and carries no hint, so only speculation can reach it.
    const ref = await new ManufacturerResolver().resolve("ZZ9000");
    assert.ok(ref, "the speculative tier should have found this");
    assert.equal(ref!.pdfUrl, adiUrl);
  } finally {
    restore();
  }
});

test("candidate ORDER wins, not completion order", async () => {
  // The candidate list is ordered by confidence, so a slow high-confidence URL must beat a fast
  // low-confidence one. Otherwise a generic redirect endpoint could out-race the exact datasheet
  // URL and we would cite the wrong source.
  const exact = "https://www.ti.com/lit/ds/symlink/lmp7704-sp.pdf";
  const generic = "https://www.ti.com/lit/gpn/lmp7704-sp";
  const restore = stubFetch(() => new Response("", { status: 404 }));
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === generic) {
      return new Response(PDF_BYTES, { status: 200 }); // fast
    }
    if (url === exact) {
      await new Promise((r) => setTimeout(r, 30)); // slow but higher confidence
      return new Response(PDF_BYTES, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const ref = await new ManufacturerResolver().resolve("LMP7704-SP", { manufacturer: "TI" });
    assert.equal(ref!.pdfUrl, exact, "the higher-confidence candidate must win despite being slower");
  } finally {
    globalThis.fetch = original;
    restore();
  }
});

test("a 404 on every candidate is a clean null, not an error", async () => {
  const restore = stubFetch(() => new Response("not found", { status: 404 }));
  try {
    assert.equal(await new ManufacturerResolver().resolve("LMP7704-SP", { manufacturer: "TI" }), null);
  } finally {
    restore();
  }
});

test("a candidate serving HTML falls through instead of returning garbage", async () => {
  // ti.com/lit/gpn/... can redirect to a product page. That is not a datasheet, and finalizeRef's
  // %PDF check is what stops it reaching the parser.
  const html = `<html><body>${"product page ".repeat(16)}</body></html>`;
  const restore = stubFetch(() => new Response(html, { status: 200, headers: { "content-type": "text/html" } }));
  try {
    assert.equal(await new ManufacturerResolver().resolve("LMP7704-SP", { manufacturer: "TI" }), null);
  } finally {
    restore();
  }
});

test("total transport failure is SOFT, so the upload fallback stays open", async () => {
  const restore = stubFetch(() => {
    throw new Error("ECONNREFUSED");
  });
  try {
    await assert.rejects(
      () => new ManufacturerResolver().resolve("LMP7704-SP", { manufacturer: "TI" }),
      (err: unknown) => err instanceof ResolverError && err.kind === "transport" && err.hard === false
    );
  } finally {
    restore();
  }
});

// --- Multi-vendor coverage --------------------------------------------------------------------
// Every URL asserted below was fetched live on 2026-07-22 and returned a real datasheet. If a
// vendor changes its scheme, these are the tripwires.

const VERIFIED_ST_URL = "https://www.st.com/resource/en/datasheet/rhf310a.pdf";
const VERIFIED_ADI_URL = "https://www.analog.com/media/en/technical-documentation/data-sheets/ad590.pdf";

test("builds the verified ST URL for the rad-hard RHF310A", () => {
  // RHF310A is RHA QML-V, 300krad TID. ST's space line IS derivable, unlike the pure-play
  // rad-hard houses, which is why this pattern is worth more than a mainstream one.
  assert.ok(claimedUrls("RHF310A", "STMicroelectronics").includes(VERIFIED_ST_URL));
});

test("builds the verified ADI URL for AD590", () => {
  assert.ok(claimedUrls("AD590", "Analog Devices").includes(VERIFIED_ADI_URL));
});

test("claims rad-hard families by prefix with no manufacturer hint", () => {
  // An engineer typing a rad-hard part number should not have to also know the vendor.
  assert.ok(claimedUrls("RHF310A").some((u) => u.includes("st.com")), "RHF should claim ST");
  assert.ok(claimedUrls("LMP7704-SP").some((u) => u.includes("ti.com")), "LMP should claim TI");
  assert.ok(claimedUrls("AD590").some((u) => u.includes("analog.com")), "AD should claim ADI");
});

test("a manufacturer hint routes to that vendor even for an odd part number", () => {
  const urls = claimedUrls("XYZ999", "STMicroelectronics");
  assert.ok(urls.length > 0 && urls.every((u) => u.includes("st.com")));
});

test("resolves an ST rad-hard part end to end with zero credentials", async () => {
  const restore = stubFetch((url) =>
    url === VERIFIED_ST_URL
      ? new Response(PDF_BYTES, { status: 200, headers: { "content-type": "application/pdf" } })
      : new Response("not found", { status: 404 })
  );
  try {
    const ref = await new ManufacturerResolver().resolve("RHF310A", { manufacturer: "STMicroelectronics" });
    assert.ok(ref);
    assert.equal(ref!.pdfUrl, VERIFIED_ST_URL);
    assert.equal(ref!.fileName, "RHF310A.pdf");
  } finally {
    restore();
  }
});

test("vendors stay isolated: a TI part never queries ST or ADI", () => {
  const urls = claimedUrls("LMP7704-SP", "Texas Instruments");
  assert.ok(urls.every((u) => u.includes("ti.com")), `unexpected cross-vendor candidates: ${urls.join(", ")}`);
});

// --- Manufacturer hint matching ---------------------------------------------------------------
// Regression: the coverage benchmark caught a TE Connectivity connector (282836-2) being claimed by
// Texas Instruments, because the hint match was a substring test and "connecTIvity" contains "ti".
// A connector part was being sent to ti.com. Short aliases must match the whole string.

test("a short alias does not match as a substring of an unrelated vendor", () => {
  assert.deepEqual(
    claimedUrls("282836-2", "TE Connectivity"),
    [],
    "connecTIvity must not be read as Texas Instruments"
  );
  assert.deepEqual(claimedUrls("43045-0400", "Molex"), []);
  assert.deepEqual(claimedUrls("S2B-PH-K-S", "JST"), []);
});

test("short aliases still work when they ARE the whole hint", () => {
  assert.ok(claimedUrls("LMP7704-SP", "TI").some((u) => u.includes("ti.com")));
  assert.ok(claimedUrls("RHF310A", "ST").some((u) => u.includes("st.com")));
  assert.ok(claimedUrls("AD590", "ADI").some((u) => u.includes("analog.com")));
});

test("corporate suffixes are tolerated on full names", () => {
  // Real hints arrive as "Texas Instruments Inc." and similar, and must still match.
  assert.ok(claimedUrls("LMP7704-SP", "Texas Instruments Inc.").some((u) => u.includes("ti.com")));
  assert.ok(
    claimedUrls("AD590", "Analog Devices, Inc.").some((u) => u.includes("analog.com")),
    "a trailing corporate suffix must not break the match"
  );
  assert.ok(claimedUrls("RHF310A", "STMicroelectronics N.V.").some((u) => u.includes("st.com")));
});
