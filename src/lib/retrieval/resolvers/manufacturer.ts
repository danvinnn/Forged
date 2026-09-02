// Manufacturer-direct resolver: construct the datasheet URL from the part number and fetch it
// straight from the vendor.
//
// NETWORK MODULE. Only ever loaded through the commercial branch of makeResolver. Never imported
// in air-gapped mode.
//
// Why this exists and why it runs first:
//   - No credentials, no quota, no third-party search engine. The TI demo path works on a fresh
//     checkout with an empty .env.
//   - It is deterministic. One or two HTTP GETs against a known URL, versus the scrape resolver's
//     DuckDuckGo crawl, which is brittle and rate-limit prone.
//   - The manufacturer is the authoritative source. A distributor or aggregator copy can be stale;
//     ti.com serves the current revision.
//
// VERIFICATION RULE, non-negotiable: a pattern goes in this registry only after someone has
// actually fetched a real datasheet through it and confirmed it returns a PDF with no login and no
// interstitial. Inventing a plausible-looking URL pattern is the same failure mode ARCHITECTURE.md
// forbids when it says never let a model "find" a datasheet URL, just relocated into code. A dead
// pattern here costs a wasted round trip on every lookup and erodes trust in the citation story.
//
// COVERAGE REALITY, corrected 2026-09-01 by fetching every pattern below through Node's `fetch`.
// It is vendor by vendor, not "rad-hard is impossible" and not "doc-number vendors are impossible":
//
//   DERIVABLE from the part number. Each verified by fetching a real datasheet, see each entry.
//     TI, ST, ADI, onsemi, NXP, Diodes, Espressif, Raspberry Pi, Renesas, Molex, TE, Amphenol.
//
//   NOT derivable, but the vendor's PRODUCT PAGE is. Microchip files datasheets under document
//     numbers (`39582C.pdf`), so no part-number pattern can reach them, but
//     `microchip.com/en-us/product/{PART}` is derivable and carries the link. Those go in
//     `productUrls`, which the scrape resolver harvests. See `productUrls` below.
//
//   NEITHER derivable. Infineon's filename carries a version (`Infineon-IRF540N-DataSheet-v01_01-EN
//     .pdf`) and its product page is category-pathed; Vishay is the same shape. Those stay uploads.
//
// TWO EARLIER CLAIMS IN THIS HEADER WERE WRONG and are corrected rather than quietly edited:
//
//   1. "VORAGO, CAES/Cobham, Teledyne e2v and Honeywell cannot be resolved, do not try." The live
//      coverage bench resolves all six `radhard-specialist` parts, through distributor-hosted and
//      vendor-hosted copies the scrape resolver already finds. The advice to not add GUESSED
//      patterns for them stands. The claim that they are unreachable does not.
//
//   2. "Microchip, Vishay and Infineon are not derivable, so they must not be added." True of the
//      datasheet filename, false as a conclusion: a product page is a candidate too, and one of
//      those three is reachable that way.
//
// A NOTE ON MEASURING THIS. Probing these patterns with curl reports blocks that do not exist:
// vendor CDNs fingerprint curl's TLS handshake, and ST, ADI, onsemi and Microchip all refuse it
// while answering Node's `fetch` normally. Verify a pattern through the same client the product
// uses, or the measurement is fiction.

import type { DatasheetRef, DatasheetResolver, ResolveOptions } from "../resolver";
import { finalizeRef } from "../ref";
import { PdfValidationError } from "../pdf";
import { ResolverError } from "./errors";
import { fetchWithTimeout, readBodyWithLimit, DOWNLOAD_TIMEOUT_MS } from "./http";
import { buildPartVariants, normalizePartNumber } from "../partnumber";
import { documentNamesPart } from "../identity";
import { logger } from "../logging";

const RESOLVER_NAME = "manufacturer";

/**
 * Ceiling on the speculative tier, which is fetched in PARALLEL.
 *
 * SWEPT, not argued for. It was first set to 24 with a paragraph of reasoning calling it a
 * backstop, and a sweep over all 142 part numbers in the two retrieval corpora showed it was
 * nothing of the kind: the real maximum is 27 and 24 was CLIPPING 13 of 142 parts. Prose had said
 * "backstop" while the behaviour was "silently drops three candidates on 9% of lookups", which is
 * the failure this project keeps writing down.
 *
 * 40 leaves headroom for several more vendors before it binds again, and still bounds a runaway.
 * Re-sweep after adding vendors: if the observed max reaches this, raise it deliberately rather
 * than letting it start clipping.
 *
 * The tier is worth bounding but NOT worth shrinking. Measured on the same sweep: 40 of the 142
 * parts have no claiming vendor at all, so for 28% of them speculation is the only path the
 * manufacturer resolver has. Vendors already decline to guess where their URL shape cannot apply
 * (see `urls` on VendorPattern), which is what keeps the tier from being nonsense rather than
 * merely large.
 */
