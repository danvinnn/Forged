import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithTimeout, TimeoutError } from "../resolvers/http";

test("fetchWithTimeout aborts a hung request and throws TimeoutError", async () => {
  const original = globalThis.fetch;
  // A fetch that never resolves until aborted, mimicking a hung host.
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    })) as typeof fetch;

  try {
    await assert.rejects(
      () => fetchWithTimeout("https://hung.test/x", {}, 20),
      (err: unknown) => err instanceof TimeoutError
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchWithTimeout returns a normal response when fast enough", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
  try {
    const res = await fetchWithTimeout("https://fast.test/x", {}, 1000);
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = original;
  }
});
