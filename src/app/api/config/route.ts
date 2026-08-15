import { NextResponse } from "next/server";
import { getDeploymentMode, type DeploymentMode } from "../../../lib/retrieval";

export const runtime = "nodejs";

// The UI reads this on load to decide whether to show the part-number lookup box. The server 403
// on /api/lookup remains the real gate; this endpoint is UX only. Mode is never derived from a
// NEXT_PUBLIC_ env, which could drift from the server's actual mode.
export async function GET() {
  const mode = getDeploymentMode();
  // `packageFamilies` used to be served here: a list of the families with a
  // characterised land pattern, which the UI rendered as "characterised
  // footprints (anything else is refused)". Both are gone with the table they
  // came from. What a package produces is now a property of the DOCUMENT rather
  // than of a set of names, and `packageChoice` on the parse response already
  // answers it per package, by running the real generator.
  return NextResponse.json<{
    mode: DeploymentMode;
    lookupEnabled: boolean;
  }>({
    mode,
    lookupEnabled: mode === "commercial"
  });
}