const MAX_SPECULATIVE = 40;

interface VendorPattern {
  vendor: string;
  // True when this vendor plausibly owns the part, from the manufacturer hint or the part prefix.
  claims(part: string, manufacturer?: string): boolean;
  // Candidate URLs in priority order, most likely first.
  //
  // Returns EMPTY for a variant this vendor's URL shape cannot apply to. That is what keeps the
  // speculative tier honest: a connector vendor whose paths are built from digits has nothing to
  // say about `LM358`, and returning a garbage URL there costs a real outbound request on every
  // lookup of every part. A vendor declining to guess is the vendor's own knowledge, so it lives
  // in the vendor's own entry rather than in a flag some caller has to remember to read.
  urls(partVariant: string): string[];
  // The vendor's own product page for this part, when it is derivable.
  //
  // For vendors that file datasheets under a DOCUMENT NUMBER there is no part-number pattern to
  // find, but the product page is often still derivable and carries the link. These are handed to
  // the scrape resolver, which already knows how to fetch a page, harvest its PDF links, rank them
  // and try the best. They are deliberately NOT used by this resolver: a product page is HTML, and
  // this resolver's contract is an exact URL that is either a PDF or a miss.
  productUrls?(partVariant: string): string[];
}

// Digits only, for the connector vendors whose paths are built from the numeric part number.
// `43045-0400` and `0022232021` are both real Molex orderable numbers and both resolve.
function digitsOnly(part: string): string {
  return part.replace(/\D/g, "");
}

/**
 * A JST-style connector ordering number: housing, then SERIES, then option codes.
 *
 * `S2B-PH-K-S`, `B4B-XH-A`, `B2B-EH-A`.
 *
 * THE TRAILING SECTIONS MUST BE ALPHABETIC, and that is not decoration. An earlier version ended
 * `[A-Z0-9-]+$`, which matched `ESP32-WROOM-32`: `ESP` + `32` + `-WROOM-` + `32`. So every lookup
 * of an Espressif module also asked jst-mfg.com for `eWROOM.pdf`. Nothing broke, because Espressif
 * claims the part too and the %PDF check discards the 404, but a rule whose wording says "JST" and
 * whose behaviour says "Espressif modules as well" is exactly what RULES.md rule 4 forbids.
 *
 * JST's option and plating codes are letters (`-K-S`, `-A`, `-TB`) while a module suffix like
 * `-WROOM-32` ends in digits, so requiring letters separates them on a real property of the
 * numbering rather than on a special case. Verified against the four JST parts probed on
 * 2026-09-02 and against all 142 part numbers in the two retrieval corpora, where it now claims
 * nothing outside its own vendor.
 */
const JST_SHAPE = /^[A-Z]{1,3}\d{1,2}[A-Z]{0,3}-[A-Z]{2,5}(-[A-Z]{1,3})+$/;

// Matching a manufacturer hint has a trap in it that the coverage benchmark caught: a substring
// test on a SHORT alias produces absurd false positives. "ti" is a substring of "TE Connectivity"
// (connec-TI-vity), so a Molex-style connector part was being claimed by Texas Instruments and
// sent to ti.com. "st" is worse, appearing in "Toshiba"-adjacent names and many others.
//
// So: long, distinctive names may match as substrings, because "texas instruments inc." should
// match "texas instruments". Short aliases must match the WHOLE string, after stripping trailing
// corporate suffixes.
const CORPORATE_SUFFIX = /\s*(,?\s*(inc|inc\.|corp|corp\.|corporation|ltd|ltd\.|llc|gmbh|semiconductor|semiconductors|technologies|technology))+$/i;

function normalizeManufacturer(value: string): string {
  return value.trim().toLowerCase().replace(CORPORATE_SUFFIX, "").trim();
}

