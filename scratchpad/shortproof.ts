import { readFileSync } from "node:fs";
import { extractPartRecord } from "../src/lib/datasheet";
import { makeExtractionModel, runExtraction } from "../src/lib/extraction";
import { cachingModel } from "../src/lib/__bench__/modelcache";
import { getDeploymentMode } from "../src/lib/retrieval/deployment";
import { loadBenchEnv } from "../src/lib/__bench__/env";
import { withPrintedFootprint } from "../src/lib/readout";
import { BENCH_SETTINGS, shipOutcome } from "../src/lib/__bench__/shipcheck";
import { buildFootprintGeometry } from "../src/lib/exporters";
import { validateGeometry, confidenceChecks } from "../src/lib/confidence";
import { densityOf } from "../src/lib/settings";
loadBenchEnv();
void (async () => {
  const b = readFileSync(".bench-cache/TPS7A4700.pdf");
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const ex = await extractPartRecord("TPS7A4700.pdf", buf);
  let rec = ex.part;
  const inner = await makeExtractionModel(getDeploymentMode());
  const m = cachingModel(inner!, "offline", () => "TPS7A4700");
  const o = await runExtraction(rec, ex.doc, buf, m, "TPS7A4700.pdf"); if (o) rec = o.part;
  rec = withPrintedFootprint(rec, ex.doc);
  const out = await shipOutcome(rec, BENCH_SETTINGS);
  const base = out.shippedPart!;
  for (const span of [4.65, 3.9]) {
    const part = { ...base, dimensions: { ...base.dimensions, landSpanMm: span, landSpanCrossMm: span } };
    let verdict: string;
    try {
      const g = buildFootprintGeometry(part, densityOf(BENCH_SETTINGS), BENCH_SETTINGS.formedLeadSpanMm, undefined, BENCH_SETTINGS.formedLeadContactMm);
      validateGeometry(g, part);
      const inner1 = span - (part.dimensions.landPadLengthMm ?? 0);
      const clearance = (inner1 - (part.dimensions.thermalPadWidthMm ?? 0)) / 2;
      verdict = `BUILT   inner gap ${inner1.toFixed(3)}  clearance to pad ${clearance.toFixed(3)} mm`;
    } catch (e) {
      verdict = `REFUSED  ${(e as Error).message.replace(/\s+/g, " ").slice(0, 120)}`;
    }
    const check = confidenceChecks(part).find((c) => c.id === "lands-clear-centre")!;
    console.log(`span ${span}:  ${verdict}`);
    console.log(`           check "${check.label}" = ${check.state}: ${check.detail}`);
  }
})();
