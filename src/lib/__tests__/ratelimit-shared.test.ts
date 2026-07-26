import { test } from "node:test";
import assert from "node:assert/strict";
import { SharedRateLimitStore, type RedisLikeClient } from "../ratelimit-shared";
import { RateLimiter } from "../retrieval/ratelimit";

// Closes the distributed half of the rate-limiting item. The in-process store
// gives roughly (limit x instances) on a serverless deploy; this makes the limit
// hold across instances. Tested against a fake that behaves like Redis,
// including the failure modes that matter (lost TTL, store outage).

class FakeRedis implements RedisLikeClient {
  readonly store = new Map<string, { count: number; expiresAt: number | null }>();
  failNext = false;
  calls: string[] = [];

  private live(key: string) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async incr(key: string): Promise<number> {
    this.calls.push(`incr:${key}`);
    if (this.failNext) throw new Error("redis unreachable");
    const entry = this.live(key) ?? { count: 0, expiresAt: null };
    entry.count += 1;
    this.store.set(key, entry);
    return entry.count;
  }

  async pexpire(key: string, ms: number): Promise<unknown> {
    this.calls.push(`pexpire:${key}`);
    const entry = this.live(key);
    if (entry) entry.expiresAt = Date.now() + ms;
    return 1;
  }

  async pttl(key: string): Promise<number> {
    const entry = this.live(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return entry.expiresAt - Date.now();
  }
}

test("the limit holds across separate limiter instances", async () => {
  // Two instances, as a multi-instance deploy would have.
  const redis = new FakeRedis();
  const store = new SharedRateLimitStore(redis);
  const instanceA = new RateLimiter(3, 60_000, { store });
  const instanceB = new RateLimiter(3, 60_000, { store });

  assert.equal((await instanceA.check("1.2.3.4")).allowed, true);
  assert.equal((await instanceB.check("1.2.3.4")).allowed, true);
  assert.equal((await instanceA.check("1.2.3.4")).allowed, true);

  // The fourth request is refused no matter which instance receives it.
  assert.equal((await instanceB.check("1.2.3.4")).allowed, false, "instance B must honour A's usage");
  assert.equal((await instanceA.check("1.2.3.4")).allowed, false);
});

test("the window TTL is set once, on the first request", async () => {
  const redis = new FakeRedis();
  const limiter = new RateLimiter(5, 60_000, { store: new SharedRateLimitStore(redis) });

  for (let i = 0; i < 4; i++) await limiter.check("client");

  const expiries = redis.calls.filter((call) => call.startsWith("pexpire:"));
  assert.equal(expiries.length, 1, "a sliding TTL would never let a client recover");
});

test("the window actually expires and the budget returns", async () => {
  const redis = new FakeRedis();
  const limiter = new RateLimiter(1, 30, { store: new SharedRateLimitStore(redis) });

  assert.equal((await limiter.check("x")).allowed, true);
  assert.equal((await limiter.check("x")).allowed, false);
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal((await limiter.check("x")).allowed, true, "the window must reset");
});

test("keys are namespaced so limiters can share one database", async () => {
  const redis = new FakeRedis();
  const store = new SharedRateLimitStore(redis, { prefix: "forge:lookup" });
  const limiter = new RateLimiter(2, 60_000, { store });
  await limiter.check("9.9.9.9");

  assert.ok([...redis.store.keys()].every((key) => key.startsWith("forge:lookup:")));
});

test("a counter that lost its TTL is re-armed instead of locking the client out forever", async () => {
  const redis = new FakeRedis();
  const store = new SharedRateLimitStore(redis);
  const limiter = new RateLimiter(1, 60_000, { store });

  await limiter.check("stuck");
  // Simulate an eviction or a crash between INCR and PEXPIRE.
  const entry = redis.store.get("forge:rl:stuck")!;
  entry.expiresAt = null;

  const refused = await limiter.check("stuck");
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterSeconds > 0, "a permanent counter would report no retry time");
  assert.notEqual(redis.store.get("forge:rl:stuck")!.expiresAt, null, "the TTL must be restored");
});

test("a store outage fails OPEN by default, and reports it", async () => {
  const redis = new FakeRedis();
  redis.failNext = true;
  const failures: unknown[] = [];
  const limiter = new RateLimiter(1, 60_000, {
    store: new SharedRateLimitStore(redis, { onFailure: (error) => failures.push(error) })
  });

  const result = await limiter.check("client");
  assert.equal(result.allowed, true, "a cache blip must not take the API down");
  assert.equal(failures.length, 1, "the outage must be observable");
});

test("failing closed is available for deployments that need the limit absolute", async () => {
  const redis = new FakeRedis();
  redis.failNext = true;
  const limiter = new RateLimiter(1, 60_000, {
    store: new SharedRateLimitStore(redis, { onError: "deny" })
  });

  assert.equal((await limiter.check("client")).allowed, false);
});

test("different clients do not share a budget", async () => {
  const redis = new FakeRedis();
  const store = new SharedRateLimitStore(redis);
  const limiter = new RateLimiter(1, 60_000, { store });

  assert.equal((await limiter.check("a")).allowed, true);
  assert.equal((await limiter.check("b")).allowed, true, "one client must not exhaust another");
  assert.equal((await limiter.check("a")).allowed, false);
});
