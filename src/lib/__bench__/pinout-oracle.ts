/**
 * Known-correct pin NAMES, read by a human off the datasheet.
 *
 * ## Why this exists
 *
 * Six shipping parts had wrong pin names and nothing could see it. The benchmark
 * counts fields and bundles; the suite checks synthetic fixtures. Neither asks
 * whether the name on pin 5 of a real part is the name the vendor printed, so an
 * ISO7741 pin 7 called `EN1NAMEISO7740`, an LM358 pin 2 called `IN1–NAMELCCC(1)`
 * and an SN65HVD230 pin 5 called `VNCref` all survived a green suite and a clean
 * benchmark run. They were found by dumping every extracted pinout and reading it
 * against the documents, which is not a thing that happens on a schedule.
 *
 * The name is not cosmetic. It is what the schematic symbol is wired by, so a
 * wrong one is a wrong netlist, and `VNCref` is not a pin anybody can connect.
 *
 * ## The rules for adding an entry
 *
 * Every name here was read off the named page of the actual datasheet by a
 * person. NOT copied from the extractor's own output, which would make this agree
 * with whatever it currently does and measure nothing. If you have not opened the
 * PDF, do not add the entry.
 *
 * Entries are PARTIAL by design: a map of pin number to name, so a part can be
 * pinned for the pins that have been checked without claiming the rest. That is
 * honest about how these were built and it lets an entry grow.
 *
 * `packageType` records which package the names belong to where the document
 * describes several, so the next person can tell whether an entry still applies.
 * It is documentation rather than a second assertion: the check compares names
 * against whatever pinout the extractor settled on, which is the thing a user
 * would receive.
 */

export interface PinoutOracleEntry {
  /** Package the pinout belongs to, where the document describes several. */
  packageType?: string;
  /** Where a person read these names. */
  source: string;
  /** Pin number to name, as printed. Partial is fine. */
  pins: Record<string, string>;
}

/**
 * Compared case-insensitively and ignoring spaces and dash STYLE, because a
 * vendor's `IN1–` (en dash) and `IN1-` (hyphen) are the same pin and a PDF's
 * choice between them is typography rather than data. Everything else must match.
 */