function manufacturerMatches(
  manufacturer: string | undefined,
  opts: { names: string[]; aliases?: string[] }
): boolean {
  if (!manufacturer) return false;
  const normalized = normalizeManufacturer(manufacturer);
  if (opts.aliases?.some((alias) => normalized === alias)) return true;
  return opts.names.some((name) => normalized === name || normalized.includes(name));
}

const VENDORS: VendorPattern[] = [
  {
    // VERIFIED 2026-07-22: fetched https://www.ti.com/lit/ds/symlink/lmp7704-sp.pdf and got the
    // real LMP7704-SP datasheet (SNOSDB6D Rev D). Direct PDF, no login, no interstitial.
    vendor: "texas-instruments",
    claims(part, manufacturer) {
      if (
        manufacturerMatches(manufacturer, {
          names: ["texas instruments", "burr-brown", "national semiconductor"],
          aliases: ["ti"]
        })
      ) {
        return true;
      }
      // TI prefixes weighted toward the analog, power, and hi-rel catalog. Conservative on purpose:
      // a false positive costs one 404, but a greedy regex would fire on every part typed.
      return /^(LM|LMP|LMH|LMV|LMK|INA|OPA|THS|TPS|TPA|TLV|TLC|TL|SN|SNJ|ADS|DAC|ADC|UCC|UCD|CD|REF|BQ|CSD|ISO|TMP|TCA|PCA|TXB|TXS|LP|TPD|TPL|MSP)\d/i.test(part);
    },
    urls(part) {
      const lower = part.toLowerCase();
      return [
        `https://www.ti.com/lit/ds/symlink/${lower}.pdf`,
        // Generic part-number endpoint; redirects to the current datasheet for many parts.
        `https://www.ti.com/lit/gpn/${lower}`
      ];
    }
  },
  {
    // VERIFIED 2026-07-22: fetched https://www.st.com/resource/en/datasheet/rhf310a.pdf and got the
    // real RHF310A datasheet (DS6201 Rev 8, April 2026), a RAD-HARD RHA QML-V part rated to
    // 300krad TID. ST's whole space line (RHF/RHR) is reachable this way, which is the single most
    // valuable pattern here for our thesis.
    vendor: "stmicroelectronics",
    claims(part, manufacturer) {
      if (
        manufacturerMatches(manufacturer, {
          names: ["stmicroelectronics", "st micro"],
          aliases: ["st", "stm"]
        })
      ) {
        return true;
      }
      // RHF and RHR are ST's rad-hard families; the rest are mainstream ST prefixes.
      return /^(RHF|RHR|RHFL|STM32|STM8|STL|STP|STB|STD|STGW|ST[A-Z]?\d|L\d|LD\d|LF\d|LM\d|TS\d|TSV|TSZ|VN\d|M24|M95|VIPER|BLUENRG)/i.test(part);
    },
    urls(part) {
      return [`https://www.st.com/resource/en/datasheet/${part.toLowerCase()}.pdf`];
    }
  },
  {
    // VERIFIED 2026-07-22: fetched
    // https://www.analog.com/media/en/technical-documentation/data-sheets/ad590.pdf and got the
    // real AD590 datasheet (Rev G), served as application/pdf. Note ad590s.pdf is the SPACE-GRADE
    // variant of the same part, so ADI's "S" suffix parts fall out of this pattern naturally.
    // ADI now owns Linear Technology and Maxim, so LT/LTC/MAX prefixes are claimed here too;
    // some legacy LT parts use a different filename convention and will simply 404 through.
    vendor: "analog-devices",
    claims(part, manufacturer) {
      if (
        manufacturerMatches(manufacturer, {
          names: ["analog devices", "linear technology", "maxim"],
          aliases: ["adi"]
        })
      ) {
        return true;
      }
      return /^(AD|ADG|ADM|ADP|ADR|ADL|ADF|ADE|ADUM|ADAU|ADXL|ADXRS|HMC|LTC|LTM|LT\d|MAX)\d/i.test(part);
    },
    urls(part) {
      const lower = part.toLowerCase();
      return [`https://www.analog.com/media/en/technical-documentation/data-sheets/${lower}.pdf`];
    }
    // No productUrls: analog.com answers its /en/products/ paths with 403 to us, verified
    // 2026-09-01 on ADR4525. The media path above is unaffected and keeps working.
  },
  {
    // VERIFIED 2026-09-01, 6 of 8 probed parts returned a real PDF: ncp1200, mc33063a, bss138,
    // ncp1117, ncp3063, ncv7351. The two misses (mmbt3904, 1n4148) are legacy parts filed under a
    // different name.
    //
    // NOTE THE PATH. `onsemi.com/pdf/datasheet/{part}-d.pdf` is the older, widely-cited form and it
    // answers 403 for some parts while `/download/data-sheet/pdf/` serves them, so the two are not
    // interchangeable. And onsemi answers a part it does not have with HTTP 200 AND AN HTML BODY,
    // not a 404, so status is not a miss signal here. `finalizeRef`'s %PDF check is what catches it.
    vendor: "onsemi",
    claims(part, manufacturer) {
      if (
        manufacturerMatches(manufacturer, {
          names: ["onsemi", "on semiconductor", "fairchild"],
          aliases: ["on"]
        })
      ) {
        return true;
      }
      return /^(NCP|NCV|NCS|NUD|NTD|NTR|NTM|FDN|FDS|FDD|MMBT|MMSZ|MBR|MUR|BSS\d|MC\d{4})/i.test(part);
    },
    urls(part) {
      return [`https://www.onsemi.com/download/data-sheet/pdf/${part.toLowerCase()}-d.pdf`];
    }
  },
  {
    // VERIFIED 2026-09-01: TJA1050, TJA1051, PCA9685 and PCF8574_PCF8574A all returned real PDFs.
    // LPC1768 does not, because NXP files it under the combined family name
    // `LPC1769_68_67_66_65_64_63.pdf`, which no part-number pattern can produce.
    vendor: "nxp",
    claims(part, manufacturer) {
      if (manufacturerMatches(manufacturer, { names: ["nxp", "freescale", "philips semiconductors"] })) {
        return true;
      }
      return /^(TJA|PCA\d|PCF\d|LPC\d|MFRC|NTAG|PN5|S32|MK\d|MC9S)/i.test(part);
    },
    urls(part) {
      return [`https://www.nxp.com/docs/en/data-sheet/${part.toUpperCase()}.pdf`];
    }
  },
  {
    // VERIFIED 2026-09-01: AP2112, ZXCT1010 and 74LVC1G14 returned real PDFs. AP63203 did not.
    vendor: "diodes",
    claims(part, manufacturer) {
      if (manufacturerMatches(manufacturer, { names: ["diodes", "zetex"] })) return true;
      return /^(AP\d|ZX|DMN\d|DMP\d|DMG\d|BAT\d{2}|BAV\d{2}|74[ALV]{2,3}\d)/i.test(part);
    },
    urls(part) {
      return [`https://www.diodes.com/assets/Datasheets/${part.toUpperCase()}.pdf`];
    }
  },
  {
    // VERIFIED 2026-09-01: esp32 and esp32-wroom-32 both returned real PDFs.
    vendor: "espressif",
    claims(part, manufacturer) {
      if (manufacturerMatches(manufacturer, { names: ["espressif"] })) return true;
      return /^ESP(32|8266)/i.test(part);
    },
    urls(part) {
      if (!/^ESP(32|8266)/i.test(part)) return [];
      const lower = part.toLowerCase();
      return [`https://www.espressif.com/sites/default/files/documentation/${lower}_datasheet_en.pdf`];
    }
  },
  {
    // VERIFIED 2026-09-01: rp2040 returned the real 5.3MB RP2040 datasheet.
    vendor: "raspberry-pi",
    claims(part, manufacturer) {
      if (manufacturerMatches(manufacturer, { names: ["raspberry pi"] })) return true;
      return /^RP\d{4}$/i.test(part);
    },
    urls(part) {
      if (!/^RP\d{4}$/i.test(part)) return [];
      const lower = part.toLowerCase();
      return [`https://datasheets.raspberrypi.com/${lower}/${lower}-datasheet.pdf`];
    }
  },
  {
    // VERIFIED 2026-09-01: isl71001m returned the real datasheet. Note the URL has no `.pdf`
    // extension and is served as application/pdf, which the %PDF magic-byte check handles and a
    // content-type or extension check would not.
    //
    // ISL71001M is a RAD-HARD part that the coverage bench had scored as structurally unreachable.
    vendor: "renesas",
    claims(part, manufacturer) {
      if (manufacturerMatches(manufacturer, { names: ["renesas", "intersil"] })) return true;
      return /^(ISL|HIP|ICL|EL\d|ZL\d|R5F|RA\d|RX\d|RL78)/i.test(part);
    },
    urls(part) {
      return [`https://www.renesas.com/en/document/dst/${part.toLowerCase()}-datasheet`];
    }
  },
  {
    // VERIFIED 2026-09-01, 4 of 4: 430450400, 0022232021, 5023800200 and 0533980571. Molex accepts
    // the digits with or without the leading zero, so one form covers both.
    //
    // Connectors are the category where a generated footprint is worth the most and where coverage
    // was zero.
    vendor: "molex",
    claims(part, manufacturer) {
      if (manufacturerMatches(manufacturer, { names: ["molex"] })) return true;
      return /^\d{4,6}-?\d{3,4}$/.test(part);
    },
    urls(part) {
      const digits = digitsOnly(part);
      if (digits.length < 8 || digits.length > 10) return [];
      return [`https://www.molex.com/pdm_docs/sd/${digits}_sd.pdf`];
    }
  },
  {
    // VERIFIED 2026-09-01, 2 of 2: 282836 and 284392. TE's customer drawing IS the dimensioned
    // document a footprint comes from, so this is the right document to ask for rather than a
    // second choice. The orderable number carries a dash suffix the document number does not.
    vendor: "te-connectivity",
    claims(part, manufacturer) {
      if (manufacturerMatches(manufacturer, { names: ["te connectivity", "tyco", "amp"] })) return true;
      return /^\d?-?\d{5,6}-\d{1,2}$/.test(part);
    },
    urls(part) {
      const base = digitsOnly(part.replace(/-\d{1,2}$/, ""));
      if (base.length < 5 || base.length > 7) return [];
      return [
        `https://www.te.com/commerce/DocumentDelivery/DDEController?Action=srchrtrv&DocNm=${base}` +
          `&DocType=Customer+Drawing&DocLang=English`
      ];
    }
  },
  {
    // VERIFIED 2026-09-01: 10118193 returned the real drawing. Note the host is `www.` and not
    // `cdn.`, which answers 403.
    vendor: "amphenol",
    claims(part, manufacturer) {
      if (manufacturerMatches(manufacturer, { names: ["amphenol"] })) return true;
      return /^\d{8}-\d{4}[A-Z]{0,2}$/i.test(part);
    },
    urls(part) {
      const base = digitsOnly(part.replace(/-.*$/, ""));
      if (base.length !== 8) return [];
      return [`https://www.amphenol-cs.com/media/wysiwyg/files/drawing/${base}.pdf`];
    }
  },
  {
    // VERIFIED 2026-09-01, 3 of 4: S2B-PH-K-S, B4B-XH-A and B2B-EH-A. SM02B-SRSS-TB missed.
    //
    // JST publishes one document per SERIES rather than per orderable part, and the series is the
    // second dash-separated token: `S2B-PH-K-S` is documented by `ePH.pdf`. That is a real naming
    // convention, not a guess, but it is the reason this vendor cannot use the shared variant list:
    // stripping after the first dash gives `S2B`, which is the housing style and documents nothing.
    vendor: "jst",
    claims(part, manufacturer) {
      if (manufacturerMatches(manufacturer, { names: ["jst"] })) return true;
      return JST_SHAPE.test(part);
    },
    urls(part) {
      const series = part.split("-")[1];
      if (!series || !/^[A-Z]{2,5}$/.test(series)) return [];
      return [`https://www.jst-mfg.com/product/pdf/eng/e${series}.pdf`];
    }
  },
  {
    // PRODUCT PAGE ONLY, and this is the entry that shows why `productUrls` exists.
    //
    // Microchip files datasheets under document numbers: ATMEGA328P's is
    // `Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf` and PIC16F877A's is
    // `39582C.pdf`. No part-number pattern reaches either. But `microchip.com/en-us/product/{PART}`
    // is derivable, and the page carries the link.
    //
    // VERIFIED 2026-09-01, 3 of 3. Each page was fetched, its PDF links harvested and ranked the
    // way `scrape.ts` ranks them, and the correct datasheet came FIRST out of 92, 53 and 11 links.
    vendor: "microchip",
    claims(part, manufacturer) {
      if (manufacturerMatches(manufacturer, { names: ["microchip", "atmel", "microsemi", "actel"] })) {
        return true;
      }
      return /^(ATMEGA|ATTINY|ATSAM|ATXMEGA|PIC\d|DSPIC|MCP\d|SST\d|A3P|AGL)/i.test(part);
    },
    urls() {
      // Nothing derivable. The product page below is the whole contribution.
      return [];
    },
    productUrls(part) {
      return [`https://www.microchip.com/en-us/product/${part.toUpperCase()}`];
    }
  }
  // Adding a vendor: fetch a real datasheet through the candidate pattern FIRST, using Node's
  // `fetch` and not curl (see the note in COVERAGE REALITY), then add it with the part numbers and
  // date you verified against, as above. Unverified patterns are worse than no pattern: they cost a
  // round trip on every lookup and quietly erode trust in the citation story.
];

