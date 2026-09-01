import { test } from "node:test";
import assert from "node:assert/strict";
import { VertexExtractionModel } from "../extraction/models/vertex";
import { ExtractionModelError } from "../extraction/contracts";

/**
 * VERTEX, THE PROVIDER THE PRODUCT ACTUALLY BILLS, had no test of any kind.
 *
 * Measured on 2026-08-30 with c8: `vertex.ts` was at 0% of 188 lines while the
 * suite reported 874 passing tests. Nothing had ever executed it.
 *
 * That is the same file where switching provider once silently disabled the
 * spend ceiling and the cost ledger, and the reason it could is that the ledger
 * keys on `name`. So the two things checked here are the two that have already
 * gone wrong: what the model calls itself, and whether it will refuse to run
 * half-configured.
 *
 * No network. Every assertion below is about the decisions made BEFORE the SDK
 * is constructed, which is where all of this file's own logic lives.
 */

function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const request = { pages: [], images: [], fileName: "TEST.pdf", partNumber: "TEST", fields: [] } as unknown as import("../extraction/contracts").ExtractionRequest;

test("the name carries the vertex prefix, so an answer cannot collide with AI Studio's", () => {
  withEnv({ FORGE_VERTEX_MODEL: "gemini-3.6-flash", FORGE_GEMINI_MODEL: undefined, FORGE_THINKING_BUDGET: undefined }, () => {
    const name = new VertexExtractionModel().name;
    assert.ok(name.startsWith("vertex:"), `expected a vertex: prefix, got ${name}`);
    assert.ok(name.includes("gemini-3.6-flash"), `expected the model id in ${name}`);
  });
});

test("the model id is always in the name, even when nothing set it", () => {
  // The Vertex default differs from AI Studio's. Leaving a defaulted id out of
  // the name would let two genuinely different models share one cache key.
  withEnv({ FORGE_VERTEX_MODEL: undefined, FORGE_GEMINI_MODEL: undefined, FORGE_THINKING_BUDGET: undefined }, () => {
    const name = new VertexExtractionModel().name;
    assert.notEqual(name, "vertex");
    assert.ok(name.split(":").length >= 2, `expected an id after the prefix, got ${name}`);
  });
});

test("a credential without a project is NOT configured", () => {
  // Neither has a safe default. Guessing the project from the credential means
  // guessing who gets billed.
  withEnv({ GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sa.json", FORGE_VERTEX_PROJECT: undefined }, () => {
    assert.equal(new VertexExtractionModel().isConfigured(), false);
  });
});

test("a project without a credential is NOT configured", () => {
  withEnv({ GOOGLE_APPLICATION_CREDENTIALS: undefined, FORGE_VERTEX_PROJECT: "some-project-id" }, () => {
    assert.equal(new VertexExtractionModel().isConfigured(), false);
  });
});

test("both together are configured", () => {
  withEnv({ GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sa.json", FORGE_VERTEX_PROJECT: "some-project-id" }, () => {
    assert.equal(new VertexExtractionModel().isConfigured(), true);
  });
});

test("extracting with no credential refuses by name rather than reaching the network", async () => {
  await withEnv({ GOOGLE_APPLICATION_CREDENTIALS: undefined, FORGE_VERTEX_PROJECT: "some-project-id" }, async () => {
    await assert.rejects(
      () => new VertexExtractionModel().extract(request),
      (error: unknown) => {
        assert.ok(error instanceof ExtractionModelError);
        assert.equal(error.kind, "config");
        assert.match(error.message, /GOOGLE_APPLICATION_CREDENTIALS/);
        return true;
      }
    );
  });
});

test("extracting with no project refuses, and says it wants the project ID not the display name", async () => {
  await withEnv({ GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sa.json", FORGE_VERTEX_PROJECT: undefined }, async () => {
    await assert.rejects(
      () => new VertexExtractionModel().extract(request),
      (error: unknown) => {
        assert.ok(error instanceof ExtractionModelError);
        assert.equal(error.kind, "config");
        assert.match(error.message, /FORGE_VERTEX_PROJECT/);
        // The distinction cost an afternoon once. It stays in the message.
        assert.match(error.message, /display name/);
        return true;
      }
    );
  });
});