export const PINOUT_ORACLE: Record<string, PinoutOracleEntry> = {
  LM358: {
    packageType: "8-Pin SOIC",
    source: "page 3, Table 4-1 Pin Functions, SOIC column",
    pins: {
      "1": "OUT1", "2": "IN1-", "3": "IN1+", "4": "V-",
      "5": "IN2+", "6": "IN2-", "7": "OUT2", "8": "V+"
    }
  },
  SN65HVD230: {
    source: "page 5, Pin Functions. Pins 5 and 8 carry a second name for the '232, which is a different part.",
    pins: {
      "1": "D", "2": "GND", "3": "VCC", "4": "R",
      "5": "Vref", "6": "CANL", "7": "CANH", "8": "RS"
    }
  },
  UCC27524: {
    source: "page 4, Figure 5-1 and Table 5-1 agreeing",
    pins: {
      "1": "ENA", "2": "INA", "3": "GND", "4": "INB",
      "5": "OUTB", "6": "VDD", "7": "OUTA", "8": "ENB"
    }
  },
  INA240: {
    packageType: "8-pin TSSOP",
    source: "page 3, Table 6-1 Pin Functions, PW (TSSOP) column",
    pins: {
      "1": "NC", "2": "IN+", "3": "IN-", "4": "GND",
      "5": "VS", "6": "REF2", "7": "REF1", "8": "OUT"
    }
  },
  OPA333: {
    source: "page 3, OPA333 D Package 8-Pin SOIC Top View figure",
    pins: {
      "1": "NC", "2": "-IN", "3": "+IN", "4": "V-",
      "5": "NC", "6": "OUT", "7": "V+", "8": "NC"
    }
  },
  ADR4525: {
    packageType: "8-Lead SOIC",
    source: "page 11, Table 9 (8-Lead SOIC). Table 10 on the same page is the LCC and disagrees at pin 3.",
    pins: {
      "1": "NIC", "2": "VIN", "3": "NIC", "4": "GND",
      "5": "NIC", "6": "VOUT", "7": "NIC", "8": "DNC"
    }
  },
  AD8232: {
    source: "page 6, Table 3 Pin Function Descriptions",
    pins: {
      "1": "HPDRIVE", "2": "+IN", "3": "-IN", "4": "RLDFB", "5": "RLD",
      "6": "SW", "7": "OPAMP+", "8": "REFOUT", "9": "OPAMP-", "10": "OUT",
      "11": "LOD-", "12": "LOD+", "13": "SDN", "14": "AC/DC", "15": "FR",
      "16": "GND", "17": "+VS", "18": "REFIN", "19": "IAOUT", "20": "HPSENSE"
    }
  },
  ADG5412: {
    source: "page 9, TSSOP pin configuration figure (left of the two drawn)",
    pins: {
      "1": "IN1", "2": "D1", "3": "S1", "4": "VSS", "5": "GND", "6": "S4",
      "7": "D4", "8": "IN4", "9": "IN3", "10": "D3", "11": "S3", "12": "NC",
      "13": "VDD", "14": "S2", "15": "D2", "16": "IN2"
    }
  },
  RHFL4913: {
    packageType: "FLAT-16P",
    source: "page 3, Table 1 Pin description, FLAT-16P column. Cells hold groups: VO is 1, 2, 6, 7.",
    pins: {
      "1": "VO", "2": "VO", "3": "VI", "4": "VI", "5": "VI", "6": "VO",
      "7": "VO", "8": "ISC", "9": "NC", "10": "OCM", "11": "NC", "12": "NC",
      "13": "GND", "14": "INHIBIT", "15": "NC", "16": "SENSE"
    }
  },
  TLV9061: {
    packageType: "SOT-23",
    source: "page 5, Table 5-1 Pin Functions: TLV9061, SOT-23/SOT-553 column",
    pins: { "1": "OUT", "2": "V-", "3": "IN+", "4": "IN-", "5": "V+" }
  },
  ISO7741: {
    source:
      "page 5, Table 4-1 Pin Functions, ISO7741 column of three. GND1 is 2 and 8, GND2 is 9 and 15, so those cells hold groups.",
    pins: {
      "1": "VCC1", "2": "GND1", "3": "INA", "4": "INB", "5": "INC", "6": "OUTD",
      "7": "EN1", "8": "GND1", "9": "GND2", "10": "EN2", "11": "IND", "12": "OUTC",
      "13": "OUTB", "14": "OUTA", "15": "GND2", "16": "VCC2"
    }
  },
  ADS1115: {
    source: "page 3, Table 4-1 Pin Functions, ADS1115 column of three (the '1113 and '1114 differ)",
    pins: {
      "1": "ADDR", "2": "ALERT/RDY", "3": "GND", "4": "AIN0", "5": "AIN1",
      "6": "AIN2", "7": "AIN3", "8": "VDD", "9": "SDA", "10": "SCL"
    }
  },
  SN74LVC1G08: {
    source:
      "page 3, DSF package figure and the Pin Functions table agreeing. VCC is drawn as V with a CC subscript on the line below.",
    pins: { "1": "A", "2": "B", "3": "GND", "4": "Y", "5": "NC", "6": "VCC" }
  },
  OPA2277: {
    source: "page 4, Table Pin Functions: OPA2277",
    pins: {
      "1": "Out A", "2": "-In A", "3": "+In A", "4": "V-",
      "5": "+In B", "6": "-In B", "7": "Out B", "8": "V+"
    }
  },
  TXB0104: {
    source: "page 3, Pin Functions",
    pins: {
      "1": "VCCA", "2": "A1", "3": "A2", "4": "A3", "5": "A4", "6": "NC",
      "7": "GND", "8": "OE", "9": "NC", "10": "B4", "11": "B3", "12": "B2",
      "13": "B1", "14": "VCCB"
    }
  },
  RHFL4913A: {
    packageType: "Flat-16P",
    source: "page 3, Table 1 Pin description, Flat-16P column. Differs from the RHFL4913 at 15 and 16.",
    pins: {
      "1": "VO", "2": "VO", "3": "VI", "4": "VI", "5": "VI", "6": "VO",
      "7": "VO", "8": "ISC", "9": "NC", "10": "OCM", "11": "NC", "12": "NC",
      "13": "GND", "14": "INHIBIT", "15": "ADJ", "16": "NC"
    }
  },
  MC33063A: {
    source: "page 3, D (SOIC) or P (PDIP) package figure. The labels ARE the full function names.",
    pins: {
      "1": "Switch Collector", "2": "Switch Emitter", "3": "Timing Capacitor",
      "4": "GND", "5": "Comparator Inverting Input", "6": "VCC",
      "7": "Ipk", "8": "Driver Collector"
    }
  },
  ISL71001M: {
    packageType: "64 Ld EP-TQFP",
    // Read off Figure 6 on page 6, which draws the 64-pin part on one page, and so
    // is independent of the Table on pages 6-7 that the extractor reads. The table
    // names the repeated rails generically (`PVINx`, `LXx`, `PGNDx`) where the
    // figure numbers them per block, so only the pins both spell the same way are
    // pinned here.
    source: "page 6, Figure 6 Pin Assignments - Top View (cross-checked against the Pin Descriptions table, pages 6-7)",
    pins: {
      "1": "M/S", "2": "DGND", "3": "DGND", "4": "DGND", "5": "PGOOD", "6": "SS",
      "7": "NC", "8": "DVDD", "9": "DVDD", "10": "DVDD", "11": "DGND", "12": "DGND",
      "13": "DGND", "14": "AGND", "15": "AGND", "16": "NC", "17": "NC", "18": "AVDD",
      "19": "REF", "20": "FB", "21": "EN", "22": "PORSEL", "23": "NC", "32": "NC",
      "33": "NC", "48": "NC", "49": "NC", "64": "SYNC"
    }
  },
  STM32F103C8: {
    packageType: "LQFP48",
    // Read off Table 5 on pages 28-33, LQFP48/UFQFPN48 column. Cross-checked
    // against Figure 8 (the LQFP48 pinout) for the corners. The table prints four
    // packages' numbering side by side with BGA ball designators to the LEFT of
    // the LQFP columns, so the pin NAME is the column to their right.
    source: "pages 28-33, Table 5 Medium-density pin definitions, LQFP48/UFQFPN48 column",
    pins: {
      "1": "VBAT", "2": "PC13-TAMPER-RTC", "3": "PC14-OSC32_IN", "4": "PC15-OSC32_OUT",
      "5": "OSC_IN", "6": "OSC_OUT", "7": "NRST", "8": "VSSA", "9": "VDDA",
      "10": "PA0-WKUP", "11": "PA1", "12": "PA2", "18": "PB0", "19": "PB1", "20": "PB2",
      "23": "VSS_1", "24": "VDD_1", "29": "PA8", "34": "PA13", "35": "VSS_2", "36": "VDD_2",
      "37": "PA14", "44": "BOOT0", "45": "PB8", "46": "PB9", "47": "VSS_3", "48": "VDD_3"
    }
  },
  AD590: {
    packageType: "8-Lead SOIC",
    // The names are the SOIC's and the part declares a 2-lead FLATPACK, which is
    // why the pin COUNT is refused and only the names are pinned here. Page one
    // draws four packages: the 2-lead flatpack (no numbers), the 4-lead LFCSP,
    // the 3-pin TO-52 and this one. All four are the AD590.
    source: "page 1, 8-lead SOIC figure under PIN CONFIGURATIONS (rendered)",
    pins: {
      "1": "NC", "2": "V+", "3": "V-", "4": "NC",
      "5": "NC", "6": "NC", "7": "NC", "8": "NC"
    }
  },
  "LMP7704-SP": {
    packageType: "14-Pin CFP",
    source: "page 3, Table 4-1 Pin Functions (rendered)",
    pins: {
      "1": "OUT A", "2": "IN A-", "3": "IN A+", "4": "V+", "5": "IN B+", "6": "IN B-",
      "7": "OUT B", "8": "OUT C", "9": "IN C-", "10": "IN C+", "11": "V-",
      "12": "IN D+", "13": "IN D-", "14": "OUT D"
    }
  },
  REF5025: {
    packageType: "8-Pin CFP",
    // The page draws the HKJ and the HKQ, and HKQ is a "dead bug" version: it is
    // the same die mirrored, so its numbers run the other way round the outline
    // and every pin still carries the same name. The two agree, which is why the
    // page reads at all.
    source: "page 3, HKJ Package 8-Pin CFP figure and Pin Functions table (rendered)",
    pins: {
      "1": "DNC", "2": "VIN", "3": "TEMP", "4": "GND",
      "5": "TRIM/NR", "6": "VOUT", "7": "NC", "8": "DNC"
    }
  },
  "TPS7A4501-SP": {
    packageType: "10-Pin CFP",
    // Read off the U package figure. Pin 9 is `SENSE/ADJ` on both figures and
    // plain `ADJ` in the table below them; the figure is what this reads.
    source: "page 3, U Package 10-Pin CFP figure (rendered)",
    pins: {
      "1": "SHDN", "2": "IN", "3": "IN", "4": "IN", "5": "NC",
      "6": "OUT", "7": "OUT", "8": "OUT", "9": "SENSE/ADJ", "10": "GND"
    }
  },
  "ADC128S102QML-SP": {
    packageType: "16-Pin CFP",
    source: "page 4, NAC Package 16-Pin CFP figure, cross-checked against the Pin Functions table (rendered)",
    pins: {
      "1": "CS", "2": "VA", "3": "AGND", "4": "IN0", "5": "IN1", "6": "IN2", "7": "IN3",
      "8": "IN4", "9": "IN5", "10": "IN6", "11": "IN7", "12": "DGND", "13": "VD",
      "14": "DIN", "15": "DOUT", "16": "SCLK"
    }
  },
  AD8628: {
    packageType: "5-Lead TSOT-23",
    // The page draws the 5-lead TSOT/SOT-23 and the 8-lead SOIC, and they are
    // different pinouts of the same part. This entry is the FIVE-lead one, which
    // is the package the front matter declares; the SOIC reads 1 NC, 2 -IN,
    // 3 +IN, 4 V-, 5 NC, 6 OUT, 7 V+, 8 NC and was verified at the same time.
    //
    // The five-lead figure is ASYMMETRIC, three leads down one side and two down
    // the other, so it is the reason `readAsymmetricFigure` exists.
    source: "page 1, 5-Lead TSOT-23 (UJ-5) / 5-Lead SOT-23 (RT-5) figure (rendered)",
    pins: { "1": "OUT", "2": "V-", "3": "+IN", "4": "-IN", "5": "V+" }
  },
  RHF310A: {
    packageType: "ceramic Flat-8",
    // NOT currently read, and this entry records why rather than what we emit.
    // Pin 4 is printed `VCC-`; the text layer hands the run over as `"-VCC"` with
    // a NEGATIVE advance, meaning the glyphs were positioned right to left and
    // the string is not the printed order. The reader now refuses that run rather
    // than emit a pin nobody can connect, so this part reports no pins at all.
    // See `hasPrintedOrder` in pdftext.ts. Kept so the day it is recovered, it is
    // recovered correctly.
    source: "page 2, Figure 1 Pin connections of ceramic Flat-8 (rendered at 8x)",
    pins: {
      "1": "NC", "2": "IN-", "3": "IN+", "4": "VCC-",
      "5": "NC", "6": "OUT", "7": "+VCC", "8": "NC"
    }
  },
  STM32F407VG: {
    packageType: "LQFP100",
    // Read off a RENDER of Figure 13, which is a FOUR-SIDED figure: 1..25 down
    // the left, 26..50 across the bottom, 51..75 up the right and 76..100 back
    // across the top. Both horizontal rows are set ROTATED, and those are the
    // entries that matter here, because nothing about a rotated run's reported
    // width says where it sits on the page.
    //
    // Pin 70 is the other one to keep: the figure prints it `PA 11`, with a
    // space, between `PA10` and `PA12` that have none.
    source: "page 44, Figure 13 STM32F40xxx LQFP100 pinout (rendered)",
    pins: {
      "1": "PE2", "6": "VBAT", "10": "VSS", "12": "PH0", "14": "NRST",
      "20": "VSSA", "21": "VREF+", "25": "PA2", "26": "PA3", "27": "VSS",
      "49": "VCAP_1", "50": "VDD", "51": "PB12", "67": "PA8", "70": "PA11",
      "73": "VCAP_2", "75": "VDD", "76": "PA14", "88": "PD7", "94": "BOOT0",
      "97": "PE0", "98": "PE1", "99": "VSS", "100": "VDD"
    }
  },
  STM32H743ZI: {
    packageType: "LQFP144",
    // Read off a RENDER of Figure 7. Same four-sided shape as the F407 above,
    // with two differences that are the reason this entry exists: the LEFT
    // column arrives with each name and its number MERGED into one run
    // (`PE2   1`), and the whole BOTTOM row arrives as a single run of
    // thirty-six space-separated numbers, so both edges are recovered rather
    // than read. Pins 1, 36, 37 and 72 are the corners of those two edges.
    source: "page 57, Figure 7 LQFP144 pinout (rendered)",
    pins: {
      "1": "PE2", "6": "VBAT", "8": "PC14-OSC32_IN", "9": "PC15-OSC32_OUT",
      "16": "VSS", "23": "PH0-OSC_IN", "24": "PH1-OSC_OUT", "25": "NRST",
      "28": "PC2_C", "29": "PC3_C", "32": "VREF+", "36": "PA2", "37": "PA3",
      "49": "PF11", "56": "PG0", "71": "VCAP", "72": "VDD", "73": "PB12",
      "95": "VDD33USB", "106": "VCAP", "108": "VDD", "109": "PA14",
      "132": "PG15", "138": "BOOT0", "143": "PDR_ON", "144": "VDD"
    }
  },
  RHF1201: {
    packageType: "SO48",
    // Read off a RENDER of the page, which is the only way to see the thing that
    // matters here: pins 4, 5, 20 and 21 have an EMPTY name cell with `NC` in the
    // description column, and the text layer cannot show which column a run sits
    // in. Pins 3, 4, 5 and 7 additionally arrive with their number GLUED to the
    // cell beside it (`3VCCBE`), so those four are the un-gluing's own check.
    source: "page 6, Table 2 Pin descriptions, both blocks (rendered)",
    pins: {
      "1": "GNDBI", "2": "GNDBE", "3": "VCCBE", "4": "NC", "5": "NC", "6": "OR",
      "7": "D11(MSB)", "8": "D10", "18": "D0(LSB)", "19": "DR", "20": "NC", "21": "NC",
      "22": "VCCBE", "23": "GNDBE", "24": "VCCBI", "25": "SRC", "26": "OEB", "27": "DFSB",
      "31": "IPOL", "32": "VREFP", "33": "VREFM", "35": "VIN", "37": "VINB", "39": "INCM",
      "46": "CLK", "48": "DGND"
    }
  },
  MSP430F5529: {
    packageType: "LQFP (80)",
    // Read off the FIGURE rather than off the table the extractor reads, which
    // makes this an independent check rather than a restatement: Table 7-1 runs
    // across pages 16 to 20 and prints four packages' numbering side by side,
    // while Figure 7-1 draws the 80-pin PN package on one page. Both agree.
    source: "page 10, Figure 7-1, 80-pin PN package pinout (cross-checked against Table 7-1, pages 16-20, PN column)",
    pins: {
      "1": "P6.4/CB4/A4", "2": "P6.5/CB5/A5", "3": "P6.6/CB6/A6", "4": "P6.7/CB7/A7",
      "5": "P7.0/CB8/A12", "8": "P7.3/CB11/A15", "9": "P5.0/A8/VREF+/VeREF+",
      "10": "P5.1/A9/VREF-/VeREF-", "11": "AVCC1", "12": "P5.4/XIN", "13": "P5.5/XOUT",
      "14": "AVSS1", "47": "P4.2/PM_UCB1SOMI/PM_UCB1SCL", "48": "P4.3/PM_UCB1CLK/PM_UCA1STE",
      "49": "DVSS2", "50": "DVCC2", "53": "P4.6/PM_NONE", "54": "P4.7/PM_NONE",
      "60": "P7.7/TB0CLK/MCLK", "61": "VSSU", "62": "PU.0/DP", "63": "PUR", "64": "PU.1/DM",
      "65": "VBUS", "66": "VUSB", "67": "V18", "68": "AVSS2", "69": "P5.2/XT2IN",
      "70": "P5.3/XT2OUT", "71": "TEST/SBWTCK", "72": "PJ.0/TDO", "73": "PJ.1/TDI/TCLK",
      "74": "PJ.2/TMS", "75": "PJ.3/TCK", "76": "RST/NMI/SBWTDIO", "77": "P6.0/CB0/A0",
      "78": "P6.1/CB1/A1", "79": "P6.2/CB2/A2", "80": "P6.3/CB3/A3"
    }
  },
  DRV8825: {
    packageType: "HTSSOP (28)",
    // Read off a coordinate dump of the two pages, pairing each name with the
    // number on its own baseline by eye, before any reader returned a pinout for
    // this part. Weaker independence than the entries checked against a FIGURE,
    // and it is stated rather than glossed: the pinout figure on page 3 is drawn
    // as artwork with no text inside it, so there is no second rendering of these
    // names in the document to check against.
    //
    // Pin 14 and pin 28 are both GND, printed as the single cell `GND | 14, 28`.
    // That cell is why this table needed a reader that counts a column in pins
    // rather than in cells.
    source: "pages 3-4, Pin Functions and Pin Functions (continued), NAME and NO. columns",
    pins: {
      "1": "CP1", "2": "CP2", "3": "VCP", "4": "VMA", "5": "AOUT1", "6": "ISENA",
      "7": "AOUT2", "8": "BOUT2", "9": "ISENB", "10": "BOUT1", "11": "VMB",
      "12": "AVREF", "13": "BVREF", "14": "GND", "15": "V3P3OUT", "16": "nRESET",
      "17": "nSLEEP", "18": "nFAULT", "19": "DECAY", "20": "DIR", "21": "nENBL",
      "22": "STEP", "23": "NC", "24": "MODE0", "25": "MODE1", "26": "MODE2",
      "27": "nHOME", "28": "GND"
    }
  }
};

