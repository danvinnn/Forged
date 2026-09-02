/**
 * The suite workspace, on its own route.
 *
 * NEW ROUTE ON PURPOSE. `/` keeps the workspace main already ships, so this
 * branch adds files and changes none: the merge is additive and nothing that
 * works today can regress. When the flow is signed off, `/` becomes a redirect
 * here and `src/app/page.tsx` is deleted in one commit.
 */

import SuiteWorkspace from "./SuiteWorkspace";
import "./suite.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Forge",
  description: "Read a datasheet, get a schematic symbol, a footprint, a 3D body or a SPICE model."
};

export default function SuitePage() {
  return <SuiteWorkspace />;
}
