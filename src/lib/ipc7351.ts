/**
 * IPC-7351B land pattern calculation.
 *
 * Why this exists: the exporters used to size pads with invented arithmetic
 * (`padWidth = pitch * 0.55`) and, when the pitch was not extracted, silently
 * defaulted it to 1.27 mm. Pad pitch is the number that decides whether a part
 * physically fits the board, so a guessed one is the single most dangerous value
 * this product can emit. Everything here is the published standard, and anything
 * the standard needs but we do not have is a refusal, never a default.
 *
 * The model is the standard's: compute the three land extents from the lead's
 * min/max dimensions, a fillet goal chosen by density level, and an RSS
 * combination of the tolerances.
 *
 *   Zmax = Lmin + 2*Jt + sqrt(CL^2 + F^2 + P^2)     outer toe-to-toe extent
 *   Gmin = Smax - 2*Jh - sqrt(CS^2 + F^2 + P^2)     inner heel-to-heel gap
 *   Xmax = Wmin + 2*Js + sqrt(CW^2 + F^2 + P^2)     land width across the lead
 *
 * where L is the overall lead span, T the seated contact length, S = L - 2T the
 * inner span, W the lead width, and C* the tolerance range of each.
 */

/**
 * IPC-7351B density level. B is the standard's own default and the right choice
 * for essentially all board work; A buys solder-joint robustness with area and
 * is what you want for high-reliability or high-vibration builds, which for this
 * product's customers is a real consideration rather than a footnote.
 */
export type DensityLevel = "A" | "B" | "C";

/** Lead form. Only forms whose fillet goals are entered below can be computed. */
export type LeadForm = "gullwing";

/**
 * Fillet goals in mm, from IPC-7351B for gull-wing leads.
 *
 * Toe (Jt) is the fillet beyond the lead tip, heel (Jh) the fillet behind it,
 * side (Js) the fillet either side of the lead. Only gull-wing is entered here
 * on purpose: no-lead (QFN/DFN/SON), J-lead, BGA and through-hole each have
 * their own goal table, and inventing their numbers to widen coverage is exactly
 * the failure this module exists to prevent. Adding a form means entering its
 * published goals and pinning the result to a known land pattern in a test.
 */
const FILLET_GOALS: Record<LeadForm, Record<DensityLevel, { toe: number; heel: number; side: number }>> = {
  gullwing: {
    A: { toe: 0.55, heel: 0.45, side: 0.05 },
    B: { toe: 0.35, heel: 0.35, side: 0.03 },
    C: { toe: 0.15, heel: 0.25, side: 0.01 }
  }
};

/**
 * Courtyard excess in mm beyond the land extents, per IPC-7351B density level.
 */
const COURTYARD_EXCESS: Record<DensityLevel, number> = { A: 0.5, B: 0.25, C: 0.12 };

/**
 * Board fabrication and placement allowances in mm.
 *
 * These are process inputs, not part data: they describe the fab and the pick
 * and place, so they belong to the customer's line rather than the datasheet.
 * The defaults are the ones IPC-7351B's own calculator ships with. They are
 * stated here rather than buried so a customer with a tighter or looser process
 * can see exactly what to change.
 */
export const DEFAULT_FABRICATION_TOLERANCE_MM = 0.05;
export const DEFAULT_PLACEMENT_TOLERANCE_MM = 0.025;

/** A min/max pair from a package drawing. Both bounds are required. */
export interface Range {
  minMm: number;
  maxMm: number;
}

/**
 * The lead dimensions IPC-7351B needs.
 *
 * `span` is toe to toe across the package (drawing dimension E or D) and
 * `width` is the lead width (b). Both are read straight off a package drawing.
 *
 * `contact` is NOT. It is named for the seated foot length the standard's model
 * calls T, but the value stored is a per-family constant fitted so that the
 * computed land reproduces the land pattern published for that family. It has to
 * work that way today: a JEDEC drawing quotes the whole formed lead (MS-012 and
 * MS-013 both say 0.40 to 1.27), and feeding that range in puts the heel over a
 * millimetre too far inboard. Narrow SOIC then fits at 0.40-0.625 while wide SOIC
 * needs 0.40-1.00, which is the tell: the difference between them is absorbing
 * something the model is not representing, not measuring two different feet.
 *
 * This is honest only because every family is pinned by test to a published land
 * pattern, so a wrong constant fails loudly. It is still a fudge, and it means
 * each new family costs a calibration rather than falling out of the standard.
 * Resolving it against the IPC-7351B text is open work; see DEFERRED.md.
 */
