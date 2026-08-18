import { NextResponse } from "next/server";
import {
  asPackage,
  createExportZip,
  FootprintUnavailableError,
  GeneratorUnavailableError,
  type SuppliedDimensions
} from "../../../lib/exporters";
import { FootprintInvalidError } from "../../../lib/confidence";
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
  // Naming a DIFFERENT package discards the drawing evidence, and it has to:
  // every geometric value on the record was read off the drawings for the
  // package the document resolved to. `asPackage` is the one place that rule is
  // written, shared with the chooser so the two can never disagree about what a
  // click will build. Naming the package it already is changes nothing.
  const part = requestedPackage
    ? asPackage(resolved.part, requestedPackage.slice(0, 64))
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

  // The seated FOOT, from the same forming operation and for the same reason: an
  // unformed lead has none until the assembler's die makes one, so no datasheet
  // prints it. Bounded far tighter than the span because a foot is a feature of
  // one lead rather than a distance across the package; anything above a few
  // millimetres is a typo or a different dimension.
  const formedContact = payload.formedLeadContactMm;
  if (
    formedContact !== undefined &&
    (typeof formedContact !== "number" || !Number.isFinite(formedContact) || formedContact <= 0 || formedContact > 5)
  ) {
    return NextResponse.json(
      { error: "formedLeadContactMm must be a positive number of millimetres, no greater than 5." },
      { status: 400 }
    );
  }

  // The land pattern the user typed, when their datasheet did not print one.
  //
  // Validated exactly as strictly as the span above: these become copper. A
  // millimetre figure outside this range is a units mistake or a typo, and
  // either would be built faithfully by the generator.
  const suppliedNumbers: Record<string, unknown> = {};
  for (const field of [
    "bodyLengthMm",
    "bodyWidthMm",
    "bodyHeightMm",
    "landPadLengthMm",
    "landPadWidthMm",
    "landSpanMm",
    // The cross-axis span. The generator asks for it on a four-sided package and
    // this list is what makes the ask answerable; a field the exporter requests
    // and the route rejects is a refusal with extra words.
    "landSpanCrossMm",
    "leadDiameterMm",
    "pitchMm",
    "thermalPadLengthMm",
    "thermalPadWidthMm"
  ] as const) {
    const value = (payload as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 200) {
      return NextResponse.json(
        { error: `${field} must be a positive number of millimetres.` },
        { status: 400 }
      );
    }
    suppliedNumbers[field] = value;
  }
  const sides = (payload as Record<string, unknown>).leadSides;
  if (sides !== undefined) {
    // 1 IS VALID. It became a valid reading on 2026-08-17 so that a TO-220,
    // TO-92 or SIP could be represented at all, and this validator was not
    // updated: the generator asked for it, the UI offered a box that accepts it,
    // and the route answered 400. Every value the record accepts has to be
    // accepted everywhere it is asked for.
    if (sides !== 1 && sides !== 2 && sides !== 4) {
      return NextResponse.json(
        {
          error:
            "leadSides must be 1 (a single line of leads, as on a TO-220 or SIP), 2 (two opposing rows) or 4 (leads on all four sides)."
        },
        { status: 400 }
      );
    }
    suppliedNumbers.leadSides = sides;
  }

  // Which grid position on the short row of a dual package carries no lead.
  const vacant = (payload as Record<string, unknown>).vacantLeadSlot;
  if (vacant !== undefined) {
    if (typeof vacant !== "number" || !Number.isInteger(vacant) || vacant < 1 || vacant > 300) {
      return NextResponse.json(
        { error: "vacantLeadSlot must be a whole grid position, counted from pin 1." },
        { status: 400 }
      );
    }
    suppliedNumbers.vacantLeadSlot = vacant;
  }

  // How the leads divide between four sides, e.g. `6,6,6,5`.
  //
  // The generator has asked for this since 2026-08-14 and the route had no way
  // to receive it, so the question was unanswerable: a quad package with unequal
  // sides refused, told the user which value would fix it, and then rejected
  // that value as an unknown field. Every asked-for field is accepted here; that
  // is what makes it an ask rather than a refusal with extra words.
  const perSide = (payload as Record<string, unknown>).leadsPerSide;
  if (perSide !== undefined) {
    // ONE COUNT PER SIDE, for the side counts this generator can build: 1, 2 or
    // 4. This demanded exactly FOUR, so a two-sided package with unequal rows
    // had a question the route could not accept an answer to. Three is still
    // rejected, because a package with leads on three sides is refused by the
    // pad placer rather than approximated, and `sidesFrom` in the generator does
    // the rest: it checks the length against `leadSides` and the sum against the
    // pin count, and refuses a list that does neither.
    if (typeof perSide !== "string" || !/^\d{1,3}(?:,\d{1,3})?$|^\d{1,3}(?:,\d{1,3}){3}$/.test(perSide)) {
      return NextResponse.json(
        { error: "leadsPerSide must be comma-separated whole counts from pin 1, one per side, e.g. 6,6,6,5." },
        { status: 400 }
      );
    }
    suppliedNumbers.leadsPerSide = perSide;
  }

  // A package with no characterised land pattern is a refusal, not a degraded
  // export. Emitting the symbol and the 3D body while silently dropping the
  // footprint would read as a success to anyone who did not check the file list.
  let bundle: Awaited<ReturnType<typeof createExportZip>>;
  try {
    bundle = await createExportZip(part, format, {
      formedLeadSpanMm: formedSpan,
      formedLeadContactMm: formedContact,
      supplied: suppliedNumbers as SuppliedDimensions
    });
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
    // THE FOOTPRINT CONTRADICTED ITSELF, which is a refusal and not a crash.
    //
    // `validateGeometry` is the one guard measured as catching real defects: it
    // found two quad packages shipping with all four corner lands shorted on its
    // first run. It fired correctly and then left this handler uncaught, so
    // Next.js answered 500 and the user read "Export failed".
    //
    // Its own message names the values to check and says that correcting one
    // rebuilds the footprint. That message was unreachable, which made a working
    // guard indistinguishable from a broken server.
    //
    // 422 rather than 500 because the request was well formed and the ANSWER is
    // that no file can honestly be produced from it. `violations` is itemised
    // separately from the prose so a UI can list them without parsing a
    // paragraph. Deliberately NOT `needs`: a violation is not a question, and
    // dressing it as one would prompt for a value that fixes nothing.
    if (error instanceof FootprintInvalidError) {
      return NextResponse.json(
        {
          error: error.message,
          code: "FOOTPRINT_INVALID",
          violations: error.violations,
          packageType: part.packageType
        },
        { status: 422 }
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
          pinCount: resolved.part.pinCount
        },
        { status: 422 }
      );
    }
    throw error;
  }
  // sanitizeFileName enforces a safe basename; swap the .pdf it appends for the real .zip extension.
  const fileName = sanitizeFileName(`${resolved.part.partNumber}-forge`).replace(/\.pdf$/, ".zip");
  // What the lands ACTUALLY are, taken from the footprint that was just built.
  //
  // This said "generated from the IPC-7351B land pattern" unconditionally,
  // including for the common case where the lands are the vendor's own printed
  // footprint and IPC-7351B contributed only the courtyard margin. The file's
  // own `descr` has always said the right thing; the sentence the user reads
  // did not, and the two claims are not interchangeable to anyone signing off a
  // board.
  const exportNote = `Native ${format} library. Lands: ${bundle.footprint.source}.`;

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