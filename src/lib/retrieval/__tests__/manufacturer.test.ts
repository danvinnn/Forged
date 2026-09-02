import { test } from "node:test";
import assert from "node:assert/strict";
import { ManufacturerResolver, buildCandidateUrls, buildProductPageUrls } from "../resolvers/manufacturer";
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

test("a hint naming a known vendor is tried FIRST, not exclusively", async () => {
  // This used to assert that speculation was skipped entirely when the hint named a known vendor.
  // That rule LOST PCF8574 the moment NXP entered the registry: the corpus hints it as NXP, NXP
  // really does make it, `nxp.com/docs/en/data-sheet/PCF8574.pdf` really does 404, and the copy
  // that resolves is TI's. Adding a vendor made a working part stop working.
  const requested: string[] = [];
  const restore = stubFetch((url) => {
    requested.push(url);
    return new Response("not found", { status: 404 });
  });
  try {
    await new ManufacturerResolver().resolve("LMP7704-SP", { manufacturer: "Texas Instruments" });
    const tiFirst = requested.findIndex((u) => u.includes("ti.com"));
    const otherFirst = requested.findIndex((u) => !u.includes("ti.com"));
    assert.ok(tiFirst === 0, "the hinted vendor must be tried first");
    assert.ok(otherFirst > 0, "other vendors must still be tried once the hinted one misses");
  } finally {
    restore();
  }
});

