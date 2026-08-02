// The HOLD-OUT corpus, and the only number in this project that predicts what a
// stranger's datasheet will do.
//
// ## Why this exists
//
// Every document in `BENCH_CORPUS` has been opened by hand and had reader rules
// fitted to it. Bounds were widened until a specific part read, caption spellings
// were added as they were met, tolerances were chosen by measuring one page. So
// the extraction bench does not measure how good the parser is. It measures how
// well thirty-nine documents were fitted, and it will keep going up as long as
// anyone keeps fitting them. It cannot go down when the parser fails to
// generalise, because nothing in it is unseen.
//
// The parts below were chosen WITHOUT opening their datasheets, across the three
// vendors whose URL patterns resolve, spanning op-amps, data converters,
// regulators, logic, interface, sensors and MCUs, and deliberately mixing modern
// and old document templates.
//
// ## The rule that makes the number mean anything
//
// **Nothing here may ever be tuned against.** Do not open a hold-out datasheet to
// diagnose a failure and then widen a bound so it passes. The moment you do, this
// file becomes a second training set and the project loses the only honest signal
// it has. If a hold-out failure needs diagnosing, the finding is the CLASS of
// failure, not the document: fix the class, re-measure, and if a specific part
// had to be looked at to get there, MOVE it into `BENCH_CORPUS` and add a
// replacement here.
//
// Usage:
//   npm run bench:holdout              measure what is cached
//   npm run bench:holdout -- --fetch   fetch anything missing first (network)
//
// PDFs cache under `.holdout-cache/` and are gitignored for the same reason
// `.bench-cache/` is: no vendor datasheet is ever committed to this repo.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractPartRecord } from "../datasheet";
import { resolveForExport, type PartRecord } from "../types";
import { createExportZip, FootprintUnavailableError } from "../exporters";

if (!process.env.FORGE_LOG_LEVEL) process.env.FORGE_LOG_LEVEL = "error";

const FETCH = process.argv.includes("--fetch");
const VERBOSE = process.argv.includes("--verbose");
const CACHE_DIR = join(process.cwd(), ".holdout-cache");
const FETCH_DELAY_MS = 1200;

export interface HoldoutPart {
  partNumber: string;
  manufacturer: string;
  /** Rough family, so a failure can be grouped by the kind of part rather than the vendor. */
  kind: "opamp" | "converter" | "power" | "logic" | "interface" | "sensor" | "mcu" | "reference";
}

