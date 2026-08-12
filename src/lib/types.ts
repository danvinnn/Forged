import { z } from "zod";
// One shared definition of traceability, used by both the export gate here and
// the UI. See provenance.ts for why it does not live in this file.
import { isUntraceable } from "./provenance";

export const exportFormats = ["kicad", "altium", "cadence"] as const;

export const pinElectricalTypes = [
  "power",
  "input",
  "output",
  "bidirectional",
  "passive",
  "nc",
  "open_collector",
  "open_emitter",
  "unspecified"
] as const;

/**
 * How a value was produced. "deterministic" is the code parser, "vlm" is a
 * vision-language model, "user" is a human edit in the UI. null means the
 * value was never determined.
 */
/**
 * How a value got into the record.
 *
 * `vlm` and `vlm-drawing` are both model answers and are kept apart because
 * they carry different EVIDENCE, which is what an auditor is really asking
 * about. A `vlm` value was found in the page's text layer, so the citation
 * quotes it and anyone can grep the document for the same string. A
 * `vlm-drawing` value was read off the rendered page and is not in the text at
 * all, which is the only way to reach a dimension printed beside a dimension
 * line; its citation names the page and what was identified on it, and checking
 * it means looking at the drawing.
 *
 * Collapsing the two would let a value nobody can grep pass as one they can.
 */
// `user-confirmed` is distinct from `user` on purpose. "A person typed this
// number" and "a model read this number and a person checked it against page 2"
// are different provenance, and a QML reviewer auditing the record is entitled
// to tell them apart. Collapsing them would lose the fact that a citation backs
// the value.
export const extractionMethods = ["deterministic", "vlm", "vlm-drawing", "user", "user-confirmed"] as const;

export const textRegionSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
});

/** Where a value was read from in the source datasheet. */
export const citationSchema = z.object({
  page: z.number().int().positive(),
  snippet: z.string(),
  region: textRegionSchema.nullable()
});

/**
 * Wraps every extracted value with its provenance. A value that could not be
 * determined is `null` with a null confidence, method, and citation, so an
 * honest gap is visible in the data instead of being filled with a guess.
 * This is the IPC Class 3 / QML traceability requirement expressed in types.
 */
function extracted<T extends z.ZodTypeAny>(valueSchema: T) {
  return z.object({
    value: valueSchema.nullable(),
    confidence: z.number().min(0).max(1).nullable(),
    method: z.enum(extractionMethods).nullable(),
    citation: citationSchema.nullable()
  });
}

export const pinSchema = z.object({
  number: z.string().min(1),
  name: z.string().min(1),
  electricalType: z.enum(pinElectricalTypes),
  description: z.string().optional()
});

/**
 * A lead width is a min/max pair on the drawing, not a single figure, and
 * IPC-7351B uses both ends: the minimum sets the land width and the spread feeds
 * the RSS tolerance. Collapsing it to one number would throw away the half the
 * standard needs.
 */
export const leadWidthSchema = z.object({
  minMm: z.number(),
  maxMm: z.number()
});

