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
export const extractionMethods = ["deterministic", "vlm", "user"] as const;

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
  pinCount: extracted(z.number().int().positive()),
  pins: extracted(z.array(pinSchema)),
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
};

export type RadiationData = {
  tid: Extracted<string>;
  see: Extracted<string>;
  sel: Extracted<string>;
  qmlClass: Extracted<string>;
};

export type PackageVariantRecord = z.infer<typeof packageVariantSchema>;

export type PartRecord = {
  id: string;
  partNumber: Extracted<string>;
  manufacturer: Extracted<string>;
  packageType: Extracted<string>;
  packageOutlineCode: Extracted<string>;
  packageVariants: PackageVariantRecord[];
  pinCount: Extracted<number>;
  pins: Extracted<PinRecord[]>;
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
  pinCount: number;
  pins: PinRecord[];
  dimensions: {
    bodyLengthMm: number | null;
    bodyWidthMm: number | null;
    bodyHeightMm: number | null;
    pitchMm: number | null;
    leadLengthMm: number | null;
    leadCount: number | null;
    leadWidthMm: LeadWidth | null;
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
  | { ok: false; missing: string[]; untraceable?: string[] };

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
  "leadWidthMm"
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

  return {
    ok: true,
    part: {
      id: part.id,
      partNumber: partNumber as string,
      manufacturer: part.manufacturer.value ?? "Unknown",
      packageType: part.packageType.value ?? "Unknown package",
      packageOutlineCode: part.packageOutlineCode.value,
      pinCount: pinCount as number,
      pins,
      dimensions: {
        bodyLengthMm: part.dimensions.bodyLengthMm.value,
        bodyWidthMm: part.dimensions.bodyWidthMm.value,
        bodyHeightMm: part.dimensions.bodyHeightMm.value,
        pitchMm: part.dimensions.pitchMm.value,
        leadLengthMm: part.dimensions.leadLengthMm.value,
        leadCount: part.dimensions.leadCount.value,
        leadWidthMm: part.dimensions.leadWidthMm.value
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
