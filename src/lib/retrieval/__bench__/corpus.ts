// Coverage benchmark corpus.
//
// Air-gap safety: pure data, no network, no imports that reach the network.
//
// Purpose: turn "coverage feels thin" into a number. Every claim about Layer 1's reach up to now
// has been judgment from reading the registry, which is exactly the kind of thing that drifts from
// reality without anyone noticing. This corpus is the measuring stick.
//
// Categories are chosen to match how coverage actually fails, not how a catalog is organized:
//   radhard-major     rad-hard parts from vendors with derivable URL patterns. Our thesis, and the
//                     part of it we can actually serve.
//   radhard-specialist rad-hard from pure-play vendors that publish no public datasheets. Expected
//                     to miss. Kept in the corpus precisely so the miss stays visible and nobody
//                     later "fixes" coverage numbers by quietly dropping the hard cases.
//   analog            the mainstream analog/mixed-signal catalog. Our strongest area.
//   mcu               microcontrollers. Mixed: STM32 covered, most others are not.
//   power-discrete    regulators, FETs, drivers. Mostly uncovered vendors.
//   logic-interface   glue logic and transceivers.
//   connector         the worst gap, and the one where footprint generation is most valuable.
//   memory-fpga       effectively zero coverage today.
//
// Parts are real, publicly documented, non-controlled devices. Adding a controlled or
// customer-specific part number here would be a compliance problem, so the same rule as
// test-data/ applies: public parts only.

export type BenchCategory =
  | "radhard-major"
  | "radhard-specialist"
  | "analog"
  | "mcu"
  | "power-discrete"
  | "logic-interface"
  | "connector"
  | "memory-fpga";

export interface BenchPart {
  partNumber: string;
  manufacturer?: string;
  category: BenchCategory;
  // What we expect today, so a run surfaces surprises in BOTH directions. An unexpected hit is as
  // interesting as an unexpected miss: it usually means a pattern generalizes further than assumed.
  expect: "hit" | "miss";
  note?: string;
}

