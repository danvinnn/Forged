import { randomUUID } from "node:crypto";
import { citationAt, extractDatasheetText, type DatasheetText } from "./pdftext";
import { extractPinFigureByGeometry } from "./pinfigure";
import { extractPinTableByGeometry, packageFamilies } from "./pintable";
import { findVendorLandPattern } from "./vendorland";
import { readDrawingDimensions, type DrawnDimensions } from "./drawingdimensions";
import {
  declaredLeadCount,
  findOrderablePackages,
  findPackageVariants,
  namesPackageFamily,
  selectSinglePackage,
  soleDeclaredLeadCount,
  type PackageVariant,
} from "./packagevariants";
import {
  extractedValue,
  unknown,
  type Citation,
  type Extracted,
  type LeadWidth,
  type PackageDimensions,
  type PartRecord,
  type PinElectricalType,
  type PinRecord,
  type RadiationData
} from "./types";

/**
 * Deterministic (text) extraction pass.
 *
 * Every value returned carries its own confidence and a citation back into the
 * datasheet. A value this pass cannot determine is returned as `unknown()`, not
 * as a guess: a fabricated pin count becomes fabricated pads in a flight-part
 * footprint, so "I do not know" has to be representable and has to propagate.
 */

/** Front matter carries the package and ordering information on these datasheets. */
const FRONT_MATTER_PAGES = 3;

/**
 * Parse resource limits. Layer 1 validates the %PDF magic bytes and the file
 * size but never opens the document, so this is the first point at which a
 * small file that expands catastrophically becomes a denial-of-service vector.
 */
const MAX_PAGES = 400;

/**
 * Wall-clock ceiling for text extraction. Must sit under the route's
 * maxDuration (30s) so the platform does not kill the request first and turn a
 * clean error into a 504.
 */
function parseBudgetMs(): number {
  const raw = Number(process.env.FORGE_PARSE_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
}

interface VendorHint {
  /** Canonical name written into the record. */
  name: string;
  /** Strings that identify the vendor. Short ones must match as whole words. */
  aliases: string[];
}

/**
 * Includes the rad-hard specialists, which the previous list omitted entirely,
 * so a VORAGO datasheet could only ever be attributed to some other vendor it
 * happened to mention in passing.
 */
const vendorHints: VendorHint[] = [
  { name: "Texas Instruments", aliases: ["Texas Instruments", "ti.com"] },
  { name: "Analog Devices", aliases: ["Analog Devices", "analog.com"] },
  { name: "STMicroelectronics", aliases: ["STMicroelectronics", "st.com"] },
  { name: "VORAGO Technologies", aliases: ["VORAGO"] },
  { name: "CAES", aliases: ["CAES", "Cobham Advanced Electronic Solutions", "Cobham"] },
  { name: "Teledyne e2v", aliases: ["Teledyne e2v", "Teledyne"] },
  { name: "Honeywell", aliases: ["Honeywell"] },
  { name: "Microchip", aliases: ["Microchip", "Microsemi"] },
  { name: "BAE Systems", aliases: ["BAE Systems"] },
  { name: "Renesas", aliases: ["Renesas", "Intersil"] },
  { name: "Infineon", aliases: ["Infineon"] },
  { name: "NXP", aliases: ["NXP"] },
  { name: "onsemi", aliases: ["onsemi", "ON Semiconductor"] },
  { name: "Nexperia", aliases: ["Nexperia"] },
  { name: "Vishay", aliases: ["Vishay"] },
  { name: "Qorvo", aliases: ["Qorvo"] }
];

interface RawMatch {
  index: number;
  length: number;
  groups: (string | undefined)[];
  text: string;
}

function firstMatch(haystack: string, pattern: RegExp, offset = 0): RawMatch | null {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const rx = new RegExp(pattern.source, flags);
  const match = rx.exec(haystack);
  if (!match) return null;
  return {
    index: offset + match.index,
    length: match[0].length,
    groups: match.slice(1),
    text: match[0]
  };
}

function allMatches(haystack: string, pattern: RegExp, offset = 0): RawMatch[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const rx = new RegExp(pattern.source, flags);
  const out: RawMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = rx.exec(haystack)) !== null) {
    out.push({ index: offset + match.index, length: match[0].length, groups: match.slice(1), text: match[0] });
    if (match[0].length === 0) rx.lastIndex += 1;
  }
  return out;
}

function cite(doc: DatasheetText, match: RawMatch): Citation | null {
  return citationAt(doc, match.index, match.length);
}

/** Character offset at which the front matter ends. */
function frontMatterEnd(doc: DatasheetText): number {
  const boundary = doc.pages.find((page) => page.page === FRONT_MATTER_PAGES + 1);
  return boundary ? boundary.start : doc.text.length;
}

function cleanValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Field extractors
// ---------------------------------------------------------------------------

