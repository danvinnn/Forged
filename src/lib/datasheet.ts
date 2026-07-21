import pdfParse from "pdf-parse";
import { randomUUID } from "node:crypto";
import { type PackageDimensions, type PartRecord, type PinElectricalType, type PinRecord } from "./types";

const manufacturerHints = [
  "Texas Instruments",
  "Analog Devices",
  "STMicroelectronics",
  "Microchip",
  "onsemi",
  "NXP",
  "Renesas",
  "Infineon",
  "Teledyne",
  "Qorvo"
];

function fallbackPartNumber(sourceFileName: string): string {
  const baseName = sourceFileName.replace(/\.[^.]+$/, "").toUpperCase();
  return baseName.replace(/[^A-Z0-9\-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "UNKNOWN-PART";
}

function classifyPinType(name: string, description = ""): PinElectricalType {
  const merged = `${name} ${description}`.toUpperCase();
  if (/\b(NC|NO CONNECT)\b/.test(merged)) return "nc";
  if (/\b(GND|VCC|VDD|VSS|VEE|VSS1|VSS2|V+|V-)\b/.test(merged)) return "power";
  if (/\b(OUT|OUTPUT)\b/.test(merged)) return "output";
  if (/\b(IN|INPUT|VIN)\b/.test(merged)) return "input";
  if (/\b(AD|SDA|SCL|TX|RX|CLK|DATA|DIO|IO)\b/.test(merged)) return "bidirectional";
  return "unspecified";
}

function findManufacturer(text: string): string {
  for (const hint of manufacturerHints) {
    if (text.includes(hint.toUpperCase())) return hint;
  }
  return "Unknown";
}

function findPartNumber(text: string, sourceFileName: string): string {
  const fallback = fallbackPartNumber(sourceFileName);
  const matchPatterns = [
    /\b[A-Z][A-Z0-9]{2,}(?:-[A-Z0-9]+)+\b/i,
    /\b[A-Z]{2,}\d{2,}[A-Z0-9]*(?:-[A-Z0-9]+)+\b/i,
    /(?:PRODUCT|DEVICE|PART)\s+NUMBER\s*[:\-]\s*([A-Z0-9][A-Z0-9\-./]{2,})/i
  ];

  for (const pattern of matchPatterns) {
    const match = text.match(pattern);
    const candidate = match?.[1] ?? match?.[0];
    if (candidate && /\d/.test(candidate) && /-/.test(candidate)) {
      return candidate.trim();
    }
  }

  return fallback;
}

function findPackageType(text: string): string {
  const packagePatterns = [
    /\b([A-Z]{2,6}\s*\(\d{1,3}\))\b/i,
    /\b(\d{1,3}-lead\s+[A-Z]{2,8})\b/i,
    /\b(HBH\s+Package,\s*\d{1,3}-Pin\s+[A-Z]{2,8})\b/i,
    /\b(package|pkg)\s*[:\-]\s*([A-Z0-9\-()\/\s]{2,})/i
  ];

  for (const pattern of packagePatterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
    if (match?.[2]) return match[2].trim();
  }

  return "Unknown package";
}

function findPinCount(text: string): number {
  const counts = Array.from(text.matchAll(/\b(\d{1,3})\s*[- ]?pin\b/gi)).map((match) => Number(match[1]));
  const leadCounts = Array.from(text.matchAll(/\b(\d{1,3})\s*[- ]?lead\b/gi)).map((match) => Number(match[1]));
  const packageCounts = Array.from(text.matchAll(/\b[A-Z]{2,6}\s*\((\d{1,3})\)\b/gi)).map((match) => Number(match[1]));
  const allCounts = [...counts, ...leadCounts, ...packageCounts].filter((value) => Number.isFinite(value));
  if (allCounts.length === 0) return 0;
  return Math.max(...allCounts);
}

function parseDimensions(text: string): PackageDimensions {
  const mmMatch = (pattern: RegExp) => {
    const match = text.match(pattern);
    return match?.[1] ? Number(match[1]) : null;
  };

  const pairMatch = text.match(/\b(\d+(?:\.\d+)?)\s*mm\s*[×x]\s*(\d+(?:\.\d+)?)\s*mm\b/i);
  const leadCountMatch = text.match(/\b(?:HBH\s+Package,\s*)?(\d{1,3})-Pin\s+CFP\b/i) ?? text.match(/\bCFP\s*\((\d{1,3})\)\b/i);

  return {
    bodyLengthMm: mmMatch(/body\s*length[^\d]{0,20}(\d+(?:\.\d+)?)\s*mm/i) ?? (pairMatch?.[1] ? Number(pairMatch[1]) : null),
    bodyWidthMm: mmMatch(/body\s*width[^\d]{0,20}(\d+(?:\.\d+)?)\s*mm/i) ?? (pairMatch?.[2] ? Number(pairMatch[2]) : null),
    bodyHeightMm: mmMatch(/body\s*height[^\d]{0,20}(\d+(?:\.\d+)?)\s*mm/i),
    pitchMm: mmMatch(/(?:lead\s+pitch|pitch)[^\d]{0,20}(\d+(?:\.\d+)?)\s*mm/i),
    leadLengthMm: mmMatch(/lead\s*length[^\d]{0,20}(\d+(?:\.\d+)?)\s*mm/i),
    leadCount: leadCountMatch?.[1] ? Number(leadCountMatch[1]) : null
  };
}

function extractRadiationField(text: string, label: string): string | null {
  const patterns = [
    new RegExp(`${label}[^\n]{0,120}`, "i"),
    new RegExp(`${label}[^\d]{0,40}(\d+(?:\.\d+)?)\s*(krad|mrad|rad|gy)`, "i")
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[0]) return match[0].replace(/\s+/g, " ").trim();
  }

  return null;
}

function extractRadiationData(text: string) {
  const tidMatch = text.match(/TID\s*=\s*([^\n]+)/i) ?? text.match(/RHA\s+up\s+to\s+TID\s*=\s*([^\n]+)/i);
  const seeMatch = text.match(/SEE\s+characterized\s+to\s+([^\n]+)/i);
  const selMatch = text.match(/SEL\s+resilient\s+to\s+([^\n]+)/i);
  const qmlMatch = text.match(/\bQML\s+Class\s+[A-Z0-9]+\b/i);

  return {
    tid: tidMatch?.[1]?.replace(/\s+/g, " ").trim() ?? null,
    see: seeMatch?.[1]?.replace(/\s+/g, " ").trim() ?? null,
    sel: selMatch?.[1]?.replace(/\s+/g, " ").trim() ?? null,
    qmlClass: qmlMatch?.[0] ?? null
  };
}

function extractPinCandidates(text: string): PinRecord[] {
  const sectionMatch = text.match(/Table 4-1\. Pin Functions([\s\S]*?)(?:5 Specifications|6 Detailed Description)/i);
  const section = sectionMatch?.[1] ?? text;
  const lines = section.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const pins: PinRecord[] = [];
  let pendingName = "";

  for (const line of lines) {
    if (/^(PIN|TYPE|DESCRIPTION|NAME|NO\.)/i.test(line)) {
      continue;
    }

    if (/^(Table\s+\d+|Figure\s+\d+|www\.ti\.com|LMP7704-SP|SNOS|Copyright|Submit Document Feedback|Product Folder Links)/i.test(line)) {
      continue;
    }

    const compact = line.replace(/\s+/g, "");
    const directRow = compact.match(/^([A-Z][A-Z0-9+\-_/()]*)?(\d{1,3})(Input|Output|Power)(.*)$/i);
    if (directRow && directRow[1]) {
      const rawName = directRow[1].replace(/[^A-Z0-9+\-_/]/gi, "");
      const number = directRow[2];
      const typeLabel = directRow[3];
      const description = directRow[4].replace(/^[\s\-—:]+/, "").trim();

      if (rawName && rawName.toUpperCase() !== "PAD") {
        pins.push({
          number,
          name: rawName,
          electricalType: classifyPinType(rawName, `${typeLabel} ${description}`),
          description: description || undefined
        });
      }

      pendingName = "";
      continue;
    }

    const numberedRow = compact.match(/^(\d{1,3})(Input|Output|Power)(.*)$/i);
    if (numberedRow && pendingName) {
      const rawName = pendingName.replace(/[^A-Z0-9+\-_/]/gi, "");
      const number = numberedRow[1];
      const typeLabel = numberedRow[2];
      const description = numberedRow[3].replace(/^[\s\-—:]+/, "").trim();

      if (rawName && rawName.toUpperCase() !== "PAD") {
        pins.push({
          number,
          name: rawName,
          electricalType: classifyPinType(rawName, `${typeLabel} ${description}`),
          description: description || undefined
        });
      }

      pendingName = "";
      continue;
    }

    if (/^[A-Z][A-Z\s+\-()\/]+$/.test(line) || /^[+\-]$/.test(line)) {
      pendingName = pendingName ? `${pendingName} ${line}` : line;
      continue;
    }

    pendingName = "";
  }

  const unique = new Map<string, PinRecord>();
  for (const pin of pins) {
    if (!unique.has(pin.number)) unique.set(pin.number, pin);
  }

  return [...unique.values()].sort((left, right) => Number(left.number) - Number(right.number));
}

export async function parseDatasheetPdf(fileName: string, pdfBuffer: ArrayBuffer, sourceUrl?: string): Promise<PartRecord> {
  const parsed = await pdfParse(Buffer.from(pdfBuffer));
  const text = parsed.text.replace(/\u0000/g, "").replace(/\r/g, "");
  const partNumber = findPartNumber(text.toUpperCase(), fileName);
  const manufacturer = findManufacturer(text.toUpperCase());
  const packageType = findPackageType(text) || "Unknown package";
  const pinCount = findPinCount(text);
  const pins = extractPinCandidates(text);
  const dimensions = parseDimensions(text);
  const radiation = extractRadiationData(text);

  if (dimensions.leadCount === null && pinCount > 0) {
    dimensions.leadCount = pinCount;
  }

  const notes = [
    parsed.numpages ? `PDF pages: ${parsed.numpages}` : "PDF page count unavailable",
    pins.length > 0 ? `Detected ${pins.length} pin candidates from text extraction.` : "No explicit pin table was detected; review pin data manually.",
    dimensions.bodyLengthMm || dimensions.pitchMm ? "Some package dimensions were extracted from text." : "Package dimensions were not confidently extracted.",
    radiation.tid || radiation.see || radiation.sel || radiation.qmlClass ? "Radiation qualification text was detected." : "No explicit radiation qualification text was detected."
  ];

  return {
    id: randomUUID(),
    partNumber,
    manufacturer,
    packageType,
    pinCount: pinCount || Math.max(pins.length, 1),
    pins: pins.length > 0 ? pins : Array.from({ length: Math.max(pinCount, 1) }, (_, index) => ({
      number: String(index + 1),
      name: `PIN${index + 1}`,
      electricalType: "unspecified" as const
    })),
    dimensions,
    radiation,
    sourceFileName: fileName,
    sourceUrl,
    notes
  };
}