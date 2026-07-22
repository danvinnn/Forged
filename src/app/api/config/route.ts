import { NextResponse } from "next/server";
import { getDeploymentMode, type DeploymentMode } from "../../../lib/retrieval";

export const runtime = "nodejs";

// The UI reads this on load to decide whether to show the part-number lookup box. The server 403
// on /api/lookup remains the real gate; this endpoint is UX only. Mode is never derived from a
// NEXT_PUBLIC_ env, which could drift from the server's actual mode.
export async function GET() {
  const mode = getDeploymentMode();
  return NextResponse.json<{ mode: DeploymentMode; lookupEnabled: boolean }>({
    mode,
    lookupEnabled: mode === "commercial"
  });
}
