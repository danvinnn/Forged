import type { RenderedPage } from "../pagerender";
import type { PinRecord } from "../types";

/**
 * Layer 2 extraction model contract.
 *
 * This module is reachable in air-gapped mode and must contain no networking
 * code and no external URLs. Concrete models live under `models/` and are
 * reached only through a dynamic import in `factory.ts`, the same structural
 * gate the resolver factory uses.
 */

/** Fields a model may be asked to resolve. Dotted paths address nested values. */
export const extractionFields = [
  "partNumber",
  "manufacturer",
  "packageType",
  "pinCount",
  "pins",
  "dimensions.bodyLengthMm",
  "dimensions.bodyWidthMm",
  "dimensions.bodyHeightMm",
  "dimensions.pitchMm",
  "dimensions.leadLengthMm",
  "dimensions.leadCount",
  // The two a land pattern is actually built from, and the two nothing asked
  // for until 2026-08-03. `computeLandPattern` needs a lead span and a lead
  // width; the deterministic drawing reader reads the width and explicitly
  // cannot read the span, so every span in `packages.ts` is a hand-read family
  // constant. A model reading the rendered drawing returns both exactly.
  "dimensions.leadWidthMm",
  "dimensions.leadSpanMm",
  "dimensions.leadContactMm",
  // The exposed thermal pad's own size. Without these a part with a pad cannot
  // be built at all: the numbered lands alone are a footprint missing the
  // feature the part is soldered by.
  "dimensions.thermalPadLengthMm",
  "dimensions.thermalPadWidthMm",
  "radiation.tid",
  "radiation.see",
  "radiation.sel",
  "radiation.qmlClass"
] as const;

export type ExtractionField = (typeof extractionFields)[number];

/**
 * One value the model claims to have read, with the page it claims to have read
 * it from. The page is a CLAIM, not a citation: it is verified against the
 * document before it becomes one, because an unverifiable citation is worse
 * than no citation for a QML audit trail.
 */
/** A dimension a drawing prints as a range, e.g. lead span 6.2 to 6.6. */
export interface ModelRange {
  minMm: number;
  maxMm: number;
}

export interface ModelValue {
  value: string | number | PinRecord[] | ModelRange | null;
  /** 1-indexed page the model says the value appears on, if it reported one. */
  page: number | null;
}

/**
 * What was sent to the model, and what it was a subset of.
 *
 * Lived in `pageselect.ts` until that module was deleted on 2026-08-11. The
 * whole document now goes to the model, so `reason` is `whole-document` in
 * practice and `truncated` only past a 2,000,000-character safety rail; the
 * older values are kept so a stored record from before the change still reads.
 */
export interface PageSelection {
  pages: Array<{ page: number; text: string }>;
  /** How the pages were chosen, for the record and for logs. */
  reason: "relevance" | "leading" | "whole-document" | "truncated";
  /** Pages the whole document had, before any limit was applied. */
  totalPages: number;
  /** Characters the whole document had, before any limit was applied. */
  totalChars: number;
}