test("a second-sourced part resolves from a vendor the hint did not name", async () => {
  // The regression above, as a test. PCF8574 is hinted NXP and answered by TI.
  const tiUrl = "https://www.ti.com/lit/ds/symlink/pcf8574.pdf";
  const restore = stubFetch((url) =>
    url === tiUrl
      ? new Response(PDF_BYTES, { status: 200, headers: { "content-type": "application/pdf" } })
      : new Response("not found", { status: 404 })
  );
  try {
    const ref = await new ManufacturerResolver().resolve("PCF8574", { manufacturer: "NXP" });
    assert.ok(ref, "NXP publishes it and does not host it; TI does");
    assert.equal(ref!.pdfUrl, tiUrl);
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
  // This used to assert "no candidates at all", which was a proxy for the real property only
  // while the registry had no connector vendors in it. TE and Molex are now in it and correctly
  // claim their own parts, so the proxy would fail for a good reason and hide the bad one.
  // Assert what the regression was actually about: these must not be sent to ti.com.
  const te = claimedUrls("282836-2", "TE Connectivity");
  assert.ok(!te.some((u) => u.includes("ti.com")), "connecTIvity must not be read as Texas Instruments");
  assert.ok(te.some((u) => u.includes("te.com")), "TE should claim its own part");

  const molex = claimedUrls("43045-0400", "Molex");
  assert.ok(!molex.some((u) => u.includes("ti.com")));
  assert.ok(molex.some((u) => u.includes("molex.com")), "Molex should claim its own part");

  const jst = claimedUrls("S2B-PH-K-S", "JST");
  assert.ok(!jst.some((u) => u.includes("ti.com")));
  assert.ok(jst.some((u) => u.includes("jst-mfg.com")), "JST should claim its own part");
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

// --- Vendors added 2026-09-01 ------------------------------------------------------------------
// Each URL below was fetched through Node's `fetch` on 2026-09-01 and returned a real PDF. These
// assertions are the tripwire for a vendor changing its scheme, which is the only thing that can
// silently take the coverage back down. See the per-vendor notes in `manufacturer.ts`.
//
// Verified with `fetch` and NOT curl, deliberately: vendor CDNs fingerprint curl's TLS handshake,
// and ST, ADI, onsemi and Microchip all refuse it while answering fetch normally. A pattern
// "verified" with curl would have been recorded as unreachable when it works fine.

test("builds the verified URL for each vendor added in the 2026-09-01 pass", () => {
  const cases: Array<[string, string | undefined, string]> = [
    ["NCP1200", "onsemi", "https://www.onsemi.com/download/data-sheet/pdf/ncp1200-d.pdf"],
    ["TJA1050", "NXP", "https://www.nxp.com/docs/en/data-sheet/TJA1050.pdf"],
    ["AP2112", "Diodes", "https://www.diodes.com/assets/Datasheets/AP2112.pdf"],
    ["RP2040", "Raspberry Pi", "https://datasheets.raspberrypi.com/rp2040/rp2040-datasheet.pdf"],
    ["ISL71001M", "Renesas", "https://www.renesas.com/en/document/dst/isl71001m-datasheet"],
    ["43045-0400", "Molex", "https://www.molex.com/pdm_docs/sd/430450400_sd.pdf"],
    // JST documents a SERIES, not an orderable part: the series is the second dash-separated token.
    ["S2B-PH-K-S", "JST", "https://www.jst-mfg.com/product/pdf/eng/ePH.pdf"]
  ];
  for (const [part, manufacturer, expected] of cases) {
    assert.ok(
      claimedUrls(part, manufacturer).includes(expected),
      `${part} should produce the verified URL ${expected}`
    );
  }
});

test("ESP32-WROOM-32 keeps its suffix: the datasheet is filed under the full module name", () => {
  // A module's suffix is part of its identity rather than an ordering code, so the variant list's
  // habit of stripping after a dash must not be what wins here.
  assert.ok(
    claimedUrls("ESP32-WROOM-32", "Espressif").includes(
      "https://www.espressif.com/sites/default/files/documentation/esp32-wroom-32_datasheet_en.pdf"
    )
  );
});

// --- Vendors decline to guess ------------------------------------------------------------------
// The speculative tier tries every registry vendor's shape against a part no vendor claimed. That
// was affordable at three vendors. With connector vendors in the registry it is not: their paths
// are built from digits, so speculating them against `LM358` spends a real outbound request to
// learn nothing. A vendor that cannot apply its shape returns nothing rather than a garbage URL.

test("a digits-only vendor produces no URL for an alphabetic part", () => {
  const all = buildCandidateUrls("LM358");
  const urls = [...all.claimed, ...all.speculative];
  for (const host of ["molex.com", "te.com", "amphenol-cs.com", "espressif.com", "raspberrypi.com"]) {
    assert.ok(!urls.some((u) => u.includes(host)), `${host} has no URL shape that fits LM358`);
  }
});

test("the speculative tier stays bounded as the registry grows", () => {
  // The tier is fetched in PARALLEL, and its whole justification is that parallel speculation costs
  // about one round trip. Unbounded, every vendor added multiplies into every part variant and one
  // user request becomes dozens of outbound ones from a public endpoint.
  for (const part of ["LM358", "XYZ1234", "9999-9999", "SOMETHINGWEIRD99"]) {
    assert.ok(
      buildCandidateUrls(part).speculative.length <= 24,
      `${part} produced an unbounded speculative tier`
    );
  }
});

// --- Product pages -----------------------------------------------------------------------------
// Microchip files datasheets under document numbers (`39582C.pdf`), so no part-number pattern can
// reach them. Its product page is derivable and carries the link, which the scrape resolver
// harvests. Verified 2026-09-01 on ATMEGA328P, PIC16F877A and MCP2515: the correct datasheet ranked
// FIRST out of 92, 53 and 11 harvested links.

test("a document-number vendor contributes a product page instead of a datasheet URL", () => {
  assert.deepEqual(claimedUrls("ATMEGA328P", "Microchip"), [], "no derivable datasheet filename");
  assert.ok(
    buildProductPageUrls("ATMEGA328P", "Microchip").includes(
      "https://www.microchip.com/en-us/product/ATMEGA328P"
    )
  );
});

test("product pages are claimed-only, never speculative", () => {
  // A product page costs a page fetch, a parse and up to eight further downloads. That is
  // affordable once for a vendor that plausibly owns the part, and not affordable across the whole
  // registry on a guess.
  assert.deepEqual(buildProductPageUrls("LMP7704-SP", "Texas Instruments"), []);
  assert.deepEqual(buildProductPageUrls("RHF310A", "STMicroelectronics"), []);
});

test("no vendor claims a part outside its own class", () => {
  // RULES.md rule 4, as a check rather than an intention. Found by sweeping all 142 part numbers in
  // the two retrieval corpora: the JST shape rule matched ESP32-WROOM-32, so every Espressif module
  // lookup also asked jst-mfg.com for `eWROOM.pdf`. A rule whose wording says JST and whose
  // behaviour says Espressif is tailored, whatever its comment claims.
  const connectorHosts = ["molex.com", "te.com", "amphenol-cs.com", "jst-mfg.com"];
  const chips: Array<[string, string]> = [
    ["ESP32-WROOM-32", "Espressif"],
    ["LMP7704-SP", "Texas Instruments"],
    ["STM32G071RB", "STMicroelectronics"],
    ["ADA4522-2", "Analog Devices"],
    ["PIC32MX250F128B", "Microchip"]
  ];
  for (const [part, mfr] of chips) {
    const urls = [...claimedUrls(part, mfr), ...buildProductPageUrls(part, mfr)];
    for (const host of connectorHosts) {
      assert.ok(!urls.some((u) => u.includes(host)), `${part} must not be sent to ${host}`);
    }
  }
});
