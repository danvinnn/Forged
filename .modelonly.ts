// MODEL-ONLY, reconstructed from the answers this run already paid for.
//
// Rebuilds each record from the model's values alone, discarding every
// deterministic one, then runs the real resolve and export. No new calls: the
// merged run asked about every field that determines a footprint, so the
// model's side of it is already on disk.
import { readFileSync, existsSync } from "node:fs";
import { loadBenchEnv } from "./src/lib/__bench__/env";
loadBenchEnv();
process.env.FORGE_LOG_LEVEL = "error";

async function main() {
  const { HOLDOUT_CORPUS } = await import("./src/lib/__bench__/holdout");
  const { extractPartRecord } = await import("./src/lib/datasheet");
  const { runExtraction, makeExtractionModel } = await import("./src/lib/extraction");
  const { cachingModel } = await import("./src/lib/__bench__/modelcache");
  const { resolveForExport } = await import("./src/lib/types");
  const { createExportZip, FootprintUnavailableError } = await import("./src/lib/exporters");

  const inner = await makeExtractionModel("commercial");
  let cached = 0, readOk = 0, ships = 0, asks = 0;
  const blocked = new Map<string, number>();
  const bump = (k: string) => blocked.set(k, (blocked.get(k) ?? 0) + 1);

  for (const part of HOLDOUT_CORPUS) {
    const path = `.holdout-cache/${part.partNumber.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
    if (!existsSync(path)) continue;
    cached += 1;
    const b = readFileSync(path);
    const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    let rec;
    try {
      const { doc, part: det } = await extractPartRecord(`${part.partNumber}.pdf`, buf);
      // OFFLINE: replays this run's answers, and can never spend.
      const model = cachingModel(inner!, "offline", () => part.partNumber);
      const out = await runExtraction(det, doc, buf, model, `${part.partNumber}.pdf`, part.partNumber);
      if (!out) { bump("no model answer"); continue; }
      // Keep ONLY what the model read. Everything the deterministic pass
      // supplied is nulled, which is what "model only" means for the record.
      // Doing it here rather than with FORGE_MODEL_ONLY is deliberate: blanking
      // the record up front changes the field list, which changes the prompt,
      // which misses every cached answer this run paid for.
      const fromModel = (f: {method?: string | null}) => typeof f?.method === "string" && f.method.startsWith("vlm");
      const strip = <T extends Record<string, unknown>>(group: T): T => {
        const out2: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(group)) {
          const f = v as { value?: unknown; method?: string | null };
          out2[k] = fromModel(f) ? f : { ...f, value: null };
        }
        return out2 as T;
      };
      rec = {
        ...out.part,
        pins: fromModel(out.part.pins as never) ? out.part.pins : { ...out.part.pins, value: null },
        pinCount: fromModel(out.part.pinCount as never) ? out.part.pinCount : { ...out.part.pinCount, value: null },
        packageType: fromModel(out.part.packageType as never) ? out.part.packageType : { ...out.part.packageType, value: null },
        dimensions: strip(out.part.dimensions as never),
        // Identity is not what the parser/model question is about, and a record
        // with no part number cannot resolve at all.
        partNumber: out.part.partNumber,
        manufacturer: out.part.manufacturer
      } as typeof out.part;
    } catch { bump("no model answer"); continue; }

    const pins = rec.pins.value ?? [];
    if (pins.length === 0 || rec.pinCount.value === null) { bump("did not read"); continue; }
    readOk += 1;
    const r = resolveForExport(rec);
    if (!r.ok) {
      bump(r.unsettled?.length ? `held: disagree (${[...new Set(r.unsettled)].join(",")})` : `held: ${r.missing.join(",")}`);
      continue;
    }
    try { await createExportZip(r.part, "kicad"); ships += 1; }
    catch (e) {
      if (e instanceof FootprintUnavailableError && e.needs.length > 0) { asks += 1; bump(`asks: ${e.needs.map(n=>n.field).join(",")}`); }
      else bump("no footprint");
    }
  }
  console.log(`MODEL ONLY, reconstructed (no new calls)`);
  console.log(`cached:  ${cached}`);
  console.log(`READ:    ${readOk}/${cached}  (${Math.round(readOk/cached*100)}%)`);
  console.log(`SHIPS:   ${ships}/${cached}  (${Math.round(ships/cached*100)}%)`);
  console.log(`ASKS:    ${asks}\n`);
  for (const [k, n] of [...blocked].sort((a,b)=>b[1]-a[1]).slice(0,8)) console.log(`  ${String(n).padStart(3)}  ${k}`);
}
main().catch((e) => console.error("ERR", (e as Error).message));
