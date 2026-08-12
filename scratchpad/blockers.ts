import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { extractPartRecord } from "../src/lib/datasheet";
import { createExportZip, FootprintUnavailableError } from "../src/lib/exporters";
import { resolveForExport } from "../src/lib/types";

const PARTS = ["RHF1201","ADC128S102QML-SP","ISL71001M","ADS1115","LIS3DH","ADS8688","TLV9061","AD8628","ADG5412","OPA2277","AD8232","STM32F103C8","DRV8825","SN74LVC1G08","TXB0104"];
async function main() {
  const buckets = new Map<string, string[]>();
  for (const p of PARTS) {
    const path = join(process.cwd(), ".bench-cache", `${p}.pdf`);
    if (!existsSync(path)) continue;
    const b = readFileSync(path);
    const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    const { part } = await extractPartRecord(`${p}.pdf`, buf);
    const r = resolveForExport(part);
    if (!r.ok) { buckets.set("record incomplete", [...(buckets.get("record incomplete") ?? []), p]); continue; }
    try { await createExportZip(r.part, "kicad"); }
    catch (e) {
      const key = e instanceof FootprintUnavailableError
        ? (part.packageType.value ?? "unknown package")
        : `other: ${(e as Error).name}`;
      buckets.set(key, [...(buckets.get(key) ?? []), p]);
    }
  }
  for (const [k, v] of [...buckets].sort((a,b) => b[1].length - a[1].length)) {
    console.log(`  ${String(v.length).padStart(2)}  ${k.padEnd(28)} ${v.join(", ")}`);
  }
}
main();
