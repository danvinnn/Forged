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
  }),
  /**
   * The land pattern the datasheet PRINTS, off its own recommended footprint
   * drawing. Where these are present they ARE the pads: no IPC-7351B, no
   * hand-typed family table, no other vendor's house rule.
   *
   * Defaulted like the rest, so a record written before this existed still
   * validates as what it is: a record with no printed pattern read.
   */
  landPadLengthMm: extracted(z.number().positive()).default({
    value: null,
    confidence: null,
    method: null,
    citation: null
  }),
  landPadWidthMm: extracted(z.number().positive()).default({
    value: null,
    confidence: null,
    method: null,
    citation: null
  }),
  /** Centre to centre between opposing rows of lands. */
  landSpanMm: extracted(z.number().positive()).default({
    value: null,
    confidence: null,
    method: null,
    citation: null
  }),
  /**
   * How the leads leave the package: formed out and down, a pad underneath, or
   * straight and untrimmed.
   *
   * Decides which land-pattern model applies, and IPC-7351B only publishes
   * fillet goals for gull-wing in this codebase. Read off the drawing rather
   * than guessed from the package name, because the name is a designator and
   * the drawing is the thing that shows the lead.
   *
   * `straight` was added 2026-08-14, when the hand-typed family table was
   * deleted. That table was the only thing that knew a ceramic flat pack ships
   * untrimmed, and it knew it by NAME. TI's HKU0010A drawing shows the leads
   * plainly: 22.7 mm tip to tip on a 7 mm body, straight, for the assembler to
   * trim and form. That is a fact about the drawing, so it is read off the
   * drawing, and the seated span is then asked for once per assembler. Nearly
   * every rad-hard part in this product's market is one of these.
   */
  /**
   * How the part attaches to the board: lands on the surface, or leads through
   * plated holes.
   *
   * Read off the package drawing, which shows it plainly: a through-hole lead is
   * a straight pin below the seating plane, and the drawing dimensions the row
   * spacing rather than a lead span. Nothing else on the record implies it, and
   * guessing from the package NAME is the mistake the deleted family table made.
   *
   * Defaulted to unread rather than to `smd`. A part whose mounting nobody read
   * is not a surface-mount part by default; it is a part we have not finished
   * reading, and the generator asks.
   */
  mounting: extracted(z.enum(["smd", "through-hole"])).default({
    value: null,
    confidence: null,
    method: null,
    citation: null
  }),
  /**
   * Lead diameter or thickness for a through-hole part, in millimetres.
   *
   * IPC-7251 sizes the hole from this and nothing else. Distinct from
   * `leadWidthMm`, which is the width of a formed surface-mount lead as seen
   * from above.
   */
  leadDiameterMm: extracted(z.number().positive()).default({
    value: null,
    confidence: null,
    method: null,
    citation: null
  }),
  leadForm: extracted(z.enum(["gullwing", "nolead", "straight"])).default({
    value: null,
    confidence: null,
    method: null,
    citation: null
  }),
  /**
   * On a two-row package whose rows are unequal, the grid position on the
   * SHORTER row that carries no lead, counted from the pin 1 end, 1-based.
   *
   * An odd lead count means one row is one lead short, and where that gap sits
   * is drawn on the pinout. Until this was read the generator refused every odd
   * package outright, which is 2 of 37 corpus parts but a much larger share of
   * real designs: 5- and 6-pin SOT-23 is where a great many op-amps, references
   * and regulators live.
   *
   * Refusing was the right call while the position was unknown. Putting a lead
   * in the wrong slot is a miswired board that looks correct in CAD.
   */
  vacantLeadSlot: extracted(z.number().int().positive()).default({
    value: null,
    confidence: null,
    method: null,
    citation: null
  }),
  /**
   * How the leads divide between the sides, counted off the pinout, e.g. `6,6,6,5`.
   *
   * Only meaningful where the sides are UNEQUAL, which on a four-sided package
   * means a pin count that does not divide by four. Which side carries the short
   * row is drawn on the page; it is not implied by the count.
   *
   * Added 2026-08-14 because the exporter had started asking the USER for this
   * without ever asking the model. Every other thing the exporter asks for is
   * read first and asked about only on failure, and that one had skipped the
   * reading step entirely.
   */
  leadsPerSide: extracted(z.string().regex(/^\d+(,\d+)*$/)).default({
    value: null,
    confidence: null,
    method: null,
    citation: null
  }),
  /**
   * Solder mask clearance around each land, in millimetres.
   *
   * Printed on 20 of 46 corpus land-pattern drawings, right beside the pad
   * dimensions we already read, e.g. "0.05 MIN ALL AROUND". Both KiCad and
   * Altium carry a per-pad mask expansion, and we were emitting footprints with
   * none, so the board house applied its own default to copper the datasheet
   * had already specified.
   */
  solderMaskExpansionMm: extracted(z.number().nonnegative()).default({
    value: null,
    confidence: null,
    method: null,
    citation: null
  }),
  /**
   * Whether the pad's size is set by the copper or by the mask opening.
   *
   * Stated in words on the same drawing, usually as a labelled pair with one
   * marked preferred. It changes what the fabricator builds, so guessing it is
   * not available; unread means unread.
   */
  solderMaskDefined: extracted(z.enum(["solder-mask-defined", "non-solder-mask-defined"])).default({
    value: null,
    confidence: null,
    method: null,
    citation: null
  }),
  /**
   * Thermal via drill diameter and grid pitch under an exposed pad.
   *
   * Printed on 30 of 46. A part with an exposed pad is soldered through these,
   * and a footprint that lays the pad without them is missing the feature that
   * carries the heat out.
   */
  thermalViaDiameterMm: extracted(z.number().positive()).default({
    value: null,
    confidence: null,
    method: null,
    citation: null
  }),
  thermalViaPitchMm: extracted(z.number().positive()).default({
    value: null,
    confidence: null,
    method: null,
    citation: null
  }),
  /**
   * How many SIDES of the package carry leads, counted off the drawing.
   *
   * 2 for a dual package, 4 for a quad. Read rather than looked up, because the
   * only other source for it was a hand-typed family table, and a table that
   * has never heard of SOT-23 refused a datasheet that prints its own footprint
   * in full. The package's own drawing shows how many sides have leads; nothing
   * about that needs a standard or a vendor convention.
   *
   * 1, 2 or 4, because those are the arrangements the pad placement can build.
   * A part with leads on THREE sides is still refused rather than approximated.
   *
   * `1` was added on 2026-08-17. Before that a single line of pins could not be
   * REPRESENTED, so TO-220, TO-92 and SIP were permanently unbuildable however
   * well their datasheets were read: the schema rejected a 1, the prompt told
   * the model to answer null, and null was the exact state that once fell
   * through to two rows and shipped a 3-lead regulator as two columns 5 mm
   * apart. Widening the type is what makes the honest answer sayable.
   */
  leadSides: extracted(z.union([z.literal(1), z.literal(2), z.literal(4)])).default({
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
   * The JEDEC outline registration the drawing cites, e.g. `MO-153 AA`.
   *
   * Distinct from `packageOutlineCode`, which is the VENDOR's own code
   * (`PW0008A`, `DW0016B`) and means nothing outside that vendor. The JEDEC
   * registration is the industry-wide identity of the package, printed on 21 of
   * 46 corpus drawings as "Reference JEDEC registration MO-153, variation AA".
   *
   * Recorded because it is the canonical answer to "which package is this",
   * which a hand-typed family table was previously guessing at from the
   * designator text.
   */
  jedecOutline: extracted(z.string().min(1)).default({
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
   * One pin table per package, where the document describes more than one.
   *
   * On the SCHEMA and not only on the type, which is the half that was missing:
   * `/api/export` validates the posted record with this schema, zod strips keys
   * it does not know about, and the field would have been dropped on exactly the
   * route that relabels a part as a sibling package. Adding it to the TypeScript
   * type alone would have left `asPackage` unable to find the right table there
   * while finding it everywhere else.
   *
   * Optional rather than defaulted: absent means the document described one
   * pinout, which is a different statement from an empty list.
   */
  pinTablesByPackage: z
    .array(
      z
        .object({
        packageType: z.string().min(1).max(64),
        pins: z.array(pinSchema),
        /**
         * Whether THIS package has an exposed thermal pad.
         *
         * Per table rather than per record, because a pad belongs to one package
         * of a family and not to its siblings: the same part is routinely an
         * SOIC without one and a QFN with one. A single flag on the record has to
         * be wrong for one of them, and it was: `asPackage` set it to false on
         * every relabel, which emits a footprint missing a mandatory soldered
         * feature, and the comment there said so while doing it.
         *
         * Optional so a record written before this existed still validates.
         */
        exposedPad: z.boolean().optional(),
        // The page this table was FOUND on, filled by the merge rather than
        // claimed by the model. Nullable, and a null one is what keeps an
        // unlocatable table out of a footprint.
        citation: citationSchema.nullable().optional()
        })
        /**
         * THE SAME PROOF `pins` HAS TO PASS: rows number 1..N, no gaps, no
         * repeats.
         *
         * `mergeModelValues` enforces this when a model answer enters the
         * record, and that is one door of two. `/api/export` accepts a POSTED
         * record, and a table with a gap in it reaches `asPackage` there without
         * passing through merge at all. Both doors have to ask, or the guard is
         * a suggestion.
         *
         * A gap is not cosmetic. Measured 2026-08-16: rows numbered 1-7,9 build
         * EIGHT pads, one of them numbered 8 which the document never mentions,
         * against SEVEN symbol pins. `validateGeometry` cannot catch it, because
         * the pads run 1..pinCount exactly as it expects.
         */
        .refine(
          (table) => {
            const numbers = table.pins.map((pin) => Number(pin.number));
            if (numbers.some((value) => !Number.isInteger(value) || value < 1)) return false;
            return new Set(numbers).size === numbers.length && Math.max(...numbers) === numbers.length;
          },
          { message: "a per-package pin table must number 1..N with no gaps or repeats" }
        )
    )
    .max(16)
    .optional(),
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
  /**
   * The land pattern the datasheet PRINTS, read off its own recommended
   * footprint drawing. Where these are present they ARE the footprint: no
   * standard, no family table, no other vendor's house rule.
   */
  landPadLengthMm: Extracted<number>;
  landPadWidthMm: Extracted<number>;
  /** Centre to centre between opposing rows of lands. */
  landSpanMm: Extracted<number>;
  /** Sides of the package carrying leads: 2 for dual, 4 for quad. Read off the drawing. */
  leadSides: Extracted<1 | 2 | 4>;
  /** How the leads leave the package. Decides which land-pattern model applies. */
  leadForm: Extracted<"gullwing" | "nolead" | "straight">;
  /** Lands on the surface, or leads through plated holes. Read off the drawing. */
  mounting: Extracted<"smd" | "through-hole">;
  /** Lead diameter for a through-hole part, mm. IPC-7251 sizes the hole from it. */
  leadDiameterMm: Extracted<number>;
  /** Grid position on the shorter row that carries no lead, 1-based from pin 1. */
  vacantLeadSlot: Extracted<number>;
  /** Leads on each side in order from pin 1, e.g. `6,6,6,5`. Only where sides are unequal. */
  leadsPerSide: Extracted<string>;
  /** Solder mask clearance around each land, mm. Printed beside the land pattern. */
  solderMaskExpansionMm: Extracted<number>;
  /** Whether the pad is defined by copper or by the mask opening. */
  solderMaskDefined: Extracted<"solder-mask-defined" | "non-solder-mask-defined">;
  /** Thermal via drill diameter and grid pitch under an exposed pad, mm. */
  thermalViaDiameterMm: Extracted<number>;
  thermalViaPitchMm: Extracted<number>;
};

export type RadiationData = {
  tid: Extracted<string>;
  see: Extracted<string>;
  sel: Extracted<string>;
  qmlClass: Extracted<string>;
};

export type PackageVariantRecord = z.infer<typeof packageVariantSchema>;

/** One field, read two ways. Both sides carry the page so a reviewer can check both. */

export type PartRecord = {
  id: string;
  partNumber: Extracted<string>;
  manufacturer: Extracted<string>;
  packageType: Extracted<string>;
  packageOutlineCode: Extracted<string>;
  /**
   * A pin table per package, where the document describes more than one.
   *
   * Read in the SAME pass that reads everything else, so choosing a package
   * later costs nothing. Before this, a part whose number did not name its
   * package produced no pins at all, the record was therefore unreadable, and
   * the package chooser refused to offer the very choice that would have
   * unblocked it. The product deadlocked on its own question.
   */
  pinTablesByPackage?: Array<{ packageType: string; pins: PinRecord[]; exposedPad?: boolean; citation?: Citation | null }>;
  /** JEDEC outline registration, e.g. `MO-153 AA`. Vendor-independent package identity. */
  jedecOutline: Extracted<string>;
  packageVariants: PackageVariantRecord[];
  vendorLandPattern: { page: number; valuesMm: number[] } | null;
  pinCount: Extracted<number>;
  pins: Extracted<PinRecord[]>;
  /** True when a reader saw a non-numbered terminal. Blocks the footprint, not the pinout. */
  exposedPad: boolean;
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
  jedecOutline: string | null;
  /** The land pattern the datasheet prints for this package, in mm. */
  vendorLandPattern: { page: number; valuesMm: number[] } | null;
  pinCount: number;
  pins: PinRecord[];
  /**
   * One pin table per package, where the document describes more than one.
   *
   * Carried through to generation so that RELABELLING a part as a sibling
   * package can take that package's own pinout instead of the one above.
   * `asPackage` already blanks every dimension when it relabels, precisely
   * because they describe a different package; the pin table is the same kind
   * of value and was the one thing carried across unchanged.
   */
  pinTablesByPackage?: Array<{ packageType: string; pins: PinRecord[]; exposedPad?: boolean; citation?: Citation | null }>;
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
    landPadLengthMm: number | null;
    landPadWidthMm: number | null;
    landSpanMm: number | null;
    leadSides: 1 | 2 | 4 | null;
    leadForm: "gullwing" | "nolead" | "straight" | null;
    mounting: "smd" | "through-hole" | null;
    leadDiameterMm: number | null;
    vacantLeadSlot: number | null;
    leadsPerSide: string | null;
    solderMaskExpansionMm: number | null;
    solderMaskDefined: "solder-mask-defined" | "non-solder-mask-defined" | null;
    thermalViaDiameterMm: number | null;
    thermalViaPitchMm: number | null;
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

/**
 * EVERY DIMENSION, rather than a list of names.
 *
 * ## Why this stopped being a list
 *
 * It was one: nine field names, correct the day they were written. Then the land
 * pattern's SOURCE moved. Until 2026-08-12 the pads were computed from
 * `leadSpanMm` and `leadContactMm`, which is why those two are singled out in
 * the note this replaces as "the numbers a drawing-derived land pattern is built
 * from". Since then the pads are `landPadLengthMm`, `landPadWidthMm` and
 * `landSpanMm` read straight off the datasheet's own printed footprint, and none
 * of the three was ever added here.
 *
 * So for four months the gate named the fields that USED to place copper and not
 * the ones that did. Nothing noticed, because a hardcoded list cannot report
 * that it has fallen behind. Nor could `leadSides` (two rows or four),
 * `mounting` (holes or lands), `leadDiameterMm` (the drill), the thermal pad or
 * the vacant slot, every one of which changes the physical output.
 *
 * Enumerating the dimension object is the same rule with no list to maintain. A
 * field added to `packageDimensionsSchema` next month is gated the day it is
 * added, without anyone remembering, and the mistake runs in the safe direction:
 * a new field is protected by default, and exempting one takes a deliberate act.
 * That is the reasoning `asPackage` already uses for its whitelist of what
 * survives a relabel.
 *
 * ## What it costs
 *
 * Measured 2026-08-16 by running the real merge over the tuned corpus, PDFs off
 * disk with cached model answers and the same citation verification production
 * does, drawing citations included: of 25 parts, 16 resolve today and 16 resolve
 * after. **Nothing is newly blocked.** A value read off a page we sent earns a
 * citation, so the widening catches the case nobody has hit yet rather than
 * taking parts away.
 */
function untraceableDimensions(dimensions: PartRecord["dimensions"]): string[] {
  return Object.entries(dimensions)
    .filter(([, field]) => isUntraceable(field as Extracted<unknown>))
    .map(([name]) => `dimensions.${name}`);
}

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
      ...untraceableDimensions(part.dimensions)
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
      jedecOutline: part.jedecOutline.value,
      vendorLandPattern: part.vendorLandPattern,
      pinCount: pinCount as number,
      pins,
      pinTablesByPackage: part.pinTablesByPackage,
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
        thermalPadWidthMm: part.dimensions.thermalPadWidthMm.value,
        landPadLengthMm: part.dimensions.landPadLengthMm.value,
        landPadWidthMm: part.dimensions.landPadWidthMm.value,
        landSpanMm: part.dimensions.landSpanMm.value,
        leadSides: part.dimensions.leadSides.value,
        leadForm: part.dimensions.leadForm.value,
        mounting: part.dimensions.mounting.value,
        leadDiameterMm: part.dimensions.leadDiameterMm.value,
        vacantLeadSlot: part.dimensions.vacantLeadSlot.value,
        leadsPerSide: part.dimensions.leadsPerSide.value,
        solderMaskExpansionMm: part.dimensions.solderMaskExpansionMm.value,
        solderMaskDefined: part.dimensions.solderMaskDefined.value,
        thermalViaDiameterMm: part.dimensions.thermalViaDiameterMm.value,
        thermalViaPitchMm: part.dimensions.thermalViaPitchMm.value
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
