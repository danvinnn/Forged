import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POST } from "../../app/api/parse/route";

/**
 * WHAT THE USER GETS WHEN THE READER FAILS MID-PARSE.
 *
 * ## Why this had no test until 2026-08-30
 *
 * Measured with c8 that day: `app/api/parse/route.ts` sat at 51% of statements,
 * and the uncovered block was lines 282-453 - the entire model section, every
 * failure branch in it, and the success response. The suite has 874 tests and
 * had never executed the part of the main route that calls the reader, because
 * no test ever supplied a model.
 *
 * The branches in there are not incidental. Each one is a decision, written in
 * the route's own comments, about the one failure this product must not commit:
 *
 *     "A PARSE THAT LOST THE MODEL PASS IS A FAILED PARSE, NOT A THINNER ONE."
 *
 * The parser alone reads nothing on an unseen datasheet - `bench:holdout`
 * measures it at READ 0 of 59 - so handing back a deterministic record with a
 * note attached is a silent degrade wearing a success code. Anthony's call on
 * 2026-08-20 was that either the files need no second-guessing or the answer is
 * "we could not read it, try again". Nothing checked that the code still does
 * that.
 *
 * ## How the model is injected without a seam in the route
 *
 * The route builds its own reader through `makeExtractionModel`, which is right:
 * a test hook on the model would be a hole in the air-gap guarantee, since the
 * whole point of that function is that the cloud providers are reachable only
 * through its commercial branch.
 *
 * So the model is supplied the way a customer's would be - a local endpoint on
 * a private address, which is the air-gapped configuration - and the server
 * behind it misbehaves in a specific way per test. Nothing is stubbed, and the
 * route runs exactly as it does in production.
 */

const PDF = readFileSync(join(process.cwd(), ".bench-cache", "NCP1200.pdf"));

function listen(handler: (body: string) => { status: number; body: string }): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const answer = handler(body);
        res.writeHead(answer.status, { "content-type": "application/json" });
        res.end(answer.body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        close: () => new Promise((done) => server.close(() => done()))
      });
    });
  });
}

function upload(): Request {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(PDF)], { type: "application/pdf" }), "NCP1200.pdf");
  return new Request("http://localhost/api/parse", { method: "POST", body: form });
}

async function withReader<T>(url: string, run: () => Promise<T>): Promise<T> {
  const keep = {
    FORGE_LOCAL_MODEL_URL: process.env.FORGE_LOCAL_MODEL_URL,
    FORGE_DEPLOYMENT_MODE: process.env.FORGE_DEPLOYMENT_MODE,
    GOOGLE_GEMINI_API_KEY: process.env.GOOGLE_GEMINI_API_KEY,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS
  };
  process.env.FORGE_LOCAL_MODEL_URL = url;
  process.env.FORGE_DEPLOYMENT_MODE = "air-gapped";
  // The cloud providers must not be picked up from a developer's env file, or
  // this test would spend money and stop being deterministic.
  delete process.env.GOOGLE_GEMINI_API_KEY;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(keep)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a reader that refuses every call fails the parse rather than returning a thin record", async () => {
  const server = await listen(() => ({ status: 500, body: '{"error":"nope"}' }));
  try {
    await withReader(server.url, async () => {
      const response = await POST(upload());
      const body = (await response.json()) as { part?: unknown; error?: string; retryable?: boolean };
      // The one thing that must never happen: HTTP 200 carrying a record the
      // reader never contributed to.
      assert.notEqual(response.status, 200, "a failed read must not be reported as a success");
      assert.ok(typeof body.error === "string" && body.error.length > 0, "the failure has to say something");
      assert.equal(body.part, undefined, "no half-built record may be handed back");
    });
  } finally {
    await server.close();
  }
});

test("a reader that answers with prose instead of JSON fails the parse", async () => {
  // A local model that ignores the JSON instruction is the likeliest real
  // misconfiguration in an air-gapped deployment: the wrong model pulled into
  // Ollama answers in sentences.
  const server = await listen(() => ({
    status: 200,
    body: JSON.stringify({ choices: [{ message: { content: "I am unable to read this datasheet." } }] })
  }));
  try {
    await withReader(server.url, async () => {
      const response = await POST(upload());
      const body = (await response.json()) as { part?: unknown; error?: string };
      assert.notEqual(response.status, 200, "unreadable prose is not a successful read");
      assert.equal(body.part, undefined);
    });
  } finally {
    await server.close();
  }
});

test("the failure is marked retryable, because the UI offers a retry on exactly that flag", async () => {
  const server = await listen(() => ({ status: 503, body: '{"error":"busy"}' }));
  try {
    await withReader(server.url, async () => {
      const response = await POST(upload());
      const body = (await response.json()) as { retryable?: boolean; error?: string };
      assert.equal(response.status, 503);
      assert.equal(body.retryable, true, "a transient reader failure has to be offered as retryable");
    });
  } finally {
    await server.close();
  }
});

test("no reader configured at all is reported as such, not as a datasheet that says nothing", async () => {
  // `bench:badinput` found this on 2026-08-29: with no model, the route returned
  // 200 and an empty record, which reads to a user as "your datasheet is bad".
  const keep = {
    FORGE_LOCAL_MODEL_URL: process.env.FORGE_LOCAL_MODEL_URL,
    FORGE_DEPLOYMENT_MODE: process.env.FORGE_DEPLOYMENT_MODE,
    GOOGLE_GEMINI_API_KEY: process.env.GOOGLE_GEMINI_API_KEY,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS
  };
  delete process.env.FORGE_LOCAL_MODEL_URL;
  delete process.env.GOOGLE_GEMINI_API_KEY;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  process.env.FORGE_DEPLOYMENT_MODE = "air-gapped";
  try {
    const response = await POST(upload());
    const body = (await response.json()) as { code?: string; error?: string };
    assert.equal(response.status, 503);
    assert.equal(body.code, "MODEL_UNAVAILABLE");
    assert.match(String(body.error), /never read/);
  } finally {
    for (const [key, value] of Object.entries(keep)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