export interface ExtractionRequest {
  /** Page-scoped text. Models are given pages, not one flattened blob, so they can cite. */
  pages: Array<{ page: number; text: string }>;
  /**
   * The same pages RENDERED, where a renderer was available.
   *
   * Sent alongside the text rather than instead of it, because the two are good
   * at different things. The text layer is exact for anything typed and is what
   * `verifyCitation` checks a claim against; the render is the only faithful
   * view of a mechanical drawing, and the only one that survives a PDF which
   * encodes a pin name's glyphs in reverse order. See `pagerender.ts` for the
   * measurement behind that.
   *
   * Empty when no renderer is present, which is a supported deployment: the
   * request degrades to the text-only form it had before.
   */
  images: RenderedPage[];
  fileName: string;
  /** Requested part number, when the caller knows it. */
  partNumber?: string;
  /**
   * The package the deterministic pass resolved this part to, when it could.
   *
   * Load-bearing on any datasheet covering more than one package, which is most
   * of them. Measured on 2026-08-03: asked about an LM358 without it, the model
   * correctly returned NULL for every dimension and said why, "the document
   * describes several packages with different physical dimensions, and no
   * specific package variant was specified". That is the right answer to the
   * question it was asked, and the wrong question.
   *
   * It also guards against the opposite failure. The ambiguity is what produced
   * the one wrong package family the model has ever been caught on: told
   * nothing, it picked one of four the document offered and picked wrong.
   */
  packageType?: string | null;
  /**
   * The packages this document describes, when the deterministic pass could not
   * settle on ONE of them.
   *
   * The complement of `packageType` above, and it exists because refusing to
   * pick is not the same as having nothing to say. Told nothing, the model
   * refuses the whole document and says exactly why, measured on the hold-out:
   * STM32L476RG, "the document specifies multiple package options (LQFP64,
   * WLCSP72, ...) so package dimensions, lead specifications and pin count
   * cannot be uniquely assigned"; TSZ121, "without specifying a single primary
   * package for intake". Both are correct answers to the question as asked, and
   * both cost the entire part.
   *
   * A person resolves this from the PART NUMBER: an `STM32L476RG` is the 64-pin
   * member of its family, so LQFP64 is the only candidate that fits. That is
   * knowledge about a vendor's ordering scheme, which is exactly the kind of
   * thing a model has and a parser cannot be given.
   *
   * It is a list of CANDIDATES the document itself names, never an invitation to
   * invent one, and where the part number genuinely does not decide (a part
   * really sold in two packages) the model is told to refuse rather than guess.
   * That refusal is the package chooser's job, not extraction's.
   */
  packageCandidates?: string[];
  /**
   * Only the fields the deterministic pass could not resolve. A model is never
   * asked about, and can never overwrite, a value that was read off the page by
   * code.
   */
  fields: ExtractionField[];
  /**
   * What `pages` is a subset of, and how it was chosen. Present so a partial
   * view of the document is recorded rather than silent: a model that answered
   * null may simply never have been shown the page.
   */
  selection?: PageSelection;
}

export interface ExtractionResult {
  /** Values the model produced, keyed by field. Absent means "no answer". */
  values: Partial<Record<ExtractionField, ModelValue>>;
  /** Free-form observations to surface as record notes. */
  notes?: string[];
  /**
   * Pages the model wants to LOOK at, named after it has read the whole text.
   *
   * The second pass. A mechanical drawing states its dimensions as labels beside
   * dimension lines, and which dimension a label belongs to is carried by the
   * ARROWS, which are graphics: the text layer has the numbers and not what they
   * measure. So the values on those pages are unreadable from text and readable
   * from a render.
   *
   * Asked of the model rather than decided for it, because after reading the
   * document it knows where its drawings are and nothing else in the system
   * does. Everything that tried to decide this on the model's behalf has been a
   * source of lost parts.
   *
   * Absent or empty means the text was enough and no second pass is made.
   */
  pagesWorthRendering?: number[];
  /**
   * What the call cost, when the provider reports it. Absent otherwise, and
   * absent is not zero.
   *
   * Here because the run that ran the account dry could not say how much it had
   * spent, and the estimate it was authorised against turned out to be for a
   * different configuration: the image path is roughly four times the input of
   * the text path, and reasoning tokens are billed as output and were never
   * counted at all. A number nobody can see is a number nobody can check.
   *
   * `outputTokens` INCLUDES reasoning tokens where the provider separates them,
   * because the bill does.
   */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ExtractionModel {
  /** Identifies the model in provenance and logs, e.g. "gemini" or "local:qwen3-vl". */
  readonly name: string;
  /** Whether this model has everything it needs to run (key, endpoint, etc.). */
  isConfigured(): boolean;
  extract(request: ExtractionRequest): Promise<ExtractionResult>;
}

/** Thrown when a model is misconfigured or its response cannot be used. */
export class ExtractionModelError extends Error {
  readonly kind: "config" | "transport" | "bad_response";

  constructor(kind: "config" | "transport" | "bad_response", message: string) {
    super(message);
    this.name = "ExtractionModelError";
    this.kind = kind;
  }
}
