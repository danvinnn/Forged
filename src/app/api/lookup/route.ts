import { NextResponse } from "next/server";
import { lookupAndParseDatasheet } from "../../../lib/datasheet-web";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const partNumber = typeof payload?.partNumber === "string" ? payload.partNumber.trim() : "";
  const manufacturer = typeof payload?.manufacturer === "string" ? payload.manufacturer.trim() : "";

  if (!partNumber) {
    return NextResponse.json({ error: "Part number is required." }, { status: 400 });
  }

  try {
    const result = await lookupAndParseDatasheet(partNumber, manufacturer || undefined);
    return NextResponse.json({
      part: result.part,
      pdfUrl: result.pdfUrl,
      sourcePageUrl: result.sourcePageUrl,
      searchQuery: result.searchQuery,
      candidateUrls: result.candidateUrls
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to resolve datasheet." },
      { status: 404 }
    );
  }
}