function fallbackPartNumber(sourceFileName: string): string {
  const baseName = sourceFileName.replace(/\.[^.]+$/, "").toUpperCase();
  return baseName.replace(/[^A-Z0-9\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "UNKNOWN-PART";
}

/**
 * Identifiers that are shaped exactly like a part number and are not one.
 *
 * Every datasheet cites standards, qualification methods and its own literature
 * numbers, and they all match "letters, digits, a hyphen". Taking the first such
 * token in the whole document made UCC27524 come back as `JESD22-C101`, a JEDEC
 * ESD test method named on page 5. That is not a cosmetic defect: the part
 * number names the generated symbol, the footprint and the STEP product, so the
 * entire CAD bundle ends up filed under a test standard.
 *
 * Each entry is anchored to the whole candidate, so a real part whose name
 * merely starts with these letters (ISO7741, a TI digital isolator) is safe.
 */
const NOT_A_PART_NUMBER: RegExp[] = [
  /^JESD/i,
  /^JEDEC/i,
  /^MIL-(?:STD|PRF|DTL|S|M|C)/i,
  /^(?:IPC|ASME|ANSI|EIA|IEEE|SAE)-/i,
  /^ISO-\d/i,
  /^IEC-?\d/i,
  /^UL-?\d/i,
  /^AEC-Q/i,
  /^EN-\d/i,
  // Vendor document, revision and literature numbers. ST and Microchip stamp a
  // "DS<number>" on every page, so it outnumbers the part number itself and wins
  // any frequency ranking: STM32H743ZI came back as DS12110 without this.
  /^DS\d{3,}/i,
  /^FN\d{3,}/i,
  /^(?:DOC|DOCID|REV|TB|AN)\d/i,
  // TI literature numbers: four letters then digits, e.g. SLUSFA9, SNAS411P.
  /^S[A-Z]{3}\d/i,
  /^\d+-\d+$/,
  // Package designators with a lead count. These are the other thing on a front
  // page shaped like a part number, and they made AD590 report "SOIC-8".
  /^(?:SOIC|SOP|TSSOP|SSOP|HVSSOP|VSSOP|MSOP|TSOT|SOT|X\d?QFN|VQFN|WQFN|UQFN|QFN|WSON|VSON|SON|DFN|LQFP|TQFP|HTQFP|QFP|FBGA|TBGA|BGA|WCSP|DSBGA|CDIP|PDIP|DIP|CFP|CLCC|PLCC|LCC|TO|SC)-?\d/i
];

/** A part number is at least a few characters and contains a digit. */
const PART_NUMBER_CANDIDATE = /\b[A-Z][A-Z0-9]{2,}(?:-[A-Z0-9]+)*\b/g;
const MIN_PART_NUMBER_LENGTH = 5;

function isPlausiblePartNumber(candidate: string): boolean {
  if (!/\d/.test(candidate)) return false;
  return !NOT_A_PART_NUMBER.some((pattern) => pattern.test(candidate));
}

/** The filename with its extension dropped, kept close to what the vendor wrote. */
function fileNameStem(sourceFileName: string): string {
  return sourceFileName.replace(/\.[^.]+$/, "").trim().toUpperCase();
}

function findPartNumber(doc: DatasheetText, sourceFileName: string): Extracted<string> {
  // The strongest signal available, and the cheapest: the file is named after a
  // part AND the document says the same thing. Two independent sources agreeing
  // beats any single regex, and because the document is where the match is
  // found, the value still carries a citation.
  // The stem has to look like a part number before it is allowed to corroborate.
  // Without this a file saved as "datasheet.pdf" matches the word "datasheet" in
  // the document and is reported as the part number at high confidence.
  const stem = fileNameStem(sourceFileName);
  if (stem.length >= MIN_PART_NUMBER_LENGTH && isPlausiblePartNumber(stem)) {
    const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const corroborated = firstMatch(doc.text, new RegExp(`\\b${escaped}\\b`, "i"));
    if (corroborated) return extractedValue(stem, 0.95, cite(doc, corroborated));
  }

  // An explicit label wins outright when the document offers one.
  const labelled = firstMatch(
    doc.text,
    /(?:PRODUCT|DEVICE|PART)\s+NUMBER\s*[:\-]\s*([A-Z0-9][A-Z0-9\-./]{2,})/i
  );
  const labelledValue = labelled ? cleanValue(labelled.groups[0] ?? "") : "";
  if (labelled && labelledValue && isPlausiblePartNumber(labelledValue)) {
    return extractedValue(labelledValue, 0.9, cite(doc, labelled));
  }

  // Otherwise take candidates from the front matter only, and rank them by how
  // often the WHOLE document repeats them. A part number is stamped on every
  // page header, in the ordering table and in every section title; a package
  // code or a qualification standard is mentioned a handful of times. Measured
  // over the benchmark corpus this lifted front-matter-only identification from
  // roughly 5% to 84%, where the residue is datasheets covering a whole family
  // (TLV9061/9062/9064) in which no single part is "the" part.
  const scope = doc.text.slice(0, frontMatterEnd(doc));
  const upper = doc.text.toUpperCase();
  const counted = new Map<string, number>();

  for (const match of scope.toUpperCase().matchAll(PART_NUMBER_CANDIDATE)) {
    const candidate = match[0];
    if (candidate.length < MIN_PART_NUMBER_LENGTH) continue;
    if (counted.has(candidate)) continue;
    if (!isPlausiblePartNumber(candidate)) continue;
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    counted.set(candidate, upper.split(new RegExp(`\\b${escaped}\\b`)).length - 1);
  }

  const ranked = [...counted.entries()].sort((left, right) => right[1] - left[1]);
  const leader = ranked[0];
  if (leader && leader[1] > 1) {
    const runnerUp = ranked[1]?.[1] ?? 0;
    // A clear leader is a part number. A near-tie is a family datasheet, where
    // the choice is genuinely arbitrary, so it is reported at low confidence.
    const decisive = leader[1] >= runnerUp * 1.5;
    const located = firstMatch(doc.text, new RegExp(`\\b${leader[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
    return extractedValue(leader[0], decisive ? 0.85 : 0.55, located ? cite(doc, located) : null);
  }

  // The filename is still a real signal, but nothing in the document confirmed
  // it, so it is recorded at low confidence with no citation.
  const fromFileName = fallbackPartNumber(sourceFileName);
  return fromFileName === "UNKNOWN-PART" ? unknown<string>() : extractedValue(fromFileName, 0.3, null);
}

/**
 * Returns the vendor whose name appears EARLIEST in the document, not the first
 * one that happens to sit highest in a hardcoded list. A passing mention of
 * another vendor deep in an application note can no longer win.
 */
function findManufacturer(doc: DatasheetText): Extracted<string> {
  let best: { vendor: VendorHint; match: RawMatch } | null = null;

  for (const vendor of vendorHints) {
    for (const alias of vendor.aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Short aliases must match as whole words: "TI" inside "Connectivity"
      // is the substring trap that mis-attributed a TE connector to TI.
      const pattern = alias.length <= 4 ? new RegExp(`\\b${escaped}\\b`, "i") : new RegExp(escaped, "i");
      const match = firstMatch(doc.text, pattern);
      if (!match) continue;
      if (!best || match.index < best.match.index) best = { vendor, match };
    }
  }

  if (!best) return unknown<string>();

  // A vendor named in the front matter is the publisher; one that first appears
  // deep in the body is far more likely to be an incidental mention.
  const inFrontMatter = best.match.index < frontMatterEnd(doc);
  return extractedValue(best.vendor.name, inFrontMatter ? 0.9 : 0.4, cite(doc, best.match));
}

/**
 * Signal and section labels that share the shape of a package designator.
 * Without this, "OUT (1)" on an ST pinout diagram parses as a 1-pin package,
 * which is a confidently wrong answer rather than an honest miss.
 */
const NOT_A_PACKAGE = new Set([
  "OUT", "IN", "VIN", "VOUT", "VCC", "VDD", "VSS", "VEE", "GND", "NC", "CLK", "EN",
  "REF", "SET", "ADJ", "FB", "CS", "SD", "PD", "OE", "IO", "NOTE", "FIG", "TABLE",
  "EQ", "MIN", "MAX", "TYP", "PIN", "LEAD"
]);

function isPlausiblePackage(designator: string): boolean {
  const letters = designator.match(/^([A-Z]{2,6})\s*\((\d{1,3})\)$/i);
  if (!letters) return true;
  if (NOT_A_PACKAGE.has(letters[1].toUpperCase())) return false;
  // No real package has a single terminal position in a (n) designator.
  return Number(letters[2]) >= 2;
}

/**
 * Package designator forms seen in the front matter of real datasheets, e.g.
 * "SOIC-8", "SOIC (8)", "SOIC 8)", "8-pin SOIC", "14-lead CFP".
 *
 * Most datasheets offer a part in SEVERAL packages: UCC27524 is SOIC-8,
 * HVSSOP-8 and WSON-8, ISO7741 is SOIC and SSOP. A footprint is per package, so
 * which one applies is a choice the caller makes, not something the document
 * decides. This returns the best single candidate for display; the export path
 * takes an explicit override.
 */
const PACKAGE_DESIGNATOR_PATTERNS: RegExp[] = [
  /\b(?:package|pkg)\s*[:\-]\s*([A-Z0-9][A-Z0-9\-()\/]{1,20})/i,
  /\b(\d{1,3}-(?:lead|pin)\s+[A-Z]{2,8})\b/i,
  // The space before the bracket is required, and it is the same rule
  // findDeclaredPinCount relies on: a package designator is a separate token
  // ("SOIC (8)", "SON (6)") and a footnote marker is glued to the word it
  // annotates ("NUMBER(3)", "TYPE(1)", "CMTI(1)"). This pattern allowed the
  // space to be optional while the count's did not, so a TLV9061 read its pin
  // table correctly and then reported its package as "NUMBER(3)", which no land
  // pattern can match.
  /\b([A-Z]{2,6}\s\(\d{1,3}\))/,
  // "SOIC-8" and "SOIC 8)", the two forms the previous patterns missed. This is
  // why UCC27524 had no package at all and so could not export.
  /\b([A-Z]{3,8}-\d{1,3})\b/,
  /\b([A-Z]{3,8})\s+\d{1,3}\)/
];

function findPackageType(doc: DatasheetText, variants?: PackageVariant[]): Extracted<string> {
  const scope = doc.text.slice(0, frontMatterEnd(doc));
  const offered = variants ?? findPackageVariants(doc.text, frontMatterEnd(doc));


  // NOTE: this scan takes the FIRST package-shaped token in the front matter,
  // which on a multi-package part is whichever the vendor listed first rather
  // than the one the caller is holding. That is a guess wearing a citation, and
  // choosing a package is properly the caller's decision, not ours.
  //
  // Gating it on "does the document offer several packages" was measured on
  // 2026-08-09 and REVERTED the same day: reachable parts fell from 17/44 to
  // 13/44, because refusing to guess only helps if the choice we put in front of
  // the user contains the right answer, and today it often does not. An AD590
  // offers FLATPACK, TO-52, SC-11 and Ceramic Flat, and the two packages whose
  // pinouts this parser can actually read, the 8-lead SOIC and the 4-lead LFCSP,
  // are in neither the list nor the front matter.
  //
  // The order of work is therefore: make `packageVariants` list the packages the
  // document DRAWS, then stop guessing here. Doing the second first swaps a
  // lucky guess for a dead end.
  for (const pattern of PACKAGE_DESIGNATOR_PATTERNS) {
    for (const match of allMatches(scope, pattern)) {
      const candidate = cleanValue(match.groups[0] ?? match.text);
      // A candidate that names no package family is not a designator, whatever
      // shape it has. This is what stops `80-pin target development board`
      // becoming an MSP430F5529's package and `MIL-STD-883B` an RTAX2000S's.
      if (candidate && isPlausiblePackage(candidate) && namesPackageFamily(candidate)) {
        return extractedValue(candidate, 0.75, cite(doc, match));
      }
    }
  }

  // Nothing in the front matter, which is the common case on the parts that
  // could not export: the designator is real and printed somewhere else, in a
  // form these five patterns do not cover. `SO48` and `Flat-16P` are glued
  // together, `64 Ld EP-TQFP` is a thermal table entry, `16-Lead TSSOP` is on
  // page 8. The variant reader finds all of them, and answers here only when the
  // document describes ONE package; otherwise the choice goes to the caller.
  const single = selectSinglePackage(offered);
  if (!single) return unknown<string>();

  const escaped = single.designator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const located = firstMatch(doc.text, new RegExp(escaped, "i"));
  // Lower than the front-matter patterns: this is a real designator read from a
  // real document, and it was found somewhere the document was not introducing
  // itself, so it deserves less weight than a front page saying so outright.
  return extractedValue(single.designator, 0.6, located ? cite(doc, located) : null);
}

/**
 * Pin count from the package designator in the front matter.
 *
 * The previous implementation took Math.max over every "N-pin" / "N-lead"
 * match in the whole document, so a 128-pin FPGA mentioned in a reference
 * design beat the part's own package. Scoping to the front matter and
 * requiring a package-shaped match removes that entire class of error.
 */
/**
 * Letter prefixes whose trailing number is not a pin count.
 *
 * All of these were caught reading the benchmark corpus, and each one produced a
 * confidently wrong pin count before it was listed here:
 *
 * - `TO-220`, `TO-257`, `SOT-23`, `SOT-223`, `SOT-553`, `DO-214`: JEDEC package
 *   OUTLINE codes. The number is the outline, not a terminal count, and TO-220
 *   is a three-lead part.
 * - `STD-883`, `PRF-38535`: MIL standards. An RTAX2000S read as an 883-pin part.
 * - `RS-485`, `RS-232`: interface standards.
 * - `MO-220`, `MS-012`: JEDEC outline registrations.
 *
 * This is deliberately a list of observed liars rather than a rule, because the
 * shape `LETTERS-NUMBER` is genuinely how packages are written too (`SOIC-8`,
 * `DBQ-16`, `GDIP-14`), and no property of the string separates them.
 */
const NOT_A_PIN_COUNT_PREFIX = new Set([
  "TO", "SOT", "DO", "DPAK", "SOD", "SC",
  "STD", "MIL", "PRF", "JESD", "JEDEC", "EIA", "IPC", "IEC", "ISO", "ANSI", "ASME", "DIN", "EN",
  "MO", "MS", "RS", "USB", "SPI", "I2C", "CAN"
]);

/**
 * The pin count the document declares about itself, as opposed to the one read
 * off a pin table.
 *
 * Both signals are weak in different ways, which is why `buildPartRecord` treats
 * a disagreement between them as unknown. This one's weakness is that a
 * datasheet's front matter is dense with numbers that look like designators, so
 * every candidate is filtered three ways: the letters must not be a known
 * standard or outline family, the letters must not be a signal name, and the
 * count must be plausible for a package.
 */
function findDeclaredPinCount(doc: DatasheetText): Extracted<number> {
  const scope = doc.text.slice(0, frontMatterEnd(doc));
  // Ordered by how much the form constrains its own meaning. "14-lead CFP" says
  // what the number counts; "GDIP-14" only implies it. The parenthesised form
  // runs last because it used to run second, which is the whole reason an
  // LM139AQML-SP declared seven pins: it matched GND(7) before reaching GDIP-14.
  //
  // That form also requires a SPACE before the bracket, and the space is doing
  // real work. Across the corpus the designators are written with one and the
  // false positives are not, without exception: SOIC (8), SON (6), UQFN (12)
  // against GND(7), NUMBER(3), CMTI(1), SIZE(2). A footnote marker is glued to
  // the word it annotates; a package designator is a separate token. That is a
  // property of how the documents are typeset rather than a list of words we
  // happened to lose to, so it should keep working on datasheets nobody has
  // looked at.
  const patterns: RegExp[] = [
    /\b(\d{1,3})-(?:pin|lead)\s+[A-Z]{2,8}\b/i,
    // The count and the family are not always adjacent. An ADXL345 writes
    // `14-lead, plastic package` in one place and `3 mm x 5 mm x 1 mm LGA
    // package` in another, so no form pairing a count WITH a family sees either,
    // and a correctly read fourteen-row pin table had nothing to corroborate it.
    //
    // Requiring the word `package` is what makes this safe, and it is a stronger
    // constraint than the form above rather than a weaker one: that form accepts
    // any two-to-eight letter word after the count, so it would read `128-pin
    // FPGA companion` in a reference design as a declaration about this part.
    // This one only fires where the document says the thing being counted IS a
    // package. The span is bounded and may not cross a sentence.
    /\b(\d{1,3})-(?:pin|lead)s?\b[^.]{0,24}\bpackage\b/i,
    /\b([A-Z]{2,6})-(\d{1,3})\b/,
    /\b([A-Z]{2,6})\s+\((\d{1,3})\)/
  ];

  for (const pattern of patterns) {
    for (const match of allMatches(scope, pattern)) {
      // The first pattern captures only the count; the other two capture the
      // letters first so they can be judged.
      const [first, second] = match.groups;
      const prefix = second === undefined ? null : (first ?? "").toUpperCase();
      const count = Number(second ?? first);

      if (prefix && (NOT_A_PIN_COUNT_PREFIX.has(prefix) || NOT_A_PACKAGE.has(prefix))) continue;
      // A 1-pin package does not exist, so a (1) is a signal label, not a
      // designator. Same false positive that made ST's "OUT (1)" a package.
      if (!Number.isFinite(count) || count < 2 || count > 1000) continue;

      return extractedValue(count, 0.7, cite(doc, match));
    }
  }

  return unknown<number>();
}

/**
 * The pin count an ORDERING SCHEME encodes in the part number.
 *
 * An MCU datasheet covers a whole family, so it declares no single pin count. It
 * does print the scheme that decodes the ordering code, as a labelled list:
 *
 *     Pin count
 *       T = 36 pins
 *       C = 48 pins
 *       R = 64 pins
 *       V = 100 pins
 *
 * The mapping is READ from that list rather than remembered. `C = 48` is this
 * document's statement about this family, and a table of vendor letters carried
 * in code is exactly the kind of knowledge that goes stale silently.
 *
 * Only the POSITION is structural: the code sits immediately after the subfamily
 * digits, which is what the scheme's own example (`STM32 F 103 C 8 T 7`) lays
 * out. Position is needed because a letter appears in more than one of the
 * scheme's lists — `T` is both 36 pins and an LQFP — so searching the part number
 * for any listed letter is ambiguous where reading the one at the right offset is
 * not.
 *
 * This unblocks nothing by itself. It supplies the count that CHOOSES among the
 * package columns of a pin table that has already proved itself: an STM32F103C8's
 * table yields a clean 1..48 and a clean 1..64 side by side, and nothing else in
 * the document says which one the caller is holding.
 */
const ORDERING_PIN_COUNT_HEADING = /^pin\s+count$/i;

/**
 * One entry of the pin-count list.
 *
 * The unit word is OPTIONAL, because ST does not always print it: an
 * STM32G071RB's scheme reads `C = 48` and `R = 64` with no `pins` anywhere,
 * while an STM32F030C8's reads `C = 48 pins`. Requiring the word cost the whole
 * list on the documents that omit it.
 *
 * Dropping it entirely would be unsafe, since the list that FOLLOWS this one is
 * flash sizes and `B = 128 Kbytes` has exactly this shape. So the entry must end
 * either in a unit word or at the end of the line, which `B = 128 Kbytes` does
 * neither of. The section heading between the two lists stops the scan anyway;
 * this is the second guard, not the first.
 *
 * `balls` counts as a unit because a BGA is written that way, and a slashed
 * second figure is allowed because ST writes `V = 100/99 pins` where a variant
 * drops a pin, and `I = 176 pins/176+25 balls` for a part sold both ways. The
 * first number is the one that names the package this scheme is indexing.
 */
const ORDERING_CODE_LINE = /^([A-Z])\s*=\s*(\d{1,3})(?:\/\d{1,3})?(?:\s*(?:pins?|balls?)\b|\s*$)/i;
const ORDERING_PART_NUMBER = /^(STM32[A-Z])(\d+)([A-Z])/i;

function findOrderingSchemePinCount(doc: DatasheetText, partNumber: string | null): number | null {
  const code = partNumber ? ORDERING_PART_NUMBER.exec(partNumber)?.[3]?.toUpperCase() : null;
  if (!code) return null;

  for (const page of doc.pages) {
    const lines = [...page.items]
      .sort((left, right) => right.y - left.y || left.x - right.x)
      .map((item) => cleanValue(item.str));

    for (let index = 0; index < lines.length; index += 1) {
      if (!ORDERING_PIN_COUNT_HEADING.test(lines[index])) continue;

      // The list runs until a line that is not one of its entries, so a heading
      // cannot reach across the page and collect an unrelated list.
      const counts = new Map<string, number>();
      for (let next = index + 1; next < Math.min(index + 10, lines.length); next += 1) {
        const entry = ORDERING_CODE_LINE.exec(lines[next]);
        if (!entry) break;
        counts.set(entry[1].toUpperCase(), Number(entry[2]));
      }

      const found = counts.get(code);
      if (found !== undefined) return found;
    }
  }

  return null;
}

function classifyPinType(name: string, description = ""): PinElectricalType {
  const merged = `${name} ${description}`.toUpperCase();
  if (/\b(NC|NO CONNECT)\b/.test(merged)) return "nc";
  if (/\b(GND|VCC|VDD|VSS|VEE|V\+|V-|POWER|SUPPLY)\b/.test(merged)) return "power";
  if (/\b(OUT|OUTPUT)\b/.test(merged)) return "output";
  if (/\b(IN|INPUT|VIN)\b/.test(merged)) return "input";
  if (/\b(SDA|SCL|TX|RX|CLK|DATA|DIO|IO)\b/.test(merged)) return "bidirectional";
  return "unspecified";
}

const PIN_SECTION_HEADING =
  /(?:Pin\s+Functions|Pin\s+Description[s]?|Terminal\s+Functions|Pin\s+Configuration[s]?|Pin\s+Assignment[s]?|Signal\s+Description[s]?)/i;

/**
 * Dotted leaders, the signature of a table-of-contents entry.
 *
 * Datasheets name their pin section in the contents before the section itself,
 * so the FIRST match of the heading is almost always the contents line. The
 * parser then read contents entries as pin rows, found nothing, and reported no
 * pin table. Measured across the corpus this was the single largest cause of
 * missing pin data: 20 of 24 blocked parts had a real pin section the parser
 * never reached.
 */
const TOC_LEADER = /\.{4,}|(?:\.\s){4,}/;

/** Finds the pin section, skipping contents entries that merely name it. */
function findPinSection(text: string): RawMatch | null {
  const candidates = allMatches(text, PIN_SECTION_HEADING);
  for (const candidate of candidates) {
    // Judge by what FOLLOWS the heading: a contents entry is followed by dotted
    // leaders and a page number, a real section by the table itself.
    const following = text.slice(candidate.index, candidate.index + 300);
    if (!TOC_LEADER.test(following)) return candidate;
  }
  return candidates[0] ?? null;
}
const SIGN_LINE = /^[+\-–−]$/;
/**
 * Pin-name characters include the Unicode minus and en dash, because datasheets
 * set the "-" of an inverting input as a typographic minus, not ASCII. Missing
 * them silently dropped every inverting input and V- from the table.
 */
/**
 * A pin-function table row: NAME, number, type, description.
 *
 * **Measured negative, 2026-07-27. Do not widen the type column again without
 * new evidence.** Real tables mostly abbreviate the type, and a TI SN65HVD230
 * reads `D 1 I`, `GND 2 GND`, `VCC 3 Supply`, `CANL 6 I/O`, of which only the
 * `I/O` rows match here. Adding the terse forms (`I`, `O`, `P`, `GND`, `Supply`,
 * and the rest) looked obviously right and moved the benchmark by nothing:
 * export-readiness, package and citation rates were identical to four
 * significant figures before and after.
 *
 * The reason is worth keeping. The extra matches were not table rows, they were
 * PINOUT DIAGRAM lines, and they arrive with the number glued to the name:
 * `OutA1`, `IN–3`, `GND4`, `V–4`, `OUT61`. So the wider vocabulary bought noise
 * that the completeness gate then threw away, while leaving the matcher loose
 * enough that a stray prose run could one day fake a gap-free 1..N.
 *
 * The tables this misses are not missed because of the type column. They are
 * missed because pdf-parse interleaves the wrapped description column between
 * the rows, which no row-at-a-time regex recovers from. That needs column
 * geometry, the same conclusion the number-first pin tables reached.
 */
const PIN_ROW = /^([A-Z][A-Z0-9\s+\-_/–−]*?)\s+(\d{1,3})\s+(Input|Output|Power|Passive|Bidirectional|I\/O|NC)\b\s*(.*)$/i;

/**
 * Fewest rows a pin table may have and still be believed. A two-terminal part
 * exists; a one-row "table" is a line of prose that matched `PIN_ROW`.
 */
const MIN_TABLE_PINS = 2;

/** Normalizes typographic minus variants to ASCII so names compare and export cleanly. */
/**
 * A pin name's sign, written as ASCII.
 *
 * `±` is in the list because of how a PDF encodes it, not because of what it
 * means: an INA240's pinout figure draws `IN–` and the font hands that glyph
 * back as `±`, so the part exported with a pin called `IN±`. Confirmed by
 * RENDERING page 3 rather than by reading the text layer, which is the only way
 * to settle a question about a drawing. A pin name carries a plus or a minus; it
 * does not carry a tolerance, and no other name in the corpus contains one.
 */
function normalizeSigns(name: string): string {
  return name.replace(/[–−±]/g, "-");
}

/**
 * Parses the pin table. Superscript +/- signs land on their own baseline and so
 * arrive as their own line; they belong to the row that follows. The old parser
 * had no way to see that, which is why it found 8 of LMP7704-SP's 14 pins.
 *
 * Returns an empty list when no table is found. It never synthesizes rows.
 */
function extractPinTable(doc: DatasheetText): { pins: PinRecord[]; citation: Citation | null; confidence: number } {
  const heading = findPinSection(doc.text);
  const sectionStart = heading ? heading.index : 0;
  const scope = doc.text.slice(sectionStart, sectionStart + 6000);

  const pins: PinRecord[] = [];
  const seen = new Set<string>();
  let pendingSign = "";
  let cursor = sectionStart;
  let firstRowIndex: number | null = null;

  for (const rawLine of scope.split("\n")) {
    const lineStart = cursor;
    cursor += rawLine.length + 1;
    const line = rawLine.trim();
    if (!line) continue;

    if (SIGN_LINE.test(line)) {
      pendingSign = /[+]/.test(line) ? "+" : "-";
      continue;
    }

    const row = PIN_ROW.exec(line);
    if (!row) {
      // Headers and stray prose reset any dangling sign so it cannot attach to
      // an unrelated row further down.
      if (!/^(PIN|TYPE|DESCRIPTION|NAME|NO\.?)$/i.test(line)) pendingSign = "";
      continue;
    }

    const tokens = row[1].trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      pendingSign = "";
      continue;
    }

    // The sign is a superscript on the first token, so "IN A" with a leading
    // "+" is IN+A and a bare "V" is V+.
    const name = normalizeSigns(
      pendingSign ? [tokens[0], pendingSign, ...tokens.slice(1)].join("") : tokens.join("")
    );
    pendingSign = "";

    const number = row[2];
    const typeLabel = row[3];
    const description = cleanValue(row[4] ?? "");

    if (!name || name.toUpperCase() === "PAD" || name.toUpperCase() === "LID") continue;
    if (seen.has(number)) continue;
    seen.add(number);
    if (firstRowIndex === null) firstRowIndex = lineStart;

    pins.push({
      number,
      name,
      electricalType: classifyPinType(name, `${typeLabel} ${description}`),
      description: description || undefined
    });
  }

  pins.sort((left, right) => Number(left.number) - Number(right.number));

  // A read that is not a whole table is not a small table, it is noise.
  //
  // `PIN_ROW` matches anything shaped like NAME NUMBER TYPE, and body prose hits
  // that often enough to matter: over the benchmark corpus it produced pins 16
  // and 18 for an 8-pin LM358, pin 73 alone for an STM32F103C8, and one row of
  // an AD8628 named "GENERALDESCRIPTIONWithanoffsetvoltageofonly". Those reads
  // were not merely useless. Where the document declared no count of its own,
  // `pins.length` became the pin count, and four parts in the corpus passed the
  // export gate on them: an STM32F103C8 was export-ready as a ONE-PIN part.
  //
  // So the table is now held to the same bar as the pinout figure, which has
  // refused partial reads since it was written: the numbers it recovered must be
  // exactly 1..N with no gaps. That is what a table of a real package looks like
  // when it has been read whole, and it is not what prose produces. Every one of
  // the fourteen bad reads in the corpus fails it.
  //
  // The floor is two rows rather than the figure's four, because a two- or
  // three-terminal part is a real thing this product must not refuse, and with
  // the 1..N rule a spurious pair has to be numbered exactly 1 and 2 to survive.
  // It is set by what the corpus showed, not by taste: two rows is the smallest
  // floor that rejects all fourteen.
  const numbers = pins.map((pin) => Number(pin.number));
  const complete = numbers.length >= MIN_TABLE_PINS && numbers.every((value, index) => value === index + 1);
  if (!complete) return { pins: [], citation: null, confidence: 0 };

  const citation =
    firstRowIndex !== null ? citationAt(doc, firstRowIndex, 40) : heading ? cite(doc, heading) : null;

  return { pins, citation, confidence: heading ? 0.85 : 0.6 };
}

/**
 * One row of a two-column top-view pinout figure: the left pin and its number,
 * then the right pin's number and its name, which is the order pdf-parse emits
 * for that layout.
 *
 *   VCC1 1 16 VCC2
 *   GND1 2 15 GND2
 */
const DIAGRAM_PIN_NAME = String.raw`[A-Z][A-Z0-9+\-_/.–−]*`;
const DIAGRAM_ROW = new RegExp(
  String.raw`^(${DIAGRAM_PIN_NAME})\s+(\d{1,3})\s+(\d{1,3})\s+(${DIAGRAM_PIN_NAME})$`,
  "i"
);

/** Two rows is the smallest thing that can be a two-column figure at all. */
const MIN_DIAGRAM_PINS = 4;

/**
 * Reads the pinout figure rather than the pin function table.
 *
 * This is worth a second parser because unlike every other pin signal it carries
 * its own proof. In a top view the left column ascends while the right descends,
 * so leftNumber + rightNumber is the same constant on every row, and that
 * constant is pinCount + 1. Since both numbers are then bounded by that sum, a
 * figure that yields sum - 1 distinct numbers has yielded exactly 1..N with no
 * gaps. Prose does not do that by accident.
 *
 * Measured over the 37-part benchmark corpus: 6 parts whose function table no
 * regex could read (ADS1115, ADC128S102QML-SP, SN74LVC1G08, TPS7A4501-SP,
 * TXB0104, UCC27524) give a complete and internally consistent pinout here.
 *
 * Returns null unless the figure proves itself complete. A partial read is
 * refused rather than reported, because a footprint built from half a pinout is
 * worse than an honest gap.
 */
function extractPinDiagram(doc: DatasheetText): { pins: PinRecord[]; citation: Citation | null } | null {
  const bySum = new Map<number, { number: number; name: string; index: number }[]>();
  let cursor = 0;

  for (const rawLine of doc.text.split("\n")) {
    const lineStart = cursor;
    cursor += rawLine.length + 1;

    const row = DIAGRAM_ROW.exec(rawLine.trim());
    if (!row) continue;

    const left = Number(row[2]);
    const right = Number(row[3]);
    // The left column ascends and the right descends, so the left number is
    // always the smaller one. Rows that do not obey that are not this figure.
    if (left < 1 || left >= right) continue;

    const sum = left + right;
    const group = bySum.get(sum) ?? [];
    group.push({ number: left, name: normalizeSigns(row[1]), index: lineStart });
    group.push({ number: right, name: normalizeSigns(row[4]), index: lineStart });
    bySum.set(sum, group);
  }

  // Every candidate sum is judged on its own. Looking at only the largest group
  // was the first attempt and it was wrong: on a 50-page UCC27524 an unrelated
  // parameter table outgrew the real figure, and the real figure was never
  // reached. Completeness is what makes a group trustworthy, not size.
  const complete: { sum: number; names: Map<number, { name: string; index: number }> }[] = [];

  for (const [sum, rows] of bySum) {
    // A figure is at least two rows, so at least four pins. Without this floor a
    // single stray line establishes its own trivially "complete" group: the
    // UCC27524 timing table's "tM 1 2 ns" reads as a complete 2-pin part and
    // then conflicts with the real 8-pin figure, so both were thrown away.
    if (sum - 1 < MIN_DIAGRAM_PINS || rows.length < 4) continue;

    const names = new Map<number, { name: string; index: number }>();
    let consistent = true;

    for (const row of rows) {
      const existing = names.get(row.number);
      if (!existing) {
        names.set(row.number, { name: row.name, index: row.index });
        continue;
      }
      // One datasheet often draws several devices or package variants, and they
      // can disagree about what lives at a position: ISO7741 pin 6 is IND in one
      // figure and OUTD in the other, SN65HVD230 pin 8 is RS or NC by variant.
      // That is a real ambiguity in the source, so the figure is refused.
      if (existing.name.toUpperCase() !== row.name.toUpperCase()) {
        consistent = false;
        break;
      }
    }

    // Both numbers on a row are bounded by the sum, so sum - 1 distinct numbers
    // means the set is exactly 1..N with no gaps. Anything less is a partial
    // read of the figure and is not reported as a pinout.
    if (consistent && names.size === sum - 1) complete.push({ sum, names });
  }

  if (complete.length === 0) return null;
  // Two complete figures that imply different pin counts are two packages, and
  // choosing between them is the caller's job, not a regex's.
  if (complete.some((candidate) => candidate.sum !== complete[0].sum)) return null;

  const best = complete.reduce((left, right) => (right.names.size > left.names.size ? right : left));
  const pins: PinRecord[] = [...best.names.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([number, entry]) => ({
      number: String(number),
      name: entry.name,
      electricalType: classifyPinType(entry.name)
    }));

  const firstRow = Math.min(...[...best.names.values()].map((entry) => entry.index));
  return { pins, citation: citationAt(doc, firstRow, 40) };
}

/**
 * Does the pinout FIGURE resolve to the same pin count as the table?
 *
 * Corroboration by a second reader that shares no code with the first. The table
 * reader proves a gap-free 1..N down a column of row geometry; the figure reader
 * proves one by the constant sum of opposing sides. Neither can produce the
 * other's proof by accident, so agreement on N is evidence about the DEVICE and
 * not merely about the table, which is exactly what `needsCorroboration` asks for.
 *
 * Deliberately compares the COUNT and nothing else. The two readers disagree
 * about names often and legitimately (a figure abbreviates what a table spells
 * out), and requiring the names to match would refuse parts that are read
 * correctly. The count is the value the footprint is built from and the only one
 * this needs to settle.
 *
 * No declared count is passed. Supplying one lets the figure reader choose among
 * figures using the very signal this is standing in for, which would make the
 * agreement circular.
 */
function figureAgreesWithTable(
  doc: DatasheetText,
  tablePins: number,
  partNumber?: string,
  packageType?: string
): boolean {
  const figure = extractPinFigureByGeometry(doc, partNumber, packageType, null);
  return figure !== null && figure.pins.length === tablePins;
}

/**
 * The pin signal, from the function table when it is readable and from the
 * pinout figure when it is not.
 *
 * `selfVerified` marks a result the document proved internally, which only the
 * figure can do (see extractPinDiagram). Callers use it to decide whether the
 * pin count may be trusted over a disagreeing package designator.
 */
function extractPins(
  doc: DatasheetText,
  partNumber?: string,
  packageType?: string,
  /**
   * The count the document declares, used by ONE reader and only to choose
   * between number columns that have each already proved themselves; see
   * `readContinuedTable`. It never vouches for a column.
   */
  declaredCount?: number | null,
  /** Whether `packageType` came from the caller rather than from the document. */
  packageRequested = false
): {
  pins: PinRecord[];
  citation: Citation | null;
  confidence: number;
  selfVerified: boolean;
  /**
   * Set when the pins were read as a table whose subject cannot be confirmed.
   * The reader proved a well-formed table exists; it could not prove the table
   * belongs to the device being asked about, so the count must be corroborated
   * by the document's own declared count before it is believed.
   */
  needsCorroboration?: boolean;
  /**
   * The pins came from a TABLE read off row geometry, not from a figure.
   *
   * Load-bearing for the figure tie-break in `buildPartRecord`: asking whether a
   * figure agrees with pins the FIGURE itself produced compares a reader to
   * itself and always says yes. That is the AD590 shape, an eight-pin figure on
   * a part declared as a two-lead flatpack, and it is guarded by a test.
   */
  fromTable?: boolean;
} {
  // Geometry first. It is the only reader that sees the page as a table rather
  // than as lines, so it recovers rows whose description column wrapped, which
  // is the shape that defeats both readers below. It also proves itself twice
  // over: the numbers it found spell 1..N with no gaps, and the type column
  // reads as pin types rather than as a figure's opposite-side numbers.
  const geometry = extractPinTableByGeometry(doc, partNumber, packageType, declaredCount);

  // Where the table's length CONTRADICTS the count the document declares, and a
  // figure on the same document agrees with that count, the figure is the better
  // answer.
  //
  // This is the rule `readContinuedTable` already applies to a table's per-package
  // columns and `extractPinFigureByGeometry` to a document's several figures,
  // applied one level up: the count only ever chooses between readings that have
  // each already proved themselves, so it cannot promote a bad one.
  //
  // Without it the first reader wins outright and its disagreement then throws the
  // pin count away, losing BOTH answers. Measured on the hold-out, that is the
  // largest single loss: a document drawing a five-pin SOT and an eight-pin SOIC
  // has the table reader find one and the designator declare the other, and the
  // part comes back with a pinout it refuses to count.
  if (geometry && declaredCount != null && geometry.pins.length !== declaredCount) {
    const corroborated = extractPinFigureByGeometry(doc, partNumber, packageType, declaredCount, packageRequested);
    if (corroborated && corroborated.pins.length === declaredCount) {
      return {
        pins: corroborated.pins.map((pin) => ({
          number: String(pin.number),
          name: normalizeSigns(pin.name),
          electricalType: classifyPinType(pin.name)
        })),
        citation: citationAt(doc, corroborated.start, 40),
        confidence: 0.9,
        selfVerified: false,
        needsCorroboration: true
      };
    }
  }

  // An UNCAPTIONED table that contradicts the document's own declared count is
  // not evidence, and keeping it here was producing fabricated pinouts.
  //
  // Measured on LP5907, found by cross-checking against a model on 2026-08-11.
  // Page 17 is `7.4 Layout / Layout Guidelines` and carries an application
  // circuit; the reader took the symbol's callouts as a three-row table and the
  // record shipped pins named `VINCIN`, `GND`, `Enable` at confidence 0.9,
  // citing a layout page. The document declares a 4-pin DSBGA and page 3 draws
  // the real pinout.
  //
  // The type-column proxy cannot catch this and never could: on a schematic the
  // pin labels ARE the type vocabulary, so `IN`, `GND`, `EN` scores three out of
  // three. What the fabrication cannot fake is agreement with a count the
  // document states somewhere else.
  //
  // Narrow on purpose, in both directions. A CAPTIONED table is the vendor
  // saying "these rows are the pinout", and it is allowed to disagree with a
  // designator, which is the existing behaviour for the multi-package documents
  // where the caption is the only thing that distinguishes siblings. And where
  // no count is declared there is nothing to contradict, so nothing changes.
  // An uncaptioned table that agrees with NOTHING in the document is dropped.
  //
  // By this point the table contradicts the declared count and no figure matched
  // the COUNT. One case remains where keeping it is right: a figure that
  // independently resolves to the TABLE's length, two readers agreeing against a
  // designator, which is the measured tie-break above and is worth a part.
  //
  // What is left over is a table agreeing with nobody, and that is where the
  // fabrications live. LP5907's page 17 is `7.4 Layout / Layout Guidelines` with
  // an application circuit on it; the reader took the symbol callouts as three
  // rows and the record shipped pins named `VINCIN`, `GND`, `Enable` at
  // confidence 0.9. The document declares a 4-pin DSBGA and page 3 draws the
  // real pinout, so the table matched neither.
  //
  // The type-column proxy cannot catch this and never could: on a schematic the
  // pin labels ARE the type vocabulary, so `IN`, `GND`, `EN` scores three out of
  // three. Agreement with an independent reading is what a fabrication cannot
  // fake.
  //
  // Narrow in both directions. A CAPTIONED table is the vendor saying "these
  // rows are the pinout" and may still disagree with a designator, which is what
  // separates siblings on a multi-package document. Where no count is declared
  // there is nothing to contradict and nothing changes.
  const uncorroborated =
    geometry !== null &&
    !geometry.claimed &&
    declaredCount != null &&
    geometry.pins.length !== declaredCount &&
    extractPinFigureByGeometry(doc, partNumber, packageType, null)?.pins.length !== geometry.pins.length;

  if (geometry && !uncorroborated) {
    return {
      pins: geometry.pins.map((pin) => ({
        number: pin.number,
        name: pin.name,
        electricalType: classifyPinType(pin.name, `${pin.type} ${pin.description}`),
        description: pin.description || undefined
      })),
      citation: citationAt(doc, geometry.start, 40),
      confidence: 0.9,
      // NOT self-verified, and the distinction is the whole point. This proves
      // the page holds a well-formed pin table; it does not prove the table is
      // THIS part's. A TLV9061 datasheet also covers the TLV9062 and TLV9064,
      // and the first complete table on the page set is the quad's: reading it
      // as self-verifying made a five-pin op-amp export as a sixteen-pin part.
      //
      // The pinout figure earns the flag because its proof is about the device
      // it draws. A table's proof is only about the table.
      selfVerified: false,
      // Unless the table's own caption names the part that was asked for, which
      // is a proof about the device and is what corroboration was ever for. The
      // TLV9061 case above is exactly this: `Table 5-1. Pin Functions: TLV9061`
      // sits above the five-pin table and `Pin Functions: TLV9064S` above the
      // sixteen-pin one. A claimed table still does not outrank a declared count
      // that CONTRADICTS it, because the numbering proof says nothing about
      // which package the caller wants.
      needsCorroboration: !geometry.claimed,
      fromTable: true
    };
  }

  const table = extractPinTable(doc);
  const diagram = extractPinDiagram(doc);

  if (!diagram) {
    if (table.pins.length > 0) return { ...table, selfVerified: false };

    // Last resort, and deliberately last: the pinout figure read off the page
    // GEOMETRY rather than the flattened text. It runs only when both text
    // readers found nothing, so it can add parts and cannot take any away.
    //
    // Its count is NOT self-verified, which is the difference between it and the
    // text figure reader above. The constant-sum proof says the figure is
    // complete, not that it is the package the caller wants, and a datasheet
    // draws several: an AD590 draws an eight-pin SOIC while declaring a two-lead
    // flatpack, an AD8628 draws an eight-pin SOIC and a five-pin TSOT. So the
    // pins are reported and the count waits for the declared count to agree,
    // which is the same rule the geometry TABLE follows and for the same reason.
    //
    // UNLESS the figure's own caption names the package that was asked for, which
    // is `packageClaimed`. That is the objection above answered in the document's
    // own words: the doubt is never that the figure is incomplete, it is that a
    // complete figure does not say WHICH package it draws, and a caption naming
    // the requested package says exactly that. It does not apply to the AD590,
    // whose lone SOIC figure is captioned nothing like its flatpack, and it
    // cannot be satisfied by two captioned figures of different lengths, because
    // `agree` still has to hold across everything the caption selected.
    //
    // This is what makes a package choice worth making. An OPA192 user who picks
    // `SOT-23 (DBV)` gets a five-pin figure captioned for that package and
    // nothing else in the document to corroborate it with, since the front matter
    // describes the eight-pin SOIC.
    const figure = extractPinFigureByGeometry(doc, partNumber, packageType, declaredCount, packageRequested);
    if (figure) {
      return {
        pins: figure.pins.map((pin) => ({
          number: String(pin.number),
          name: normalizeSigns(pin.name),
          electricalType: classifyPinType(pin.name)
        })),
        citation: citationAt(doc, figure.start, 40),
        confidence: 0.85,
        selfVerified: false,
        needsCorroboration: figure.packageClaimed !== true
      };
    }

    return { ...table, selfVerified: false };
  }
  // When both agree on the count the table wins on content, since it carries
  // the type column and the description the figure does not have.
  if (table.pins.length === diagram.pins.length) return { ...table, selfVerified: true };

  // The text figure reader won, so the answer is a FIGURE. Where the geometry
  // reader read the same figure and agrees on the count, its NAMES supersede: it
  // is reading positions rather than a flattened line, so it recovers a name that
  // arrives in several runs and a subscript on its own baseline. The text reader
  // sees only what survived flattening, which is how an SN74LVC1G08 pin 6 came
  // back called `V` when the figure says `VCC`.
  //
  // Only the names change. The count is the text reader's and stays self-verified
  // on the strength of the agreement, so this cannot alter which pins exist.
  // The declared count is passed here for the same reason it is passed above: a
  // document drawing several packages offers several figures, and where neither
  // the device nor the package caption separates them the count does. An
  // SN74LVC1G08 draws its DBV, DRL, DSF, YZP and DRY packages on one page, two of
  // them five-pin and two six-pin, so without it the figures disagree, no names
  // supersede, and pin 6 goes back to the `V` the flattened text gives.
  const geometryFigure = extractPinFigureByGeometry(doc, partNumber, packageType, declaredCount, packageRequested);
  if (geometryFigure && geometryFigure.pins.length === diagram.pins.length) {
    const byNumber = new Map(geometryFigure.pins.map((pin) => [String(pin.number), pin.name]));
    return {
      ...diagram,
      pins: diagram.pins.map((pin) => {
        const better = byNumber.get(String(pin.number));
        return better ? { ...pin, name: normalizeSigns(better) } : pin;
      }),
      confidence: 0.9,
      selfVerified: true
    };
  }

  return { ...diagram, confidence: 0.9, selfVerified: true };
}

/**
 * A dimension the document states, and ONLY where it states one.
 *
 * Every dimension here is a property of ONE PACKAGE, and this reads the whole
 * document, so on a family datasheet taking the first match answers with
 * whichever package the document happens to mention first. That was measured on
 * the lead pitch, where an STM32G071RB came back as a 0.4 mm part off a WLCSP
 * entry in its own package list and an STM32H743ZI as 1.00 mm off a ball grid
 * array. Both are 0.5 mm parts, and the wrong value did not merely sit in the
 * record: it VETOED a correct land pattern, because the resolver refuses when
 * the extracted pitch disagrees with the family's.
 *
 * Body length and width are the same kind of value read the same way, and they
 * reach the emitted body outline and the 3D model.
 *
 * So the rule is the one `soleDeclaredLeadCount` already applies to lead counts:
 * where a document states several values, none of them is known to be THIS
 * package's, and unknown is the honest answer. A document describing one package
 * still answers, which is the common case and the one these were useful for.
 *
 * The drawing reader is unaffected and still outranks this, because it confirms
 * the drawing is this part's before reading anything off it. See
 * `withDrawnDimensions`.
 */
function findDimension(doc: DatasheetText, pattern: RegExp, confidence = 0.7): Extracted<number> {
  const seen = new Map<number, RawMatch>();
  for (const match of allMatches(doc.text, pattern)) {
    const raw = match.groups[0];
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (!seen.has(value)) seen.set(value, match);
  }

  if (seen.size !== 1) return unknown<number>();
  const [[value, match]] = [...seen];
  return extractedValue(value, confidence, cite(doc, match));
}

/**
 * Merges what the mechanical drawing states into the dimensions read from prose.
 *
 * The drawing WINS wherever it has an answer, and that ordering is the point of
 * reading it. A prose pitch is a regex over whatever sentence happened to use
 * the word, and this corpus has caught that pattern picking up a neighbouring
 * package's figure; a drawing's `6X 1.27` is the pitch of the outline it is
 * drawn on, tagged with a repeat count that checks against the pin count, on a
 * page already confirmed to be this part's package.
 */
function withDrawnDimensions(
  dimensions: PackageDimensions,
  drawn: DrawnDimensions | null
): PackageDimensions {
  if (!drawn) return dimensions;

  // Confidence 0.9 rather than the prose reader's 0.7: the value is tagged with
  // a repeat count that had to agree with the pin count before it was accepted.
  const pitch = drawn.pitchMm
    ? extractedValue(drawn.pitchMm.value, 0.9, drawn.pitchMm.citation)
    : dimensions.pitchMm;
  const leadWidth = drawn.leadWidthMm
    ? extractedValue(drawn.leadWidthMm.value, 0.9, drawn.leadWidthMm.citation)
    : dimensions.leadWidthMm;

  return { ...dimensions, pitchMm: pitch, leadWidthMm: leadWidth };
}

function parseDimensions(doc: DatasheetText, leadCount: Extracted<number>): PackageDimensions {
  // A LABELLED body dimension only. The two-number front-matter pair used to
  // fill these and it is not a body, which cross-checking against the model
  // caught on 2026-08-11 in two different ways at once:
  //
  //   INA226   "PACKAGE SIZE     VSSOP (10)  3.00mm x 4.90mm"
  //            4.90 is the LEAD SPAN. The body is 3.0 x 3.0 (drawing DGS0010A,
  //            page 37). The second number is not a body dimension at all.
  //   PCM1808  "BODY SIZE (NOM)  TSSOP (14)  4.40 mm x 5.00 mm"
  //            both ARE body dimensions, printed WIDTH FIRST. The drawing
  //            PW0014A on page 27 gives length 5.0 (note 3) and width 4.4
  //            (note 4), so the pair assigned both the wrong way round.
  //
  // A third instance was already on record: DRV8825 prints 9.70 x 6.40 against
  // its own GENERIC PACKAGE VIEW of 4.4 x 9.7. Three for three, and the two
  // failures are different, so no ordering rule and no header test recovers it.
  // The header does not even agree between the two documents above.
  //
  // Dropped rather than demoted. A value at confidence 0.5 still reaches the
  // courtyard and the silkscreen outline, and "usually wrong" is not a weaker
  // version of right. The labelled prose forms below say which dimension they
  // are, and the mechanical drawing remains the source that can be checked.
  const bodyLength = findDimension(doc, /body\s*length[^\d]{0,20}(\d+(?:\.\d+)?)\s*mm/i);
  const bodyWidth = findDimension(doc, /body\s*width[^\d]{0,20}(\d+(?:\.\d+)?)\s*mm/i);

  return {
    bodyLengthMm: bodyLength,
    bodyWidthMm: bodyWidth,
    bodyHeightMm: findDimension(doc, /body\s*height[^\d]{0,20}(\d+(?:\.\d+)?)\s*mm/i),
    pitchMm: findDimension(doc, PROSE_PITCH, 0.6),
    leadLengthMm: findDimension(doc, /lead\s*length[^\d]{0,20}(\d+(?:\.\d+)?)\s*mm/i),
    // No deterministic reader. The drawing reader can supply a lead width and
    // explicitly cannot supply a span; see `leadSpanMm` in types.ts.
    leadWidthMm: unknown<LeadWidth>(),
    leadSpanMm: unknown<LeadWidth>(),
    leadContactMm: unknown<LeadWidth>(),
    // No deterministic reader either. The exposed pad is dimensioned D2/E2 on a
    // drawing, which is arrows, so only a reader that can SEE the page supplies
    // these. Absent means a part with a pad is refused, which is correct.
    thermalPadLengthMm: unknown<number>(),
    thermalPadWidthMm: unknown<number>(),
    leadCount
  };
}

const PROSE_PITCH = /(?:lead\s+pitch|pitch)[^\d]{0,20}(\d+(?:\.\d+)?)\s*mm/i;

/**
 * Tries each pattern in order and takes the first that matches. Patterns are
 * ordered most specific first and are bounded: an unbounded "rest of the line"
 * capture swallows the prose that follows the value, which is how TID came back
 * as "100krad(Si) product, and a wide supply voltage. The device".
 */
function findRadiationField(doc: DatasheetText, patterns: RegExp[], confidence = 0.8): Extracted<string> {
  for (const pattern of patterns) {
    const match = firstMatch(doc.text, pattern);
    const raw = match?.groups[0];
    if (!match || !raw) continue;
    const value = cleanValue(raw);
    if (value) return extractedValue(value, confidence, cite(doc, match));
  }
  return unknown<string>();
}

/** A linear energy transfer spec, bounded so it stops at the unit. */
const LET_VALUE = String.raw`LET\s*=\s*[^\n]{0,24}?\/\s*mg`;

/**
 * A total dose figure, e.g. "100 krad(Si)", "300 kRad (Si, Functional)".
 *
 * The parenthesised species is optional because ST writes "tested up to 300 krad"
 * with no qualifier at all.
 *
 * Two guards, both from values this corpus produced:
 * - The leading lookbehind rejects a figure that starts mid-number. Without it
 *   UT54LVDS217's "Total Ionizing Dose (TID) 1.0E6 rad(Si)" was reported as
 *   "6 rad(Si)", off by five orders of magnitude and confidently cited.
 * - The trailing lookahead rejects a dose RATE. "10mrad(Si)/s" and "0.55 rad/s"
 *   are irradiation conditions, not a qualification level, and they appear far
 *   more often in a radiation report than the total dose does.
 */
const DOSE_FIGURE = String.raw`(?<![\d.eE])\d+(?:\.\d+)?\s*[kKmM]?[Rr]ad\s*(?:\(\s*Si[^)]{0,16}\))?(?!\s*/\s*s)`;

/**
 * A linear energy transfer figure in any of the punctuations vendors use for
 * MeV-cm2/mg: TI sets the separator as a middle dot, ST as a period, Microsemi
 * as a hyphen, and the exponent on cm2 is frequently lost in text extraction.
 */
const LET_FIGURE = String.raw`\d+(?:\.\d+)?\s*MeV\s*[·•.\-/]?\s*cm\s*2?\s*/\s*mg`;

/**
 * Radiation qualification, which is the field that decides whether a part is
 * usable at all for this product's customers, and the one the parser was worst
 * at: 3% corpus-wide and 13% even on rad-hard parts, because every pattern was
 * fitted to one TI phrasing with an equals sign.
 *
 * What the corpus actually shows: TI writes "Total Ionizing Dose 100 krad(Si)",
 * ST writes "Rad-hard: 300 kRad(Si) TID performance" with the value BEFORE the
 * cue, and Microsemi writes "Total Ionizing dose Up to 300 krad (Si, Functional)".
 * So the general patterns pair a cue with a bounded figure rather than trying to
 * spell out the sentence.
 *
 * The single-event patterns are deliberately case SENSITIVE. "SEE" and "SET"
 * are ordinary English words that appear on nearly every page of a datasheet
 * ("see Table 9", "set by an external resistor"), and matching them
 * case-insensitively next to any nearby number is how a prose sentence becomes
 * a radiation spec. Vendors always capitalise the acronym.
 */
function extractRadiationData(doc: DatasheetText): RadiationData {
  return {
    tid: findRadiationField(doc, [
      // Exact TI phrasing first, so a document that has it is unaffected.
      /(?:RHA\s+up\s+to\s+)?TID\s*[=:]\s*(\d+(?:\.\d+)?\s*[kKmM]?rad\s*(?:\([^)]{0,10}\))?)/i,
      new RegExp(
        String.raw`(?:Total\s+Ionizing\s+Dose|TID)\b[^\n]{0,40}?(${DOSE_FIGURE})`,
        "i"
      ),
      // ST puts the figure first: "Rad-hard: 300 kRad(Si) TID performance".
      new RegExp(String.raw`(${DOSE_FIGURE})\s{0,4}TID\b`, "i"),
      new RegExp(
        String.raw`(?:Rad[\s-]?hard\w*|Radiation\s+Hardness\s+Assur\w*|RHA)\b[^\n]{0,40}?(${DOSE_FIGURE})`,
        "i"
      ),
      /(?:RHA\s+up\s+to\s+)?TID\s*[=:]\s*([^\n,.;]{1,40})/i
    ]),
    see: findRadiationField(doc, [
      new RegExp(String.raw`SEE\s+characterized\s+to\s+(${LET_VALUE})`, "i"),
      new RegExp(String.raw`\b(?:SEE|SEU|SET|SEFI)\b[^\n]{0,60}?(${LET_FIGURE})`),
      /SEE\s+characterized\s+to\s+([^\n,.;]{1,40})/i
    ]),
    sel: findRadiationField(doc, [
      new RegExp(String.raw`SEL\s+(?:resilient|immune)\s+to\s+(${LET_VALUE})`, "i"),
      new RegExp(
        String.raw`(?:\bSEL\b|Single[\s-]?Event\s+Latch[\s-]?Up)[^\n]{0,60}?(${LET_FIGURE})`
      ),
      /SEL\s+(?:resilient|immune)\s+to\s+([^\n,.;]{1,40})/i
    ]),
    qmlClass: findQmlClass(doc)
  };
}

/**
 * QML class, in one of two canonical spellings: "QML Class V" or "QML-V".
 *
 * ST typesets it as "Qml-V qualified" and the hyphenated short form is as common
 * in this corpus as the spelled-out one, so both are read. The result is
 * canonicalised rather than kept verbatim because case and spacing carry no
 * meaning in a classification label, while "Qml-V" in an export record reads as
 * a parse fault. The citation still points at the source text, so the claim
 * stays checkable.
 */
function findQmlClass(doc: DatasheetText): Extracted<string> {
  const found = findRadiationField(
    doc,
    [/\b(QML[\s-]+Class\s+[A-Z0-9]+)\b/i, /\b(QML\s*-\s*[VQTNH])\b/i],
    0.9
  );
  if (found.value === null) return found;

  const spelledOut = /^QML[\s-]+Class\s+(\w+)$/i.exec(found.value);
  if (spelledOut) return { ...found, value: `QML Class ${spelledOut[1].toUpperCase()}` };

  const short = /^QML\s*-\s*(\w)$/i.exec(found.value);
  if (short) return { ...found, value: `QML-${short[1].toUpperCase()}` };

  return found;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * What the caller already knows, which the readers must not have to guess.
 *
 * Only the package so far, and it is the one that matters: a document offering
 * several packages does say what they are and cannot say which one the user is
 * holding. See `buildPartRecord`.
 */
export interface ExtractionHints {
  /**
   * The package the user picked, as printed in the document. Replaces the
   * designator search outright rather than competing with it.
   */
  packageType?: string | null;
}

/** A package designator is a short printed token; anything longer is not one. */
const MAX_PACKAGE_HINT_LENGTH = 64;

/**
 * The deterministic pass over already-extracted text. Split from the PDF read
 * so it can be exercised against synthetic documents, which is how the
 * "unknown stays unknown" behavior is tested without committing a fixture PDF
 * for every failure shape.
 *
 * `hints.packageType` is the answer to the one question the document genuinely
 * cannot answer for itself. Measured on the hold-out: nine parts of thirty-eight
 * read NOTHING unaided and read completely once a package is named, because
 * every reader below takes the package as an argument and uses it to choose
 * among per-package pinouts. That is the difference between 20 of 38 and 29 of
 * 38, and it is a click, not a lookup: the candidates are the ones this document
 * printed.
 */
export function buildPartRecord(
  doc: DatasheetText,
  fileName: string,
  sourceUrl?: string,
  hints?: ExtractionHints
): PartRecord {
  const partNumber = findPartNumber(doc, fileName);
  const manufacturer = findManufacturer(doc);

  // The vendor's own ordering table, where the document has one, REPLACES the
  // prose reader rather than adding to it. It is keyed to the part number, so it
  // is the only source here that can tell this part's packages from its
  // siblings', and the prose reader pools them by construction: an OPA333
  // document describes the OPA2333 too and prose yields seven families where the
  // ordering table yields two, of which exactly one has this part's pin count.
  //
  // Measured over both caches, on the 30 documents that have the table: it drops
  // an MSP430F5529 from six families to `LQFP (PN) | 80`, a TLV9061 from ten to
  // three, and it is the ONLY source for a CD4017B, whose prose yields nothing at
  // all. It also carries the outline CODE, which is what tells a `SOIC (D)` from
  // a `SOIC (DW)`; those two share a name and differ by 4.3 mm of lead span.
  //
  // Falling back rather than merging is deliberate. A union would put the
  // siblings straight back in, which is the thing this fixes.
  const orderable = findOrderablePackages(doc.text, partNumber.value ?? "");
  const packageVariants =
    orderable.length > 0 ? orderable : findPackageVariants(doc.text, frontMatterEnd(doc));

  // A supplied package REPLACES the search rather than being reconciled with it.
  // The search exists to guess what the user is holding; when the user has said,
  // there is nothing left to guess, and letting a lower-confidence designator
  // argue with them would be the same disagreement-means-unknown rule turned
  // against its own user.
  //
  // Carries `method: "user"` and NO citation, the same way the lookup route
  // marks a part number the requester supplied. It is not on the page in the
  // sense a citation claims, and a value the user chose must never be dressed as
  // a value the document stated.
  const hinted = hints?.packageType?.trim();
  const packageType =
    hinted && hinted.length > 0 && hinted.length <= MAX_PACKAGE_HINT_LENGTH
      ? { value: hinted, confidence: 1, method: "user" as const, citation: null }
      : findPackageType(doc, packageVariants);

  // Derived from the SETTLED value, not from the hint, so the two can never
  // drift: a hint that failed the length check above is not a choice.
  const userChosePackage = packageType.method === "user";
  const declaredPinCount = findDeclaredPinCount(doc);

  // The lead count the RESOLVED designator declares is a second source for this,
  // and a better-founded one than a fresh regex over the front matter: that
  // designator has already been checked to name a real package family, and its
  // count was parsed by the same reader that found it.
  //
  // It is what corroborates a pinout on the parts whose designator the front
  // matter pattern cannot see at all. `Flat-16P` is the case: that pattern is
  // case-sensitive where its sibling is not, so a mixed-case designator declared
  // nothing, and an RHFL4913A read a complete 16-pin table next to a 16-lead
  // package name and still reported an unknown pin count.
  //
  // Computed BEFORE the pins because one reader needs it: a table continued
  // across pages can prove two number columns at once (an MSP430F5529's 80-pin
  // and 64-pin columns are both internally perfect) and the declared count is
  // what picks. It is a selector there, never a corroboration; see
  // `readContinuedTable`.
  // The designator's OWN lead count comes first, ahead of the front-matter scan.
  //
  // Both are guesses, but they are not equally specific. `declaredLeadCount` reads
  // the count out of the package this part was settled on; `declaredPinCount` is a
  // regex over the front matter that matches the first `N-pin XXXX` it meets,
  // which on a family datasheet is routinely a SIBLING's package.
  //
  // Measured on the hold-out: an OPA2189 front matter yields 14 while its own
  // designator says `SOIC (8)`, and the pin table reads 8. Taking 14 made the
  // table look like a misread and the pin count was thrown away, on a part where
  // two of the three signals already agreed.
  //
  // The front-matter scan is SKIPPED entirely when the user named the package.
  // It is the one source here that is about a package rather than about the
  // document, and once a package has been chosen it is routinely about the wrong
  // one: an OPA192 user who picks `SOT-23 (DBV)` gets a correctly read five-pin
  // figure vetoed by an `8-Pin SOIC` in the front matter, which is a sentence
  // about the package they did not pick. Weighing evidence for package A against
  // evidence for package B is not a corroboration, and refusing on it defeats the
  // entire point of having asked.
  //
  // The other two sources survive the choice because they are about the document
  // as a whole and so are about the chosen package too: `soleDeclaredLeadCount`
  // only answers when EVERY package named agrees on one count, and the ordering
  // scheme decodes the count out of the part number. An SN74HC595 keeps its
  // sole-count of 16 and keeps refusing the 15-pin table that misreads it.
  const declared =
    (packageType.value !== null ? declaredLeadCount(packageType.value) : null) ??
    (userChosePackage ? null : declaredPinCount.value) ??
    // A family datasheet may declare no count anywhere while printing the scheme
    // that decodes one out of the ordering code.
    findOrderingSchemePinCount(doc, partNumber.value) ??
    // And where the package is AMBIGUOUS, the document may still name exactly one
    // lead count across every package it offers, which corroborates a table that
    // reads that many pins without saying which package the caller holds. An
    // ADG5412 is a 16-lead TSSOP and a 16-lead LFCSP: two packages, one count.
    soleDeclaredLeadCount(packageVariants);

  const {
    pins,
    citation: pinCitation,
    confidence: pinConfidence,
    selfVerified,
    needsCorroboration,
    fromTable
  } = extractPins(
    doc,
    partNumber.value ?? undefined,
    packageType.value ?? undefined,
    declared,
    // `method: "user"` is exactly the marker for a package the caller named; see
    // the hint handling above, which is the only place that sets it.
    packageType.method === "user"
  );

  // Two independent signals, the package designator and the pin table, either
  // corroborate each other or they do not. When they disagree, at least one is
  // a misread, and there is usually no basis for choosing between them: an AD590
  // (a 2-lead part) produced three garbage pins from a prose paragraph, and
  // preferring the "table" exported a 3-pad footprint. Disagreement therefore
  // means unknown, which fails closed at the export boundary.
  //
  // The one exception is a pin signal the document proved itself: a pinout
  // figure that resolves to a gap-free 1..N under a single constant sum cannot
  // be a misread, while the declared count is a regex over front matter that
  // this corpus has caught returning 220 for an LD1117 and 883 for an RTAX2000S.
  // Between a proof and a guess there IS a basis for choosing, so the proof
  // wins, and the discrepancy is written into the notes so it stays auditable.
  let pinCount: Extracted<number>;
  const disagrees = pins.length > 0 && declared !== null && declared !== pins.length;

  // A table read off the page geometry proves it is a real table and not that it
  // is THIS device's table. A TLV9061 datasheet also documents the TLV9062 and
  // TLV9064, and the only complete table in it is the quad's; taken on its own
  // it made a five-pin op-amp a sixteen-pin part. So an uncorroborated table
  // reports its pins, which are useful to look at, and refuses to set the count,
  // which is what the footprint is built from.
  const uncorroborated = needsCorroboration === true && declared === null && pins.length > 0;

  // A TABLE and a FIGURE that resolve to the same N, against a declared count
  // that disagrees with both.
  //
  // This is the exception above with a second proof standing in for the first.
  // The two readers share no code and prove different things: the table reader
  // finds a gap-free 1..N down a column of row geometry, the figure reader finds
  // one under a single constant sum across opposing sides. Neither can produce
  // the other's proof by accident, so their agreement is at least as strong as
  // the self-verified figure that already outranks a declared count here, and
  // the thing it outranks is the same regex that returned 220 for an LD1117.
  //
  // Computed ONLY inside the disagreement, which is rare. Running the figure
  // reader on every part that has a table costs 7% of p50 parse latency and 12%
  // of p95 for nothing: measured, agreement never changes the answer anywhere
  // else, because a table that already agrees with the declared count is
  // believed without it.
  const figureBacksTable =
    disagrees &&
    !selfVerified &&
    fromTable === true &&
    figureAgreesWithTable(doc, pins.length, partNumber.value ?? undefined, packageType.value ?? undefined);

  if (disagrees && !selfVerified && !figureBacksTable) {
    pinCount = unknown<number>();
  } else if (uncorroborated) {
    pinCount = unknown<number>();
  } else if (pins.length > 0) {
    const confidence = declared === pins.length ? 0.95 : selfVerified || figureBacksTable ? 0.9 : 0.7;
    pinCount = extractedValue(pins.length, confidence, pinCitation);
  } else if (userChosePackage) {
    // No pinout read for the package the user named, so there is no count that
    // is known to be ABOUT that package. The front-matter scan below would still
    // answer, and pairing its number with the user's package is how a wrong
    // footprint gets built silently: a document whose front matter says `14-Pin
    // SOIC` would give a user who picked the eight-lead VSSOP a fourteen-pad
    // land pattern, with nothing in the record marking the mismatch. The
    // `packageContradicts` guard below cannot catch it either, because a
    // designator like `VSSOP (DGK)` declares no count of its own to contradict.
    //
    // Failing closed here costs nothing that was working: a record with no pins
    // has no symbol to export regardless.
    pinCount = unknown<number>();
  } else {
    pinCount = declaredPinCount;
  }
  const conflicted = pinCount.value === null && pins.length > 0 && declared !== null;

  // A designator that declares a lead count and disagrees with the settled pin
  // count is about a DIFFERENT PACKAGE, and keeping it is how a part gets the
  // wrong land pattern. An ADC128S102QML-SP names four packages in its front
  // matter and the first one recognised is `14-pin CFP`; the part is 16 pins, so
  // that designator belongs to something else in the document. This is the same
  // rule the pin count follows one block up, applied to the other signal, and it
  // is the check the ISO7741 footprint failure was missing.
  const declaredLeads = packageType.value !== null ? declaredLeadCount(packageType.value) : null;
  const packageContradicts =
    declaredLeads !== null && pinCount.value !== null && declaredLeads !== pinCount.value;
  const survivingPackageType = packageContradicts ? unknown<string>() : packageType;

  // The pin count, once settled, can name the package the designator search
  // could not.
  //
  // `findPackageType` runs BEFORE the count exists, so on a family datasheet it
  // sees every package the document offers and answers with none of them: an
  // STM32G071RB's document names LQFP32, LQFP48, LQFP64 and more, and nothing at
  // that point says which is this part's. Once the pinout has been read and the
  // count settled at 64, exactly one of those declares 64, and it is no longer a
  // guess between candidates but the only candidate left.
  //
  // Requiring EXACTLY ONE survivor is what keeps it honest. An STM32F103C8 is 48
  // pins and its document offers LQFP48, VQFN48 and UQFN48, all of which declare
  // 48 and have entirely different land patterns; that stays unknown and is a
  // question for the user, which is what the package chooser is for.
  //
  // Only ever fills a BLANK. A designator already read off the page outranks
  // this, because it was read rather than deduced.
  const uniquelyCounted =
    survivingPackageType.value === null && pinCount.value !== null
      ? packageVariants.filter((variant) => variant.leadCount === pinCount.value)
      : [];
  const resolvedPackageType =
    uniquelyCounted.length === 1
      ? extractedValue(
          uniquelyCounted[0].designator.slice(0, 64),
          // Below every read designator. This is an inference from two things the
          // document does state, not a sentence the document contains.
          0.55,
          citationAt(doc, uniquelyCounted[0].index, 40)
        )
      : survivingPackageType;

  // Read AFTER the pin count is settled, because settling it is what lets the
  // drawing be confirmed as this part's: the outline code's lead count has to
  // agree with it. Both signals the drawing reader needs are now final.
  const drawn = readDrawingDimensions(doc, resolvedPackageType.value ?? undefined, pinCount.value);
  const dimensions = withDrawnDimensions(parseDimensions(doc, declaredPinCount), drawn);
  const radiation = extractRadiationData(doc);

  const resolvedFamily = resolvedPackageType.value
    ? (packageFamilies(resolvedPackageType.value)[0] ?? resolvedPackageType.value)
    : null;
  const printed = resolvedFamily ? findVendorLandPattern(doc, resolvedFamily) : null;
  const printedLand = printed
    ? { page: printed.page, valuesMm: printed.dimensions.map((dimension) => dimension.valueMm) }
    : null;

  const notes: string[] = [`PDF pages: ${doc.pageCount}`];
  if (doc.truncated) {
    notes.push(`Only the first ${doc.pages.length} pages were parsed (page cap ${MAX_PAGES}).`);
  }
  if (pins.length === 0) {
    notes.push("No pin table was detected. Pin data is recorded as unknown rather than estimated.");
  }
  if (conflicted) {
    notes.push(
      `Conflicting pin counts: the package designator declares ${declared} but ${pins.length} rows were read as a pin table. Both are suspect, so the pin count is recorded as unknown. Resolve it manually before export.`
    );
  }
  if (packageContradicts) {
    notes.push(
      `The package designator "${packageType.value}" declares ${declaredLeads} leads, but this part reads ${pinCount.value} pins, so the designator describes a different package in the same document. It is recorded as unknown rather than used to pick a land pattern. Name the package explicitly to override.`
    );
  }
  if (disagrees && figureBacksTable && !selfVerified) {
    notes.push(
      `The package designator declares ${declared} pins, but the pin table numbers 1 to ${pins.length} with no gaps AND the pinout figure independently resolves to the same ${pins.length}. Two agreeing readers outrank the designator, so ${pins.length} was used. Check the package designator before export.`
    );
  }
  if (disagrees && selfVerified) {
    notes.push(
      `The package designator declares ${declared} pins, but the pinout diagram numbers 1 to ${pins.length} with no gaps, which is self-consistent evidence the designator is not. The diagram was used. Check the package designator before export.`
    );
  }

  return {
    id: randomUUID(),
    partNumber,
    manufacturer,
    packageType: resolvedPackageType,
    // Reported whether or not a single package could be chosen. When one could
    // not, this list is the whole answer the caller needs: the document names
    // the packages, it just does not say which one is in their hand.
    //
    // Narrowed to the packages that fit THIS part. A datasheet covering a family
    // names its siblings' packages too, and offering one of those is offering a
    // wrong answer dressed as a choice: an OPA2277 is an eight-pin part and its
    // document also describes the quad's `14-Pin SOIC`. A variant that declares
    // no count is kept, because it contradicts nothing.
    // The land pattern this datasheet PRINTS for the resolved package.
    //
    // Read here rather than in the HTTP route because it is document evidence
    // like everything else on this record, and because a caller using this
    // function directly must get the same guard: the bench does, and with the
    // read in the route it shipped an ADS1115 footprint the route would have
    // refused.
    //
    // Filtered on the FAMILY token, not the designator. `findVendorLandPattern`
    // matches against the name in the drawing header, which reads `DYN0010A SOT`;
    // asking it for `SOT-10` matches nothing and returns no land pattern at all,
    // which would disable the guard on exactly the parts that need it.
    vendorLandPattern: printedLand,
    packageVariants: packageVariants
      .filter(
        (variant) =>
          pinCount.value === null || variant.leadCount === null || variant.leadCount === pinCount.value
      )
      .map((variant) => ({
        designator: variant.designator.slice(0, 64),
        family: variant.family,
        leadCount: variant.leadCount,
        inFrontMatter: variant.inFrontMatter
      })),
    // The code is only present when the drawing carrying it was confirmed to be
    // this part's package, so recording it IS the record of that confirmation.
    packageOutlineCode: drawn?.code
      ? extractedValue(drawn.code.code, 0.95, {
          page: drawn.page,
          snippet: drawn.code.code,
          region: null
        })
      : unknown<string>(),
    pinCount,
    pins: pins.length > 0 ? extractedValue(pins, pinConfidence, pinCitation) : unknown<PinRecord[]>(),
    // The deterministic readers all prove a gap-free 1..N, so a pad terminal can
    // never reach them; only the model pass sets this. See `normalizeModelPins`.
    exposedPad: false,
    // Filled only by the model pass; the deterministic reader has nothing to disagree with.
    conflicts: [],
    dimensions,
    radiation,
    sourceFileName: fileName,
    sourceUrl,
    notes
  };
}

/**
 * Extracts text and builds the deterministic record, returning both. Callers
 * that want to run a model afterwards need the document too, so that the model
 * can be given pages and its page claims can be verified against them.
 */
export async function extractPartRecord(
  fileName: string,
  pdfBuffer: ArrayBuffer,
  sourceUrl?: string,
  hints?: ExtractionHints
): Promise<{ doc: DatasheetText; part: PartRecord }> {
  const doc = await extractDatasheetText(pdfBuffer, {
    maxPages: MAX_PAGES,
    budgetMs: parseBudgetMs()
  });
  return { doc, part: buildPartRecord(doc, fileName, sourceUrl, hints) };
}

export async function parseDatasheetPdf(
  fileName: string,
  pdfBuffer: ArrayBuffer,
  sourceUrl?: string
): Promise<PartRecord> {
  const { part } = await extractPartRecord(fileName, pdfBuffer, sourceUrl);
  return part;
}
