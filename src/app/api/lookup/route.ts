import { NextResponse } from "next/server";
import { lookupAndParseDatasheet } from "../../../lib/datasheet-web";
import { lookupAndParseDatasheetWithGemini } from "../../../lib/datasheet-gemini";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const partNumber = typeof payload?.partNumber === "string" ? payload.partNumber.trim() : "";
  const manufacturer = typeof payload?.manufacturer === "string" ? payload.manufacturer.trim() : "";

  if (!partNumber) {
    return NextResponse.json({ error: "Part number is required." }, { status: 400 });
  }

  try {
    // Prefer Gemini if API key is configured
    if (process.env.GOOGLE_GEMINI_API_KEY) {
      const result = await lookupAndParseDatasheetWithGemini(partNumber, manufacturer || undefined);
      return NextResponse.json({
        part: result.part,
        pdfUrl: result.sourceUrl,
        sourcePageUrl: result.sourceUrl,
        searchQuery: "gemini-ai",
        candidateUrls: [result.sourceUrl],
        method: "gemini"
      });
    }

    // Fallback to web search
    const result = await lookupAndParseDatasheet(partNumber, manufacturer || undefined);
    return NextResponse.json({
      part: result.part,
      pdfUrl: result.pdfUrl,
      sourcePageUrl: result.sourcePageUrl,
      searchQuery: result.searchQuery,
      candidateUrls: result.candidateUrls,
      method: "web-search"
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to resolve datasheet." },
      { status: 404 }
    );
  }
}