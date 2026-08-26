import { loadBenchEnv } from "../../src/lib/__bench__/env";
loadBenchEnv();
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractDatasheetText } from "../../src/lib/pdftext";
async function main() {
  const [part, ...pages] = process.argv.slice(2);
  const bytes = readFileSync(join(process.cwd(), ".bench-cache", `${part}.pdf`));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const doc = await extractDatasheetText(buffer);
  for (const n of pages.map(Number)) {
    const p = doc.pages.find((x) => x.page === n);
    console.log(`\n----- page ${n} -----\n${p?.text.replace(/\s+/g, " ").slice(0, 1400)}`);
  }
}
void main();
