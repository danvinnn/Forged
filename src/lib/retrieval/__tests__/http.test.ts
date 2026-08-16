import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchWithTimeout,
  readBodyWithLimit,
  TimeoutError,
  ResponseTooLargeError,
  BlockedUrlError
} from "../resolvers/http";

test("fetchWithTimeout aborts a hung request and throws TimeoutError", { concurrency: false }, async () => {
  const original = globalThis.fetch;
  // A fetch that never resolves until aborted, mimicking a hung host. It MUST settle on abort (it
  // rejects below), otherwise the promise leaks and the runner reports "pending but event loop
  // resolved". The abort listener guarantees settlement.
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
        return;
      }
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

test("fetchWithTimeout returns a normal response when fast enough", { concurrency: false }, async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;
  try {
    const res = await fetchWithTimeout("https://fast.test/x", {}, 1000);
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = original;
  }
});

// --- Download size ceiling ---------------------------------------------------------------------
// response.arrayBuffer() buffers the ENTIRE body before anything checks its size, so assertPdfBytes
// rejecting a huge response happens far too late to prevent an OOM. These pin the earlier ceiling.

test("rejects a body whose declared Content-Length exceeds the limit", { concurrency: false }, async () => {
  const res = new Response("x", { status: 200, headers: { "content-length": String(10 * 1024 * 1024) } });
  await assert.rejects(
    () => readBodyWithLimit(res, "https://evil.test/big.pdf", 1024),
    (err: unknown) => err instanceof ResponseTooLargeError
  );
});

test("aborts mid-stream when Content-Length lies or is absent", { concurrency: false }, async () => {
  // The important case: a hostile host can simply omit or understate Content-Length, so the header
  // check alone is not enough. The stream itself has to be cut off.
  let pushed = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pushed++;
      if (pushed > 100) return controller.close();
      controller.enqueue(new Uint8Array(1024));
    }
  });
  const res = new Response(body, { status: 200 }); // no content-length at all
  await assert.rejects(
    () => readBodyWithLimit(res, "https://evil.test/liar.pdf", 4096),
    (err: unknown) => err instanceof ResponseTooLargeError
  );
  assert.ok(pushed < 100, "the stream should have been cancelled early, not fully drained");
});

test("returns the body normally when it is within the limit", { concurrency: false }, async () => {
  const res = new Response(new Uint8Array(512), { status: 200 });
  const out = await readBodyWithLimit(res, "https://ok.test/small.pdf", 4096);
  assert.equal(out.byteLength, 512);
});

test("fetchWithTimeout refuses a blocked URL before opening a connection", { concurrency: false }, async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response("", { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => fetchWithTimeout("http://169.254.169.254/latest/meta-data/", {}, 1000),
      (err: unknown) => err instanceof BlockedUrlError
    );
    assert.equal(called, false, "the guard must run before fetch, not after");
  } finally {
    globalThis.fetch = original;
  }
});

test("re-checks the SSRF guard on every redirect hop", { concurrency: false }, async () => {
  // The bypass this closes: a perfectly ordinary public URL that 302s to the metadata endpoint.
  // Passing redirect:"follow" to fetch would check only the first URL.
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("innocent.test")) {
      return new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    }
    return new Response("secrets", { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => fetchWithTimeout("https://innocent.test/datasheet.pdf", {}, 1000),
      (err: unknown) => err instanceof BlockedUrlError
    );
  } finally {
    globalThis.fetch = original;
  }
});
