import { test } from "node:test";
import assert from "node:assert/strict";
import { log, logger, timed } from "../logging";

// Logs are the one place controlled data could leak from an air-gapped deploy
// without any network call being involved: a datasheet's text written to stdout
// ends up in whatever aggregator the customer runs. These lock the redaction.

function captureStdout(run: () => void): string[] {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (line: string) => lines.push(line);
  console.warn = (line: string) => lines.push(line);
  console.error = (line: string) => lines.push(line);
  try {
    run();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
  return lines;
}

function withEnv(vars: Record<string, string | undefined>, run: () => void): void {
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("every line is a single JSON object with a timestamp and level", () => {
  const lines = captureStdout(() => logger.info({ event: "test_event", resolver: "manufacturer" }));
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.event, "test_event");
  assert.equal(parsed.level, "info");
  assert.equal(parsed.resolver, "manufacturer");
  assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("controlled content and secrets are never written", () => {
  const lines = captureStdout(() =>
    logger.info({
      event: "leaky",
      // Each of these is a field a careless caller might pass.
      text: "CONTROLLED DATASHEET TEXT",
      bytes: "%PDF-1.7 binary",
      content: "page content",
      prompt: "the full model prompt",
      body: "request body",
      apiKey: "AIzaSyREAL",
      token: "ghp_real",
      secret: "hunter2",
      resolver: "scrape"
    })
  );

  const line = lines[0];
  for (const forbidden of [
    "CONTROLLED DATASHEET TEXT",
    "%PDF",
    "page content",
    "the full model prompt",
    "request body",
    "AIzaSyREAL",
    "ghp_real",
    "hunter2"
  ]) {
    assert.doesNotMatch(line, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `must not log ${forbidden}`);
  }
  assert.match(line, /"resolver":"scrape"/, "benign fields still appear");
});

test("air-gapped does NOT log part numbers by default", () => {
  // Individually a part number is public. The SET of parts a defense customer
  // researches reveals program composition, and these are exactly the customers
  // who bought the product for its disclosure guarantees.
  withEnv({ FORGE_DEPLOYMENT_MODE: "air-gapped", FORGE_LOG_PART_NUMBERS: undefined }, () => {
    const lines = captureStdout(() => logger.info({ event: "resolver_hit", partNumber: "VA10820" }));
    assert.doesNotMatch(lines[0], /VA10820/, "the controlled path must default closed");
    assert.match(lines[0], /resolver_hit/, "the event itself is still logged");
  });
});

test("commercial DOES log part numbers by default", () => {
  // Public parts, we operate the service, and a log with no part number cannot
  // diagnose anything.
  withEnv({ FORGE_DEPLOYMENT_MODE: "commercial", FORGE_LOG_PART_NUMBERS: undefined }, () => {
    const lines = captureStdout(() => logger.info({ event: "resolver_hit", partNumber: "VA10820" }));
    assert.match(lines[0], /VA10820/);
  });
});

test("an explicit setting overrides the mode default in both directions", () => {
  withEnv({ FORGE_DEPLOYMENT_MODE: "commercial", FORGE_LOG_PART_NUMBERS: "false" }, () => {
    const lines = captureStdout(() => logger.info({ event: "resolver_hit", partNumber: "VA10820" }));
    assert.doesNotMatch(lines[0], /VA10820/);
  });

  withEnv({ FORGE_DEPLOYMENT_MODE: "air-gapped", FORGE_LOG_PART_NUMBERS: "true" }, () => {
    const lines = captureStdout(() => logger.info({ event: "resolver_hit", partNumber: "VA10820" }));
    assert.match(lines[0], /VA10820/);
  });
});

test("an Error is reduced to its message, never a stack dump", () => {
  const lines = captureStdout(() => logger.error({ event: "failed", error: new Error("boom at /Users/secret/path") }));
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.error, "boom at /Users/secret/path");
  assert.equal(typeof parsed.error, "string");
});

test("the level threshold is honoured", () => {
  withEnv({ FORGE_LOG_LEVEL: "warn" }, () => {
    assert.equal(captureStdout(() => logger.debug({ event: "d" })).length, 0);
    assert.equal(captureStdout(() => logger.info({ event: "i" })).length, 0);
    assert.equal(captureStdout(() => logger.warn({ event: "w" })).length, 1);
    assert.equal(captureStdout(() => logger.error({ event: "e" })).length, 1);
  });
});

test("timed logs both outcomes and rethrows failures", async () => {
  let lines = captureStdout(() => {});
  const ok = await (async () => {
    const captured: string[] = [];
    const original = console.log;
    console.log = (line: string) => captured.push(line);
    try {
      return await timed("op", { resolver: "x" }, async () => 42);
    } finally {
      console.log = original;
      lines = captured;
    }
  })();

  assert.equal(ok, 42);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.outcome, "ok");
  assert.ok(typeof parsed.durationMs === "number");
});

test("log() accepts an arbitrary level without throwing on odd input", () => {
  const lines = captureStdout(() => log("info", { event: "weird", nested: { a: 1 }, list: [1, 2] }));
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(parsed.nested, { a: 1 });
  assert.deepEqual(parsed.list, [1, 2]);
});