/** Normalised for comparison: case, spacing and dash style are typography. */
export function normalizePinName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, "");
}

export interface NameMismatch {
  pin: string;
  got: string;
  want: string;
}

/** Every oracle pin whose extracted name disagrees. */
export function checkPinNames(
  entry: PinoutOracleEntry,
  pins: { number: string; name: string }[]
): NameMismatch[] {
  const byNumber = new Map(pins.map((pin) => [String(pin.number), pin.name]));
  const wrong: NameMismatch[] = [];

  for (const [number, want] of Object.entries(entry.pins)) {
    const got = byNumber.get(number);
    if (got === undefined) {
      wrong.push({ pin: number, got: "(absent)", want });
      continue;
    }
    if (normalizePinName(got) !== normalizePinName(want)) wrong.push({ pin: number, got, want });
  }

  return wrong;
}

/**
 * The package families each datasheet actually describes, read by a human.
 *
 * ## Why this exists
 *
 * Designator accuracy has been quoted at 56% and 62% in this project's own
 * documents, and used to argue that characterising a new land-pattern family is a
 * correctness risk. Neither figure measured accuracy. `bench:extraction` scores
 * the package group by whether `packageType`, `pinCount` and `pins` are non-null,
 * which is a FILL RATE: it cannot tell a right designator from a wrong one, and
 * nothing else ever looked.
 *
 * That matters more here than for most fields, because the designator is what
 * selects the land pattern. A wrong one does not fail; it produces a plausible
 * footprint with the wrong dimensions.
 *
 * ## What an entry means
 *
 * `families` lists every package the DOCUMENT describes for this part, read off
 * its Device Information table, ordering guide or package section. The extracted
 * designator is correct when it names one of them: most of these datasheets cover
 * several packages, so naming one is the honest answer and choosing between them
 * is the caller's job. An extracted designator naming a family NOT in this list is
 * an error, and that is the number worth having.
 *
 * `ceramic` marks a part whose package is hermetic. It is separate because the
 * word is load-bearing rather than descriptive: `packages.ts` refuses a ceramic
 * part the plastic JEDEC families by testing the designator string for it, so a
 * designator that drops the word silently drops the guard.
 */