export const packageDimensionsSchema = z.object({
  bodyLengthMm: extracted(z.number()),
  bodyWidthMm: extracted(z.number()),
  bodyHeightMm: extracted(z.number()),
  pitchMm: extracted(z.number()),
  leadLengthMm: extracted(z.number()),
  leadCount: extracted(z.number().int().positive()),
  // Defaulted rather than required so a record produced before this field
  // existed still validates as what it is: a record with no lead width read.
  leadWidthMm: extracted(leadWidthSchema).default({
    value: null,
    confidence: null,
    method: null,
    citation: null
  }),
  /**
   * Lead span, tip to tip across the package, as printed on the drawing.
   *
   * The one land-pattern input nothing in this project could read. The
   * deterministic drawing reader says so in its own notes: a vendor tags the
   * span on a flat pack (`2X 7.62`) and leaves it untagged on a SOIC or TSSOP,
   * where it is a plain max/min pair among several others, so it was left
   * absent rather than approximated. Every span in `packages.ts` was therefore
   * read by hand off one drawing and applied to a whole family.
   *
   * A model reading the rendered drawing does not have that problem: it can see
   * which pair of numbers the dimension line points at. Measured on 2026-08-03
   * against the hand-read values, it returned 6.2-6.6 for an INA240's PW0008A
   * and 4.75-5.05 for an LM358's DGK0008A, both exact.
   *
   * Same min/max shape as `leadWidthMm`, because that is how a drawing prints
   * it, and defaulted for the same backward-compatibility reason.
   */
  leadSpanMm: extracted(leadWidthSchema).default({
    value: null,
    confidence: null,
    method: null,
    citation: null
  }),
  /**
   * Lead contact length, drawing dimension L: the length of the foot that sits
   * on the land. Distinct from `leadLengthMm`, which is a single prose figure.
   *
   * A range because that is how a drawing prints it, and because the RANGE is
   * the part IPC-7351B needs. Measured on 2026-08-04, deriving a land pattern
   * from a single nominal instead cost up to 0.079 mm against the hand-read
   * family entry, always in the same direction: a shorter land on a wider span,
   * which is slightly less heel fillet. The spread is what the standard's RSS
   * term consumes, so dropping it is not a rounding difference, it is throwing
   * away one of the two tolerance inputs.
   */
  leadContactMm: extracted(leadWidthSchema).default({
    value: null,
    confidence: null,
    method: null,
    citation: null
  }),
  /**
   * The exposed thermal pad on the underside, drawing dimensions D2 and E2.
   *
   * Separate from the body because they are unrelated numbers: a 5 x 5 mm VQFN
   * carries a 3.1 x 3.1 mm pad. Both are needed before a part with a pad can be
   * built at all, so `exposedPad` without these is still a refusal.
   */
  thermalPadLengthMm: extracted(z.number().positive()).default({
    value: null,
    confidence: null,
    method: null,
    citation: null
  }),
  thermalPadWidthMm: extracted(z.number().positive()).default({
    value: null,
    confidence: null,
    method: null,
    citation: null
  })
});

export const radiationDataSchema = z.object({
  tid: extracted(z.string()),
  see: extracted(z.string()),
  sel: extracted(z.string()),
  qmlClass: extracted(z.string())
});

/**
 * A package the datasheet offers the part in.
 *
 * Recorded as a list because most datasheets offer several and a footprint is per
 * package: LD1117 covers four, TSV911 six, ADG5412 two. Multi-package ambiguity
 * now blocks more parts than any parsing defect, and every one of those refusals
 * is a document that DOES say which packages exist and does not say which one the
 * caller is holding. Reporting the list is what turns that refusal into a choice
 * the caller can make in one click, which is the friction the input model budgets
 * for.
 */
export const packageVariantSchema = z.object({
  designator: z.string().min(1).max(64),
  family: z.string().min(1).max(16),
  leadCount: z.number().int().positive().max(600).nullable(),
  /** Named where the datasheet introduces itself, rather than deeper in. */
  inFrontMatter: z.boolean()
});

