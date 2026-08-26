/**
 * The choices that belong to the USER's process rather than to any datasheet.
 *
 * ## Why there is a screen and not a set of prompts
 *
 * RULES.md 3: a value the document does not state, that legitimately differs
 * between one user's line and another's, is a setting. Two things follow, and
 * the second is the one that was missing.
 *
 * First, these cannot be read. No vendor knows your reflow profile, your stencil
 * or your forming die, so no amount of reading a datasheet better will produce
 * them.
 *
 * Second, they are properties of the INSTALLATION, so asking them per part is a
 * defect in its own right. Measured on the tuned corpus 2026-08-19: seven parts
 * were blocked on `formedLeadSpanMm` and `formedLeadContactMm` alone, which are
 * both made by the same forming die and are the same two numbers for every part
 * that customer will ever build. Asked once, seven parts ship. Asked per part,
 * the product looks like it cannot read seven datasheets it read perfectly.
 *
 * ## Blank means the published standard, and the screen says which
 *
 * Where a published standard answers a field, leaving it blank is a real answer
 * and the screen names the standard so nobody is accepting something unnamed.
 * Where no standard answers it, the field is required before the first run,
 * because a default there would be invented (RULES.md 1) and a silent choice
 * would be assumed (RULES.md 2).
 */

import type { DensityLevel } from "./ipc7351";

/** How the footprint's copper is chosen when the datasheet prints its own. */
export type FootprintSource =
  /**
   * The manufacturer's own recommended footprint wins where the datasheet
   * prints one, and IPC-7351B computes the rest. The default, and what most
   * engineers expect: the vendor tested that pattern.
   *
   * Measured over the hold-out 2026-08-19: 18 of the 27 shipping parts take
   * this route and 9 fall through to the computed one.
   */
  | "datasheet-first"
  /**
   * Always compute from IPC-7351B at the chosen density, even where the
   * datasheet prints a pattern.
   *
   * A real house rule rather than a convenience: a shop that standardises wants
   * every joint on the board to behave the same, and vendor patterns vary in
   * age and in how tight they are. Two vendors' printed no-lead patterns
   * measured on 2026-08-19 disagree with each other by more than either
   * disagrees with the standard.
   */
  | "standard-always";

export interface ForgeSettings {
  /**
   * IPC-7351B density level: A most copper, B nominal, C least.
   *
   * PUBLISHED STANDARD: IPC-7351B names B as the nominal. Blank means B.
   */
  densityLevel?: DensityLevel;
  /** PUBLISHED PRACTICE: the vendor's own pattern where there is one. Blank means `datasheet-first`. */
  footprintSource?: FootprintSource;
  /**
   * Seated toe-to-toe span, in mm, for packages whose leads the assembler trims
   * and forms. Ceramic flat packs, which is most of this product's market.
   *
   * NO PUBLISHED STANDARD. The manufacturer ships the leads straight and never
   * bends them, so no datasheet can carry this and no standard specifies one
   * shop's forming die. REQUIRED before the first run.
   */
  formedLeadSpanMm?: number;
  /**
   * Seated foot length, in mm, from the same forming operation.
   *
   * NO PUBLISHED STANDARD, for the same reason. REQUIRED before the first run.
   */
  formedLeadContactMm?: number;
}

/** A field the user must answer, because nothing else can. */
export interface SettingsField {
  key: keyof ForgeSettings;
  label: string;
  /** The standard that answers it, or null where none does. */
  standard: string | null;
  unit: "mm" | null;
  why: string;
  /**
   * The largest value `/api/export` will accept for this field, where it is a
   * number.
   *
   * Carried on the field rather than kept private so the SCREEN can state it.
   * `parseSettings` drops anything above it, which is correct, but a screen that
   * does not know the bound cannot say why the value it just took disappeared:
   * the box still showed 8, the gate still said one field was needed, and
   * nothing connected the two. The user is then stuck on a required field they
   * have already answered.
   */
  max?: number;
}

/** Largest values the export route accepts, mirrored so the screen refuses first. */
const MAX_SPAN_MM = 200;
const MAX_CONTACT_MM = 5;

