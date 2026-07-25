// Wires the commercial-path resolver stack. This is the entry point of the network subtree;
// makeResolver reaches it only through a dynamic import in its commercial branch, so importing
// this file is what pulls the networking code into the process. That never happens in air-gapped
// mode.

import { CachingResolver } from "./caching";
import { CompositeResolver } from "./composite";
import { ManufacturerResolver } from "./manufacturer";
import { ScrapeResolver } from "./scrape";
import type { DatasheetResolver } from "../resolver";

export function buildCommercialResolver(): DatasheetResolver {
  // Order is priority, cheapest and most deterministic first:
  //
  //   1. manufacturer : no credentials, no quota, no third party. A constructed vendor URL fetched
  //                     straight from the manufacturer. The whole demo path runs on this, which is
  //                     why a fresh checkout with an empty .env works.
  //   2. scrape       : DuckDuckGo plus hardcoded URL patterns. Brittle and rate-limit prone, so
  //                     it is the last resort. It stays because it is the only resolver that can
  //                     find a part no manufacturer pattern claims.
  //
  // No component-API resolver is present by design. See LAYER1.md "Decided against: component
  // distributor APIs" for why Nexar, Mouser, and DigiKey were each evaluated and dropped.
  // The cache wraps the WHOLE chain, not each child. A rad-hard miss walks every resolver
  // including scrape's DuckDuckGo crawl, so caching the chain-level miss is what stops the second
  // person who types VA10820 from paying that cost again. Errors are never cached.
  return new CachingResolver(new CompositeResolver([new ManufacturerResolver(), new ScrapeResolver()]));
}