export const HOLDOUT_CORPUS: HoldoutPart[] = [
  // Texas Instruments
  { partNumber: "OPA192", manufacturer: "Texas Instruments", kind: "opamp" },
  { partNumber: "OPA2189", manufacturer: "Texas Instruments", kind: "opamp" },
  { partNumber: "TLV9002", manufacturer: "Texas Instruments", kind: "opamp" },
  { partNumber: "LMV321", manufacturer: "Texas Instruments", kind: "opamp" },
  { partNumber: "INA333", manufacturer: "Texas Instruments", kind: "opamp" },
  { partNumber: "THS3491", manufacturer: "Texas Instruments", kind: "opamp" },
  { partNumber: "INA226", manufacturer: "Texas Instruments", kind: "converter" },
  { partNumber: "ADS1220", manufacturer: "Texas Instruments", kind: "converter" },
  // ADS8688 was PROMOTED into BENCH_CORPUS on 2026-08-02 and ADS1256 replaces it.
  // Diagnosing a hold-out failure means reading the document, and a document that
  // has been read is a tuned document; leaving it here would quietly turn the
  // honest number into the fitted one. Third promotion, after TSV321 -> TSB611
  // and DRV8825 -> TPS61022. The replacement was chosen by part number alone and
  // its datasheet has NOT been opened.
  { partNumber: "ADS1256", manufacturer: "Texas Instruments", kind: "converter" },
  { partNumber: "DAC8552", manufacturer: "Texas Instruments", kind: "converter" },
  { partNumber: "PCM1808", manufacturer: "Texas Instruments", kind: "converter" },
  { partNumber: "TPS62130", manufacturer: "Texas Instruments", kind: "power" },
  { partNumber: "TPS7A4700", manufacturer: "Texas Instruments", kind: "power" },
  { partNumber: "TPS54360", manufacturer: "Texas Instruments", kind: "power" },
  { partNumber: "LM5117", manufacturer: "Texas Instruments", kind: "power" },
  { partNumber: "LP5907", manufacturer: "Texas Instruments", kind: "power" },
  { partNumber: "UCC28C43", manufacturer: "Texas Instruments", kind: "power" },
  { partNumber: "TPS61022", manufacturer: "Texas Instruments", kind: "power" },
  { partNumber: "SN74HC595", manufacturer: "Texas Instruments", kind: "logic" },
  { partNumber: "SN74LVC245A", manufacturer: "Texas Instruments", kind: "logic" },
  { partNumber: "SN74AUP1G04", manufacturer: "Texas Instruments", kind: "logic" },
  { partNumber: "CD4017B", manufacturer: "Texas Instruments", kind: "logic" },
  { partNumber: "TCA9548A", manufacturer: "Texas Instruments", kind: "interface" },
  { partNumber: "SN65HVD72", manufacturer: "Texas Instruments", kind: "interface" },
  { partNumber: "ISO7841", manufacturer: "Texas Instruments", kind: "interface" },
  { partNumber: "TPD4E1U06", manufacturer: "Texas Instruments", kind: "interface" },
  { partNumber: "TMP117", manufacturer: "Texas Instruments", kind: "sensor" },
  { partNumber: "REF3025", manufacturer: "Texas Instruments", kind: "reference" },
  { partNumber: "TL431", manufacturer: "Texas Instruments", kind: "reference" },
  { partNumber: "MSP430FR2433", manufacturer: "Texas Instruments", kind: "mcu" },

  // STMicroelectronics
  { partNumber: "TS922", manufacturer: "STMicroelectronics", kind: "opamp" },
  { partNumber: "TSZ121", manufacturer: "STMicroelectronics", kind: "opamp" },
  { partNumber: "TSB611", manufacturer: "STMicroelectronics", kind: "opamp" },
  { partNumber: "L7805", manufacturer: "STMicroelectronics", kind: "power" },
  { partNumber: "LD39050", manufacturer: "STMicroelectronics", kind: "power" },
  { partNumber: "ST1S10", manufacturer: "STMicroelectronics", kind: "power" },
  { partNumber: "VIPER22A", manufacturer: "STMicroelectronics", kind: "power" },
  { partNumber: "M24C02", manufacturer: "STMicroelectronics", kind: "interface" },
  { partNumber: "LIS3DH", manufacturer: "STMicroelectronics", kind: "sensor" },
  { partNumber: "LSM6DSO", manufacturer: "STMicroelectronics", kind: "sensor" },
  { partNumber: "STM32L476RG", manufacturer: "STMicroelectronics", kind: "mcu" },
  { partNumber: "STM32G071RB", manufacturer: "STMicroelectronics", kind: "mcu" },
  { partNumber: "STM32F030C8", manufacturer: "STMicroelectronics", kind: "mcu" },

  // Analog Devices
  { partNumber: "AD620", manufacturer: "Analog Devices", kind: "opamp" },
  { partNumber: "AD8221", manufacturer: "Analog Devices", kind: "opamp" },
  { partNumber: "OP07", manufacturer: "Analog Devices", kind: "opamp" },
  { partNumber: "LT1013", manufacturer: "Analog Devices", kind: "opamp" },
  { partNumber: "ADA4522-2", manufacturer: "Analog Devices", kind: "opamp" },
  { partNumber: "AD7124-8", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "AD7606", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "AD5679R", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "AD9833", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "LTC2400", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "ADG1211", manufacturer: "Analog Devices", kind: "interface" },
  { partNumber: "ADUM1201", manufacturer: "Analog Devices", kind: "interface" },
  { partNumber: "ADM3202", manufacturer: "Analog Devices", kind: "interface" },
  { partNumber: "ADXL345", manufacturer: "Analog Devices", kind: "sensor" },
  { partNumber: "AD8495", manufacturer: "Analog Devices", kind: "sensor" },
  { partNumber: "LTC3105", manufacturer: "Analog Devices", kind: "power" }
];

