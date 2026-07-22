import { NextResponse } from "next/server";
import { parseDatasheetPdf } from "../../../lib/datasheet";
import { parseDatasheetWithGemini } from "../../../lib/datasheet-gemini";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing PDF upload." }, { status: 400 });
  }

  if (!file.name.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "Only PDF uploads are supported." }, { status: 400 });
  }

  const buffer = await file.arrayBuffer();

  try {
    // Prefer Gemini if API key is configured
    if (process.env.GOOGLE_GEMINI_API_KEY) {
      const result = await parseDatasheetWithGemini(Buffer.from(buffer), file.name);
      return NextResponse.json({ part: result.part, method: "gemini" });
    }

    // Fallback to regex-based parsing
    const part = await parseDatasheetPdf(file.name, buffer);
    return NextResponse.json({ part, method: "regex" });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to parse datasheet." },
      { status: 400 }
    );
  }
}