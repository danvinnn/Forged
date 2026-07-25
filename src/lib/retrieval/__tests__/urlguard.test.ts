import { test } from "node:test";
import assert from "node:assert/strict";
import { assertFetchableUrl, isBlockedAddress, BlockedUrlError } from "../resolvers/urlguard";

// The exposure these close: the scrape resolver fetches URLs it extracted from third-party
// search-result HTML, and follows redirects. Without this guard, a poisoned result or a redirect
// decides what our server connects to. On a cloud host the prize is the metadata endpoint.

test("blocks cloud metadata and loopback addresses", () => {
  assert.equal(isBlockedAddress("169.254.169.254"), true); // AWS/GCP instance metadata
  assert.equal(isBlockedAddress("127.0.0.1"), true);
  assert.equal(isBlockedAddress("0.0.0.0"), true);
});

test("blocks every RFC1918 private range", () => {
  for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.1", "100.64.0.1"]) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`);
  }
  // Boundaries: 172.15 and 172.32 are public and must NOT be blocked.
  assert.equal(isBlockedAddress("172.15.0.1"), false);
  assert.equal(isBlockedAddress("172.32.0.1"), false);
});

test("blocks IPv6 loopback, unique-local, link-local, and IPv4-mapped bypasses", () => {
  assert.equal(isBlockedAddress("::1"), true);
  assert.equal(isBlockedAddress("fc00::1"), true);
  assert.equal(isBlockedAddress("fe80::1"), true);
  // ::ffff:169.254.169.254 would reach metadata if only the v4 path were checked.
  assert.equal(isBlockedAddress("::ffff:169.254.169.254"), true);
});

test("allows ordinary public addresses", () => {
  assert.equal(isBlockedAddress("8.8.8.8"), false);
  assert.equal(isBlockedAddress("2606:4700::1"), false);
});

test("rejects non-http schemes", async () => {
  for (const url of ["file:///etc/passwd", "gopher://x/", "data:text/plain,hi"]) {
    await assert.rejects(() => assertFetchableUrl(url), BlockedUrlError, `${url} must be refused`);
  }
});

test("rejects internal hostnames without needing DNS", async () => {
  for (const url of [
    "http://localhost/x.pdf",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://db.internal/x.pdf",
    "http://printer.local/x.pdf"
  ]) {
    await assert.rejects(() => assertFetchableUrl(url), BlockedUrlError, `${url} must be refused`);
  }
});

test("rejects a literal private IP in the URL", async () => {
  await assert.rejects(
    () => assertFetchableUrl("http://169.254.169.254/latest/meta-data/iam/security-credentials/"),
    BlockedUrlError
  );
  await assert.rejects(() => assertFetchableUrl("http://192.168.0.1/admin"), BlockedUrlError);
});

test("accepts a real vendor datasheet URL", async () => {
  const url = await assertFetchableUrl("https://www.ti.com/lit/ds/symlink/lmp7704-sp.pdf");
  assert.equal(url.hostname, "www.ti.com");
});

test("rejects a malformed URL rather than passing it to fetch", async () => {
  await assert.rejects(() => assertFetchableUrl("not a url"), BlockedUrlError);
});
