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
import { answersFromSettings, parseSettings } from "../../../lib/settings";
import { PdfExtractionError, PdfUnreadableError } from "../../../lib/pdftext";
// The extraction layer's public surface deliberately excludes the concrete
// models, so importing it cannot pull a networked model into the air-gapped
// module graph. makeExtractionModel reaches those by dynamic import.
import { makeExtractionModel, runExtraction } from "../../../lib/extraction";
import { SpendLimitReached } from "../../../lib/spend";
import { SecondPassFailedError } from "../../../lib/extraction/contracts";
import {
  ModelDeadlineError,
  modelBudgetMs,
  withDeadline,
  worthAsking
} from "../../../lib/extraction/budget";
import { type PackageDrawing } from "../../../lib/packagedrawing";
import { type ReviewItem } from "../../../lib/review";
import type { Confirmation } from "../../../lib/confirm";
import { type RenderedPage } from "../../../lib/pagerender";
import { type PackageChoice } from "../../../lib/exporters";
import { type ConfidenceCheck } from "../../../lib/confidence";
import { buildReadout } from "../../../lib/readout";

/**
 * How much of a route's remaining budget rendering may take.
 *
 * `renderPages` returns FEWER PAGES rather than throwing when it runs out of
 * time, so an unbounded render inside a deadlined route does not fail loudly: it
 * quietly thins the second pass, and the part reads worse for a reason nothing
 * reports. That became live on 2026-08-18 when the page budget went from 8 to
 * 16 and the render ceiling, which is sized from it, went to about 24 seconds
 * inside a route allowed 30.
 *
 * A third leaves two thirds for the two model calls, which are the part of the
 * work that cannot be made cheaper by doing less of it.
 */
const RENDER_SHARE_OF_BUDGET = 1 / 3;

export const runtime = "nodejs";
// Ceiling so a slow retrieval or parse cannot hold a request open indefinitely.
//
// RAISED FROM 30 ON 2026-08-20. Measured with `bench:repeat`, six parts, live
// calls, NET of the bench's own rate-limit pacing: a parse takes p50 75.6s and
// p90 128.8s, and 9 of 9 parses blew the ~25s this route was leaving the model.
// On that deadline `withDeadline` discards the WHOLE pass, including a pass 1
// that had already succeeded and been paid for.
//
// 150 covers the p90 with the response margin and local work on top. It is NOT
// a serverless platform's number: this is our own budget, enforced by our own
// code, so it travels to whatever host we run on. A host that imposes something
// shorter has to be told about it here.
export const maxDuration = 150;

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

/**
 * How long the settings blob may be before this route refuses to parse it.
 *
 * `parseSettings` drops anything it does not recognise, so the risk is not a
 * bad field but the JSON parse itself: an unbounded string from an untrusted
 * caller is an unbounded parse. The real object is two numbers and a density
 * level.
 */
