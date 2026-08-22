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
// COVERAGE REALITY, corrected 2026-07-22 after checking rather than assuming. It is vendor by
// vendor, not "rad-hard is impossible":
//
//   Derivable, INCLUDING their rad-hard lines. Verified by fetching real datasheets:
//     TI    LMP7704-SP  (QMLV, RHA 100krad)  via ti.com/lit/ds/symlink/
//     ST    RHF310A     (RHA QML-V, 300krad) via st.com/resource/en/datasheet/
//     ADI   AD590       (and ad590s.pdf is the space-grade variant)
//
//   NOT derivable. The pure-play rad-hard vendors publish document-numbered filenames:
//     VORAGO publishes VA10820 as "VA10820_DS_12.pdf", where the trailing number is a document
//     revision, and the reachable copies are hosted by distributors rather than at a predictable
//     path on voragotech.com. CAES/Cobham, Teledyne e2v, and Honeywell are the same shape.
//     You cannot build those URLs from a part number. Do not add guessed patterns for them; that
//     is what the upload path is for.
//
// So the honest split: the big analog and MCU vendors ship rad-hard parts we CAN resolve, and the
// specialist rad-hard houses we cannot. Both halves matter, and neither should be overstated.

import type { DatasheetRef, DatasheetResolver, ResolveOptions } from "../resolver";
import { finalizeRef } from "../ref";
import { PdfValidationError } from "../pdf";
import { ResolverError } from "./errors";
import { fetchWithTimeout, readBodyWithLimit, DOWNLOAD_TIMEOUT_MS } from "./http";
import { buildPartVariants, normalizePartNumber } from "../partnumber";
import { documentNamesPart } from "../identity";
import { logger } from "../logging";

const RESOLVER_NAME = "manufacturer";

interface VendorPattern {
  vendor: string;
  // True when this vendor plausibly owns the part, from the manufacturer hint or the part prefix.
  claims(part: string, manufacturer?: string): boolean;
  // Candidate URLs in priority order, most likely first.
  urls(partVariant: string): string[];
}

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
  }
  // Adding a vendor: fetch a real datasheet through the candidate pattern FIRST, then add it with
  // the part number and date you verified against, as above. Unverified patterns are worse than no
  // pattern: they cost a round trip on every lookup and quietly erode trust in the citation story.
  // Do NOT add VORAGO, CAES/Cobham, Teledyne e2v, or Honeywell: see COVERAGE REALITY in the header.
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
    speculative: [...new Set(speculative)].filter((u) => !claimedSet.has(u))
  };
}

// A manufacturer hint that names a vendor we know means speculation is pointless: the user told us
// who makes it, so trying other vendors' URL shapes only adds noise and outbound requests.
function hintNamesKnownVendor(manufacturer: string | undefined, partNumber: string): boolean {
  if (!manufacturer) return false;
  return VENDORS.some((v) => v.claims(partNumber, manufacturer));
}

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

    // Tier 2: every other known vendor pattern. Our prefix regexes are deliberately conservative,
    // so a real part from a vendor we support can fall outside them; this catches those. Skipped
    // when the user named a vendor we recognize, since they already told us the answer.
    if (!hintNamesKnownVendor(opts?.manufacturer, normalizePartNumber(partNumber))) {
      const fallback = await this.raceBatch(speculative, partNumber);
      if (fallback.ref) return fallback.ref;
    }

    return null;
  }
}
