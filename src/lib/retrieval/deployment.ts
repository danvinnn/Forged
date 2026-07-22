// Deployment mode is the single switch that decides whether Forge is allowed to
// touch the network at all. It is read once, here, from the environment.
//
// Air-gap safety: this module makes no network calls and imports nothing that does.
// It is safe to load in an air-gapped deployment.

export type DeploymentMode = "commercial" | "air-gapped";

export const DEPLOYMENT_MODE_ENV = "FORGE_DEPLOYMENT_MODE";

// Resolves the deployment mode from the environment.
//
// Explicit values are honored exactly: "commercial" unlocks network retrieval,
// "air-gapped" forbids it. The interesting case is when the value is unset or
// unrecognized, which is what happens when someone misconfigures a deploy:
//
//   - Not production (local dev, tests): default to "commercial", so a fresh
//     checkout just works with no setup. This is pure ergonomics for the phase
//     where the only users are us and consumer testers.
//   - Production: fail closed to "air-gapped". A live server that was never told
//     it may reach the network must assume it may not, so a misconfigured prod
//     deploy denies rather than leaks controlled data.
//
// Consequence worth stating: the consumer SaaS is a production deploy and needs
// network access, so its hosting env MUST set FORGE_DEPLOYMENT_MODE=commercial
// explicitly. That is deliberate. A prod box that reaches the network should say
// so on purpose, never inherit it by omission.
export function getDeploymentMode(): DeploymentMode {
  const raw = process.env[DEPLOYMENT_MODE_ENV]?.trim().toLowerCase();
  if (raw === "commercial") return "commercial";
  if (raw === "air-gapped") return "air-gapped";
  return process.env.NODE_ENV === "production" ? "air-gapped" : "commercial";
}

export function isAirGapped(mode: DeploymentMode = getDeploymentMode()): boolean {
  return mode !== "commercial";
}
