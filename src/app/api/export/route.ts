import { NextResponse } from "next/server";
import { createExportZip } from "../../../lib/exporters";
import { partSchema } from "../../../lib/types";
import { sanitizeFileName, clientKey, RateLimiter } from "../../../lib/retrieval";

export const runtime = "nodejs";
// Cap how long an export can hold a serverless function open.
export const maxDuration = 30;

// Export generates files and is CPU-bound, so it gets its own limiter.
const exportLimiter = new RateLimiter(30, 60_000);
// A part record is small JSON; reject anything absurd before parsing it.
const MAX_EXPORT_BODY_BYTES = 1_000_000;

// Builds a Content-Disposition value that cannot break out of the header. Two defenses:
//   1. Derive an ASCII-only fallback filename from the sanitized basename, so the plain filename=
//      token contains only characters that are safe in a quoted-string.
//   2. Also emit filename*=UTF-8'' per RFC 5987 for correctness.
// A raw part number in this header was an injection point: CR/LF or a quote could inject a second
// header or directive. sanitizeFileName already strips path separators and control characters; here
// we additionally hard-restrict the quoted token to a conservative ASCII set.
function contentDisposition(baseName: string): string {
  const asciiFallback = baseName.replace(/[^A-Za-z0-9._-]/g, "_") || "export.zip";
  const encoded = encodeURIComponent(baseName);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export async function POST(request: Request) {
  const limit = exportLimiter.check(clientKey(request));
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many exports. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_EXPORT_BODY_BYTES) {
    return NextResponse.json({ error: "Request body too large." }, { status: 413 });
  }

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
  // sanitizeFileName enforces a safe basename; swap the .pdf it appends for the real .zip extension.
  const fileName = sanitizeFileName(`${partResult.data.partNumber}-forge`).replace(/\.pdf$/, ".zip");
  const exportNote =
    format === "kicad"
      ? "KiCad source bundle generated successfully."
      : `Vendor-neutral exchange bundle generated for ${format}; native library emitters are still pending.`;

  return new Response(new Uint8Array(bundle.buffer), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(fileName),
      "X-Content-Type-Options": "nosniff",
      "X-Forge-Step-Supported": String(bundle.stepSupported),
      "X-Forge-Step-Note": encodeURIComponent(bundle.stepNote),
      "X-Forge-Export-Note": encodeURIComponent(exportNote)
    }
  });
}