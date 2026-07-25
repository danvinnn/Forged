import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, clientKey } from "../ratelimit";

// Why this is a security control: /api/lookup makes OUTBOUND requests to vendor sites on behalf of
// an anonymous caller. One request in becomes several fetches out, so an unlimited endpoint is a
// traffic amplifier pointed at the third parties we depend on.

test("allows up to the limit then refuses", () => {
  const limiter = new RateLimiter(3, 60_000);
  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.check("1.2.3.4").allowed, true, `request ${i + 1} should pass`);
  }
  const blocked = limiter.check("1.2.3.4");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0, "a refusal must tell the caller when to retry");
});

test("keys are independent", () => {
  const limiter = new RateLimiter(1, 60_000);
  assert.equal(limiter.check("a").allowed, true);
  assert.equal(limiter.check("b").allowed, true, "one client must not exhaust another's budget");
  assert.equal(limiter.check("a").allowed, false);
});

test("the window resets", async () => {
  const limiter = new RateLimiter(1, 20);
  assert.equal(limiter.check("x").allowed, true);
  assert.equal(limiter.check("x").allowed, false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(limiter.check("x").allowed, true);
});

test("the key map is bounded against address rotation", () => {
  // The map is keyed by client-controlled values, so it is itself a memory-exhaustion target.
  const limiter = new RateLimiter(5, 60_000, 50);
  for (let i = 0; i < 500; i++) limiter.check(`10.0.0.${i}`);
  assert.ok(limiter.size <= 50, `expected bounded map, got ${limiter.size}`);
});

test("clientKey takes the FIRST x-forwarded-for entry", () => {
  // Proxy headers are attacker-appendable. The first entry is the client as recorded by the
  // closest trusted hop; trusting the last would let a caller spoof a fresh identity per request.
  const req = new Request("http://test/", { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } });
  assert.equal(clientKey(req), "203.0.113.9");
});

test("clientKey falls back to a SHARED bucket when unidentifiable", () => {
  // Deliberate: unidentifiable traffic contending with itself is better than each such request
  // getting a fresh allowance, which would make the limit bypassable by stripping headers.
  const a = clientKey(new Request("http://test/"));
  const b = clientKey(new Request("http://test/"));
  assert.equal(a, b);
});

test("x-real-ip is used when x-forwarded-for is absent", () => {
  const req = new Request("http://test/", { headers: { "x-real-ip": "198.51.100.7" } });
  assert.equal(clientKey(req), "198.51.100.7");
});
