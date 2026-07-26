import { randomUUID } from "node:crypto";
import { citationAt, extractDatasheetText, type DatasheetText } from "./pdftext";
import {
  extractedValue,
  unknown,
  type Citation,
  type Extracted,
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

function findPartNumber(doc: DatasheetText, sourceFileName: string): Extracted<string> {
  const patterns: RegExp[] = [
    /(?:PRODUCT|DEVICE|PART)\s+NUMBER\s*[:\-]\s*([A-Z0-9][A-Z0-9\-./]{2,})/i,
    /\b[A-Z][A-Z0-9]{2,}(?:-[A-Z0-9]+)+\b/,
    /\b[A-Z]{2,}\d{2,}[A-Z0-9]*(?:-[A-Z0-9]+)+\b/
  ];

  for (const pattern of patterns) {
    const match = firstMatch(doc.text, pattern);
    const candidate = match?.groups[0] ?? match?.text;
    if (match && candidate && /\d/.test(candidate) && /-/.test(candidate)) {
      return extractedValue(cleanValue(candidate), 0.85, cite(doc, match));
    }
  }

  // The filename is a real signal (vendor-named PDFs), but it is not read off
  // the document, so it is recorded at low confidence with no citation.
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

function findPackageType(doc: DatasheetText): Extracted<string> {
  const scope = doc.text.slice(0, frontMatterEnd(doc));
  const patterns: RegExp[] = [
    /\b(?:package|pkg)\s*[:\-]\s*([A-Z0-9][A-Z0-9\-()\/]{1,20})/i,
    /\b(\d{1,3}-(?:lead|pin)\s+[A-Z]{2,8})\b/i,
    /\b([A-Z]{2,6}\s*\(\d{1,3}\))/
  ];

  for (const pattern of patterns) {
    for (const match of allMatches(scope, pattern)) {
      const candidate = cleanValue(match.groups[0] ?? match.text);
      if (candidate && isPlausiblePackage(candidate)) {
        return extractedValue(candidate, 0.75, cite(doc, match));
      }
    }
  }

  return unknown<string>();
}

/**
 * Pin count from the package designator in the front matter.
 *
 * The previous implementation took Math.max over every "N-pin" / "N-lead"
 * match in the whole document, so a 128-pin FPGA mentioned in a reference
 * design beat the part's own package. Scoping to the front matter and
 * requiring a package-shaped match removes that entire class of error.
 */
function findDeclaredPinCount(doc: DatasheetText): Extracted<number> {
  const scope = doc.text.slice(0, frontMatterEnd(doc));
  const patterns: RegExp[] = [
    /\b(\d{1,3})-(?:pin|lead)\s+[A-Z]{2,8}\b/i,
    /\b[A-Z]{2,6}\s*\((\d{1,3})\)/,
    /\b[A-Z]{2,6}-(\d{1,3})\b/
  ];

  for (const pattern of patterns) {
    for (const match of allMatches(scope, pattern)) {
      const count = Number(match.groups[0]);
      // A 1-pin package does not exist, so a (1) is a signal label, not a
      // designator. Same false positive that made ST's "OUT (1)" a package.
      if (Number.isFinite(count) && count >= 2 && count <= 1000) {
        return extractedValue(count, 0.7, cite(doc, match));
      }
    }
  }

  return unknown<number>();
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

const PIN_SECTION_HEADING = /(?:Pin\s+Functions|Pin\s+Description[s]?|Terminal\s+Functions|Pin\s+Configuration[s]?)/i;
const SIGN_LINE = /^[+\-–−]$/;
/**
 * Pin-name characters include the Unicode minus and en dash, because datasheets
 * set the "-" of an inverting input as a typographic minus, not ASCII. Missing
 * them silently dropped every inverting input and V- from the table.
 */
const PIN_ROW = /^([A-Z][A-Z0-9\s+\-_/–−]*?)\s+(\d{1,3})\s+(Input|Output|Power|Passive|Bidirectional|I\/O|NC)\b\s*(.*)$/i;

/** Normalizes typographic minus variants to ASCII so names compare and export cleanly. */
function normalizeSigns(name: string): string {
  return name.replace(/[–−]/g, "-");
}

/**
 * Parses the pin table. Superscript +/- signs land on their own baseline and so
 * arrive as their own line; they belong to the row that follows. The old parser
 * had no way to see that, which is why it found 8 of LMP7704-SP's 14 pins.
 *
 * Returns an empty list when no table is found. It never synthesizes rows.
 */
function extractPins(doc: DatasheetText): { pins: PinRecord[]; citation: Citation | null; confidence: number } {
  const heading = firstMatch(doc.text, PIN_SECTION_HEADING);
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

  const citation =
    firstRowIndex !== null ? citationAt(doc, firstRowIndex, 40) : heading ? cite(doc, heading) : null;

  return { pins, citation, confidence: heading ? 0.85 : 0.6 };
}

function findDimension(doc: DatasheetText, pattern: RegExp, confidence = 0.7): Extracted<number> {
  const match = firstMatch(doc.text, pattern);
  const raw = match?.groups[0];
  if (!match || !raw) return unknown<number>();
  const value = Number(raw);
  if (!Number.isFinite(value)) return unknown<number>();
  return extractedValue(value, confidence, cite(doc, match));
}

function parseDimensions(doc: DatasheetText, leadCount: Extracted<number>): PackageDimensions {
  const pair = firstMatch(doc.text, /\b(\d+(?:\.\d+)?)\s*mm\s*[×x]\s*(\d+(?:\.\d+)?)\s*mm\b/i);

  const bodyLength = findDimension(doc, /body\s*length[^\d]{0,20}(\d+(?:\.\d+)?)\s*mm/i);
  const bodyWidth = findDimension(doc, /body\s*width[^\d]{0,20}(\d+(?:\.\d+)?)\s*mm/i);

  return {
    bodyLengthMm:
      bodyLength.value !== null
        ? bodyLength
        : pair && pair.groups[0]
          ? extractedValue(Number(pair.groups[0]), 0.5, cite(doc, pair))
          : unknown<number>(),
    bodyWidthMm:
      bodyWidth.value !== null
        ? bodyWidth
        : pair && pair.groups[1]
          ? extractedValue(Number(pair.groups[1]), 0.5, cite(doc, pair))
          : unknown<number>(),
    bodyHeightMm: findDimension(doc, /body\s*height[^\d]{0,20}(\d+(?:\.\d+)?)\s*mm/i),
    pitchMm: findDimension(doc, /(?:lead\s+pitch|pitch)[^\d]{0,20}(\d+(?:\.\d+)?)\s*mm/i),
    leadLengthMm: findDimension(doc, /lead\s*length[^\d]{0,20}(\d+(?:\.\d+)?)\s*mm/i),
    leadCount
  };
}

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

function extractRadiationData(doc: DatasheetText): RadiationData {
  return {
    tid: findRadiationField(doc, [
      /(?:RHA\s+up\s+to\s+)?TID\s*[=:]\s*(\d+(?:\.\d+)?\s*[kKmM]?rad\s*(?:\([^)]{0,10}\))?)/i,
      /(?:RHA\s+up\s+to\s+)?TID\s*[=:]\s*([^\n,.;]{1,40})/i
    ]),
    see: findRadiationField(doc, [
      new RegExp(String.raw`SEE\s+characterized\s+to\s+(${LET_VALUE})`, "i"),
      /SEE\s+characterized\s+to\s+([^\n,.;]{1,40})/i
    ]),
    sel: findRadiationField(doc, [
      new RegExp(String.raw`SEL\s+(?:resilient|immune)\s+to\s+(${LET_VALUE})`, "i"),
      /SEL\s+(?:resilient|immune)\s+to\s+([^\n,.;]{1,40})/i
    ]),
    qmlClass: findRadiationField(doc, [/\b(QML\s+Class\s+[A-Z0-9]+)\b/i], 0.9)
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The deterministic pass over already-extracted text. Split from the PDF read
 * so it can be exercised against synthetic documents, which is how the
 * "unknown stays unknown" behavior is tested without committing a fixture PDF
 * for every failure shape.
 */
export function buildPartRecord(doc: DatasheetText, fileName: string, sourceUrl?: string): PartRecord {
  const partNumber = findPartNumber(doc, fileName);
  const manufacturer = findManufacturer(doc);
  const packageType = findPackageType(doc);
  const declaredPinCount = findDeclaredPinCount(doc);
  const { pins, citation: pinCitation, confidence: pinConfidence } = extractPins(doc);

  // Two independent signals, the package designator and the pin table, either
  // corroborate each other or they do not. When they disagree, at least one is
  // a misread, and there is no basis for choosing between them: an AD590
  // (a 2-lead part) produced three garbage pins from a prose paragraph, and
  // preferring the "table" exported a 3-pad footprint. Disagreement therefore
  // means unknown, which fails closed at the export boundary.
  let pinCount: Extracted<number>;
  const declared = declaredPinCount.value;
  if (pins.length > 0 && declared !== null && declared !== pins.length) {
    pinCount = unknown<number>();
  } else if (pins.length > 0) {
    pinCount = extractedValue(pins.length, declared === pins.length ? 0.95 : 0.7, pinCitation);
  } else {
    pinCount = declaredPinCount;
  }
  const conflicted = pinCount.value === null && pins.length > 0 && declared !== null;

  const dimensions = parseDimensions(doc, declaredPinCount);
  const radiation = extractRadiationData(doc);

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

  return {
    id: randomUUID(),
    partNumber,
    manufacturer,
    packageType,
    pinCount,
    pins: pins.length > 0 ? extractedValue(pins, pinConfidence, pinCitation) : unknown<PinRecord[]>(),
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
  sourceUrl?: string
): Promise<{ doc: DatasheetText; part: PartRecord }> {
  const doc = await extractDatasheetText(pdfBuffer, {
    maxPages: MAX_PAGES,
    budgetMs: parseBudgetMs()
  });
  return { doc, part: buildPartRecord(doc, fileName, sourceUrl) };
}

export async function parseDatasheetPdf(
  fileName: string,
  pdfBuffer: ArrayBuffer,
  sourceUrl?: string
): Promise<PartRecord> {
  const { part } = await extractPartRecord(fileName, pdfBuffer, sourceUrl);
  return part;
}
