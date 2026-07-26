import { test } from "node:test";
import assert from "node:assert/strict";
import { assertLocalEndpoint, isPrivateAddress, pinnedLocalAgent } from "../models/local";
import { ExtractionModelError } from "../contracts";
import { makeExtractionModel } from "../factory";

// The local model is the ONLY extraction model permitted in air-gapped mode, so
// its endpoint guard is what actually keeps controlled datasheet text inside the
// customer network. It is deliberately the inverse of the retrieval layer's SSRF
// guard: there a private address is the attack, here a public one is.

test("private and loopback addresses are recognized", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "172.16.5.4", "::1", "fd00::1", "fe80::1"]) {
    assert.equal(isPrivateAddress(address), true, `${address} should be private`);
  }
});

test("public addresses are recognized as public", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700::1111"]) {
    assert.equal(isPrivateAddress(address), false, `${address} should be public`);
  }
});

test("an IPv4-mapped public address is not treated as private", () => {
  assert.equal(isPrivateAddress("::ffff:8.8.8.8"), false);
  assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
});

test("a loopback endpoint is accepted", async () => {
  const checked = await assertLocalEndpoint("http://127.0.0.1:8000/v1/chat/completions");
  assert.equal(checked.url.hostname, "127.0.0.1");
  // A literal address has no name to re-resolve, so there is nothing to pin.
  assert.equal(checked.pinnedAddress, null);
});

test("localhost is accepted and pinned to its resolved address", async () => {
  const checked = await assertLocalEndpoint("http://localhost:11434/v1/chat/completions");
  assert.equal(checked.url.hostname, "localhost");
  assert.ok(checked.pinnedAddress, "a named host must be pinned");
  assert.equal(
    isPrivateAddress(checked.pinnedAddress!),
    true,
    "the pin must be the private address the guard cleared"
  );
});

test("a named local endpoint is pinned so it cannot be rebound to a public host", async () => {
  // This is the ITAR-relevant half: the guard resolves the name, then the socket
  // would resolve it AGAIN. A record that changes in between would send
  // controlled datasheet text to whatever it now points at. Pinning removes the
  // second resolution.
  const checked = await assertLocalEndpoint("http://localhost:11434/v1/chat/completions");
  const agent = pinnedLocalAgent(checked);
  assert.ok(agent, "a named local endpoint must produce a pinned dispatcher");
  await agent!.close();
});

test("no dispatcher is pinned when the endpoint is a literal address", async () => {
  const checked = await assertLocalEndpoint("http://127.0.0.1:8000/v1/chat/completions");
  assert.equal(pinnedLocalAgent(checked), null);
});

test("a public IP endpoint is REFUSED", async () => {
  await assert.rejects(
    () => assertLocalEndpoint("https://8.8.8.8/v1/chat/completions"),
    (error: unknown) => {
      assert.ok(error instanceof ExtractionModelError);
      assert.equal((error as ExtractionModelError).kind, "config");
      assert.match((error as Error).message, /public address|off the local network/i);
      return true;
    },
    "an air-gapped deploy must not send datasheet content to a public endpoint"
  );
});

test("a public hostname is REFUSED", async () => {
  await assert.rejects(
    () => assertLocalEndpoint("https://api.openai.com/v1/chat/completions"),
    (error: unknown) => {
      assert.ok(error instanceof ExtractionModelError);
      return true;
    },
    "a cloud endpoint misconfigured as the local model must be refused"
  );
});

test("a non-http scheme is refused", async () => {
  await assert.rejects(() => assertLocalEndpoint("file:///etc/passwd"), ExtractionModelError);
  await assert.rejects(() => assertLocalEndpoint("not a url"), ExtractionModelError);
});

// --- Factory gating ---------------------------------------------------------

function withEnv(vars: Record<string, string | undefined>, run: () => Promise<void>): Promise<void> {
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("air-gapped mode never selects the cloud model, even with a key set", async () => {
  await withEnv(
    { GOOGLE_GEMINI_API_KEY: "key-that-must-not-be-used", FORGE_LOCAL_MODEL_URL: undefined },
    async () => {
      const model = await makeExtractionModel("air-gapped");
      assert.equal(model, null, "a Gemini key must not enable a cloud model in air-gapped mode");
    }
  );
});

test("air-gapped mode selects the local model when one is configured", async () => {
  await withEnv(
    { GOOGLE_GEMINI_API_KEY: "key", FORGE_LOCAL_MODEL_URL: "http://127.0.0.1:8000/v1/chat/completions" },
    async () => {
      const model = await makeExtractionModel("air-gapped");
      assert.ok(model, "expected the local model");
      assert.match(model!.name, /^local:/);
      assert.doesNotMatch(model!.name, /gemini/i);
    }
  );
});

test("commercial mode with no model configured returns null", async () => {
  await withEnv({ GOOGLE_GEMINI_API_KEY: undefined, FORGE_LOCAL_MODEL_URL: undefined }, async () => {
    assert.equal(await makeExtractionModel("commercial"), null);
  });
});

test("commercial mode selects the cloud model when a key is present", async () => {
  await withEnv({ GOOGLE_GEMINI_API_KEY: "key", FORGE_LOCAL_MODEL_URL: undefined }, async () => {
    const model = await makeExtractionModel("commercial");
    assert.ok(model);
    assert.equal(model!.name, "gemini");
  });
});
