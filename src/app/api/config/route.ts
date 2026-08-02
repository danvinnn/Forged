import { NextResponse } from "next/server";
import { getDeploymentMode, type DeploymentMode } from "../../../lib/retrieval";
import { SUPPORTED_PACKAGE_FAMILIES } from "../../../lib/packages";

export const runtime = "nodejs";

// The UI reads this on load to decide whether to show the part-number lookup box. The server 403
// on /api/lookup remains the real gate; this endpoint is UX only. Mode is never derived from a
// NEXT_PUBLIC_ env, which could drift from the server's actual mode.
export async function GET() {
  const mode = getDeploymentMode();
  // The UI needs the package families that have a characterised land pattern,
  // because export refuses every other package. Without this the user finds out
  // only by pressing Export and reading an error, with no idea what would work.
  return NextResponse.json<{
    mode: DeploymentMode;
    lookupEnabled: boolean;
    packageFamilies: string[];
  }>({
    mode,
    lookupEnabled: mode === "commercial",
    packageFamilies: SUPPORTED_PACKAGE_FAMILIES
  });
}