export interface PackageOracleEntry {
  families: string[];
  ceramic?: boolean;
  source: string;
}

export const PACKAGE_ORACLE: Record<string, PackageOracleEntry> = {
  // The eight that ship a bundle today. A wrong designator on any of these puts
  // wrong copper on a board right now, so they were read first.
  ADR4525: { families: ["SOIC", "LCC"], source: "p41 ordering guide (8-Lead SOIC, R-8); LCC E-8-1 in outline dimensions" },
  INA240: { families: ["TSSOP", "SOIC"], source: "p1 Device Information: TSSOP (8), SOIC (8)" },
  ISO7741: { families: ["SOIC", "SSOP"], source: "p1: SOIC (DW) 10.30 x 7.50 wide body, and DBQ SSOP" },
  LM358: { families: ["SOIC", "TSSOP", "VSSOP", "PDIP"], source: "p1: D (SOIC,8), PW (TSSOP), DGK (VSSOP), P (PDIP,8)" },
  MC33063A: { families: ["SOIC", "SON"], source: "p1 Device Information: SOIC (8), SON (8)" },
  OPA333: { families: ["SOT-23", "SOT", "SOIC", "VSON"], source: "p1 Device Information: SOT-23 (5), SOT (5), SOIC (8), VSON (8)" },
  SN65HVD230: { families: ["SOIC"], source: "p1 Device Information: SOIC (8). The only package, so this one is unambiguous." },
  UCC27524: { families: ["SOIC", "HVSSOP", "WSON"], source: "p1 Device Information: D (SOIC 8)" },

  // Read after `HTSSOP` was added to the designator vocabulary, which is what
  // took this part from naming NO package to naming its own. Both statements in
  // the document agree, which is why one entry can carry it.
  DRV8825: {
    families: ["HTSSOP"],
    source:
      "p1 Device Information: DRV8825 | HTSSOP (28) | 9.70 mm x 6.40 mm, corroborated by the PACKAGE OPTION ADDENDUM: DRV8825PWPR, HTSSOP (PWP) | 28"
  },

  // Field-complete and refused at the generator. A wrong designator here is what
  // would ship the moment its family is characterised.
  ADS1115: { families: ["X2QFN", "SOT", "VSSOP"], source: "p4 Thermal Information: RUG (X2QFN), DYN (SOT), DGS (VSSOP), all 10-pin" },
  AD8232: { families: ["LFCSP"], source: "p1: 20-lead 4mm x 4mm LFCSP" },
  ADG5412: { families: ["TSSOP", "LFCSP"], source: "p8: 16-Lead TSSOP, 16-Lead LFCSP" },
  OPA2277: { families: ["SOIC", "VSON"], source: "p1 Device Information: D (SOIC, 8), DRM (VSON, 8). VSON is REAL here; DEFERRED.md called it a misread." },
  TLV9061: { families: ["SOT-23", "SC70", "X2SON"], source: "p1 Device Information: DBV (SOT-23, 5), DCK (SC70, 5)" },
  SN74LVC1G08: { families: ["SOT-23", "SC70", "SON"], source: "p1 Device Information: SOT-23 (5); DSF (SON-6) figure on p3" },
  TXB0104: { families: ["TSSOP", "SOIC", "QFN", "BGA"], source: "p1/p3 package list" },
  MSP430F5529: { families: ["LQFP", "QFN", "BGA"], source: "p104 ordering scheme (T=LQFP) and Figure 7-1, 80-pin PN" },
  ISL71001M: { families: ["TQFP"], ceramic: false, source: "p32: 64 EP-TQFP, Q64.10x10J" },
  RHF1201: { families: ["SO"], ceramic: true, source: "p1: 'Ceramic SO48 package'" },
  STM32F103C8: { families: ["LQFP", "UFQFPN", "LFBGA", "UFBGA", "VFQFPN", "TFBGA"], source: "p104 ordering scheme (T=LQFP, U=VFQFPN/UFQFPN, H=BGA, I=UFBGA) and the Table 5 column headings" },
  STM32F407VG: { families: ["LQFP", "UFBGA", "WLCSP"], source: "p186 ordering scheme, Package: T=LQFP, H=UFBGA, Y=WLCSP; figures 12-17 draw LQFP64/100/144/176, UFBGA176, WLCSP90" },
  STM32H743ZI: { families: ["LQFP", "UFBGA", "TFBGA"], source: "p346 ordering scheme, Package: T=LQFP, K/I=UFBGA, H=TFBGA; figures 5-12 draw LQFP100/144/176/208 and the BGAs" },
  RHFL4913: { families: ["FLAT", "SMD", "TO"], ceramic: true, source: "p2: FLAT-16P, SMD.5, TO-257" },
  "ADC128S102QML-SP": { families: ["SOIC", "CFP"], ceramic: true, source: "p1: 'Packaged in 16-Lead Ceramic SOIC'; CFP on p2" },

  // The four waiting on a formed lead span, all ceramic flat packs.
  "LMP7704-SP": { families: ["CFP"], ceramic: true, source: "p3: '14-Pin CFP'" },
  REF5025: { families: ["CFP"], ceramic: true, source: "p1 Device Information: CFP (HKJ)(8), 6.9 x 5.65 mm" },
  "TPS7A4501-SP": { families: ["CFP"], ceramic: true, source: "p1 Device Information, ceramic" },
  RHF310A: { families: ["FLAT"], ceramic: true, source: "p2: 'ceramic Flat-8'" }
};

