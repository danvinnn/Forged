import { test } from "node:test";
import assert from "node:assert/strict";
import { runPreflight } from "../preflight";

// Misconfiguration is the likeliest real failure for this product: the
// difference between a correct air-gapped deploy and a leaky one is environment
// variables, not source, and no code review inspects a customer's env. These
// checks are the mechanical substitute.

function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
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

const codes = (findings: Array<{ code: string }>) => findings.map((f) => f.code);

test("an unset mode in production is flagged, because it silently means air-gapped", async () => {
  await withEnv(
    { NODE_ENV: "production", FORGE_DEPLOYMENT_MODE: undefined, GOOGLE_GEMINI_API_KEY: undefined, FORGE_LOCAL_MODEL_URL: undefined },
    async () => {
      const findings = await runPreflight();
      assert.ok(codes(findings).includes("MODE_DEFAULTED"));
    }
  );
});

test("an explicit commercial production deploy is not flagged for the default", async () => {
  await withEnv(
    { NODE_ENV: "production", FORGE_DEPLOYMENT_MODE: "commercial", GOOGLE_GEMINI_API_KEY: undefined, FORGE_LOCAL_MODEL_URL: undefined, FORGE_LOG_PART_NUMBERS: undefined },
    async () => {
      const findings = await runPreflight();
      assert.ok(!codes(findings).includes("MODE_DEFAULTED"));
    }
  );
});

test("a cloud key on an air-gapped deploy is flagged", async () => {
  await withEnv(
    { FORGE_DEPLOYMENT_MODE: "air-gapped", GOOGLE_GEMINI_API_KEY: "leftover", FORGE_LOCAL_MODEL_URL: undefined },
    async () => {
      assert.ok(codes(await runPreflight()).includes("CLOUD_KEY_IN_AIRGAP"));
    }
  );
});

test("air-gapped does not log part numbers by default, so nothing is flagged", async () => {
  await withEnv(
    { FORGE_DEPLOYMENT_MODE: "air-gapped", FORGE_LOG_PART_NUMBERS: undefined, GOOGLE_GEMINI_API_KEY: undefined, FORGE_LOCAL_MODEL_URL: undefined },
    async () => {
      assert.ok(
        !codes(await runPreflight()).includes("PART_NUMBERS_LOGGED_IN_AIRGAP"),
        "the safe default needs no warning"
      );
    }
  );
});

test("explicitly turning part-number logging ON in air-gapped IS flagged", async () => {
  await withEnv(
    { FORGE_DEPLOYMENT_MODE: "air-gapped", FORGE_LOG_PART_NUMBERS: "true", GOOGLE_GEMINI_API_KEY: undefined, FORGE_LOCAL_MODEL_URL: undefined },
    async () => {
      assert.ok(codes(await runPreflight()).includes("PART_NUMBERS_LOGGED_IN_AIRGAP"));
    }
  );
});

test("a PUBLIC local-model endpoint is caught at boot, not at first request", async () => {
  // The ITAR leak trap: a "local" model pointed at a cloud host would send
  // controlled datasheet text off the network.
  await withEnv(
    { FORGE_DEPLOYMENT_MODE: "air-gapped", FORGE_LOCAL_MODEL_URL: "https://api.openai.com/v1/chat/completions" },
    async () => {
      const findings = await runPreflight();
      const invalid = findings.find((f) => f.code === "LOCAL_MODEL_INVALID");
      assert.ok(invalid, "a public local-model endpoint must be reported");
      assert.equal(invalid!.level, "error");
    }
  );
});

test("a private local-model endpoint validates cleanly", async () => {
  await withEnv(
    { FORGE_DEPLOYMENT_MODE: "air-gapped", FORGE_LOCAL_MODEL_URL: "http://127.0.0.1:8000/v1/chat/completions" },
    async () => {
      assert.ok(codes(await runPreflight()).includes("LOCAL_MODEL_OK"));
    }
  );
});

test("a parse budget above the route ceiling is flagged", async () => {
  await withEnv(
    { FORGE_PARSE_BUDGET_MS: "45000", FORGE_DEPLOYMENT_MODE: "commercial", GOOGLE_GEMINI_API_KEY: undefined, FORGE_LOCAL_MODEL_URL: undefined },
    async () => {
      assert.ok(codes(await runPreflight()).includes("PARSE_BUDGET_TOO_HIGH"));
    }
  );
});

test("a correctly configured commercial deploy produces no findings", async () => {
  await withEnv(
    {
      NODE_ENV: "production",
      FORGE_DEPLOYMENT_MODE: "commercial",
      GOOGLE_GEMINI_API_KEY: undefined,
      FORGE_LOCAL_MODEL_URL: undefined,
      FORGE_LOG_PART_NUMBERS: undefined,
      FORGE_PARSE_BUDGET_MS: undefined
    },
    async () => {
      assert.deepEqual(await runPreflight(), [], "a clean config must be silent");
    }
  );
});

test("preflight never throws, whatever the environment says", async () => {
  await withEnv(
    { FORGE_LOCAL_MODEL_URL: "not a url at all", FORGE_PARSE_BUDGET_MS: "banana" },
    async () => {
      const findings = await runPreflight();
      assert.ok(Array.isArray(findings), "a bad environment must not crash startup");
    }
  );
});