export const partSchema = z.object({
  id: z.string().min(1),
  partNumber: extracted(z.string().min(1)),
  manufacturer: extracted(z.string().min(1)),
  packageType: extracted(z.string().min(1)),
  /**
   * The outline code printed on this part's own package drawing (`DW0016B`).
   * Recorded only when the drawing was confirmed to be this part's package, so
   * its presence is itself the evidence that it can be believed.
   */
  packageOutlineCode: extracted(z.string().min(1)).default({
    value: null,
    confidence: null,
    method: null,
    citation: null
  }),
  /**
   * Every package this datasheet names, so the caller can pick one when the
   * document describes several. Defaulted, because a record stored before this
   * field existed is still a valid record.
   */
  packageVariants: z.array(packageVariantSchema).max(32).default([]),
  /**
   * The land pattern this datasheet PRINTS for the resolved package, as bare
   * millimetre callouts, plus the page it was read from.
   *
   * Carried on the record rather than recomputed because the export route never
   * sees the document. It is evidence, not a result: a land pattern derived from
   * a part's own drawing has no JEDEC outline behind it, so the vendor's own page
   * is the only independent check available, and `packageFromDrawing` refuses a
   * pattern the page contradicts. Defaulted, so a record stored before this field
   * existed is still valid.
   */
  vendorLandPattern: z
    .object({ page: z.number().int().positive(), valuesMm: z.array(z.number().positive()).max(64) })
    .nullable()
    .default(null),
  pinCount: extracted(z.number().int().positive()),
  pins: extracted(z.array(pinSchema)),
  /**
   * The part has an exposed thermal pad, so no footprint can be built for it yet.
   *
   * Recorded on the RECORD and enforced at the FOOTPRINT rather than by throwing
   * the pin table away, which is what happened until 2026-08-10. A pad row is
   * evidence about the package, not a defect in the pinout: measured over the
   * hold-out, three parts (ADS1220, LD39050, ST1S10) had a completely correct
   * pinout discarded because the last row read `Pad`, `Exposed pad` or `epad`.
   * The safety property is unchanged, because the property was never "refuse the
   * pins", it was "never emit a footprint missing a mandatory pad".
   *
   * Defaulted, so a record stored before this field existed is still valid.
   */
  exposedPad: z.boolean().default(false),
  /**
   * Fields where the code and the model read the page differently.
   *
   * Neither side wins here. The deterministic value stays on the record, because
   * it is the one measured against the hand-read oracles (31/31 pin names, 24/24
   * package families), and the disagreement is carried alongside it so a person
   * can settle it with both pages in front of them.
   *
   * This is what makes asking the model about ALREADY-ANSWERED fields worth the
   * tokens. Before it, a model reading a field the code had also read was thrown
   * away unexamined, so the one case that matters, the code being confidently
   * wrong, was invisible. Dimensions have no oracle at all and place copper.
   */
  conflicts: z
    .array(
      z.object({
        field: z.string().min(1),
        deterministic: z.object({ display: z.string(), page: z.number().int().positive().nullable() }),
        model: z.object({ display: z.string(), page: z.number().int().positive().nullable() })
      })
    )
    .default([]),
  dimensions: packageDimensionsSchema,
  radiation: radiationDataSchema,
  sourceFileName: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  /**
   * Document-level provenance only (resolution source, page count, parser
   * warnings). Per-value doubt lives on the value itself, never here.
   */
  notes: z.array(z.string())
});

export type ExportFormat = (typeof exportFormats)[number];
export type PinElectricalType = z.infer<typeof pinSchema>["electricalType"];
export type PinRecord = z.infer<typeof pinSchema>;
export type ExtractionMethod = (typeof extractionMethods)[number];
export type TextRegion = z.infer<typeof textRegionSchema>;
export type Citation = z.infer<typeof citationSchema>;

export interface Extracted<T> {
  value: T | null;
  confidence: number | null;
  method: ExtractionMethod | null;
  citation: Citation | null;
}

export type LeadWidth = { minMm: number; maxMm: number };

export type PackageDimensions = {
  bodyLengthMm: Extracted<number>;
  bodyWidthMm: Extracted<number>;
  bodyHeightMm: Extracted<number>;
  pitchMm: Extracted<number>;
  leadLengthMm: Extracted<number>;
  leadCount: Extracted<number>;
  leadWidthMm: Extracted<LeadWidth>;
  leadSpanMm: Extracted<LeadWidth>;
  leadContactMm: Extracted<LeadWidth>;
  thermalPadLengthMm: Extracted<number>;
  thermalPadWidthMm: Extracted<number>;
};

export type RadiationData = {
  tid: Extracted<string>;
  see: Extracted<string>;
  sel: Extracted<string>;
  qmlClass: Extracted<string>;
};

export type PackageVariantRecord = z.infer<typeof packageVariantSchema>;

/** One field, read two ways. Both sides carry the page so a reviewer can check both. */
export interface FieldConflict {
  field: string;
  deterministic: { display: string; page: number | null };
  model: { display: string; page: number | null };
}