// Every candidate URL for a part, de-duplicated, in priority order.
//
// Two tiers. CLAIMED candidates come from vendors whose prefix or manufacturer hint matches, and
// are tried first. SPECULATIVE candidates come from every other vendor in the registry, and exist
// because our prefix regexes are deliberately conservative: a real ADI part whose prefix we do not
// list would otherwise never be tried at all, even though the URL pattern would have worked.
//
// Speculation is only affordable because candidates are fetched in PARALLEL (see resolve below).
// Serially it would mean paying several round trips to learn nothing; in parallel the whole tier
// costs about one round trip. A wrong guess is a 404, and finalizeRef's %PDF check catches a URL
// that resolves to something that is not a datasheet, so a bad guess cannot produce a bad result.
export function buildCandidateUrls(
  partNumber: string,
  manufacturer?: string
): { claimed: string[]; speculative: string[] } {
  const normalized = normalizePartNumber(partNumber);
  const variants = buildPartVariants(normalized);
  const claimed: string[] = [];
  const speculative: string[] = [];

  for (const vendor of VENDORS) {
    const target = vendor.claims(normalized, manufacturer) ? claimed : speculative;
    for (const variant of variants) {
      target.push(...vendor.urls(variant));
    }
  }

  const claimedSet = new Set(claimed);
  return {
    claimed: [...claimedSet],
    // Never re-try something the claimed tier already covers.
    speculative: [...new Set(speculative)].filter((u) => !claimedSet.has(u)).slice(0, MAX_SPECULATIVE)
  };
}

