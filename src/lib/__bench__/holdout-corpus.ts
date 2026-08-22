/**
 * The hold-out corpus AS DATA, separate from the runner that scores it.
 *
 * `holdout.ts` starts a full measurement run the moment it is imported, which is
 * correct for a bench and useless for anything that only wants to know which
 * parts are in the corpus. `bench:corpus` needs exactly that and nothing else,
 * so the list lives here, the way `BENCH_CORPUS` already does one level down.
 *
 * **The hold-out rule still governs everything in this file.** Nothing here may
 * be tuned against. See the header of `holdout.ts` for what that means and what
 * to do instead when a hold-out part needs diagnosing.
 */

import { join } from "node:path";

export const HOLDOUT_CACHE_DIR = join(process.cwd(), ".holdout-cache");

/** Where a hold-out part's PDF caches. The sanitiser is lossy on purpose: it is
 * a filename, and the part number it came from is the one in the corpus list. */
export function holdoutCachePath(partNumber: string): string {
  return join(HOLDOUT_CACHE_DIR, `${partNumber.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`);
}

export interface HoldoutPart {
  partNumber: string;
  manufacturer: string;
  /** Rough family, so a failure can be grouped by the kind of part rather than the vendor. */
  kind: "opamp" | "converter" | "power" | "logic" | "interface" | "sensor" | "mcu" | "reference";
}

export const HOLDOUT_CORPUS: HoldoutPart[] = [
  // Texas Instruments
  { partNumber: "OPA192", manufacturer: "Texas Instruments", kind: "opamp" },
  // Replaces OPA2189, promoted into BENCH_CORPUS on 2026-08-12 after its page 5
  // had to be opened to settle a cross-check disagreement. Chosen the same way
  // every part here was: by vendor, kind and document age, WITHOUT opening it.
  { partNumber: "OPA1612", manufacturer: "Texas Instruments", kind: "opamp" },
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
  // TPS7A4700 removed 2026-08-17 for the same reason: it was in BENCH_CORPUS too.
  { partNumber: "TPS7A4901", manufacturer: "Texas Instruments", kind: "power" },
  // TPS54360 was PROMOTED to the tuned corpus on 2026-08-17: it produced an
  // invalid footprint, and a defect that cannot be opened cannot be fixed.
  // Replaced here so the hold-out keeps its size and its shape.
  { partNumber: "TPS63020", manufacturer: "Texas Instruments", kind: "power" },
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
  // TS922 and TSZ121 were PROMOTED to the tuned corpus on 2026-08-19. Both read
  // every package and every package drawing and returned NO pin table for any of
  // them, and whether their pinouts are printed as text or drawn as artwork
  // could not be established without opening them. Replaced blind below, by
  // vendor and kind, datasheets unopened.
  { partNumber: "TSV991", manufacturer: "STMicroelectronics", kind: "opamp" },
  { partNumber: "TSU101", manufacturer: "STMicroelectronics", kind: "opamp" },
  { partNumber: "TSB611", manufacturer: "STMicroelectronics", kind: "opamp" },
  // L7805 was PROMOTED to the tuned corpus on 2026-08-17: it read no pins and no
  // pin count, and why could not be established without opening it. Replaced
  // blind, by vendor and kind, datasheet unopened.
  { partNumber: "LM317", manufacturer: "STMicroelectronics", kind: "power" },
  { partNumber: "LD39050", manufacturer: "STMicroelectronics", kind: "power" },
  { partNumber: "ST1S10", manufacturer: "STMicroelectronics", kind: "power" },
  { partNumber: "VIPER22A", manufacturer: "STMicroelectronics", kind: "power" },
  { partNumber: "M24C02", manufacturer: "STMicroelectronics", kind: "interface" },
  // LIS3DH and STM32G071RB were PROMOTED into BENCH_CORPUS on 2026-08-02, one for
  // each of the two gates that account for 16 of the 18 unreadable parts. LPS22HB
  // and STM32F411RE replace them, chosen by part number alone with their
  // datasheets unopened. Fourth and fifth promotions; see the header rule.
  { partNumber: "LPS22HB", manufacturer: "STMicroelectronics", kind: "sensor" },
  { partNumber: "LSM6DSO", manufacturer: "STMicroelectronics", kind: "sensor" },
  { partNumber: "STM32L476RG", manufacturer: "STMicroelectronics", kind: "mcu" },
  { partNumber: "STM32F411RE", manufacturer: "STMicroelectronics", kind: "mcu" },
  { partNumber: "STM32F030C8", manufacturer: "STMicroelectronics", kind: "mcu" },

  // Analog Devices
  { partNumber: "AD620", manufacturer: "Analog Devices", kind: "opamp" },
  { partNumber: "AD8221", manufacturer: "Analog Devices", kind: "opamp" },
  { partNumber: "OP07", manufacturer: "Analog Devices", kind: "opamp" },
  // LT1013 was PROMOTED to the tuned corpus on 2026-08-17. It was the only part
  // in the corpus reading a pin COUNT but no pins, a category of one, which is
  // exactly the kind that stays unexplained forever unless it is promoted.
  { partNumber: "OP27", manufacturer: "Analog Devices", kind: "opamp" },
  { partNumber: "ADA4522-2", manufacturer: "Analog Devices", kind: "opamp" },
  { partNumber: "AD7124-8", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "AD7606", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "AD5679R", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "AD9833", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "LTC2400", manufacturer: "Analog Devices", kind: "converter" },
  { partNumber: "ADG1211", manufacturer: "Analog Devices", kind: "interface" },
  { partNumber: "ADUM1201", manufacturer: "Analog Devices", kind: "interface" },
  { partNumber: "ADM3202", manufacturer: "Analog Devices", kind: "interface" },
  // ADXL345 was PROMOTED to the tuned corpus on 2026-08-17, same reason.
  { partNumber: "ADXL362", manufacturer: "Analog Devices", kind: "sensor" },
  { partNumber: "AD8495", manufacturer: "Analog Devices", kind: "sensor" },
  // LTC3105 removed 2026-08-17: it was ALSO in BENCH_CORPUS, so it had been tuned
  // against while counting toward the unseen number. Replaced blind.
  { partNumber: "LT3080", manufacturer: "Analog Devices", kind: "power" }
];