/**
 * The screen, in order. Written as data so the UI, the first-run gate and the
 * tests cannot drift about which fields are required.
 */
export const SETTINGS_FIELDS: readonly SettingsField[] = [
  {
    key: "densityLevel",
    label: "Land pattern density",
    standard: "IPC-7351B, nominal density level B",
    unit: null,
    why: "How much copper each land carries. A for hand rework, C for tight assemblies."
  },
  {
    key: "footprintSource",
    label: "Where the footprint comes from",
    standard: "the manufacturer's own recommended pattern where the datasheet prints one",
    unit: null,
    why: "Most engineers take the vendor's pattern. Shops that standardise compute every part the same way instead."
  },
  {
    key: "formedLeadSpanMm",
    label: "Formed lead span, toe to toe",
    standard: null,
    unit: "mm",
    why: "Ceramic flat packs ship with straight leads and your line forms them, so only you know the seated span.",
    max: MAX_SPAN_MM
  },
  {
    key: "formedLeadContactMm",
    label: "Formed foot length",
    standard: null,
    unit: "mm",
    why: "The foot the land is sized around is made by your forming die, so no datasheet prints it.",
    max: MAX_CONTACT_MM
  }
];

/**
 * The fields the user typed a number into that `parseSettings` will throw away.
 *
 * Reported so the screen can say so. A value silently dropped for being out of
 * range is indistinguishable from one never entered, and the two need different
 * things from the user: one is "answer this", the other is "that answer is
 * outside what the export accepts, here is the limit".
 *
 * Only fields that were actually SUPPLIED are listed. A blank field is not a
 * rejection, it is the standard's answer or an unanswered requirement, and both
 * are already reported elsewhere.
 */
export function outOfRange(input: Record<string, unknown>): SettingsField[] {
  return SETTINGS_FIELDS.filter((field) => {
    if (field.max === undefined) return false;
    const raw = input[field.key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) return false;
    return raw <= 0 || raw > field.max;
  });
}

/**
 * What is still unanswered and has no standard to fall back on.
 *
 * The first run is gated on this being empty. A field WITH a standard is never
 * listed, however blank it is, because blank there is a decision rather than a
 * gap.
 */
export function missingRequired(settings: ForgeSettings): SettingsField[] {
  return SETTINGS_FIELDS.filter((field) => {
    if (field.standard !== null) return false;
    const value = settings[field.key];
    return typeof value !== "number" || !Number.isFinite(value) || value <= 0;
  });
}

/** Whether the first datasheet may be parsed yet. */
export function settingsComplete(settings: ForgeSettings): boolean {
  return missingRequired(settings).length === 0;
}

/**
 * A settings object from untrusted input, with anything unrecognised dropped.
 *
 * Bounded exactly as `/api/export` bounds the same two numbers. A settings store
 * that accepts what the export route rejects would let a user answer the
 * question and then be refused for the answer, which is the shape of defect
 * `withSupplied` was written up for.
 */
export function parseSettings(input: unknown): ForgeSettings {
  const raw = (input ?? {}) as Record<string, unknown>;
  const out: ForgeSettings = {};
  if (raw.densityLevel === "A" || raw.densityLevel === "B" || raw.densityLevel === "C") {
    out.densityLevel = raw.densityLevel;
  }
  if (raw.footprintSource === "datasheet-first" || raw.footprintSource === "standard-always") {
    out.footprintSource = raw.footprintSource;
  }
  const number = (value: unknown, max: number): number | undefined =>
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max ? value : undefined;
  const span = number(raw.formedLeadSpanMm, MAX_SPAN_MM);
  if (span !== undefined) out.formedLeadSpanMm = span;
  const contact = number(raw.formedLeadContactMm, MAX_CONTACT_MM);
  if (contact !== undefined) out.formedLeadContactMm = contact;
  return out;
}

/** The effective density, resolving blank to the standard's own nominal. */
export function densityOf(settings: ForgeSettings): DensityLevel {
  return settings.densityLevel ?? "B";
}

/** The effective footprint source, resolving blank to published practice. */
export function footprintSourceOf(settings: ForgeSettings): FootprintSource {
  return settings.footprintSource ?? "datasheet-first";
}
