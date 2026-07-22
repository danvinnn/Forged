// Wires the commercial-path resolver stack: Nexar first (the component API), Scrape last
// (the demoted MVP fallback). This is the entry point of the network subtree; makeResolver
// reaches it only through a dynamic import in its commercial branch, so importing this file
// is what pulls the networking code into the process. That never happens in air-gapped mode.

import { CompositeResolver } from "./composite";
import { NexarResolver } from "./nexar";
import { ScrapeResolver } from "./scrape";
import type { DatasheetResolver } from "../resolver";

export function buildCommercialResolver(): DatasheetResolver {
  // Order is priority. Nexar is the primary resolver; scrape is the last resort. When Nexar
  // has no credentials it reports itself not configured and the composite skips straight to
  // scrape, so the commercial path keeps working today without credentials.
  return new CompositeResolver([new NexarResolver(), new ScrapeResolver()]);
}
