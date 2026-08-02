import { NextResponse } from "next/server";
import { createExportZip, FootprintUnavailableError, GeneratorUnavailableError } from "../../../lib/exporters";
import { partSchema, resolveForExport } from "../../../lib/types";
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
  const limit = await exportLimiter.check(clientKey(request));
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
    // A record in the pre-Extracted<T> shape fails with a wall of zod errors that
    // do not say what is actually wrong. Detect it and say so plainly: every
    // field is now { value, confidence, method, citation }, because the old flat
    // shape had no way to express "this value is unknown".
    const looksLegacy = typeof (payload.part as { partNumber?: unknown } | null)?.partNumber === "string";
    if (looksLegacy) {
      return NextResponse.json(
        {
          error:
            "This part record uses the old flat format. Every extracted field is now an object: { value, confidence, method, citation }. Re-parse the datasheet to produce a current record.",
          code: "LEGACY_RECORD_FORMAT"
        },
        { status: 400 }
      );
    }
    return NextResponse.json({ error: "Invalid part record.", details: partResult.error.flatten() }, { status: 400 });
  }

  const format = payload.format;
  if (format !== "kicad" && format !== "altium" && format !== "cadence") {
    return NextResponse.json({ error: "Unsupported export format." }, { status: 400 });
  }

  // Refuse to generate CAD geometry from values nobody actually read off the
  // datasheet. A guessed pin count becomes guessed pads on a flight part.
  const resolved = resolveForExport(partResult.data);
  if (!resolved.ok) {
    if (resolved.untraceable?.length) {
      return NextResponse.json(
        {
          error:
            "Cannot generate CAD output: these values came from an extraction model and could not be located in the datasheet, so they are not traceable for sign-off. Verify them against the source and confirm before exporting.",
          code: "UNTRACEABLE_EXTRACTION",
          untraceable: resolved.untraceable
        },
        { status: 422 }
      );
    }
    return NextResponse.json(
      {
        error:
          "Cannot generate CAD output: required values were not extracted from the datasheet. Fill them in before exporting.",
        code: "INCOMPLETE_EXTRACTION",
        missing: resolved.missing
      },
      { status: 422 }
    );
  }

  // Most datasheets offer a part in several packages (UCC27524 is SOIC-8,
  // HVSSOP-8 and WSON-8), and a footprint is per package. The extracted
  // designator is a default, not an answer, so the caller may name the one they
  // are actually ordering.
  const requestedPackage = payload.packageType;
  if (requestedPackage !== undefined && typeof requestedPackage !== "string") {
    return NextResponse.json({ error: "packageType must be a string." }, { status: 400 });
  }
  // Naming a package DISCARDS the drawing evidence, and it has to. The outline
  // code, the pitch and the lead width were all read off the one drawing
  // confirmed to match the EXTRACTED designator, so against a different package
  // they describe the wrong part of the datasheet. Keeping them would either
  // refuse the caller's own explicit answer as "conflicting evidence" or, worse,
  // size the lands of a TSSOP from a SOIC drawing.
  const part = requestedPackage
    ? {
        ...resolved.part,
        packageType: requestedPackage.slice(0, 64),
        packageOutlineCode: null,
        dimensions: { ...resolved.part.dimensions, pitchMm: null, leadWidthMm: null }
      }
    : resolved.part;

  // Ceramic flat packs ship with straight leads that the assembler trims and
  // forms, so their seated span is a board-process input rather than a datasheet
  // value. There is no defensible default, so the caller supplies it.
  const formedSpan = payload.formedLeadSpanMm;
  if (formedSpan !== undefined && (typeof formedSpan !== "number" || !Number.isFinite(formedSpan) || formedSpan <= 0 || formedSpan > 200)) {
    return NextResponse.json(
      { error: "formedLeadSpanMm must be a positive number of millimetres." },
      { status: 400 }
    );
  }

  // A package with no characterised land pattern is a refusal, not a degraded
  // export. Emitting the symbol and the 3D body while silently dropping the
  // footprint would read as a success to anyone who did not check the file list.
  let bundle: Awaited<ReturnType<typeof createExportZip>>;
  try {
    bundle = await createExportZip(part, format, { formedLeadSpanMm: formedSpan });
  } catch (error) {
    if (error instanceof GeneratorUnavailableError) {
      return NextResponse.json(
        {
          error: error.message,
          code: "GENERATOR_NOT_IMPLEMENTED",
          format: error.format,
          availableFormats: error.available
        },
        { status: 501 }
      );
    }
    if (error instanceof FootprintUnavailableError) {
      // Two different refusals, and conflating them leaves the user with nothing
      // to do. `needs` populated means they can answer it and get their
      // footprint; empty means the package has no characterised land pattern,
      // which is ours to fix and not something they can type their way out of.
      const answerable = error.needs.length > 0;
      return NextResponse.json(
        {
          error: `Cannot generate CAD output: ${error.reason}${answerable ? "" : " A footprint is a manufacturing instruction, so Forge does not approximate one."}`,
          code: answerable ? "INPUT_REQUIRED" : "PACKAGE_NOT_CHARACTERISED",
          needs: error.needs,
          packageType: part.packageType,
          pinCount: resolved.part.pinCount,
          supportedFamilies: error.supportedFamilies
        },
        { status: 422 }
      );
    }
    throw error;
  }
  // sanitizeFileName enforces a safe basename; swap the .pdf it appends for the real .zip extension.
  const fileName = sanitizeFileName(`${resolved.part.partNumber}-forge`).replace(/\.pdf$/, ".zip");
  const exportNote = `Native ${format} library generated from the IPC-7351B land pattern.`;

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