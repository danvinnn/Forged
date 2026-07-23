# Nexar fixtures

`nexar-lmp7704.json` is the GraphQL response body for a `supSearchMpn` query on LMP7704-SP,
selecting exactly the fields in `SEARCH_QUERY` (`resolvers/nexar.ts`): `mpn`,
`manufacturer.name`, `octopartUrl`, `bestDatasheet.url`.

Status: hand-authored, pending live validation. We are blocked on the free Nexar Welcome 1K
credentials (see `../../LAYER1.md`). This shape is our best read of the schema, not a captured
response.

## Swapping in the live response when credentials land

1. Run `SEARCH_QUERY` for LMP7704-SP in the Nexar Nitro IDE (the query is the single source of
   truth; do not retype it, copy it from `resolvers/nexar.ts`).
2. Replace the contents of `nexar-lmp7704.json` with the captured `{ "data": { ... } }` body.
3. Run `npm test`. `nexar.test.ts` loads this file and derives the datasheet URL, source page
   URL, and MPN from it, so a same-shape capture needs no test edit. The test also asserts the
   resolver sent exactly `SEARCH_QUERY`, so if the capture was taken against a different query
   that mismatch surfaces immediately.

Keep the fixture to publicly available parts only, same rule as `test-data/` (LMP7704-SP is
public). No controlled or customer part numbers here.
