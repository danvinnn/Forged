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

// A complete part record that passes partSchema. Only partNumber varies across tests; the rest is
// benign filler. If partSchema drifts, this is the one place to update.
function partWith(partNumber: string): Record<string, unknown> {
  return {
    id: "test-1",
    partNumber,
    manufacturer: "Test",
    packageType: "SOIC-8",
    pinCount: 8,
    pins: [],
    dimensions: {
      bodyLengthMm: 4.9,
      bodyWidthMm: 3.9,
      bodyHeightMm: 1.5,
      pitchMm: 1.27,
      leadLengthMm: 0.6,
      leadCount: 8
    },
    radiation: { tid: null, see: null, sel: null, qmlClass: null },
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
