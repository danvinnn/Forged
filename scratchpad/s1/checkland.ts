import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractPartRecord } from "../../src/lib/datasheet";
import { findUnreadableFootprint, findVendorLandPattern } from "../../src/lib/vendorland";

async function main() {
  for (const part of ["AD8232", "LIS3DH", "LM139AQML-SP", "STM32F103C8", "STM32G071RB", "TLV9061"]) {
    const bytes = readFileSync(join(process.cwd(), ".bench-cache", `${part}.pdf`));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const { doc } = await extractPartRecord(`${part}.pdf`, buffer);
    const page = findUnreadableFootprint(doc);
    const parsed = findVendorLandPattern(doc);
    console.log(`${part.padEnd(14)} footprint page ${String(page).padEnd(6)} parsed land ${parsed ? JSON.stringify(parsed).slice(0,120) : "null"}`);
  }
}
void main();