export type PartRecord = {
  id: string;
  partNumber: Extracted<string>;
  manufacturer: Extracted<string>;
  packageType: Extracted<string>;
  packageOutlineCode: Extracted<string>;
  packageVariants: PackageVariantRecord[];
  vendorLandPattern: { page: number; valuesMm: number[] } | null;
  pinCount: Extracted<number>;
  pins: Extracted<PinRecord[]>;
  /** True when a reader saw a non-numbered terminal. Blocks the footprint, not the pinout. */
  exposedPad: boolean;
  /** Fields the code and the model read differently. Settled by a person, not by precedence. */
  conflicts: FieldConflict[];
  dimensions: PackageDimensions;
  radiation: RadiationData;
  sourceFileName: string;
  sourceUrl?: string;
  notes: string[];
};

/** An unknown value, stated as unknown. */
export function unknown<T>(): Extracted<T> {
  return { value: null, confidence: null, method: null, citation: null };
}

export function extractedValue<T>(
  value: T,
  confidence: number,
  citation: Citation | null,
  method: ExtractionMethod = "deterministic"
): Extracted<T> {
  return { value, confidence, method, citation };
}

// ---------------------------------------------------------------------------
// Export boundary
// ---------------------------------------------------------------------------

/**
 * The flattened view the generation layer consumes. Producing one requires
 * every value CAD geometry depends on to actually be known, so a record with
 * unknown pin data can never reach a footprint or a STEP solid.
 */
export interface ResolvedPart {
  id: string;
  partNumber: string;
  manufacturer: string;
  packageType: string;
  /** Null when the datasheet prints no drawing we could confirm as this part's. */
  packageOutlineCode: string | null;
  /** The land pattern the datasheet prints for this package, in mm. */
  vendorLandPattern: { page: number; valuesMm: number[] } | null;
  pinCount: number;
  pins: PinRecord[];
  /** True when the part has an exposed thermal pad; `buildFootprintGeometry` refuses. */
  exposedPad: boolean;
  dimensions: {
    bodyLengthMm: number | null;
    bodyWidthMm: number | null;
    bodyHeightMm: number | null;
    pitchMm: number | null;
    leadLengthMm: number | null;
    leadCount: number | null;
    leadWidthMm: LeadWidth | null;
    leadSpanMm: LeadWidth | null;
    leadContactMm: LeadWidth | null;
    thermalPadLengthMm: number | null;
    thermalPadWidthMm: number | null;
  };
  radiation: {
    tid: string | null;
    see: string | null;
    sel: string | null;
    qmlClass: string | null;
  };
  sourceFileName: string;
  sourceUrl?: string;
  notes: string[];
}

export type ResolveResult =
  | { ok: true; part: ResolvedPart }
  | { ok: false; missing: string[]; untraceable?: string[]; unsettled?: string[] };

/**
 * Fields whose values become physical geometry rather than metadata.
 *
 * Includes every dimension, not just the pin data: `pitchMm` sets pad spacing,
 * the body dimensions shape the STEP solid and the courtyard, and
 * `leadLengthMm` sets pad size. Pad pitch in particular is the number that
 * decides whether the part fits the board, so trusting an uncited one would be
 * a stranger choice than trusting an uncited pin count.
 *
 * A null dimension is fine and NOT gated: the exporters fall back to documented
 * approximations for those. What is gated is a value that claims to be real,
 * came from a model, and cannot be found in the datasheet.
 */
const GEOMETRY_FIELDS = ["pinCount", "pins"] as const;
const GEOMETRY_DIMENSIONS = [
  "bodyLengthMm",
  "bodyWidthMm",
  "bodyHeightMm",
  "pitchMm",
  "leadLengthMm",
  "leadCount",
  "leadWidthMm",
  // Gated like every other dimension, and these matter more than most: they are
  // the numbers a drawing-derived land pattern is built from, so an uncited one
  // would put pads on the board from a value nobody can check.
  "leadSpanMm",
  "leadContactMm"
] as const;

export interface ResolveOptions {
  /**
   * Refuse to generate geometry from model values that carry no verified
   * citation. Defaults to true: a datasheet is attacker-supplied on the upload
   * path, so an uncited model value is the one route by which prompt injection
   * could reach a manufactured part. Set false only for a deliberately
   * lower-assurance workflow.
   */
  requireTraceableGeometry?: boolean;
}

