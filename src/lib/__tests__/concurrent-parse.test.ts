import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { POST } from "../../app/api/parse/route";

/**
 * TWO PARSES AT ONCE.
 *
 * ## Why this had never been run
 *
 * Every instrument in this repository drives one document at a time. A person
 * does not: they open a second tab while the first is thinking, because a parse
 * takes over a minute and a minute is long enough to get bored in.
 *
 * The failure that would matter is CROSS-TALK - one upload's record coming back
 * for the other's request. A module-level `let` on the request path is all it
 * would take, and the route holds a good deal of per-request state. A source
 * scan on 2026-08-30 found only three module-level mutables in the whole request
 * path (two rate-limit test seams and the spend ledger's in-process copy), which
 * is evidence and not proof: the interleaving is what actually decides it.
 *
 * The reader is a local endpoint that answers each request with the part number
 * it can see in the prompt, so a swapped answer is visible in the result rather
 * than having to be inferred.
 */

const NCP = readFileSync(join(process.cwd(), ".bench-cache", "NCP1200.pdf"));
const DRV = readFileSync(join(process.cwd(), ".bench-cache", "DRV8825.pdf"));

/** A reader that answers with whichever part number it was shown. */
function reader(): Promise<{ url: string; close: () => Promise<void>; seen: string[] }> {
  const seen: string[] = [];
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        // Whichever of the two documents this prompt is about. Deliberately
        // crude: the point is that the ANSWER tracks the REQUEST.
        const part = /DRV8825/i.test(body) ? "DRV8825" : "NCP1200";
        seen.push(part);
        const answer = JSON.stringify({
          partNumber: { value: part, confidence: 0.9, citation: { page: 1, snippet: part } }
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: answer } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        close: () => new Promise((done) => server.close(() => done())),
        seen
      });
    });
  });
}

function upload(bytes: Buffer, name: string): Request {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), name);
  return new Request("http://localhost/api/parse", { method: "POST", body: form });
}

test("two uploads in flight together each come back as themselves", async () => {
  const server = await reader();
  const keep = {
    url: process.env.FORGE_LOCAL_MODEL_URL,
    mode: process.env.FORGE_DEPLOYMENT_MODE,
    key: process.env.GOOGLE_GEMINI_API_KEY,
    creds: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    limit: process.env.FORGE_UPLOAD_RATE_LIMIT
  };
  process.env.FORGE_LOCAL_MODEL_URL = server.url;
  process.env.FORGE_DEPLOYMENT_MODE = "air-gapped";
  delete process.env.GOOGLE_GEMINI_API_KEY;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  try {
    // Started together, deliberately, so the two runs interleave inside the
    // route rather than following one another.
    const [first, second] = await Promise.all([
      POST(upload(NCP, "NCP1200.pdf")),
      POST(upload(DRV, "DRV8825.pdf"))
    ]);
    const [a, b] = (await Promise.all([first.json(), second.json()])) as Array<{
      part?: { partNumber?: { value?: string }; sourceFileName?: string };
      source?: { fileName?: string };
    }>;

    // Whatever else happened, the two answers must not be each other's. A
    // rate-limited or refused response is a different outcome and is allowed;
    // a SWAPPED one is not.
    for (const [answer, want] of [
      [a, "NCP1200"],
      [b, "DRV8825"]
    ] as const) {
      const file = answer.source?.fileName ?? answer.part?.sourceFileName ?? "";
      if (file) assert.match(file, new RegExp(want, "i"), `a request for ${want} came back carrying ${file}`);
    }
  } finally {
    await server.close();
    for (const [key, value] of Object.entries({
      FORGE_LOCAL_MODEL_URL: keep.url,
      FORGE_DEPLOYMENT_MODE: keep.mode,
      GOOGLE_GEMINI_API_KEY: keep.key,
      GOOGLE_APPLICATION_CREDENTIALS: keep.creds,
      FORGE_UPLOAD_RATE_LIMIT: keep.limit
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the same document twice at once gives the same answer twice", async () => {
  // Not the same question as `bench:repeatable`, which runs the passes in
  // sequence. This one asks whether running them TOGETHER changes either.
  const server = await reader();
  const keep = { url: process.env.FORGE_LOCAL_MODEL_URL, mode: process.env.FORGE_DEPLOYMENT_MODE };
  process.env.FORGE_LOCAL_MODEL_URL = server.url;
  process.env.FORGE_DEPLOYMENT_MODE = "air-gapped";
  try {
    const [first, second] = await Promise.all([POST(upload(NCP, "NCP1200.pdf")), POST(upload(NCP, "NCP1200.pdf"))]);
    const [a, b] = (await Promise.all([first.json(), second.json()])) as Array<Record<string, unknown>>;
    assert.equal(first.status, second.status);
    if (first.status === 200) {
      // EVERYTHING EXCEPT `id`. Two parses are two records and each gets its own
      // identifier; that is the one field that SHOULD differ, and asserting on
      // it would be asserting that the product does the wrong thing.
      const without = (record: Record<string, unknown> | undefined) => {
        const { id, ...rest } = (record ?? {}) as { id?: unknown };
        void id;
        return JSON.stringify(rest);
      };
      assert.equal(
        without(a.part as Record<string, unknown>),
        without(b.part as Record<string, unknown>),
        "two simultaneous reads of one file disagree"
      );
    }
  } finally {
    await server.close();
    if (keep.url === undefined) delete process.env.FORGE_LOCAL_MODEL_URL;
    else process.env.FORGE_LOCAL_MODEL_URL = keep.url;
    if (keep.mode === undefined) delete process.env.FORGE_DEPLOYMENT_MODE;
    else process.env.FORGE_DEPLOYMENT_MODE = keep.mode;
  }
});
