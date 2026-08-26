import { loadBenchEnv } from "../../src/lib/__bench__/env";
loadBenchEnv();
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildCachedParts } from "../../src/lib/__bench__/oracle-match";
import { extractPartRecord } from "../../src/lib/datasheet";
import { findUnreadableFootprint } from "../../src/lib/vendorland";

async function main() {
  const built = await buildCachedParts();
  let held = 0;
  let onFootprintPage = 0;
  for (const e of built ?? []) {
    const dims = e.record.dimensions;
    const span = dims.landSpanMm;
    if (span.value === null) continue;
    held += 1;
    const page = span.citation?.page ?? null;
    let footprintPage: number | null = null;
    for (const dir of [".bench-cache", ".holdout-cache"]) {
      const path = join(process.cwd(), dir, `${e.part}.pdf`);
      if (!existsSync(path)) continue;
      const bytes = readFileSync(path);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const { doc } = await extractPartRecord(`${e.part}.pdf`, buffer);
      footprintPage = findUnreadableFootprint(doc);
      break;
    }
    const match = page !== null && footprintPage !== null && Math.abs(page - footprintPage) <= 1;
    if (match) onFootprintPage += 1;
    console.log(`${e.part.padEnd(16)} span ${String(span.value).padEnd(7)} cited p${String(page).padEnd(5)} footprint heading p${String(footprintPage).padEnd(5)} ${match ? "" : "  <- not on a footprint page"}`);
  }
  console.log(`\n${onFootprintPage}/${held} records holding a land span cite a page at or beside a recognised footprint heading.`);
}
void main();
