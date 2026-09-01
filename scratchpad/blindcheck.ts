/**
 * Render the pages behind one blind part's reading, and print what we emitted.
 *
 * Two halves on purpose: the IMAGES go to a fresh reader who is told nothing,
 * and the ANSWER stays here until they have committed to theirs.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { extractPartRecord } from "../src/lib/datasheet";
import { makeExtractionModel, runExtraction } from "../src/lib/extraction";
import { cachingModel } from "../src/lib/__bench__/modelcache";
import { getDeploymentMode } from "../src/lib/retrieval/deployment";
import { loadBenchEnv } from "../src/lib/__bench__/env";
import { BENCH_SETTINGS, shipOutcome } from "../src/lib/__bench__/shipcheck";
import { buildFootprintGeometry } from "../src/lib/exporters";
import { densityOf } from "../src/lib/settings";
import { renderPages } from "../src/lib/pagerender";

loadBenchEnv();

async function main() {
  const [name, outDir] = process.argv.slice(2);
  const path = join(process.cwd(), ".blind-cache", `${name}.pdf`);
  const bytes = readFileSync(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const { doc, part: deterministic } = await extractPartRecord(`${name}.pdf`, buffer);
  const inner = await makeExtractionModel(getDeploymentMode());
  let record = deterministic;
  if (inner) {
    const model = cachingModel(inner, "offline", () => name);
    try {
      const outcome = await runExtraction(record, doc, buffer, model, `${name}.pdf`);
      if (outcome) record = outcome.part;
    } catch {
      console.log("NO CACHED ANSWER");
      return;
    }
  }
  const outcome = await shipOutcome(record, BENCH_SETTINGS);
  if (!outcome.shippedPart) {
    console.log(`does not ship: ${outcome.why}`);
    return;
  }
  const part = outcome.shippedPart;

  // The pages a reader must see: whatever the record cites for the pinout and
  // for the mechanical drawing, plus the printed land pattern.
  const pages = new Set<number>();
  const cite = (value: unknown) => {
    const page = (value as { citation?: { page?: number } } | null)?.citation?.page;
    if (typeof page === "number") pages.add(page);
  };
  const dims = deterministic.dimensions as unknown as Record<string, unknown>;
  for (const key of ["leadSpanMm", "leadWidthMm", "leadContactMm", "pitchMm", "bodyLengthMm", "landPadLengthMm", "landSpanMm"]) {
    cite(dims[key]);
  }
  cite((deterministic as unknown as Record<string, unknown>).pins);
  if (part.vendorLandPattern?.page) pages.add(part.vendorLandPattern.page);
  for (const table of record.packagesInThisDocument ?? []) {
    if (table.citation?.page) pages.add(table.citation.page);
  }

  // A record whose dimensions are mostly null cites nothing, so fall back to
  // finding the pages by what they say. Three of the first four parts rendered
  // no images at all without this.
  if (pages.size === 0) {
    for (const page of doc.pages) {
      if (/pin (configuration|description|assignment|out)|pinout|package (outline|dimensions|drawing)|mechanical|land pattern|recommended.*(footprint|land)/i.test(page.text)) {
        pages.add(page.page);
      }
    }
  }
  const want = [...pages].sort((a, b) => a - b).slice(0, 8);
  mkdirSync(outDir, { recursive: true });
  const images = await renderPages(buffer, want, { maxPages: want.length, dpi: 200 });
  for (const image of images) {
    writeFileSync(join(outDir, `p${image.page}.png`), Buffer.from(image.base64, "base64"));
  }
  console.log(`RENDERED ${images.map((i) => `${outDir}/p${i.page}.png`).join(" ")}`);

  console.log(`\n--- WHAT WE EMITTED (do not show a blind reader) ---`);
  console.log(`part          ${part.partNumber}`);
  console.log(`package       ${part.packageType}  (${part.packageOutlineCode ?? "no outline code"})`);
  console.log(`pins          ${part.pinCount}, exposed pad ${part.exposedPad}`);
  console.log(`pitch         ${part.dimensions.pitchMm}`);
  console.log(`body          ${part.dimensions.bodyWidthMm} x ${part.dimensions.bodyLengthMm}`);
  console.log(`lead span     ${JSON.stringify(part.dimensions.leadSpanMm)} cross ${JSON.stringify(part.dimensions.leadSpanCrossMm)}`);
  console.log(`lead width    ${JSON.stringify(part.dimensions.leadWidthMm)}`);
  console.log(`lead contact  ${JSON.stringify(part.dimensions.leadContactMm)}`);
  console.log(`printed land  ${part.dimensions.landPadLengthMm} x ${part.dimensions.landPadWidthMm} on span ${part.dimensions.landSpanMm} / ${part.dimensions.landSpanCrossMm}`);
  console.log(`pins: ${part.pins.map((pin) => `${pin.number}=${pin.name}`).join(" ")}`);
  try {
    const geometry = buildFootprintGeometry(part, densityOf(BENCH_SETTINGS), BENCH_SETTINGS.formedLeadSpanMm, undefined, BENCH_SETTINGS.formedLeadContactMm);
    console.log(`source        ${geometry.provenance.source.slice(0, 160)}`);
  } catch (error) {
    console.log(`footprint failed: ${(error as Error).message.slice(0, 120)}`);
  }
}

void main();
