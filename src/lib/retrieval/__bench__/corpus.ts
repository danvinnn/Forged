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

// EXPECTATIONS RESET 2026-09-01 against two clean live runs. Before that reset, 35 of 80 parts were
// still marked `miss` from the era when the registry held three vendors, so a live run reported 29
// surprises and could no longer show a regression: the field exists to make a DROP visible, and it
// cannot do that when almost everything is expected to fail.
//
// The remaining `miss` rows are ONE class, and it is a real limit rather than a gap to fill: a
// FAMILY or SERIES document does not name the ordering part number in its front matter, so
// `namesThePart` rejects the correct file. Confirmed on each of them: the JST pattern fetches the
// right `ePH.pdf` and the document says "PH", never "S2B-PH-K-S"; the Artix-7 datasheet never says
// "XC7A35T"; the Intel datasheet says "MAX 10", never "10M08SAU169".
//
// `namesThePart` already accepts a family STEM, but only as a PREFIX ("L78" for L7805). These are
// infixes, and accepting infixes would match "PH" against half the internet. Loosening the check is
// how three wrong datasheets reached the corpus caches before, and a rejection sends the user to
// upload, which is the safe outcome. Left alone on purpose.
//
// TWO CAVEATS ON READING A LIVE RUN:
//   - The connector and memory-fpga tails depend on SEARCH RESULT ORDERING and move run to run.
//     A miss there is weak evidence; a miss in the other six categories is worth investigating.
//   - Running this bench repeatedly gets us throttled. A run immediately after several others
//     measured 70% while a rested run measured 93%, with onsemi answering 504 to one part and
//     serving another from the same host seconds later. Space the runs out.
export const BENCH_CORPUS: BenchPart[] = [
  // --- rad-hard from vendors with derivable patterns: the thesis parts we CAN serve -------------
  { partNumber: "LMP7704-SP", manufacturer: "Texas Instruments", category: "radhard-major", expect: "hit", note: "primary test part, QMLV RHA 100krad" },
  { partNumber: "RHF310A", manufacturer: "STMicroelectronics", category: "radhard-major", expect: "hit", note: "RHA QML-V, 300krad" },
  { partNumber: "RHF1201", manufacturer: "STMicroelectronics", category: "radhard-major", expect: "hit", note: "rad-hard ADC" },
  { partNumber: "RHFL4913", manufacturer: "STMicroelectronics", category: "radhard-major", expect: "hit", note: "rad-hard LDO" },
  // ADOPTED 2026-08-21 for the same reason as LTC6563: cached, tuned against,
  // scored by nothing. RHFL4913A is a SEPARATE 5MB document from RHFL4913's
  // 1MB one, and it is the RHFL4913A page that the glued-designator rule in
  // `packagevariants.ts` was fitted to ("Flat-16P", no separator).
  { partNumber: "RHFL4913A", manufacturer: "STMicroelectronics", category: "radhard-major", expect: "hit", note: "adopted: tuned against while in no corpus" },
  { partNumber: "TPS7A4501-SP", manufacturer: "Texas Instruments", category: "radhard-major", expect: "hit" },
  { partNumber: "LM139AQML-SP", manufacturer: "Texas Instruments", category: "radhard-major", expect: "hit" },
  { partNumber: "ADC128S102QML-SP", manufacturer: "Texas Instruments", category: "radhard-major", expect: "hit" },
  { partNumber: "AD590", manufacturer: "Analog Devices", category: "radhard-major", expect: "hit", note: "ad590s.pdf is the space-grade variant" },

  // --- rad-hard from pure-play specialists: expected misses, kept visible on purpose ------------
  { partNumber: "VA10820", manufacturer: "VORAGO", category: "radhard-specialist", expect: "hit", note: "distributor-hosted; found via mouser.com/pdfdocs" },
  { partNumber: "VA41630", manufacturer: "VORAGO", category: "radhard-specialist", expect: "hit", note: "distributor-hosted" },
  { partNumber: "UT32M0R500", manufacturer: "CAES", category: "radhard-specialist", expect: "hit", note: "vendor-hosted at frontgrade.com, found by search" },
  { partNumber: "UT54LVDS217", manufacturer: "CAES", category: "radhard-specialist", expect: "hit", note: "vendor-hosted at frontgrade.com, found by search" },
  { partNumber: "ISL71001M", manufacturer: "Renesas", category: "radhard-specialist", expect: "hit", note: "renesas.com/en/document/dst/ pattern" },
  { partNumber: "RTAX2000S", manufacturer: "Microchip", category: "radhard-specialist", expect: "hit", note: "Microchip doc-numbered PDF, found by search" },

  // --- mainstream analog: our strongest area ---------------------------------------------------
  { partNumber: "LM358", manufacturer: "Texas Instruments", category: "analog", expect: "hit" },
  { partNumber: "OPA333", manufacturer: "Texas Instruments", category: "analog", expect: "hit" },
  // Promoted out of the hold-out 2026-08-17, same reason as TPS54360.
  { partNumber: "ADXL345", manufacturer: "Analog Devices", category: "analog", expect: "hit", note: "promoted: invalid footprint" },
  // Promoted out of the hold-out 2026-08-17: the only part reading a pin COUNT
  // and no pins.
  { partNumber: "LT1013", manufacturer: "Analog Devices", category: "analog", expect: "hit", note: "promoted: count but no pins" },
  { partNumber: "INA240", manufacturer: "Texas Instruments", category: "analog", expect: "hit" },
  // Promoted from the hold-out 2026-08-19. Both listed every package and
  // measured every package drawing, and returned no pin table for ANY of them.
  // The question they were promoted to answer: is the pinout printed as text,
  // or drawn as artwork no reader can quote?
  { partNumber: "TS922", manufacturer: "STMicroelectronics", category: "analog", expect: "hit", note: "promoted: packages read, no pinout for any of them" },
  { partNumber: "TSZ121", manufacturer: "STMicroelectronics", category: "analog", expect: "hit", note: "promoted: packages read, no pinout for any of them" },
  { partNumber: "ADS1115", manufacturer: "Texas Instruments", category: "analog", expect: "hit" },
  {
    partNumber: "LIS3DH",
    manufacturer: "STMicroelectronics",
    category: "analog",
    expect: "hit",
    note: "Promoted out of the hold-out on 2026-08-02, replaced there by LPS22HB. Representative of the gate that refuses 9 parts: a number column is found and no name column is found beside it."
  },
  {
    partNumber: "STM32G071RB",
    manufacturer: "STMicroelectronics",
    category: "mcu",
    expect: "hit",
    note: "Promoted out of the hold-out on 2026-08-02, replaced there by STM32F411RE. Representative of the type gate, and of the MCU category, which failed 4 out of 4."
  },
  {
    partNumber: "ADS8688",
    manufacturer: "Texas Instruments",
    category: "analog",
    expect: "hit",
    note: "Promoted out of the hold-out on 2026-08-02, replaced there by ADS1256. TI's continued Pin Functions template: a 68-page document whose pin table spans pages and whose rows the reader refuses at the type gate. Promoted because diagnosing it requires reading it."
  },
  { partNumber: "TLV9061", manufacturer: "Texas Instruments", category: "analog", expect: "hit" },
  {
    partNumber: "OPA2189",
    manufacturer: "Texas Instruments",
    category: "analog",
    expect: "hit",
    note: "Promoted out of the hold-out on 2026-08-12, replaced there by OPA1612 (OPA2277 was the first pick and had to be discarded: it is already in this corpus and cited in five source files, so it was never blind). SBOS830I documents THREE devices (OPA189 single, OPA2189 dual, OPA4189 quad) and page 5 prints two pin tables: 'Pin Functions: OPA189' first, 'Pin Functions: OPA2189' second. The reader took the first and returned the SINGLE op-amp's pinout for the dual, so pin 1 read NC where the part has OUT A. Opened because the cross-check flagged it and only the page settles which side was right."
  },
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
  { partNumber: "MAX232", manufacturer: "Analog Devices", category: "analog", expect: "hit", note: "second-sourced: resolves from TI, not ADI" },
  { partNumber: "LTC3105", manufacturer: "Analog Devices", category: "analog", expect: "hit", note: "legacy Linear filename 3105fb.pdf, found by search" },
  // ADOPTED 2026-08-21, not promoted: it was never in the hold-out, it was in
  // NEITHER corpus. Its datasheet sat in .bench-cache scoring nothing while
  // reader rules were fitted to it - `sections.ts` carries its "RECOMMENDED
  // SOLDER PAD" caption and PINOUT_ORACLE carries its 24 hand-read pin names.
  // A part that has been tuned against belongs in the tuned corpus; leaving it
  // out understated the denominator and hid it from every measurement.
  { partNumber: "LTC6563", manufacturer: "Analog Devices", category: "analog", expect: "hit", note: "adopted: tuned against while in no corpus" },

  // --- MCUs ------------------------------------------------------------------------------------
  { partNumber: "STM32F407VG", manufacturer: "STMicroelectronics", category: "mcu", expect: "hit" },
  { partNumber: "STM32F103C8", manufacturer: "STMicroelectronics", category: "mcu", expect: "hit" },
  { partNumber: "STM32H743ZI", manufacturer: "STMicroelectronics", category: "mcu", expect: "hit" },
  { partNumber: "MSP430F5529", manufacturer: "Texas Instruments", category: "mcu", expect: "hit" },
  { partNumber: "ATMEGA328P", manufacturer: "Microchip", category: "mcu", expect: "hit", note: "Microchip PRODUCT PAGE, harvested and ranked" },
  { partNumber: "PIC16F877A", manufacturer: "Microchip", category: "mcu", expect: "hit", note: "Microchip product page; the file is 39582C.pdf" },
  { partNumber: "LPC1768", manufacturer: "NXP", category: "mcu", expect: "hit", note: "combined family filename LPC1769_68_67_66_65_64_63.pdf, found by search" },
  { partNumber: "ESP32-WROOM-32", manufacturer: "Espressif", category: "mcu", expect: "hit", note: "espressif pattern" },
  { partNumber: "NRF52840", manufacturer: "Nordic", category: "mcu", expect: "hit", note: "distributor-hosted, found by search" },
  { partNumber: "RP2040", manufacturer: "Raspberry Pi", category: "mcu", expect: "hit", note: "datasheets.raspberrypi.com pattern" },

  // --- power and discrete ----------------------------------------------------------------------
  { partNumber: "TPS7A4700", manufacturer: "Texas Instruments", category: "power-discrete", expect: "hit" },
  { partNumber: "UCC27524", manufacturer: "Texas Instruments", category: "power-discrete", expect: "hit" },
  // Promoted out of the hold-out 2026-08-17. Its footprint failed the output
  // invariant ("pin 9 has no land"), which is a real defect and one the
  // hold-out rules forbid diagnosing in place.
  { partNumber: "TPS54360", manufacturer: "Texas Instruments", category: "power-discrete", expect: "hit", note: "promoted: invalid footprint, pin with no land" },
  // PROMOTED from the hold-out 2026-07-31 to diagnose why TI's modern "Pin Functions"
  // table reads nothing. MSP430FR2433 stays in the hold-out as the generality check.
  { partNumber: "DRV8825", manufacturer: "Texas Instruments", category: "power-discrete", expect: "hit" },
  { partNumber: "LD1117", manufacturer: "STMicroelectronics", category: "power-discrete", expect: "hit" },
  // Was ALSO in the hold-out until 2026-08-17, so it had been tuned against and
  // counted as unseen at the same time. Removed there, not here.
  { partNumber: "L7805", manufacturer: "STMicroelectronics", category: "power-discrete", expect: "hit" },
  { partNumber: "IRF540N", manufacturer: "Infineon", category: "power-discrete", expect: "hit", note: "Infineon versioned filename, found by search" },
  { partNumber: "BSS138", manufacturer: "Infineon", category: "power-discrete", expect: "hit", note: "onsemi pattern" },
  { partNumber: "NCP1200", manufacturer: "onsemi", category: "power-discrete", expect: "hit", note: "onsemi pattern" },
  { partNumber: "MC33063A", manufacturer: "onsemi", category: "power-discrete", expect: "hit", note: "onsemi pattern" },
  { partNumber: "SI2302", manufacturer: "Vishay", category: "power-discrete", expect: "hit", note: "distributor-hosted, found by search" },
  { partNumber: "AP2112", manufacturer: "Diodes", category: "power-discrete", expect: "hit", note: "diodes pattern" },

  // --- logic and interface ---------------------------------------------------------------------
  { partNumber: "SN74LVC1G08", manufacturer: "Texas Instruments", category: "logic-interface", expect: "hit" },
  { partNumber: "SN65HVD230", manufacturer: "Texas Instruments", category: "logic-interface", expect: "hit" },
  { partNumber: "ISO7741", manufacturer: "Texas Instruments", category: "logic-interface", expect: "hit" },
  { partNumber: "TXB0104", manufacturer: "Texas Instruments", category: "logic-interface", expect: "hit" },
  { partNumber: "74HC00", manufacturer: "Nexperia", category: "logic-interface", expect: "hit", note: "second-sourced: resolves from Diodes" },
  { partNumber: "PCF8574", manufacturer: "NXP", category: "logic-interface", expect: "hit", note: "second-sourced: NXP 404s, TI hosts it. See MAX_SPECULATIVE in manufacturer.ts" },
  { partNumber: "TJA1050", manufacturer: "NXP", category: "logic-interface", expect: "hit", note: "nxp pattern" },
  { partNumber: "MCP2515", manufacturer: "Microchip", category: "logic-interface", expect: "hit", note: "Microchip product page" },

  // --- connectors: the worst gap, and where footprint generation matters most -------------------
  { partNumber: "43045-0400", manufacturer: "Molex", category: "connector", expect: "hit", note: "molex pattern" },
  { partNumber: "282836-2", manufacturer: "TE Connectivity", category: "connector", expect: "hit", note: "TE customer drawing pattern" },
  { partNumber: "S2B-PH-K-S", manufacturer: "JST", category: "connector", expect: "miss", note: "SERIES datasheet: the JST pattern fetches the right ePH.pdf and namesThePart rejects it, because the document says PH and never the ordering number" },
  { partNumber: "10118193-0001LF", manufacturer: "Amphenol", category: "connector", expect: "hit", note: "found by search" },
  { partNumber: "DF13-4P-1.25DSA", manufacturer: "Hirose", category: "connector", expect: "hit", note: "distributor-hosted, found by search" },
  { partNumber: "M39029/58-360", manufacturer: "Glenair", category: "connector", expect: "hit", note: "mil-spec, distributor-hosted, found by search" },

  // --- memory and FPGA -------------------------------------------------------------------------
  { partNumber: "MT41K256M16", manufacturer: "Micron", category: "memory-fpga", expect: "miss", note: "distributor-hosted and search-dependent; resolved in 1 of 3 clean runs" },
  { partNumber: "W25Q128JV", manufacturer: "Winbond", category: "memory-fpga", expect: "hit", note: "distributor-hosted, found by search" },
  { partNumber: "XC7A35T", manufacturer: "AMD", category: "memory-fpga", expect: "miss", note: "FAMILY datasheet: front matter says Artix-7, never XC7A35T, so namesThePart rejects it" },
  { partNumber: "10M08SAU169", manufacturer: "Intel", category: "memory-fpga", expect: "miss", note: "FAMILY datasheet: front matter says MAX 10, never the ordering number" },
  { partNumber: "A3P250", manufacturer: "Microchip", category: "memory-fpga", expect: "hit", note: "Microchip product page; lands on the Automotive family datasheet, which does name it" }
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
