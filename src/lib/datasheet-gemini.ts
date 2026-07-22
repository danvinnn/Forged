import { GoogleGenerativeAI } from "@google/generative-ai";
import pdfParse from "pdf-parse";
import { type PartRecord } from "./types";
import { lookupDatasheetPdf } from "./datasheet-web";

const apiKey = process.env.GOOGLE_GEMINI_API_KEY || "";
const client = new GoogleGenerativeAI(apiKey);

interface GeminiDatasheetResult {
  part: PartRecord;
  sourceUrl: string;
  notes: string[];
}

async function downloadPdfBuffer(url: string): Promise<Buffer> {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept": "application/pdf,application/octet-stream,*/*;q=0.9",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "DNT": "1",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Referer": new URL(url).origin + "/"
  };

  const response = await fetch(url, {
    headers,
    redirect: "follow"
  });

  if (!response.ok) {
    // 403 Forbidden might mean we need a referer or different approach
    if (response.status === 403) {
      throw new Error(
        `Access denied (403) - The server blocked the download. This may require accessing from the product page instead of direct URL.`
      );
    }
    throw new Error(`Failed to download from ${url}: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.includes("pdf") && !contentType.includes("octet-stream") && !contentType.includes("application/x-pdf")) {
    throw new Error(
      `Invalid content type: expected PDF but got "${contentType}". The URL may not point to a PDF file.`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.length < 100) {
    throw new Error(
      `Downloaded file too small (${buffer.length} bytes) - likely not a valid PDF`
    );
  }

  return buffer;
}

export async function findDatasheetUrl(partNumber: string, manufacturer?: string): Promise<string> {
  if (!apiKey) {
    throw new Error("Gemini API key not configured. Set GOOGLE_GEMINI_API_KEY environment variable.");
  }

  const model = client.getGenerativeModel({ model: "gemini-3.6-flash" });

  const query = manufacturer
    ? `Find the official direct PDF datasheet file URL for ${manufacturer} part number ${partNumber}`
    : `Find the official direct PDF datasheet file URL for part number ${partNumber}`;

  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `${query}. 
REQUIREMENTS:
- Return ONLY a direct URL to a PDF file (must end with .pdf or return a URL that serves PDF content)
- Must not be an HTML page or search result page
- Must be the actual datasheet PDF file URL
- Format: https://...pdf (or similar direct PDF link)
- No explanation, no markdown, no multiple options
- If you cannot find a direct PDF URL, respond with "NOT_FOUND"`
          }
        ]
      }
    ]
  });

  const textContent = result.response.text().trim();

  if (textContent === "NOT_FOUND" || !textContent.startsWith("http")) {
    throw new Error(
      `Unable to find datasheet URL for ${partNumber}${manufacturer ? ` (${manufacturer})` : ""}`
    );
  }

  return textContent;
}

export async function parseDatasheetWithGemini(
  pdfBuffer: Buffer,
  sourceUrl: string,
  partNumber?: string
): Promise<GeminiDatasheetResult> {
  if (!apiKey) {
    throw new Error("Gemini API key not configured. Set GOOGLE_GEMINI_API_KEY environment variable.");
  }

  // Validate PDF buffer
  if (pdfBuffer.length < 100 || !pdfBuffer.toString("ascii", 0, 4).startsWith("%PDF")) {
    throw new Error(
      `Invalid PDF structure: buffer does not appear to be a valid PDF file (size: ${pdfBuffer.length} bytes)`
    );
  }

  // First extract text from PDF
  let pdfText: string;
  try {
    const pdfData = await pdfParse(pdfBuffer);
    pdfText = pdfData.text;
    if (!pdfText || pdfText.trim().length < 50) {
      throw new Error("PDF extraction returned empty or too-short text");
    }
  } catch (error) {
    throw new Error(
      `Failed to parse PDF content: ${error instanceof Error ? error.message : "Unknown error"}. The URL may not point to a valid PDF file.`
    );
  }

  // Use Gemini vision to analyze the first page as an image for better context
  const model = client.getGenerativeModel({ model: "gemini-3.6-flash" });

  const extractionPrompt = `You are an electronics datasheet parser. Extract the following information from this datasheet text and respond in valid JSON format only (no markdown, no explanation):

{
  "partNumber": "string (the main product part number)",
  "manufacturer": "string (company name)",
  "packageType": "string (e.g., 'QFN-24', '100-lead CFP', etc.)",
  "pinCount": number,
  "pins": [
    {
      "number": "string",
      "name": "string",
      "electricalType": "power" | "input" | "output" | "bidirectional" | "passive" | "nc" | "open_collector" | "open_emitter" | "unspecified",
      "description": "string (optional)"
    }
  ],
  "dimensions": {
    "bodyLengthMm": number | null,
    "bodyWidthMm": number | null,
    "bodyHeightMm": number | null,
    "pitchMm": number | null,
    "leadLengthMm": number | null,
    "leadCount": number | null
  },
  "radiation": {
    "tid": "string | null (Total Ionizing Dose if present)",
    "see": "string | null (Single Event Effect if present)",
    "sel": "string | null (Single Event Latch-up if present)",
    "qmlClass": "string | null (QML qualification class if present)"
  },
  "notes": ["string array of any important observations or missing data"]
}

Datasheet content:
${pdfText}`;

  const response = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [
          {
            text: extractionPrompt
          }
        ]
      }
    ]
  });

  let parsedData;
  try {
    // Extract JSON from response
    const responseText = response.response.text();
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`No JSON found in Gemini response: "${responseText.substring(0, 200)}..."`);
    }
    parsedData = JSON.parse(jsonMatch[0]);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    throw new Error(
      `Failed to parse Gemini extraction response: ${errorMsg}. The datasheet text may be too complex or Gemini returned an unexpected format.`
    );
  }

  // Override part number if provided by user and parser didn't get it
  if (partNumber && (!parsedData.partNumber || parsedData.partNumber === "UNKNOWN")) {
    parsedData.partNumber = partNumber;
  }

  const part: PartRecord = {
    id: `part-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    partNumber: parsedData.partNumber || "UNKNOWN",
    manufacturer: parsedData.manufacturer || "Unknown",
    packageType: parsedData.packageType || "Unknown package",
    pinCount: parsedData.pinCount || 0,
    pins: parsedData.pins || [],
    dimensions: {
      bodyLengthMm: parsedData.dimensions?.bodyLengthMm ?? null,
      bodyWidthMm: parsedData.dimensions?.bodyWidthMm ?? null,
      bodyHeightMm: parsedData.dimensions?.bodyHeightMm ?? null,
      pitchMm: parsedData.dimensions?.pitchMm ?? null,
      leadLengthMm: parsedData.dimensions?.leadLengthMm ?? null,
      leadCount: parsedData.dimensions?.leadCount ?? null
    },
    radiation: {
      tid: parsedData.radiation?.tid ?? null,
      see: parsedData.radiation?.see ?? null,
      sel: parsedData.radiation?.sel ?? null,
      qmlClass: parsedData.radiation?.qmlClass ?? null
    },
    sourceFileName: `${parsedData.partNumber || "part"}.pdf`,
    sourceUrl: sourceUrl,
    notes: parsedData.notes || []
  };

  return {
    part,
    sourceUrl,
    notes: [`Parsed with Gemini AI from ${sourceUrl}`, ...part.notes]
  };
}

export async function lookupAndParseDatasheetWithGemini(
  partNumber: string,
  manufacturer?: string
): Promise<{ part: PartRecord; sourceUrl: string }> {
  try {
    // Step 1: Find the datasheet URL using Gemini
    const pdfUrl = await findDatasheetUrl(partNumber, manufacturer);

    // Step 2: Download the PDF
    const pdfBuffer = await downloadPdfBuffer(pdfUrl);

    // Step 3: Parse with Gemini
    const result = await parseDatasheetWithGemini(pdfBuffer, pdfUrl, partNumber);

    return {
      part: result.part,
      sourceUrl: result.sourceUrl
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    
    // If Gemini returned an invalid URL (HTML instead of PDF, or 403), fall back to web search
    if (
      errorMsg.includes("Invalid content type") ||
      errorMsg.includes("text/html") ||
      errorMsg.includes("Access denied (403)")
    ) {
      console.log(
        `Gemini URL lookup failed for ${partNumber} (${errorMsg}), falling back to web search...`
      );
      try {
        const webResult = await lookupDatasheetPdf(partNumber, manufacturer);
        const pdfBuffer = await downloadPdfBuffer(webResult.pdfUrl);
        const result = await parseDatasheetWithGemini(
          pdfBuffer,
          webResult.pdfUrl,
          partNumber
        );
        return {
          part: result.part,
          sourceUrl: result.sourceUrl
        };
      } catch (fallbackError) {
        const fallbackMsg = fallbackError instanceof Error ? fallbackError.message : "Unknown";
        throw new Error(
          `Gemini lookup failed, then web search fallback also failed: ${fallbackMsg}`
        );
      }
    }

    throw new Error(
      `Failed to lookup and parse datasheet for ${partNumber}: ${errorMsg}`
    );
  }
}
