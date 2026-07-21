import { NextResponse } from "next/server";
import { createExportZip } from "../../../lib/exporters";
import { partSchema } from "../../../lib/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  if (!payload) {
    return NextResponse.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  const partResult = partSchema.safeParse(payload.part);
  if (!partResult.success) {
    return NextResponse.json({ error: "Invalid part record.", details: partResult.error.flatten() }, { status: 400 });
  }

  const format = payload.format;
  if (format !== "kicad" && format !== "altium" && format !== "cadence") {
    return NextResponse.json({ error: "Unsupported export format." }, { status: 400 });
  }

  const bundle = await createExportZip(partResult.data, format);
  const fileName = `${partResult.data.partNumber.replace(/[^A-Za-z0-9\-]+/g, "-")}-forge.zip`;
  const exportNote =
    format === "kicad"
      ? "KiCad source bundle generated successfully."
      : `Vendor-neutral exchange bundle generated for ${format}; native library emitters are still pending.`;

  return new Response(new Uint8Array(bundle.buffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename=\"${fileName}\"`,
      "X-Forge-Step-Supported": String(bundle.stepSupported),
      "X-Forge-Step-Note": bundle.stepNote,
      "X-Forge-Export-Note": exportNote
    }
  });
}