export const BENCH_CORPUS: BenchPart[] = [
  // --- rad-hard from vendors with derivable patterns: the thesis parts we CAN serve -------------
  { partNumber: "LMP7704-SP", manufacturer: "Texas Instruments", category: "radhard-major", expect: "hit", note: "primary test part, QMLV RHA 100krad" },
  { partNumber: "RHF310A", manufacturer: "STMicroelectronics", category: "radhard-major", expect: "hit", note: "RHA QML-V, 300krad" },
  { partNumber: "RHF1201", manufacturer: "STMicroelectronics", category: "radhard-major", expect: "hit", note: "rad-hard ADC" },
  { partNumber: "RHFL4913", manufacturer: "STMicroelectronics", category: "radhard-major", expect: "hit", note: "rad-hard LDO" },
  { partNumber: "TPS7A4501-SP", manufacturer: "Texas Instruments", category: "radhard-major", expect: "hit" },
  { partNumber: "LM139AQML-SP", manufacturer: "Texas Instruments", category: "radhard-major", expect: "hit" },
  { partNumber: "ADC128S102QML-SP", manufacturer: "Texas Instruments", category: "radhard-major", expect: "hit" },
  { partNumber: "AD590", manufacturer: "Analog Devices", category: "radhard-major", expect: "hit", note: "ad590s.pdf is the space-grade variant" },

  // --- rad-hard from pure-play specialists: expected misses, kept visible on purpose ------------
  { partNumber: "VA10820", manufacturer: "VORAGO", category: "radhard-specialist", expect: "miss", note: "vendor publishes NO public datasheets; only distributor copies exist" },
  { partNumber: "VA41630", manufacturer: "VORAGO", category: "radhard-specialist", expect: "miss" },
  { partNumber: "UT32M0R500", manufacturer: "CAES", category: "radhard-specialist", expect: "miss" },
  { partNumber: "UT54LVDS217", manufacturer: "CAES", category: "radhard-specialist", expect: "miss" },
  { partNumber: "ISL71001M", manufacturer: "Renesas", category: "radhard-specialist", expect: "miss", note: "Renesas uses document-numbered filenames" },
  { partNumber: "RTAX2000S", manufacturer: "Microchip", category: "radhard-specialist", expect: "miss", note: "Microchip names datasheets by doc number" },

  // --- mainstream analog: our strongest area ---------------------------------------------------
  { partNumber: "LM358", manufacturer: "Texas Instruments", category: "analog", expect: "hit" },
  { partNumber: "OPA333", manufacturer: "Texas Instruments", category: "analog", expect: "hit" },
  { partNumber: "INA240", manufacturer: "Texas Instruments", category: "analog", expect: "hit" },
  { partNumber: "ADS1115", manufacturer: "Texas Instruments", category: "analog", expect: "hit" },
  {
    partNumber: "ADS8688",
    manufacturer: "Texas Instruments",
    category: "analog",
    expect: "hit",
    note: "Promoted out of the hold-out on 2026-08-02, replaced there by ADS1256. TI's continued Pin Functions template: a 68-page document whose pin table spans pages and whose rows the reader refuses at the type gate. Promoted because diagnosing it requires reading it."
  },
  { partNumber: "TLV9061", manufacturer: "Texas Instruments", category: "analog", expect: "hit" },
  { partNumber: "REF5025", manufacturer: "Texas Instruments", category: "analog", expect: "hit" },
  { partNumber: "AD8628", manufacturer: "Analog Devices", category: "analog", expect: "hit" },
  { partNumber: "ADG5412", manufacturer: "Analog Devices", category: "analog", expect: "hit" },
  { partNumber: "ADR4525", manufacturer: "Analog Devices", category: "analog", expect: "hit" },
  { partNumber: "TSV911", manufacturer: "STMicroelectronics", category: "analog", expect: "hit" },
  // PROMOTED from the hold-out 2026-07-31. Its "Pin connections (top view)" figure
  // was opened to diagnose why seven ST parts read nothing; the other six stay in the
  // hold-out as the check that whatever was fixed generalises.
  { partNumber: "TSV321", manufacturer: "STMicroelectronics", category: "analog", expect: "hit" },
  // No manufacturer hint: exercises prefix claiming and the speculative tier.
  { partNumber: "OPA2277", category: "analog", expect: "hit", note: "no hint, must be claimed by prefix" },
  { partNumber: "AD8232", category: "analog", expect: "hit", note: "no hint" },
  { partNumber: "MAX232", manufacturer: "Analog Devices", category: "analog", expect: "miss", note: "Maxim legacy naming, ADI pattern may not cover it" },
  { partNumber: "LTC3105", manufacturer: "Analog Devices", category: "analog", expect: "miss", note: "Linear legacy files often use a trailing f" },

  // --- MCUs ------------------------------------------------------------------------------------
  { partNumber: "STM32F407VG", manufacturer: "STMicroelectronics", category: "mcu", expect: "hit" },
  { partNumber: "STM32F103C8", manufacturer: "STMicroelectronics", category: "mcu", expect: "hit" },
  { partNumber: "STM32H743ZI", manufacturer: "STMicroelectronics", category: "mcu", expect: "hit" },
  { partNumber: "MSP430F5529", manufacturer: "Texas Instruments", category: "mcu", expect: "hit" },
  { partNumber: "ATMEGA328P", manufacturer: "Microchip", category: "mcu", expect: "miss", note: "doc-numbered" },
  { partNumber: "PIC16F877A", manufacturer: "Microchip", category: "mcu", expect: "miss" },
  { partNumber: "LPC1768", manufacturer: "NXP", category: "mcu", expect: "miss", note: "NXP uses document names" },
  { partNumber: "ESP32-WROOM-32", manufacturer: "Espressif", category: "mcu", expect: "miss", note: "no pattern" },
  { partNumber: "NRF52840", manufacturer: "Nordic", category: "mcu", expect: "miss" },
  { partNumber: "RP2040", manufacturer: "Raspberry Pi", category: "mcu", expect: "miss" },

  // --- power and discrete ----------------------------------------------------------------------
  { partNumber: "TPS7A4700", manufacturer: "Texas Instruments", category: "power-discrete", expect: "hit" },
  { partNumber: "UCC27524", manufacturer: "Texas Instruments", category: "power-discrete", expect: "hit" },
  // PROMOTED from the hold-out 2026-07-31 to diagnose why TI's modern "Pin Functions"
  // table reads nothing. MSP430FR2433 stays in the hold-out as the generality check.
  { partNumber: "DRV8825", manufacturer: "Texas Instruments", category: "power-discrete", expect: "hit" },
  { partNumber: "LD1117", manufacturer: "STMicroelectronics", category: "power-discrete", expect: "hit" },
  { partNumber: "L7805", manufacturer: "STMicroelectronics", category: "power-discrete", expect: "hit" },
  { partNumber: "IRF540N", manufacturer: "Infineon", category: "power-discrete", expect: "miss" },
  { partNumber: "BSS138", manufacturer: "Infineon", category: "power-discrete", expect: "miss" },
  { partNumber: "NCP1200", manufacturer: "onsemi", category: "power-discrete", expect: "miss" },
  { partNumber: "MC33063A", manufacturer: "onsemi", category: "power-discrete", expect: "miss" },
  { partNumber: "SI2302", manufacturer: "Vishay", category: "power-discrete", expect: "miss", note: "Vishay is doc-numbered" },
  { partNumber: "AP2112", manufacturer: "Diodes", category: "power-discrete", expect: "miss" },

  // --- logic and interface ---------------------------------------------------------------------
  { partNumber: "SN74LVC1G08", manufacturer: "Texas Instruments", category: "logic-interface", expect: "hit" },
  { partNumber: "SN65HVD230", manufacturer: "Texas Instruments", category: "logic-interface", expect: "hit" },
  { partNumber: "ISO7741", manufacturer: "Texas Instruments", category: "logic-interface", expect: "hit" },
  { partNumber: "TXB0104", manufacturer: "Texas Instruments", category: "logic-interface", expect: "hit" },
  { partNumber: "74HC00", manufacturer: "Nexperia", category: "logic-interface", expect: "miss" },
  { partNumber: "PCF8574", manufacturer: "NXP", category: "logic-interface", expect: "miss" },
  { partNumber: "TJA1050", manufacturer: "NXP", category: "logic-interface", expect: "miss" },
  { partNumber: "MCP2515", manufacturer: "Microchip", category: "logic-interface", expect: "miss" },

  // --- connectors: the worst gap, and where footprint generation matters most -------------------
  { partNumber: "43045-0400", manufacturer: "Molex", category: "connector", expect: "miss" },
  { partNumber: "282836-2", manufacturer: "TE Connectivity", category: "connector", expect: "miss" },
  { partNumber: "S2B-PH-K-S", manufacturer: "JST", category: "connector", expect: "miss" },
  { partNumber: "10118193-0001LF", manufacturer: "Amphenol", category: "connector", expect: "miss" },
  { partNumber: "DF13-4P-1.25DSA", manufacturer: "Hirose", category: "connector", expect: "miss" },
  { partNumber: "M39029/58-360", manufacturer: "Glenair", category: "connector", expect: "miss", note: "mil-spec, directly relevant to the ICP" },

  // --- memory and FPGA -------------------------------------------------------------------------
  { partNumber: "MT41K256M16", manufacturer: "Micron", category: "memory-fpga", expect: "miss" },
  { partNumber: "W25Q128JV", manufacturer: "Winbond", category: "memory-fpga", expect: "miss" },
  { partNumber: "XC7A35T", manufacturer: "AMD", category: "memory-fpga", expect: "miss" },
  { partNumber: "10M08SAU169", manufacturer: "Intel", category: "memory-fpga", expect: "miss" },
  { partNumber: "A3P250", manufacturer: "Microchip", category: "memory-fpga", expect: "miss" }
];

export function corpusByCategory(): Map<BenchCategory, BenchPart[]> {
  const grouped = new Map<BenchCategory, BenchPart[]>();
  for (const part of BENCH_CORPUS) {
    const list = grouped.get(part.category) ?? [];
    list.push(part);
    grouped.set(part.category, list);
  }
  return grouped;
}
