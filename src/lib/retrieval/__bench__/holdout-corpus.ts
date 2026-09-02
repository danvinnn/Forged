// The RETRIEVAL hold-out corpus, as data.
//
// Air-gap safety: pure data, no network, no imports that reach the network.
//
// ## Why this exists
//
// `BENCH_CORPUS` cannot measure retrieval any more. Every vendor pattern in the registry was added
// to fix a specific miss IN THAT LIST: onsemi went in because NCP1200 missed, Molex because
// 43045-0400 missed, Microchip's product page because ATMEGA328P missed. So its 95% does not say
// how often a stranger's part number resolves. It says how well eighty parts were fitted, and it
// will keep going up as long as anyone keeps fitting them.
//
// This project has already paid for that lesson once. The extraction bench read 69% on its tuned
// corpus and 49% on its hold-out: twenty points of illusion, invisible until an unseen set existed.
// Retrieval had never been measured that way at all.
//
// ## How these parts were chosen
//
// Written down BEFORE any of them was looked up, and deliberately NOT restricted to vendors the
// registry supports. That restriction is what would make the number circular: the registry's
// vendors are exactly the ones the tuned corpus taught us to add, so sampling only those would
// measure the registry against itself.
//
// The sample mirrors `BENCH_CORPUS`'s eight categories at roughly its proportions, spans vendors
// that are in the registry and vendors that are not, and mixes parts an engineer types every week
// with parts almost nobody does.
//
// Public, non-controlled parts only, the same rule `test-data/` follows.
//
// ## The rule that makes the number mean anything
//
// **Nothing here may ever be tuned against.** Do not look up why a hold-out part missed and then
// add the vendor pattern that would have caught it. The moment you do, this becomes a second
// training set and the project loses the only honest retrieval signal it has.
//
// If a hold-out miss needs diagnosing, the finding is the CLASS of failure, not the part: fix the
// class, re-measure, and if a specific part had to be examined to get there, MOVE it into
// `BENCH_CORPUS` and add a replacement here.
//
// ONE EXCEPTION, because it is a bug in the instrument rather than the product: if a part number
// here turns out not to exist or to be misspelled, that is a corpus defect. Correcting it is
// legitimate and should be noted on the line. A wrong part number scores as a miss and would
// understate coverage, which is the opposite of the bias this file guards against.

import type { BenchCategory } from "./corpus";

export interface HoldoutPart {
  partNumber: string;
  manufacturer: string;
  category: BenchCategory;
  note?: string;
}