/**
 * Whether an extracted designator names one of the families the document
 * describes. Compared on letters and digits only, so `SOT-23` and `SOT23` agree.
 */
export function checkPackageFamily(
  entry: PackageOracleEntry,
  designator: string
): { ok: boolean; ceramicLost: boolean } {
  const flat = designator.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return {
    ok: entry.families.some((family) => flat.includes(family.toUpperCase().replace(/[^A-Z0-9]/g, ""))),
    // The guard in packages.ts reads this word off the designator, so losing it
    // is a defect — but ONLY where the family name does not already imply it. A
    // `CFP` is a ceramic flat pack by definition and there is no plastic family
    // of that name to be confused with, so `14-lead CFP` has lost nothing. The
    // case that matters is a family name shared with a plastic package: RHF1201's
    // `Ceramic SO48` reduced to `SO48` is one characterised family away from
    // taking plastic geometry on a hermetic part.
    ceramicLost: entry.ceramic === true && !CERAMIC_BY_NAME.test(designator)
  };
}

/**
 * Package names that are ceramic by definition, so the word `ceramic` adds
 * nothing to them. Everything else shares its name with a plastic family.
 */
const CERAMIC_BY_NAME =
  /\b(?:CERAMIC|HERMETIC|CFP|CDFP|CQFP|CDIP|GDIP|CBGA|CLCC|LCCC|FLATPACK|FLAT-?\d{1,3}[A-Za-z]?)\b/i;