const MAX_SETTINGS_LENGTH = 2048;

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

  // THE INSTALLATION'S SETTINGS, so the chooser does not ask for what they
  // already answer.
  //
  // Two of them are per-part questions settled up front: the formed lead span
  // and the seated foot. `/api/export` has read them for months; this route
  // built the package chooser as if nothing had been answered, so a ceramic flat
  // pack was shown two questions its own settings screen had answered. Parsed
  // through `parseSettings`, which drops anything unrecognised and bounds both
  // numbers exactly as the export route bounds them.
  const settingsField = formData.get("settings");
  let settings: ReturnType<typeof parseSettings> = {};
  if (typeof settingsField === "string" && settingsField.length > 0 && settingsField.length < MAX_SETTINGS_LENGTH) {
    try {
      settings = parseSettings(JSON.parse(settingsField) as unknown);
    } catch {
      // Malformed settings are not a reason to refuse a datasheet. The chooser
      // simply asks for the two numbers, which is what it did before this
      // existed.
    }
  }

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
    // A FILE THAT WILL NOT OPEN IS BAD INPUT, NOT A SERVER FAULT.
    //
    // A download that stopped halfway used to escape as whatever pdf.js threw,
    // and an unrecognised throw out of a route handler is an HTTP 500. The
    // person saw "something went wrong" with nothing pointing at their file.
    // The underlying text is logged and not shown: "Invalid PDF structure" tells
    // a person nothing they can act on.
    if (error instanceof PdfUnreadableError) {
      console.error("upload could not be opened as a PDF", error.underlying);
      return NextResponse.json<RetrievalError>(
        { error: error.message, code: "UPLOAD_INVALID", mode },
        { status: 400 }
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

  // NO READER CONFIGURED IS THE THIRD DOOR TO THE SAME SILENT DEGRADE.
  //
  // Two doors below already refuse to hand back a parser-only record dressed as
  // a success: the budget one, and the catch around the model call. This one was
  // open. `makeExtractionModel` answers null when no key, no service account and
  // no local endpoint is configured, and the whole model block was simply
  // skipped - so an expired key, a revoked service account or a deployment that
  // lost its environment produced HTTP 200, a record of nothing but nulls, and
  // no hint anywhere that a reader had never run.
  //
  // `bench:holdout` measures the parser alone at READ 0 of 59. Handing that back
  // as a success is not a degraded answer, it is a wrong one, and the route's own
  // rule two paragraphs down already says so.
  //
  // Found by `bench:badinput` on 2026-08-29.
  if (!model) {
    return NextResponse.json(
      {
        error:
          mode === "commercial"
            ? `No reader is configured for this deployment, so the datasheet was never read. Nothing was built. ` +
              `A deployment needs either Vertex credentials, a Gemini API key, or a local model endpoint.`
            : `No local reader is configured for this air-gapped deployment, so the datasheet was never read. ` +
              `Nothing was built. Air-gapped mode needs a local model endpoint on a private address.`,
        code: "MODEL_UNAVAILABLE",
        // Not retryable: the same request will fail the same way until someone
        // configures a reader. Saying "try again" would send them round a loop.
        retryable: false,
        mode,
        // THE UPLOAD STILL HAPPENED, so it is still reported. The file was
        // received, validated and hashed before this point, and a caller that
        // has to reconcile a request with an audit trail needs the digest
        // whether or not a reader ran. Refusing to read is not a reason to
        // forget what was read from.
        source: toRetrievalSource(ref, "upload")
      },
      { status: 503 }
    );
  }

  if (model) {
    const budgetMs = modelBudgetMs(ROUTE_BUDGET_MS, Date.now() - startedAt);

    if (!worthAsking(budgetMs)) {
      // Retrieval and parsing have already used the route's budget. Asking now
      // guarantees the platform kills the function mid-call, which would lose the
      // record that is already in hand.
      // SAME RULE AS THE CATCH BELOW. Fetching and parsing the document used the
      // whole budget, so the model never ran, so the record is the parser's
      // alone - which `bench:holdout` measures at READ 0 of 59. Handing that
      // back as a success is the same silent degrade, reached by a different
      // door.
      return NextResponse.json(
        {
          error:
            `Fetching and reading this document used the whole time budget for one request, so it was never sent ` +
            `to the reader and no library was built. Try again.`,
          retryable: true
        },
        { status: 503, headers: { "Retry-After": "5" } }
      );
    } else {
      try {
        // Rendered inside the try: a renderer failure is a model-pass failure,
        // and both must leave the deterministic record untouched.
        const outcome = await withDeadline(
          runExtraction(
            part,
            doc,
            ref.bytes,
            model,
            ref.fileName,
            undefined,
            Math.round(budgetMs * RENDER_SHARE_OF_BUDGET)
          ),
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
          // THE READER ANSWERED, AND ITS ANSWER COULD NOT BE READ.
          //
          // Not the same as a datasheet that states nothing, and the difference
          // is the whole point: one is a fact about the document, the other is a
          // broken deployment. Returning 200 with an empty record told an
          // operator whose local model replies in prose that their DATASHEET was
          // the problem. Found 2026-08-30 by pointing the route at an endpoint
          // that answered in sentences.
          //
          // Both conditions, because a prose first pass followed by a good
          // drawing pass is a successful read and must not be thrown away.
          if (outcome.readerUnreadable && outcome.filled.length === 0) {
            console.error("reader answer could not be parsed and nothing was filled", ref.fileName);
            return NextResponse.json(
              {
                error:
                  `The reader answered, but its reply could not be read, so nothing was built from this ` +
                  `datasheet. This is a problem with the reader rather than with the document. Try again, ` +
                  `and if it persists check which model the deployment is pointed at.`,
                code: "MODEL_UNAVAILABLE",
                retryable: true,
                mode,
                source: toRetrievalSource(ref, "upload")
              },
              { status: 503, headers: { "Retry-After": "5" } }
            );
          }
        }
      } catch (error) {
        // THE DEPLOYMENT'S OWN SPEND CEILING. Not retryable and not the
        // document's fault: the money is still there and the provider is fine,
        // so the answer is a person deciding the spend is worth continuing.
        // Degrading to a thin record here would hide the reason entirely.
        if (error instanceof SpendLimitReached) {
          console.error("spend ceiling reached", error.message);
          return NextResponse.json(
            { error: error.message, code: "SPEND_LIMIT_REACHED", retryable: false, mode },
            { status: 402 }
          );
        }
        // A model failure must never cost the user the deterministic record.
        // Running out of time is reported as what it is rather than as a failure,
        // because the two call for different actions: one is retryable, the other
        // means the document is too big for this route's budget.
        // THE DRAWING PASS FAILING IS A FAILED PARSE, not a thinner one.
        //
        // Everything else in this catch degrades: the record survives with a
        // note and the user gets whatever was read. That is right for a
        // timeout or a first-pass error, where the alternative is nothing at
        // all. It is wrong when the pass that reads the DRAWINGS is the one
        // that died, because pass 1 answers those same dimensions off the text
        // layer and is measurably wrong there - REF5025's prose says 6.9mm
        // where its drawing says 7.035mm, RHF1201's front page says `gullwing`
        // where its drawing says `straight`. A lead form read wrong changes the
        // whole land pattern.
        //
        // Anthony's call, 2026-08-20: a caveat on the deliverable is worse than
        // useless, because it makes the user check everything and that is the
        // job they came here to avoid. Either files nobody has to second-guess,
        // or "we could not read it, try again". So this one returns an error
        // the UI can offer a retry on, and no half-built record.
        if (error instanceof SecondPassFailedError) {
          console.error("extraction drawing pass failed after retry", error);
          return NextResponse.json(
            { error: error.message, retryable: true },
            { status: 503, headers: { "Retry-After": "5" } }
          );
        }
        // A PARSE THAT LOST THE MODEL PASS IS A FAILED PARSE, NOT A THINNER ONE.
        //
        // This used to keep the deterministic record, add a note saying nothing
        // was read, and return 200. The user got a bundle, the screen said
        // "Ready to build", and the note sat in a list they had no reason to
        // open.
        //
        // Two facts make that untenable together:
        //
        //   1. The parser ALONE reads almost nothing. `bench:holdout` without
        //      `--model` scores READ 0 of 59. So the record this path preserved
        //      is not a thinner answer, it is very nearly an empty one wearing a
        //      success.
        //   2. Which path a request takes is a matter of TIMING. A rad-hard
        //      engineer reading the same PDF three times on 2026-08-28 got a
        //      package list of 2 cards, then 4, then 5, and one part's mounting
        //      as `smd` and then blank. `bench:repeatable` proves our own half is
        //      byte-identical over 100 documents and 3 runs, so this was the
        //      variance they were seeing: sometimes the model pass landed inside
        //      the budget and sometimes it did not.
        //
        // A tool for flight hardware that answers differently on identical input,
        // with no visible difference between the two answers, is worse than one
        // that says it could not finish.
        //
        // So this now does what the drawing-pass failure immediately above
        // already does, for the same stated reason - Anthony's call, 2026-08-20:
        // "a caveat on the deliverable is worse than useless, because it makes
        // the user check everything and that is the job they came here to avoid.
        // Either files nobody has to second-guess, or 'we could not read it, try
        // again'." A timeout is exactly that situation; it was simply not the
        // error being discussed at the time.
        //
        // Retryable, because both causes are transient by nature: a slow call
        // and a loaded model. The UI already offers the retry, and it is one
        // button rather than a loop.
        const timedOut = error instanceof ModelDeadlineError;
        if (!timedOut) console.error("extraction model failed", error);
        return NextResponse.json(
          {
            error: timedOut
              ? `Reading this datasheet did not finish within the ${Math.round(budgetMs / 1000)}s this request allows. Nothing was read off the document, so no library was built. Try again.`
              : `The reader failed part way through this datasheet, so nothing was read off it and no library was built. Try again.`,
            retryable: true
          },
          { status: 503, headers: { "Retry-After": "5" } }
        );
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
  const readout = await buildReadout(part, doc, ref.bytes, rendered, answersFromSettings(settings));

  return NextResponse.json<
    RetrievalSuccess & {
      method: string;
      packageDrawing: PackageDrawing | null;
      packageChoice: PackageChoice;
      checks: ConfidenceCheck[];
      review: ReviewItem[];
      /** What a person has to check; see `confirm.ts`. */
      toCheck: Confirmation[];
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
    toCheck: readout.toCheck,
    reviewPages: readout.reviewPages
  });
}