export const RETRIEVAL_HOLDOUT: HoldoutPart[] = [
  // --- rad-hard from vendors with derivable patterns ---------------------------------------------
  { partNumber: "TPS7H1101A-SP", manufacturer: "Texas Instruments", category: "radhard-major" },
  { partNumber: "TPS7H4001-SP", manufacturer: "Texas Instruments", category: "radhard-major" },
  { partNumber: "SN55HVD233-SEP", manufacturer: "Texas Instruments", category: "radhard-major" },
  { partNumber: "LM4050QML-SP", manufacturer: "Texas Instruments", category: "radhard-major" },
  { partNumber: "RHF310", manufacturer: "STMicroelectronics", category: "radhard-major" },
  { partNumber: "ISL70444SEH", manufacturer: "Renesas", category: "radhard-major" },
  { partNumber: "ISL71090SEH", manufacturer: "Renesas", category: "radhard-major" },

  // --- rad-hard from pure-play houses -----------------------------------------------------------
  // The tuned corpus resolves all six of these through distributor and vendor-hosted copies found
  // by search. Whether that generalises to specialist parts NOBODY fitted is the open question.
  { partNumber: "VA10800", manufacturer: "VORAGO", category: "radhard-specialist" },
  { partNumber: "VA41620", manufacturer: "VORAGO", category: "radhard-specialist" },
  { partNumber: "UT699", manufacturer: "CAES", category: "radhard-specialist" },
  { partNumber: "UT700", manufacturer: "CAES", category: "radhard-specialist" },
  { partNumber: "EV12AQ600", manufacturer: "Teledyne e2v", category: "radhard-specialist" },

  // --- mainstream analog and mixed-signal -------------------------------------------------------
  { partNumber: "OPA2333", manufacturer: "Texas Instruments", category: "analog" },
  { partNumber: "TLV9061", manufacturer: "Texas Instruments", category: "analog" },
  { partNumber: "INA240", manufacturer: "Texas Instruments", category: "analog" },
  { partNumber: "ADS131M04", manufacturer: "Texas Instruments", category: "analog" },
  { partNumber: "REF5025", manufacturer: "Texas Instruments", category: "analog" },
  { partNumber: "OPA1656", manufacturer: "Texas Instruments", category: "analog" },
  { partNumber: "LTC2057", manufacturer: "Analog Devices", category: "analog" },
  { partNumber: "AD8221", manufacturer: "Analog Devices", category: "analog" },
  { partNumber: "ADA4522-2", manufacturer: "Analog Devices", category: "analog" },
  // Legacy Linear naming, which files as `1150fc.pdf` rather than under the part number.
  { partNumber: "LTC1150", manufacturer: "Analog Devices", category: "analog" },
  { partNumber: "MAX4238", manufacturer: "Analog Devices", category: "analog" },
  { partNumber: "MCP6001", manufacturer: "Microchip", category: "analog" },
  { partNumber: "MCP3421", manufacturer: "Microchip", category: "analog" },
  { partNumber: "TSV991", manufacturer: "STMicroelectronics", category: "analog" },
  { partNumber: "NCS20071", manufacturer: "onsemi", category: "analog" },
  { partNumber: "TLV431", manufacturer: "Texas Instruments", category: "analog" },

  // --- microcontrollers -------------------------------------------------------------------------
  { partNumber: "STM32G071RB", manufacturer: "STMicroelectronics", category: "mcu" },
  { partNumber: "STM32L476RG", manufacturer: "STMicroelectronics", category: "mcu" },
  { partNumber: "ATSAMD21G18", manufacturer: "Microchip", category: "mcu" },
  { partNumber: "PIC32MX250F128B", manufacturer: "Microchip", category: "mcu" },
  { partNumber: "MSP430FR2433", manufacturer: "Texas Instruments", category: "mcu" },
  { partNumber: "RP2350", manufacturer: "Raspberry Pi", category: "mcu" },
  { partNumber: "ESP32-C3-MINI-1", manufacturer: "Espressif", category: "mcu" },
  { partNumber: "NRF9160", manufacturer: "Nordic", category: "mcu" },

  // --- power and discretes ----------------------------------------------------------------------
  { partNumber: "TPS62840", manufacturer: "Texas Instruments", category: "power-discrete" },
  { partNumber: "LM5164", manufacturer: "Texas Instruments", category: "power-discrete" },
  { partNumber: "CSD18540Q5B", manufacturer: "Texas Instruments", category: "power-discrete" },
  // Vendors deliberately absent from the registry, so this category is not a lap of honour.
  { partNumber: "MP2307", manufacturer: "Monolithic Power Systems", category: "power-discrete" },
  { partNumber: "AOZ1284", manufacturer: "Alpha and Omega Semiconductor", category: "power-discrete" },
  { partNumber: "IRLZ44N", manufacturer: "Infineon", category: "power-discrete" },
  { partNumber: "NCV8402", manufacturer: "onsemi", category: "power-discrete" },
  { partNumber: "BC547", manufacturer: "onsemi", category: "power-discrete" },
  { partNumber: "SS14", manufacturer: "Vishay", category: "power-discrete" },

  // --- logic and interface ----------------------------------------------------------------------
  { partNumber: "SN74LVC245A", manufacturer: "Texas Instruments", category: "logic-interface" },
  { partNumber: "74AHC1G14", manufacturer: "Nexperia", category: "logic-interface" },
  { partNumber: "MAX3232", manufacturer: "Analog Devices", category: "logic-interface" },
  { partNumber: "ADM3251E", manufacturer: "Analog Devices", category: "logic-interface" },
  { partNumber: "SP3485", manufacturer: "MaxLinear", category: "logic-interface" },
  { partNumber: "CP2102N", manufacturer: "Silicon Labs", category: "logic-interface" },

  // --- connectors -------------------------------------------------------------------------------
  // The category where a generated footprint is worth the most, and where the tuned corpus went
  // from 0 to 5 of 6 purely because patterns were added for its exact parts.
  { partNumber: "53398-0271", manufacturer: "Molex", category: "connector" },
  { partNumber: "87832-1420", manufacturer: "Molex", category: "connector" },
  { partNumber: "B2B-PH-K-S", manufacturer: "JST", category: "connector" },
  { partNumber: "FH12-40S-0.5SH", manufacturer: "Hirose", category: "connector" },
  { partNumber: "20021121-00010T4LF", manufacturer: "Amphenol", category: "connector" },
  { partNumber: "TSW-110-07-G-S", manufacturer: "Samtec", category: "connector" },

  // --- memory and programmable ------------------------------------------------------------------
  { partNumber: "W25Q32JV", manufacturer: "Winbond", category: "memory-fpga" },
  { partNumber: "IS42S16400J", manufacturer: "ISSI", category: "memory-fpga" },
  { partNumber: "MT25QL128ABA", manufacturer: "Micron", category: "memory-fpga" },
  { partNumber: "LFE5U-25F", manufacturer: "Lattice", category: "memory-fpga" },
  { partNumber: "XC6SLX9", manufacturer: "AMD", category: "memory-fpga" }
];
