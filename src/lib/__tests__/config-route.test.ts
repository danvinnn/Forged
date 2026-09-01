import { test } from "node:test";
import assert from "node:assert/strict";
import { GET } from "../../app/api/config/route";

/**
 * `/api/config` had no test at all: 0% of 24 lines, measured 2026-08-30.
 *
 * It is small and it decides one thing that matters. The UI reads it on load to
 * decide whether to offer the part-number lookup box, and lookup is the one
 * feature that reaches the network. An air-gapped deployment that answered
 * `lookupEnabled: true` would put a button in front of an operator that the
 * server then 403s - and, worse, would say out loud that this deployment fetches
 * datasheets when its whole premise is that it does not.
 *
 * The server-side 403 on `/api/lookup` is the real gate and is tested elsewhere.
 * This is about what the screen offers.
 */

function withMode<T>(mode: string | undefined, run: () => Promise<T>): Promise<T> {
  const prev = process.env.FORGE_DEPLOYMENT_MODE;
  if (mode === undefined) delete process.env.FORGE_DEPLOYMENT_MODE;
  else process.env.FORGE_DEPLOYMENT_MODE = mode;
  return run().finally(() => {
    if (prev === undefined) delete process.env.FORGE_DEPLOYMENT_MODE;
    else process.env.FORGE_DEPLOYMENT_MODE = prev;
  });
}

function withNodeEnv<T>(value: string, run: () => Promise<T>): Promise<T> {
  const prev = process.env.NODE_ENV;
  // NODE_ENV is read-only in the Next type surface; the test needs to set it.
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
  return run().finally(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = prev;
  });
}

test("commercial mode offers the lookup box", async () => {
  await withMode("commercial", async () => {
    const body = (await (await GET()).json()) as { mode: string; lookupEnabled: boolean };
    assert.equal(body.mode, "commercial");
    assert.equal(body.lookupEnabled, true);
  });
});

test("air-gapped mode does not offer the lookup box", async () => {
  await withMode("air-gapped", async () => {
    const body = (await (await GET()).json()) as { mode: string; lookupEnabled: boolean };
    assert.equal(body.mode, "air-gapped");
    assert.equal(body.lookupEnabled, false);
  });
});

test("an unset mode in PRODUCTION does not offer the lookup box", async () => {
  // The default has to fall on the safe side where it counts. An unset variable
  // is the state a half-finished deployment is in, and offering network
  // retrieval there is the failure that cannot be walked back. In development
  // the default is deliberately the other way, so that a developer with no env
  // file gets a working lookup box; `preflight.ts` flags the production case.
  await withNodeEnv("production", () =>
    withMode(undefined, async () => {
      const body = (await (await GET()).json()) as { mode: string; lookupEnabled: boolean };
      assert.equal(body.mode, "air-gapped");
      assert.equal(body.lookupEnabled, false);
    })
  );
});

test("an unrecognised mode in production does not offer the lookup box", async () => {
  // A typo in the env file is not a licence to reach the network.
  await withNodeEnv("production", () =>
    withMode("COMMERCIAL-ish", async () => {
      const body = (await (await GET()).json()) as { lookupEnabled: boolean };
      assert.equal(body.lookupEnabled, false);
    })
  );
});

test("the mode is read per request, not captured at module load", async () => {
  // The UI asks once on load and trusts the answer for the session. A value
  // frozen at import time would survive a restart-free config change and report
  // the wrong posture.
  const first = (await (await GET()).json()) as { mode: string };
  const second = await withMode(first.mode === "commercial" ? "air-gapped" : "commercial", async () =>
    ((await (await GET()).json()) as { mode: string }).mode
  );
  assert.notEqual(first.mode, second);
});
