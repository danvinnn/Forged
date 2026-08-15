import { test } from "node:test";
import assert from "node:assert/strict";
import { POST as exportPOST } from "../../../app/api/export/route";

// The export route sets Content-Disposition with a filename derived from the part number, which is
// user-controlled. A raw part number there is a header-injection point: CR/LF or a quote can inject
// a second header or directive. These lock in that the value is always safe.

function exportRequest(part: unknown, format = "kicad"): Request {
  return new Request("http://test/api/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ part, format })
  });
}

/** An honestly-unknown value: no value, so no confidence and no citation. */
function notFound(): Record<string, unknown> {
  return { value: null, confidence: null, method: null, citation: null };
}

/** Wraps a value in the Extracted envelope with a plausible citation. */
function found(value: unknown): Record<string, unknown> {
  return {
    value,
    confidence: 0.9,
    method: "deterministic",
    citation: { page: 1, snippet: String(value), region: null }
  };
}

// A complete part record that passes partSchema AND resolveForExport. Only partNumber varies
// across tests; the rest is benign filler. Pins are real because an export with no pin data is
// now refused by design, which is the point of the extraction gate.
function partWith(partNumber: string): Record<string, unknown> {
  const pins = Array.from({ length: 8 }, (_, index) => ({
    number: String(index + 1),
    name: `P${index + 1}`,
    electricalType: "unspecified"
  }));

  return {
    id: "test-1",
    partNumber: found(partNumber),
    manufacturer: found("Test"),
    packageType: found("SOIC-8"),
    pinCount: found(8),
    pins: found(pins),
    dimensions: {
      bodyLengthMm: found(4.9),
      bodyWidthMm: found(3.9),
      bodyHeightMm: found(1.5),
      pitchMm: found(1.27),
      leadLengthMm: found(0.6),
      leadCount: found(8),
      // The part's own drawing: TI D0008A, JEDEC MS-012. Added 2026-08-14 when
      // the family table was deleted; before that a package NAME was enough to
      // produce a footprint, which is what these tests happened to rely on. The
      // test is about header injection, not about land patterns, so the record
      // just has to be one that exports.
      leadWidthMm: found({ minMm: 0.31, maxMm: 0.51 }),
      leadSpanMm: found({ minMm: 5.8, maxMm: 6.2 }),
      leadContactMm: found({ minMm: 0.4, maxMm: 0.625 }),
      leadSides: found(2),
      leadForm: found("gullwing")
    },
    radiation: { tid: notFound(), see: notFound(), sel: notFound(), qmlClass: notFound() },
    sourceFileName: "test.pdf",
    notes: []
  };
}

test("a CRLF-injecting part number cannot break the Content-Disposition header", async () => {
  const malicious = "EVIL\r\nSet-Cookie: pwned=1";
  const res = await exportPOST(exportRequest(partWith(malicious)));

  // Either the schema rejects it outright (fine), or it is accepted and the header is safe. What
  // must NEVER happen is a header carrying the injected content.
  assert.equal(res.status, 200, "the record is otherwise valid, so it should export");
  const disposition = res.headers.get("content-disposition") ?? "";
  // The one property that matters: no raw CR/LF, so the injected "Set-Cookie:" cannot become its
  // own header. sanitizeFileName collapses the control chars, leaving EVILSet-Cookie-x-1-forge.zip.
  assert.doesNotMatch(disposition, /[\r\n]/, "no raw CR/LF may reach the header");
  assert.equal(res.headers.get("set-cookie"), null, "no injected cookie header");
});

test("a quote-injecting part number cannot escape the filename token", async () => {
  const malicious = 'A"; attachment; filename="evil.exe';
  const res = await exportPOST(exportRequest(partWith(malicious)));
  assert.equal(res.status, 200);
  const disposition = res.headers.get("content-disposition") ?? "";
  const asciiToken = disposition.match(/filename="([^"]*)"/);
  assert.ok(asciiToken, "expected a quoted filename token");
  // No bare quote survived, so no second filename directive can escape the token.
  assert.doesNotMatch(asciiToken![1], /["\r\n]/);
});

test("a normal part number produces a clean zip filename", async () => {
  const res = await exportPOST(exportRequest(partWith("LMP7704-SP")));
  assert.equal(res.status, 200);
  const disposition = res.headers.get("content-disposition") ?? "";
  assert.match(disposition, /filename="LMP7704-SP-forge\.zip"/);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("an oversized declared body is refused before JSON parsing", async () => {
  const req = new Request("http://test/api/export", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(5_000_000) },
    body: JSON.stringify({ part: partWith("X"), format: "kicad" })
  });
  const res = await exportPOST(req);
  assert.equal(res.status, 413);
});
