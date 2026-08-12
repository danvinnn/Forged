import { NextResponse } from "next/server";
import {
  getDeploymentMode,
  ingestUpload,
  clientKey,
  activeUploadLimiter,
  MAX_PDF_BYTES,
  UploadValidationError,
  toRetrievalSource,
  type RetrievalError,
  type RetrievalSuccess
} from "../../../lib/retrieval";
import { extractPartRecord } from "../../../lib/datasheet";
import { PdfExtractionError } from "../../../lib/pdftext";
// The extraction layer's public surface deliberately excludes the concrete
// models, so importing it cannot pull a networked model into the air-gapped
// module graph. makeExtractionModel reaches those by dynamic import.
import { makeExtractionModel, runExtraction } from "../../../lib/extraction";
import {
  ModelDeadlineError,
  modelBudgetMs,
  withDeadline,
  worthAsking
} from "../../../lib/extraction/budget";
import { computeLandPattern } from "../../../lib/ipc7351";
import { resolvePackageDefinition } from "../../../lib/packages";
import { findPackageDrawing, type PackageDrawing } from "../../../lib/packagedrawing";
import { crossCheckLandPattern } from "../../../lib/vendorland";
import { collectReviewItems, reviewPages, type ReviewItem } from "../../../lib/review";
import { renderPages, type RenderedPage } from "../../../lib/pagerender";
import { packageOptions, type PackageChoice } from "../../../lib/exporters";

export const runtime = "nodejs";
// Ceiling so a slow retrieval or parse cannot hold a serverless function open indefinitely.
export const maxDuration = 30;

/**
 * The model pass gets a budget of its own, carved out of what is left of this
 * route's. The reasoning and the measured numbers are in `extraction/budget.ts`;
 * the short version is that a model call can take 41.6 seconds against this
 * route's 30, and being killed by the platform costs the user a deterministic
 * record that had already succeeded.
 */
const ROUTE_BUDGET_MS = maxDuration * 1000;

/** A package designator is a short printed token; anything longer is not one. */
const MAX_PACKAGE_HINT_LENGTH = 64;

