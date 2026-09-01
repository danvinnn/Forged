import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { renderPages } from "../src/lib/pagerender";
import { extractDatasheetText } from "../src/lib/pdftext";
const [path, out, ...pages] = process.argv.slice(2);
async function main() {
  const bytes = readFileSync(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const doc = await extractDatasheetText(buffer);
  console.log(`${doc.pageCount} pages`);
  const want = pages.length ? pages.map(Number) : doc.pages.map((p) => p.page).slice(0, 8);
  mkdirSync(out, { recursive: true });
  const imgs = await renderPages(buffer, want, { maxPages: want.length, dpi: 200 });
  for (const img of imgs) {
    writeFileSync(`${out}/p${img.page}.png`, Buffer.from(img.base64, "base64"));
    console.log(`${out}/p${img.page}.png`);
  }
  // Where the pinout and the outline probably are, from the text.
  for (const p of doc.pages) {
    if (/pin (configuration|description|assignment)|pinout|package (outline|dimensions)|mechanical/i.test(p.text)) {
      console.log(`  page ${p.page}: ${p.text.slice(0, 90).replace(/\n/g, " ")}`);
    }
  }
}
main();