/**
 * Product pages for the vendors that CLAIM this part, for the scrape resolver to harvest.
 *
 * Claimed only, never speculative. A product page costs a fetch of a page that can be a megabyte
 * of HTML plus a parse plus up to eight further downloads, which is affordable once for a vendor
 * that plausibly owns the part and not affordable across the whole registry on a guess.
 */
export function buildProductPageUrls(partNumber: string, manufacturer?: string): string[] {
  const normalized = normalizePartNumber(partNumber);
  const urls = new Set<string>();

  for (const vendor of VENDORS) {
    if (!vendor.productUrls || !vendor.claims(normalized, manufacturer)) continue;
    for (const variant of buildPartVariants(normalized)) {
      for (const url of vendor.productUrls(variant)) urls.add(url);
    }
  }

  return [...urls];
}

// REMOVED 2026-09-01: `hintNamesKnownVendor`, which skipped the speculative tier whenever the
// manufacturer hint named a vendor in the registry.
//
// Its reasoning was "the user told us who makes it, so trying other vendors is noise". That is
// wrong for SECOND-SOURCED parts, and it gets more wrong with every vendor added, which is how it
// was found. Adding NXP to the registry LOST PCF8574: the corpus hints it as NXP, NXP genuinely
// publishes it, `nxp.com/docs/en/data-sheet/PCF8574.pdf` genuinely 404s, and the copy that resolves
// is TI's. Before NXP was in the registry the hint named nobody we knew, speculation ran, and TI
// answered. Adding a vendor made a working part stop working.
//
// The hint says where to look FIRST, not where to look ONLY. Speculation now runs whenever the
// claimed tier missed, which is the path where we are otherwise about to tell the user their part
// does not exist. One extra parallel batch is a fair price for that, and it is bounded by
// MAX_SPECULATIVE.