export async function POST(request: Request) {
  const startedAt = Date.now();
  const mode = getDeploymentMode();

  // Each call buffers and hashes megabytes, so the endpoint needs a ceiling even though it makes
  // no outbound request.
  const limit = await activeUploadLimiter().check(clientKey(request));
  if (!limit.allowed) {
    return NextResponse.json<RetrievalError>(
      { error: "Too many uploads. Try again shortly.", code: "RATE_LIMITED", mode },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  // Reject on the declared body size BEFORE parsing the multipart body. request.formData() buffers
  // the entire body into memory, so by the time assertPdfBytes runs inside ingestUpload the damage
  // is done: a 1GB POST would OOM the process long before anything validated it. Same bug class as
  // the download path, and it needed the same fix. The header can lie, which is why the real
  // file.size check below still runs.
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PDF_BYTES) {
    return NextResponse.json<RetrievalError>(
      { error: "File is larger than the 50MB limit.", code: "UPLOAD_INVALID", mode },
      { status: 413 }
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    // Malformed multipart, or a body the platform cut off. Not a crash.
    return NextResponse.json<RetrievalError>(
      { error: "Could not read the uploaded file.", code: "UPLOAD_INVALID", mode },
      { status: 400 }
    );
  }

  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json<RetrievalError>(
      { error: "Missing PDF upload.", code: "UPLOAD_INVALID", mode },
      { status: 400 }
    );
  }

  // Check the real size before calling arrayBuffer(), which is the allocation that would hurt.
  if (file.size > MAX_PDF_BYTES) {
    return NextResponse.json<RetrievalError>(
      { error: "File is larger than the 50MB limit.", code: "UPLOAD_INVALID", mode },
      { status: 413 }
    );
  }

  // The package the caller picked, where they have. A datasheet offering several
  // packages does say what they are and cannot say which one the user is
  // holding, so the readers below take it as an argument and use it to choose
  // among per-package pinouts. Measured on the hold-out: five parts of
  // thirty-eight read NOTHING unaided and read completely once it is supplied.
  //
  // Length-bounded like every other string this route accepts. A package
  // designator is a short printed token; anything longer is not one, and this
  // value reaches regex construction downstream.
  const chosenPackage = formData.get("packageType");
  const packageHint =
    typeof chosenPackage === "string" && chosenPackage.trim().length > 0
      ? chosenPackage.trim().slice(0, MAX_PACKAGE_HINT_LENGTH)
      : undefined;

  let ref;
  try {
    ref = ingestUpload({ fileName: file.name, bytes: await file.arrayBuffer() });
  } catch (error) {
    if (error instanceof UploadValidationError) {
      return NextResponse.json<RetrievalError>(
        { error: error.message, code: "UPLOAD_INVALID", mode },
        { status: 400 }
      );
    }
    throw error;
  }

  // Deterministic pass ALWAYS runs first and always wins. A model is only ever
  // asked about fields the code could not read off the page.
  let doc;
  let part;
  try {
    const extracted = await extractPartRecord(ref.fileName, ref.bytes, undefined, {
      packageType: packageHint
    });
    doc = extracted.doc;
    part = extracted.part;
  } catch (error) {
    // A structurally valid PDF that is too large or too complex to parse is bad
    // input, not a server fault, and must not read as a crash.
    if (error instanceof PdfExtractionError) {
      return NextResponse.json<RetrievalError>(
        { error: error.message, code: "PARSE_LIMIT_EXCEEDED", mode },
        { status: 422 }
      );
    }
    throw error;
  }
  let method = "deterministic";
  // Renders kept in scope past the model block. The review panel shows the user
  // the page a value came from, and re-rendering a page we already rasterised
  // for the model would be pure waste.
  let rendered: RenderedPage[] = [];

  const model = await makeExtractionModel(mode);
  if (model) {
    const budgetMs = modelBudgetMs(ROUTE_BUDGET_MS, Date.now() - startedAt);

    if (!worthAsking(budgetMs)) {
      // Retrieval and parsing have already used the route's budget. Asking now
      // guarantees the platform kills the function mid-call, which would lose the
      // record that is already in hand.
      part = {
        ...part,
        notes: [
          ...part.notes,
          `Retrieval and text extraction used the request's time budget, so the ${model.name} extraction pass was skipped. Only text extraction was applied.`
        ]
      };
    } else {
      try {
        // Rendered inside the try: a renderer failure is a model-pass failure,
        // and both must leave the deterministic record untouched.
        const outcome = await withDeadline(
          runExtraction(part, doc, ref.bytes, model, ref.fileName),
          budgetMs
        );
        if (outcome) {
          part = outcome.part;
          // Rendered pages are needed by the review panel, which shows a
          // reviewer the page a value was read from.
          rendered = await renderPages(ref.bytes, outcome.renderedPages, { maxPages: 8 });
          if (outcome.filled.length > 0) method = `deterministic+${model.name}`;
        }
      } catch (error) {
        // A model failure must never cost the user the deterministic record.
        // Running out of time is reported as what it is rather than as a failure,
        // because the two call for different actions: one is retryable, the other
        // means the document is too big for this route's budget.
        const timedOut = error instanceof ModelDeadlineError;
        if (!timedOut) console.error("extraction model failed", error);
        part = {
          ...part,
          notes: [
            ...part.notes,
            timedOut
              ? `The ${model.name} extraction pass did not answer within its ${Math.round(budgetMs / 1000)}s budget and was abandoned; only text extraction was applied.`
              : `The ${model.name} extraction pass failed; only text extraction was applied.`
          ]
        };
      }
    }
  }

  // Cross-check the land pattern we would generate against the one the vendor
  // prints, while the document is still in hand. The export route only ever sees
  // the JSON record, so this is the last point at which the comparison is free.
  // A disagreement is reported, not resolved: IPC-7351B and a vendor house rule
  // are both legitimate and they genuinely differ.
  const packageType = part.packageType.value;
  const pinCount = part.pinCount.value;

  if (packageType && pinCount !== null) {
    // The same resolution the exporter performs, drawing evidence included. An
    // ISO7741 calls itself a "16-pin SOIC" and its drawing is titled DW0016B,
    // which is the wide body: resolving without the code here would report a
    // land pattern check for a package the export does not build.
    const lookup = resolvePackageDefinition(packageType, pinCount, {
      outlineCode: part.packageOutlineCode.value,
      pitchMm: part.dimensions.pitchMm.value,
      leadWidthMm: part.dimensions.leadWidthMm.value
    });
    if (lookup.ok) {
      try {
        const land = computeLandPattern(lookup.definition.lead);
        const check = crossCheckLandPattern(doc, land, lookup.definition.family);
        if (check.agreement !== "unavailable") {
          part = { ...part, notes: [...part.notes, `Land pattern check: ${check.detail}`] };
        }
      } catch {
        // A land pattern that cannot be computed is reported by the export route
        // with a proper refusal; it is not this endpoint's job to duplicate that.
      }
    }
  }

  // Where the mechanical drawing is, so a value we could not read can be asked
  // for with that page already in front of the user instead of making them hunt
  // for it. Nothing is read off the drawing here; this is only its location.
  const packageDrawing = findPackageDrawing(doc, part.packageType.value ?? undefined);

  // What a person should look at, and the pages they need to look at it ON.
  //
  // The pages are shipped with the record rather than fetched later on demand,
  // because by the time the user is looking at the panel this route has already
  // released the PDF. A second endpoint would have to re-retrieve the document
  // to rasterise one page, which on the commercial path means fetching a vendor
  // PDF again to answer a question we could already answer.
  // What clicking each offered package would actually do. Computed here, where
  // the record is complete, because the chooser is shown before any export is
  // attempted and a dropdown that cannot say which of its entries work is the
  // failure `packageOptions` exists to end. It runs the real generator, so it
  // costs one footprint build per package and never disagrees with the export.
  const packageChoice = packageOptions(part);

  const review = collectReviewItems(part);
  const wanted = reviewPages(review);
  const already = new Map(rendered.map((image) => [image.page, image]));
  const missing = wanted.filter((page) => !already.has(page));
  // Only the pages nothing has rasterised yet. A renderer failure degrades the
  // panel to page numbers without pictures, which is still better than nothing,
  // so this is never allowed to fail the request.
  const extra = missing.length > 0 ? await renderPages(ref.bytes, missing, { maxPages: missing.length }) : [];
  for (const image of extra) already.set(image.page, image);
  const pages = wanted.map((page) => already.get(page)).filter((image): image is RenderedPage => Boolean(image));

  return NextResponse.json<
    RetrievalSuccess & {
      method: string;
      packageDrawing: PackageDrawing | null;
      packageChoice: PackageChoice;
      review: ReviewItem[];
      reviewPages: RenderedPage[];
    }
  >({
    part,
    source: toRetrievalSource(ref, "upload"),
    mode,
    method,
    packageDrawing,
    packageChoice,
    review,
    reviewPages: pages
  });
}
