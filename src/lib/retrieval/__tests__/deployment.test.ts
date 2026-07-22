import { test } from "node:test";
import assert from "node:assert/strict";
import { getDeploymentMode, isAirGapped, DEPLOYMENT_MODE_ENV } from "../deployment";

// Control both the mode env and NODE_ENV, since the default now depends on NODE_ENV.
function withEnv(mode: string | undefined, nodeEnv: string | undefined, fn: () => void): void {
  const prevMode = process.env[DEPLOYMENT_MODE_ENV];
  const prevNode = process.env.NODE_ENV;
  const set = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  set(DEPLOYMENT_MODE_ENV, mode);
  set("NODE_ENV", nodeEnv);
  try {
    fn();
  } finally {
    set(DEPLOYMENT_MODE_ENV, prevMode);
    set("NODE_ENV", prevNode);
  }
}

test("explicit commercial is honored in any environment", () => {
  withEnv("commercial", "production", () => assert.equal(getDeploymentMode(), "commercial"));
  withEnv("Commercial", "development", () => assert.equal(getDeploymentMode(), "commercial")); // trimmed + lowercased
});

test("explicit air-gapped is honored in any environment", () => {
  withEnv("air-gapped", "development", () => assert.equal(getDeploymentMode(), "air-gapped"));
  withEnv("air-gapped", "production", () => assert.equal(getDeploymentMode(), "air-gapped"));
});

test("unset in production fails closed to air-gapped", () => {
  withEnv(undefined, "production", () => {
    assert.equal(getDeploymentMode(), "air-gapped");
    assert.equal(isAirGapped(), true);
  });
});

test("unset in dev defaults to commercial for zero-config local runs", () => {
  withEnv(undefined, "development", () => assert.equal(getDeploymentMode(), "commercial"));
  withEnv(undefined, undefined, () => assert.equal(getDeploymentMode(), "commercial"));
});

test("unrecognized values follow the same environment-aware default", () => {
  withEnv("comercial", "production", () => assert.equal(getDeploymentMode(), "air-gapped"));
  withEnv("cloud", "production", () => assert.equal(getDeploymentMode(), "air-gapped"));
  withEnv("", "development", () => assert.equal(getDeploymentMode(), "commercial"));
  withEnv("garbage", "development", () => assert.equal(getDeploymentMode(), "commercial"));
});
