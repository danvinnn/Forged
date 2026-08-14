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
export type LeadForm = "gullwing" | "nolead";

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
// Keyed on `"gullwing"` alone, not on `LeadForm`. A no-lead package is laid out
// by a different rule entirely and has no entry here to be missing; typing this
// against every form would invite one to be invented to fill the gap.
const FILLET_GOALS: Record<"gullwing", Record<DensityLevel, { toe: number; heel: number; side: number }>> = {
  gullwing: {
    A: { toe: 0.55, heel: 0.45, side: 0.05 },
    B: { toe: 0.35, heel: 0.35, side: 0.03 },
    C: { toe: 0.15, heel: 0.25, side: 0.01 }
  }
};

/**
 * The no-lead land rule, recovered from four TI package drawings on 2026-08-10.
 *
 * ## This is NOT IPC-7351B, and the difference is the point
 *
 * Everything else in this module is the standard's RSS model. This is not, and
 * saying so is the whole reason it lives in its own constant instead of being
 * added to `FILLET_GOALS` where it would inherit that claim.
 *
 * The intent was to enter IPC-7351B's published no-lead goals. Working backwards
 * from vendor-published land patterns to check them showed the standard's model
 * does not describe what these drawings do. Read by hand off the drawings and the
 * matching `LAND PATTERN EXAMPLE` pages:
 *
 *   DSD0008D  WSON 8   body 2.9-3.1  b 0.25-0.37  L 0.3-0.5  e 0.65
 *   DRB0008B  VSON 8   body 2.9-3.1  b 0.25-0.35  L 0.3-0.5  e 0.65
 *   RGT0016C  VQFN 16  body 2.9-3.1  b 0.18-0.30  L 0.3-0.5  e 0.5
 *   RGC0064B  VQFN 64  body 8.85-9.15 b 0.18-0.30 L 0.3-0.5  e 0.5
 *
 * The RSS model cannot fit those four at once. It carries the BODY tolerance
 * into the toe, so the 9 mm package (tolerance 0.30) and the 3 mm packages
 * (tolerance 0.20) must land differently, and they do not: TI's land span is the
 * nominal body plus 0.4 mm in every one of the four, exactly. Fitting the toe to
 * the 3 mm parts gives 0.146 and to the 9 mm part 0.122, which is the tell that
 * the tolerance term is not there at all.
 *
 * What does fit, exactly and with no residual, is three statements:
 *
 *   pad width  = the terminal's NOMINAL width       0.31, 0.30, 0.24, 0.24
 *   pad length = the terminal's NOMINAL length + 0.2   0.6 on all four
 *   land span  = the NOMINAL body + 0.4             2.8, 2.8, 2.8, 8.8
 *
 * so the land's toe sits 0.2 mm outboard of the body edge and its heel sits on
 * the terminal's nominal inner end. Zero error against all four published
 * patterns, across two body sizes, three families and two pitches.
 *
 * ## What that means for a caller
 *
 * This reproduces what TI prints. It is a vendor house rule that TI applies
 * consistently, not a derivation from the standard, and a part from another
 * vendor may be laid out to a different one. It is used because the alternative
 * is refusing every no-lead package, and because a rule that reproduces four
 * published patterns exactly is better evidence than a goal table recalled from
 * memory would have been. The provenance travels with the footprint so a
 * reviewer can see which claim is being made.
 *
 * Density levels A and C are REFUSED rather than approximated: the four drawings
 * are one rule, they carry no density label, and there is nothing here to scale.
 */
const NOLEAD_TOE_BEYOND_BODY_MM = 0.2;

/**
 * Courtyard excess in mm beyond the land extents, per IPC-7351B density level.
 */
export const COURTYARD_EXCESS: Record<DensityLevel, number> = { A: 0.5, B: 0.25, C: 0.12 };

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
  /**
   * Where the pattern came from, so nothing downstream can describe it wrongly.
   *
   * `printed` means the datasheet drew this footprint itself and these are its
   * numbers; the density level then applies ONLY to the courtyard margin, which
   * is a board convention rather than part data. Absent or `ipc7351b` means the
   * pattern was computed here. The generated file states which, because "the
   * vendor recommends this" and "we derived this from a standard" are different
   * claims and a reviewer is entitled to tell them apart.
   */
  source?: "printed" | "ipc7351b";
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

/** The midpoint of a drawing range, which is the nominal the no-lead rule uses. */
function nominal(range: Range): number {
  return (range.minMm + range.maxMm) / 2;
}

/**
 * The no-lead land, from the rule recovered off four TI drawings.
 *
 * `span` carries the BODY dimension here rather than a lead span, because a
 * no-lead terminal ends at the body edge and there is no lead to span anything.
 * `contact` carries the terminal length and `width` its width, both as the
 * drawing prints them; only their nominals are used, which is what the four
 * published patterns are built from.
 */