export class ManufacturerResolver implements DatasheetResolver {
  readonly name = RESOLVER_NAME;

  // No credentials. Always available, which is exactly why it runs first: it costs nothing and
  // needs no setup, so the primary demo path has no configuration prerequisite at all.
  isConfigured(): boolean {
    return true;
  }

  // Fetches one candidate. The three outcomes are kept distinct on purpose:
  //   hit   : a real PDF
  //   miss  : the vendor answered and does not have this part (404, or served HTML)
  //   error : we never got an answer (dead host, timeout, blocked URL)
  // Collapsing "error" into "miss" is the same bug as reporting a blocked search as "no datasheet":
  // it turns "we could not check" into a confident statement about the part.
  private async tryCandidate(
    url: string,
    partNumber: string
  ): Promise<{ kind: "hit"; ref: DatasheetRef } | { kind: "miss" } | { kind: "error" }> {
    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        { headers: { Accept: "application/pdf,*/*;q=0.8" }, redirect: "follow" },
        DOWNLOAD_TIMEOUT_MS
      );
    } catch {
      return { kind: "error" };
    }

    // 404 is the vendor telling us it does not publish that part. A real answer.
    if (response.status === 404) return { kind: "miss" };
    if (!response.ok) return { kind: "error" };

    let bytes: ArrayBuffer;
    try {
      bytes = await readBodyWithLimit(response, url);
    } catch {
      return { kind: "error" };
    }

    // The vendor served a real PDF. That is not the same as serving THIS PART's
    // datasheet: a retired literature name redirects, a family URL can land on a
    // sibling, and both come back 200 with valid PDF bytes. A document for the
    // wrong device is reported as a MISS so the remaining candidates still run.
    // See `identity.ts`.
    if (!(await documentNamesPart(bytes, partNumber))) {
      logger.debug({ event: "resolver_wrong_part", resolver: RESOLVER_NAME, partNumber, url });
      return { kind: "miss" };
    }

    try {
      return {
        kind: "hit",
        ref: finalizeRef({
          fileName: `${normalizePartNumber(partNumber)}.pdf`,
          pdfUrl: response.url || url,
          sourcePageUrl: undefined,
          bytes
        })
      };
    } catch (error) {
      // Resolved but served HTML (a product page or a redirect to search) rather than a PDF. The
      // vendor answered, so this is a miss, not a failure to reach them.
      if (error instanceof PdfValidationError) return { kind: "miss" };
      throw error;
    }
  }

  // Runs a batch in parallel and returns the winner in CANDIDATE order, not completion order. That
  // matters: the list is ordered by confidence, so a slow high-confidence URL must still beat a
  // fast low-confidence one. Otherwise a vendor's generic redirect endpoint could out-race the
  // exact datasheet URL and we would cite the wrong source.
  private async raceBatch(
    urls: string[],
    partNumber: string
  ): Promise<{ ref: DatasheetRef | null; allErrored: boolean }> {
    if (urls.length === 0) return { ref: null, allErrored: false };

    const results = await Promise.all(urls.map((url) => this.tryCandidate(url, partNumber)));
    const hit = results.find((r) => r.kind === "hit");
    if (hit && hit.kind === "hit") return { ref: hit.ref, allErrored: false };

    return { ref: null, allErrored: results.every((r) => r.kind === "error") };
  }

  async resolve(partNumber: string, opts?: ResolveOptions): Promise<DatasheetRef | null> {
    const { claimed, speculative } = buildCandidateUrls(partNumber, opts?.manufacturer);

    // Tier 1: vendors that claim this part. Parallel, so the cost is the slowest candidate rather
    // than the sum of all of them.
    const primary = await this.raceBatch(claimed, partNumber);
    if (primary.ref) return primary.ref;

    // Every claimed candidate failed to answer at all. That is not a miss, and saying it is would
    // tell the user their part does not exist because a vendor host happened to be down. Soft, so
    // the chain continues and the upload prompt still appears.
    if (primary.allErrored && claimed.length > 0) {
      throw new ResolverError(
        "transport",
        RESOLVER_NAME,
        `All ${claimed.length} manufacturer candidates failed to respond for ${partNumber}`
      );
    }

    // Tier 2: every other known vendor pattern. Two things land here. Our prefix regexes are
    // deliberately conservative, so a real part from a vendor we support can fall outside them. And
    // a part can be SECOND-SOURCED: the hinted vendor really does make it and really does not
    // publish a datasheet at a derivable URL, while another vendor does. See the note above
    // `MAX_SPECULATIVE` for the part that proved it.
    const fallback = await this.raceBatch(speculative, partNumber);
    if (fallback.ref) return fallback.ref;

    return null;
  }
}