export interface LeadDimensions {
  form: LeadForm;
  span: Range;
  /** Fitted to the family's published land pattern, not read off a drawing. */
  contact: Range;
  width: Range;
}

export interface LandPattern {
  /** Land width across the lead, mm. */
  padWidthMm: number;
  /** Land length along the lead, mm. */
  padLengthMm: number;
  /** Distance from package centre line to land centre, mm. */
  padCentreMm: number;
  /** Outer toe-to-toe extent of the lands, mm. */
  zMaxMm: number;
  /** Inner heel-to-heel gap between opposing lands, mm. */
  gMinMm: number;
  /** Half-extent of the courtyard from the centre line, mm. */
  courtyardHalfMm: number;
  densityLevel: DensityLevel;
}

export interface LandPatternOptions {
  densityLevel?: DensityLevel;
  fabricationToleranceMm?: number;
  placementToleranceMm?: number;
}

/** Root-sum-square of the tolerance contributions, as the standard specifies. */
function rss(range: number, fabrication: number, placement: number): number {
  return Math.sqrt(range * range + fabrication * fabrication + placement * placement);
}

function isUsableRange(range: Range): boolean {
  return (
    Number.isFinite(range.minMm) &&
    Number.isFinite(range.maxMm) &&
    range.minMm > 0 &&
    range.maxMm >= range.minMm
  );
}

export class LandPatternError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `Cannot compute an IPC-7351B land pattern: ${missing.join(", ")}. No pad geometry is emitted rather than defaulting these.`
    );
    this.name = "LandPatternError";
  }
}

/**
 * Computes the land pattern for one opposing pair of lead rows.
 *
 * Throws rather than returning an approximation when an input is missing. A
 * caller that cannot supply real lead dimensions must decline to emit a
 * footprint, which is the whole point: a footprint is a manufacturing
 * instruction, and there is no honest default for one.
 */
export function computeLandPattern(lead: LeadDimensions, options: LandPatternOptions = {}): LandPattern {
  const missing: string[] = [];
  if (!isUsableRange(lead.span)) missing.push("lead span (drawing dimension E or D)");
  if (!isUsableRange(lead.contact)) missing.push("lead contact length (drawing dimension L)");
  if (!isUsableRange(lead.width)) missing.push("lead width (drawing dimension b)");
  if (missing.length > 0) throw new LandPatternError(missing);

  const densityLevel = options.densityLevel ?? "B";
  const fabrication = options.fabricationToleranceMm ?? DEFAULT_FABRICATION_TOLERANCE_MM;
  const placement = options.placementToleranceMm ?? DEFAULT_PLACEMENT_TOLERANCE_MM;
  const goal = FILLET_GOALS[lead.form][densityLevel];

  // The inner span pairs each extreme of the overall span with the OPPOSITE
  // extreme of the contact length, because the widest inner gap comes from the
  // longest span with the shortest feet.
  const innerMin = lead.span.minMm - 2 * lead.contact.maxMm;
  const innerMax = lead.span.maxMm - 2 * lead.contact.minMm;

  const zMax = lead.span.minMm + 2 * goal.toe + rss(lead.span.maxMm - lead.span.minMm, fabrication, placement);
  const gMin = innerMax - 2 * goal.heel - rss(innerMax - innerMin, fabrication, placement);
  const xMax = lead.width.minMm + 2 * goal.side + rss(lead.width.maxMm - lead.width.minMm, fabrication, placement);

  // Feet that reach more than halfway across the package meet in the middle,
  // which no gull-wing lead does. That is a data error in the package entry, and
  // computing from it yields opposing lands that cross the centre line.
  if (innerMin <= 0) {
    throw new LandPatternError([
      `the lead contact length (up to ${lead.contact.maxMm} mm) is too long for the span (from ${lead.span.minMm} mm), which leaves no body between opposing feet`
    ]);
  }
  if (gMin <= 0 || zMax <= gMin) {
    throw new LandPatternError([
      `the computed lands cross the centre line (Zmax ${zMax.toFixed(3)} mm, Gmin ${gMin.toFixed(3)} mm), so the lead dimensions are inconsistent`
    ]);
  }

  return {
    padWidthMm: xMax,
    padLengthMm: (zMax - gMin) / 2,
    padCentreMm: (zMax + gMin) / 4,
    zMaxMm: zMax,
    gMinMm: gMin,
    courtyardHalfMm: zMax / 2 + COURTYARD_EXCESS[densityLevel],
    densityLevel
  };
}