function cachePath(partNumber: string): string {
  return join(CACHE_DIR, `${partNumber.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchToCache(part: HoldoutPart): Promise<boolean> {
  const { makeResolver } = await import("../retrieval/factory");
  const resolver = await makeResolver("commercial");
  if (!resolver) return false;
  try {
    const ref = await resolver.resolve(part.partNumber, { manufacturer: part.manufacturer });
    if (!ref) return false;
    writeFileSync(cachePath(part.partNumber), Buffer.from(ref.bytes));
    return true;
  } catch {
    return false;
  }
}

/**
 * Why one part produced no bundle, in a form that GROUPS.
 *
 * The point of the hold-out is not a list of parts to go and fix, it is a
 * histogram of causes. A cause with one part behind it is a document; a cause
 * with nine is a hole in the reader.
 */
function classify(record: PartRecord): string {
  const pins = record.pins.value ?? [];
  const count = record.pinCount.value;

  if (pins.length === 0 && count === null) return "no pins, no count";
  if (pins.length === 0) return "count but no pins";
  if (count === null) return "pins but no count (nothing corroborates them)";
  return "read";
}

async function main(): Promise<void> {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

  console.log(`Hold-out corpus: ${HOLDOUT_CORPUS.length} parts never inspected\n`);

  if (FETCH) {
    let got = 0;
    for (const part of HOLDOUT_CORPUS) {
      if (existsSync(cachePath(part.partNumber))) { got += 1; continue; }
      const ok = await fetchToCache(part);
      if (ok) got += 1;
      process.stdout.write(ok ? "." : "x");
      await sleep(FETCH_DELAY_MS);
    }
    console.log(`\ncached ${got}/${HOLDOUT_CORPUS.length}\n`);
  }

  const reasons = new Map<string, string[]>();
  const byKind = new Map<string, { read: number; total: number }>();
  let cached = 0;
  let read = 0;
  let ships = 0;
  const shipRefusals = new Map<string, string[]>();

  for (const part of HOLDOUT_CORPUS) {
    const path = cachePath(part.partNumber);
    const kind = byKind.get(part.kind) ?? { read: 0, total: 0 };
    if (!existsSync(path)) {
      byKind.set(part.kind, kind);
      continue;
    }
    cached += 1;
    kind.total += 1;

    const bytes = readFileSync(path);
    let record: PartRecord;
    try {
      ({ part: record } = await extractPartRecord(
        `${part.partNumber}.pdf`,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      ));
    } catch (error) {
      const reason = `parse threw: ${(error as Error).message.slice(0, 40)}`;
      reasons.set(reason, [...(reasons.get(reason) ?? []), part.partNumber]);
      byKind.set(part.kind, kind);
      continue;
    }

    const reason = classify(record);
    reasons.set(reason, [...(reasons.get(reason) ?? []), part.partNumber]);
    if (reason === "read") {
      read += 1;
      kind.read += 1;
      const resolved = resolveForExport(record);
      if (resolved.ok) {
        try {
          await createExportZip(resolved.part, "kicad");
          ships += 1;
        } catch (error) {
          const why =
            error instanceof FootprintUnavailableError && error.needs.length > 0
              ? `needs ${error.needs.map((n) => n.field).join(",")}`
              : "no land pattern";
          shipRefusals.set(why, [...(shipRefusals.get(why) ?? []), part.partNumber]);
        }
      }
    }
    byKind.set(part.kind, kind);
  }

  console.log(`cached:    ${cached}/${HOLDOUT_CORPUS.length}`);
  console.log(`READ:      ${read}/${cached}  (${cached ? Math.round((read / cached) * 100) : 0}%)  <- the number that predicts a stranger's datasheet`);
  console.log(`SHIPS:     ${ships}/${cached}  (${cached ? Math.round((ships / cached) * 100) : 0}%)\n`);

  console.log("Why parts did not read:");
  for (const [reason, parts] of [...reasons].sort((a, b) => b[1].length - a[1].length)) {
    if (reason === "read") continue;
    console.log(`  ${String(parts.length).padStart(3)}  ${reason}`);
    if (VERBOSE) console.log(`       ${parts.join(", ")}`);
  }

  if (shipRefusals.size > 0) {
    console.log("\nRead but no bundle:");
    for (const [why, parts] of [...shipRefusals].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${String(parts.length).padStart(3)}  ${why}`);
      if (VERBOSE) console.log(`       ${parts.join(", ")}`);
    }
  }

  console.log("\nBy kind:");
  for (const [kind, counts] of [...byKind].sort()) {
    if (counts.total === 0) continue;
    console.log(`  ${kind.padEnd(11)} ${counts.read}/${counts.total}`);
  }
}

main();
