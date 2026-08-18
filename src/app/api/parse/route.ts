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
import { type PackageDrawing } from "../../../lib/packagedrawing";
import { type ReviewItem } from "../../../lib/review";
import { type RenderedPage } from "../../../lib/pagerender";
import { type PackageChoice } from "../../../lib/exporters";
import { type ConfidenceCheck } from "../../../lib/confidence";
import { buildReadout } from "../../../lib/readout";

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

  // The record the document STARTS as: the part number from the file the user
  // named, the package from the one they picked, and everything else honestly
  // unknown.
  //
  // This said "the deterministic pass ALWAYS runs first and always wins", which
  // described a 7,500-line reader deleted on 2026-08-14 after measurement showed
  // it contributed nothing to any dimension. What runs here fills two fields
  // from the CALLER, so the sentence was telling a reader the model is a
  // gap-filler behind a parser that no longer exists.
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
  let method = "text only";
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
          `Retrieval and text extraction used the request's time budget, so the ${model.name} extraction pass was skipped. Nothing was read off the document.`
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
          // THE RENDERS THE MODEL WAS ALREADY SHOWN, not a second pass over the
          // same pages. This called `renderPages` again on `outcome.renderedPages`
          // under a comment saying re-rendering them would be pure waste; the
          // images had been produced inside `runExtraction` and only their page
          // numbers came back. Rasterising is the most expensive thing this route
          // does to an untrusted PDF and it was being done twice per part.
          rendered = outcome.renderedImages;
          if (outcome.filled.length > 0) method = `read by ${model.name}`;
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
              ? `The ${model.name} extraction pass did not answer within its ${Math.round(budgetMs / 1000)}s budget and was abandoned, so nothing was read off the document.`
              : `The ${model.name} extraction pass failed, so nothing was read off the document.`
          ]
        };
      }
    }
  }

  // The land-pattern cross-check used to run here.
  //
  // It resolved the package against a hand-typed family table, computed a land
  // pattern from that family's lead dimensions, and compared the result to the
  // callouts printed in the document, as a note. Both halves are gone now and
  // for the same reason: the printed pattern is READ into `landPad*` and
  // `landSpan` and used as the pads directly, so there is no longer a substitute
  // to compare against it. Where the pattern has to be derived from the package
  // outline instead, `contradictsPrintedLand` in the generator refuses a
  // derivation the printed page disagrees with, which is a refusal rather than a
  // note and runs at the point the copper is actually placed.

  // EVERYTHING PAST THIS POINT IS SHARED WITH `/api/lookup`.
  //
  // It used to live here and only here, so a looked-up part reached the user
  // with no package chooser, no confidence checks and no review panel. See
  // `buildReadout`: past the point where the bytes are in hand, an upload and a
  // part-number lookup are the same operation, and keeping two copies is how the
  // two came to differ.
  const readout = await buildReadout(part, doc, ref.bytes, rendered);

  return NextResponse.json<
    RetrievalSuccess & {
      method: string;
      packageDrawing: PackageDrawing | null;
      packageChoice: PackageChoice;
      checks: ConfidenceCheck[];
      review: ReviewItem[];
      reviewPages: RenderedPage[];
    }
  >({
    // The readout's copy, which carries the `vendorLandPattern` repair.
    part: readout.part,
    source: toRetrievalSource(ref, "upload"),
    mode,
    method,
    packageDrawing: readout.packageDrawing,
    packageChoice: readout.packageChoice,
    checks: readout.checks,
    review: readout.review,
    reviewPages: readout.reviewPages
  });
}