/**
 * Projects a PartRecord down for generation, refusing when a value the output
 * geometry depends on is unknown or untraceable. Generating a 128-pad footprint
 * from a pin count nobody actually read off the datasheet is the failure this
 * prevents.
 */
export function resolveForExport(part: PartRecord, options: ResolveOptions = {}): ResolveResult {
  const requireTraceable = options.requireTraceableGeometry ?? true;
  const missing: string[] = [];

  const partNumber = part.partNumber.value;
  if (!partNumber) missing.push("partNumber");

  const pins = part.pins.value ?? [];
  // Do NOT fall back to pins.length here. An explicit null pin count means the
  // parser found conflicting evidence and deliberately declined to choose;
  // substituting the pin table's length would silently reinstate the very
  // answer that was rejected, and export a footprint built on it.
  const pinCount = part.pinCount.value;
  if (pinCount === null) missing.push("pinCount");
  if (pins.length === 0) missing.push("pins");

  if (missing.length > 0) return { ok: false, missing };

  if (requireTraceable) {
    const untraceable = [
      ...GEOMETRY_FIELDS.filter((field) => isUntraceable(part[field])),
      ...GEOMETRY_DIMENSIONS.filter((field) => isUntraceable(part.dimensions[field])).map(
        (field) => `dimensions.${field}`
      )
    ];
    if (untraceable.length > 0) return { ok: false, missing: [], untraceable };
  }

  // An UNSETTLED disagreement blocks the bundle.
  //
  // Two readers looked at the document and returned different numbers for
  // something that places copper. The record holds one of them, and which one is
  // decided by a precedence rule rather than by evidence. Shipping on that is
  // shipping a coin toss with a citation attached.
  //
  // This is also the control that makes model-first safe under prompt injection.
  // A crafted document can, in principle, get a value onto the record; it cannot
  // get one into a generated part without a person seeing both readings and both
  // pages and choosing. Confirming or correcting the field in the review panel
  // clears the conflict, which is what `user` and `user-confirmed` mean.
  const unsettled = (part.conflicts ?? []).filter((conflict) => {
    const field = conflict.field;
    const settled = ["user", "user-confirmed"];
    const at = field.startsWith("dimensions.")
      ? part.dimensions[field.slice("dimensions.".length) as keyof PackageDimensions]
      : (part as unknown as Record<string, Extracted<unknown>>)[field];
    return !(at && at.method && settled.includes(at.method));
  });
  if (unsettled.length > 0) {
    return { ok: false, missing: [], untraceable: [], unsettled: unsettled.map((c) => c.field) };
  }

  return {
    ok: true,
    part: {
      id: part.id,
      partNumber: partNumber as string,
      manufacturer: part.manufacturer.value ?? "Unknown",
      packageType: part.packageType.value ?? "Unknown package",
      packageOutlineCode: part.packageOutlineCode.value,
      vendorLandPattern: part.vendorLandPattern,
      pinCount: pinCount as number,
      pins,
      exposedPad: part.exposedPad,
      dimensions: {
        bodyLengthMm: part.dimensions.bodyLengthMm.value,
        bodyWidthMm: part.dimensions.bodyWidthMm.value,
        bodyHeightMm: part.dimensions.bodyHeightMm.value,
        pitchMm: part.dimensions.pitchMm.value,
        leadLengthMm: part.dimensions.leadLengthMm.value,
        leadCount: part.dimensions.leadCount.value,
        leadWidthMm: part.dimensions.leadWidthMm.value,
        leadSpanMm: part.dimensions.leadSpanMm.value,
        leadContactMm: part.dimensions.leadContactMm.value,
        thermalPadLengthMm: part.dimensions.thermalPadLengthMm.value,
        thermalPadWidthMm: part.dimensions.thermalPadWidthMm.value
      },
      radiation: {
        tid: part.radiation.tid.value,
        see: part.radiation.see.value,
        sel: part.radiation.sel.value,
        qmlClass: part.radiation.qmlClass.value
      },
      sourceFileName: part.sourceFileName,
      sourceUrl: part.sourceUrl,
      notes: part.notes
    }
  };
}
