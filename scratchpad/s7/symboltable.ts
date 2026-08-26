import { loadBenchEnv } from "../../src/lib/__bench__/env";
loadBenchEnv();
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { extractDatasheetText } from "../../src/lib/pdftext";

// How common is a mechanical-data table that states the overall height as
// symbol A with a Max column? A rule written for one document is tailoring; a
// rule covering a vendor's whole house style is not.
const TABLE = /\bSymbol\b[\s\S]{0,80}?\bMin\b[\s\S]{0,40}?\bTyp\b[\s\S]{0,40}?\bMax\b/i;
const A_ROW = /(?:^|\s)A\s*(?:\(\d+\))?\s+-\s+-\s+(\d+(?:\.\d+)?)\s/;

async function main() {
  const dir = join(process.cwd(), ".bench-cache");
  let docs = 0;
  let withTable = 0;
  const hits: string[] = [];
  for (const file of readdirSync(dir).filter((n) => n.endsWith(".pdf"))) {
    docs += 1;
    const bytes = readFileSync(join(dir, file));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    let doc;
    try { doc = await extractDatasheetText(buffer); } catch { continue; }
    const pages = doc.pages.filter((p) => TABLE.test(p.text) && A_ROW.test(p.text));
    if (pages.length === 0) continue;
    withTable += 1;
    hits.push(`${file.replace(/\.pdf$/, "").padEnd(18)} ${pages.length} page(s): ${pages.slice(0, 4).map((p) => `p${p.page}=${A_ROW.exec(p.text)?.[1]}`).join(" ")}`);
  }
  for (const h of hits) console.log(h);
  console.log(`\n${withTable}/${docs} cached datasheets state an overall height as "A  -  -  <max>" in a Min/Typ/Max symbol table.`);
}
void main();