function noLeadLandPattern(lead: LeadDimensions, densityLevel: DensityLevel): LandPattern {
  if (densityLevel !== "B") {
    throw new LandPatternError([
      `no-lead packages are laid out here by a single rule read off four vendor drawings, which carries no density level, so density ${densityLevel} cannot be produced. Use the nominal level B or supply the land pattern yourself`
    ]);
  }

  const bodyNom = nominal(lead.span);
  const padLength = nominal(lead.contact) + NOLEAD_TOE_BEYOND_BODY_MM;
  const padWidth = nominal(lead.width);

  const zMax = bodyNom + 2 * NOLEAD_TOE_BEYOND_BODY_MM;
  const gMin = zMax - 2 * padLength;

  // Terminals reaching more than halfway under the body would put opposing lands
  // across the centre line. Same guard as the gull-wing path and the same reason:
  // it means the dimensions describe something that is not this package.
  if (gMin <= 0) {
    throw new LandPatternError([
      `the terminal length (${nominal(lead.contact)} mm nominal) is too long for the body (${bodyNom} mm), which leaves no gap between opposing lands`
    ]);
  }

  return {
    padWidthMm: padWidth,
    padLengthMm: padLength,
    padCentreMm: (zMax + gMin) / 4,
    zMaxMm: zMax,
    gMinMm: gMin,
    courtyardHalfMm: zMax / 2 + COURTYARD_EXCESS[densityLevel],
    densityLevel
  };
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

  // A no-lead terminal is a pad on the underside of the body, not a formed lead,
  // and the rule that lays it out is a different one. See NOLEAD_TOE_BEYOND_BODY_MM.
  if (lead.form === "nolead") return noLeadLandPattern(lead, densityLevel);

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

// ---------------------------------------------------------------------------
// Exposed thermal pads
// ---------------------------------------------------------------------------

/**
 * The land for an exposed thermal pad, and the paste apertures that go on it.
 *
 * ## The land: 1:1 with the pad
 *
 * The thermal land equals the exposed pad's NOMINAL size. This is what the
 * vendors' own printed patterns do on every drawing in the cache, and it is what
 * IPC-7093 recommends for a solderable exposed pad: the land is not enlarged,
 * because a land wider than the pad pulls solder out from under the part and
 * gains nothing thermally.
 *
 * Stated as a rule with that basis rather than derived, exactly as the no-lead
 * rule above is. Where the datasheet prints its own land pattern, `vendorland`
 * checks this against it and refuses a disagreement.
 *
 * ## The paste: NOT 1:1, and this is the part that matters
 *
 * A thermal land pasted at 100% is a defect, not a simplification. The volume of
 * solder under the pad floats the package, lifting the perimeter leads off their
 * lands, and the excess escapes as balls. Every vendor recommendation for these
 * packages subdivides the aperture, and IPC-7093 puts the target coverage
 * between 50% and 80% of the land area.
 *
 * So the paste is an ARRAY of square apertures. The grid is the smallest that
 * keeps each aperture at or under `MAX_APERTURE_MM`, and the aperture size is
 * then solved for the coverage target: with `n` apertures of side `a` across a
 * land of side `L`, coverage is `(n*a/L)^2`, so `a = L*sqrt(coverage)/n`.
 *
 * Emitting the copper without the paste array would produce a footprint that
 * looks right in CAD and fails at reflow, which is the failure this project
 * exists to avoid.
 */
export interface ThermalPadLand {
  /** Copper land, centred on the package origin. */
  widthMm: number;
  heightMm: number;
  /** Paste apertures, centres relative to the package origin. */
  apertures: Array<{ xMm: number; yMm: number; widthMm: number; heightMm: number }>;
  /** Fraction of the land covered by paste, for the record and for review. */
  pasteCoverage: number;
}

/** Largest aperture that still breaks the solder volume up enough to stop float. */
const MAX_APERTURE_MM = 1.5;
/** Mid-band of the IPC-7093 range, so rounding cannot push it outside. */
const TARGET_PASTE_COVERAGE = 0.65;
/** Smallest aperture a stencil house will cut reliably at typical foil thickness. */
const MIN_APERTURE_MM = 0.25;

export function thermalPadLand(padLengthMm: number, padWidthMm: number): ThermalPadLand {
  if (!(padLengthMm > 0) || !(padWidthMm > 0)) {
    throw new LandPatternError([
      "The exposed thermal pad's size is not known, so no thermal land can be laid out.",
      "It is drawing dimensions D2 and E2 on the package outline."
    ]);
  }

  const columns = Math.max(1, Math.ceil(padLengthMm / MAX_APERTURE_MM));
  const rows = Math.max(1, Math.ceil(padWidthMm / MAX_APERTURE_MM));
  const apertureW = (padLengthMm * Math.sqrt(TARGET_PASTE_COVERAGE)) / columns;
  const apertureH = (padWidthMm * Math.sqrt(TARGET_PASTE_COVERAGE)) / rows;

  if (apertureW < MIN_APERTURE_MM || apertureH < MIN_APERTURE_MM) {
    throw new LandPatternError([
      `A paste aperture of ${Math.min(apertureW, apertureH).toFixed(2)} mm is below the ${MIN_APERTURE_MM} mm a stencil can cut reliably.`,
      "No thermal paste pattern is generated rather than one that cannot be manufactured."
    ]);
  }

  // Pitch spreads the apertures evenly over the land, so the outer ones sit
  // inboard of the edge rather than flush with it. Paste at the very edge is
  // what bridges to the perimeter lands.
  const pitchX = padLengthMm / columns;
  const pitchY = padWidthMm / rows;
  const apertures: ThermalPadLand["apertures"] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      apertures.push({
        xMm: (column - (columns - 1) / 2) * pitchX,
        yMm: (row - (rows - 1) / 2) * pitchY,
        widthMm: apertureW,
        heightMm: apertureH
      });
    }
  }

  return {
    widthMm: padLengthMm,
    heightMm: padWidthMm,
    apertures,
    pasteCoverage: (apertures.length * apertureW * apertureH) / (padLengthMm * padWidthMm)
  };
}
