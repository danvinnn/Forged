import { z } from "zod";

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

export const pinSchema = z.object({
  number: z.string().min(1),
  name: z.string().min(1),
  electricalType: z.enum(pinElectricalTypes),
  description: z.string().optional()
});

export const packageDimensionsSchema = z.object({
  bodyLengthMm: z.number().nullable(),
  bodyWidthMm: z.number().nullable(),
  bodyHeightMm: z.number().nullable(),
  pitchMm: z.number().nullable(),
  leadLengthMm: z.number().nullable(),
  leadCount: z.number().nullable()
});

export const radiationDataSchema = z.object({
  tid: z.string().nullable(),
  see: z.string().nullable(),
  sel: z.string().nullable(),
  qmlClass: z.string().nullable()
});

export const partSchema = z.object({
  id: z.string().min(1),
  partNumber: z.string().min(1),
  manufacturer: z.string().min(1),
  packageType: z.string().min(1),
  pinCount: z.number().int().positive(),
  pins: z.array(pinSchema),
  dimensions: packageDimensionsSchema,
  radiation: radiationDataSchema,
  sourceFileName: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  notes: z.array(z.string())
});

export type ExportFormat = (typeof exportFormats)[number];
export type PinElectricalType = z.infer<typeof pinSchema>["electricalType"];
export type PinRecord = z.infer<typeof pinSchema>;
export type PackageDimensions = z.infer<typeof packageDimensionsSchema>;
export type RadiationData = z.infer<typeof radiationDataSchema>;
export type PartRecord = z.infer<typeof partSchema>;