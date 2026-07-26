import { logger } from "./retrieval/logging";

/**
 * Startup configuration checks.
 *
 * Code review catches bad code. It does not catch a deploy configured wrongly,
 * and misconfiguration is the likelier failure for this product: the difference
 * between a correct air-gapped deployment and a leaky one is environment
 * variables, not source. These run once at boot and say loudly what mode the
 * process is actually in, so a wrong answer is visible in the first log line
 * rather than discovered by a customer.
 *
 * Deliberately does not throw. A process that refuses to boot on a warning is
 * its own outage; the request-time guards remain the real enforcement.
 */

export interface PreflightFinding {
  level: "info" | "warn" | "error";
  code: string;
  message: string;
}

export async function runPreflight(): Promise<PreflightFinding[]> {
  const findings: PreflightFinding[] = [];
  const rawMode = process.env.FORGE_DEPLOYMENT_MODE?.trim().toLowerCase();
  const isProduction = process.env.NODE_ENV === "production";
  const mode = rawMode === "commercial" ? "commercial" : "air-gapped";

  // 1. The default that surprises people. In production an unset mode means
  // air-gapped, so part-number lookup returns 403 and it looks like a bug.
  if (isProduction && !rawMode) {
    findings.push({
      level: "warn",
      code: "MODE_DEFAULTED",
      message:
        "FORGE_DEPLOYMENT_MODE is not set. In production this defaults to air-gapped (fail-closed), so /api/lookup will return 403. Set it to commercial explicitly if this deploy is meant to reach the network."
    });
  }

  // 2. A cloud key present on an air-gapped deploy is ignored by the factory,
  // but its presence usually means someone believed it would be used.
  if (mode === "air-gapped" && process.env.GOOGLE_GEMINI_API_KEY) {
    findings.push({
      level: "warn",
      code: "CLOUD_KEY_IN_AIRGAP",
      message:
        "GOOGLE_GEMINI_API_KEY is set but the deployment is air-gapped. The cloud model is never loaded in this mode and the key is ignored. Remove it to avoid implying a capability this deploy does not have."
    });
  }

  // 3. Part numbers in logs are a disclosure question on the controlled path:
  // which parts a customer looks up can itself reveal a program. Air-gapped now
  // defaults to OFF, so this only fires when someone turned it on deliberately.
  if (mode === "air-gapped" && process.env.FORGE_LOG_PART_NUMBERS?.trim().toLowerCase() === "true") {
    findings.push({
      level: "warn",
      code: "PART_NUMBERS_LOGGED_IN_AIRGAP",
      message:
        "FORGE_LOG_PART_NUMBERS=true overrides the air-gapped default. The SET of parts a customer looks up can reveal program composition even when each part is individually public. Confirm the customer has agreed to this."
    });
  }

  // 4. Validate the local model endpoint at BOOT rather than at first request,
  // so a misconfigured one is caught before a user hits it. Reached by dynamic
  // import to keep the model subtree out of the startup module graph.
  const localUrl = process.env.FORGE_LOCAL_MODEL_URL?.trim();
  if (localUrl) {
    try {
      const { assertLocalEndpoint } = await import("./extraction/models/local");
      await assertLocalEndpoint(localUrl);
      findings.push({
        level: "info",
        code: "LOCAL_MODEL_OK",
        message: "Local extraction model endpoint validated as private."
      });
    } catch (error) {
      findings.push({
        level: "error",
        code: "LOCAL_MODEL_INVALID",
        message: `FORGE_LOCAL_MODEL_URL is not usable and extraction will fail at request time: ${
          error instanceof Error ? error.message : String(error)
        }`
      });
    }
  }

  // 5. A parse budget at or above the route ceiling means the platform kills the
  // request before the parser can return a clean error.
  const budget = Number(process.env.FORGE_PARSE_BUDGET_MS);
  if (Number.isFinite(budget) && budget >= 30_000) {
    findings.push({
      level: "warn",
      code: "PARSE_BUDGET_TOO_HIGH",
      message: `FORGE_PARSE_BUDGET_MS is ${budget}ms but routes cap at 30000ms. The platform will kill the request first and the user gets a 504 instead of a clean PARSE_LIMIT_EXCEEDED.`
    });
  }

  return findings;
}

/** Runs the checks and writes them to the log. Never throws. */
export async function reportPreflight(): Promise<void> {
  try {
    const mode = process.env.FORGE_DEPLOYMENT_MODE?.trim().toLowerCase() === "commercial" ? "commercial" : "air-gapped";
    const findings = await runPreflight();

    // Always state the effective posture, so the first log line answers the
    // question "what is this process actually going to do".
    logger.info({
      event: "startup",
      mode,
      lookupEnabled: mode === "commercial",
      modelConfigured: Boolean(process.env.GOOGLE_GEMINI_API_KEY || process.env.FORGE_LOCAL_MODEL_URL),
      findings: findings.length
    });

    for (const finding of findings) {
      logger[finding.level]({ event: "preflight", code: finding.code, message: finding.message });
    }
  } catch (error) {
    // A broken preflight must never stop the server from starting.
    logger.error({
      event: "preflight_failed",
      error: error instanceof Error ? error.message : String(error)
    });
  }
}
