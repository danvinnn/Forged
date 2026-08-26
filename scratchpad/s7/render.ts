import { loadBenchEnv } from "../../src/lib/__bench__/env";
loadBenchEnv();
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderPages } from "../../src/lib/pagerender";

// Render named pages of a cached datasheet to PNG so a person can read the
// drawing. Nothing here reaches the network.
async function main() {
  const [part, ...pages] = process.argv.slice(2);
  const bytes = readFileSync(join(process.cwd(), ".bench-cache", `${part}.pdf`));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const rendered = await renderPages(buffer, pages.map(Number), { dpi: 200, maxPages: 12, maxTotalBytes: 60_000_000 });
  for (const page of rendered) {
    const out = join("scratchpad/s7", `${part}-p${page.page}.png`);
    writeFileSync(out, Buffer.from(page.base64, "base64"));
    console.log(`${out}  ${page.widthPx}x${page.heightPx}`);
  }
}
void main();
