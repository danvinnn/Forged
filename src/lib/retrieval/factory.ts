// The single place a network resolver can come into existence.
//
// Air-gap guard, enforced structurally rather than by a runtime check you could forget:
//
//   1. The test is inverted. Only an exact "commercial" mode returns a resolver. Every
//      other mode, including anything getDeploymentMode() failed closed to, returns null.
//
//   2. The concrete resolvers live under ./resolvers and are pulled in with a dynamic
//      import INSIDE the commercial branch. In air-gapped mode that branch never runs, so
//      the modules that contain fetch() are never loaded into the process at all. The
//      property a security review can verify is not "we chose not to call it" but "the
//      networking code was never loaded". That is why this function is async: the dynamic
//      import is the guard.
//
// Because of this, nothing outside this file should import from ./resolvers directly, and
// ./index.ts deliberately does not re-export them.

import type { DeploymentMode } from "./deployment";
import type { DatasheetResolver } from "./resolver";

export async function makeResolver(mode: DeploymentMode): Promise<DatasheetResolver | null> {
  if (mode !== "commercial") {
    // Air-gapped (or any non-commercial mode): no resolver exists, and the network
    // subtree below is never imported.
    return null;
  }

  const { buildCommercialResolver } = await import("./resolvers/commercial");
  return buildCommercialResolver();
}
