import { loadBenchEnv } from "../../src/lib/__bench__/env";
loadBenchEnv();
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractDatasheetText } from "../../src/lib/pdftext";

async function main() {
  const [part, ...terms] = process.argv.slice(2);
  const bytes = readFileSync(join(process.cwd(), ".bench-cache", `${part}.pdf`));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const doc = await extractDatasheetText(buffer);
  console.log(`${part}: ${doc.pages.length} pages`);
  for (const page of doc.pages) {
    for (const term of terms) {
      if (new RegExp(term, "i").test(page.text)) {
        console.log(`  p${page.page}  ${term}  ::  ${page.text.replace(/\s+/g, " ").slice(0, 130)}`);
        break;
      }
    }
  }
}
void main();
