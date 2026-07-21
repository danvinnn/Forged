import { NextResponse } from "next/server";
import { parseDatasheetPdf } from "../../../lib/datasheet";

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
  const part = await parseDatasheetPdf(file.name, buffer);

  return NextResponse.json({ part });
}