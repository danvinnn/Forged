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

/**
 * Hole allowance over the lead diameter, per IPC-7251 density level, in mm.
 *
 * The through-hole counterpart to `FILLET_GOALS`, and the same three-level
 * choice: A is the most material and the loosest fit, C the least. The standard
 * gives the hole as the maximum lead diameter plus this, and the land as the
 * hole plus an annular ring.
 *
 * A hole is not a fillet, so this is a separate table rather than a reuse of the
 * surface-mount goals. Entering it is what makes a through-hole part buildable
 * at all: `Pad.mounting` admitted only `"smd"` until 2026-08-14, so a PDIP or a
 * ceramic DIP had nowhere to go however well its datasheet was read.
 */
export const HOLE_ALLOWANCE: Record<DensityLevel, number> = { A: 0.25, B: 0.2, C: 0.15 };

/**
 * Annular ring around the hole, per density level, in mm.
 *
 * TWO independent published footprints, and they land on two different levels of
 * this table, which is the strongest evidence available that the ring is a
 * density choice rather than a single right answer:
 *
 *   KiCad `DIP-8_W7.62mm`     1.600 mm pad, 0.800 mm hole  ->  0.400 mm  (B)
 *   Ultra Librarian TO-220    1.702 mm pad, 1.194 mm hole  ->  0.254 mm  (C)
 *
 * The second came from a real Altium library added to `test-data/` on
 * 2026-08-15. Before it, level B rested on one sample and the other two levels
 * were reasoning about how the standard scales its other allowances. Now B and C
 * each have a published file behind them and A is the remaining extrapolation.
 *
 * Worth stating plainly because the two disagreeing looked at first like a
 * contradiction. It is not: they are two vendors building to two different
 * levels, and both fall inside the table rather than outside it.
 */
export const ANNULAR_RING: Record<DensityLevel, number> = { A: 0.5, B: 0.4, C: 0.25 };

/**
 * The plated hole and its land, for a lead of the given diameter.
 *
 * Both numbers come from the tables above and from the lead the drawing states.
 * Nothing here is per family and nothing is guessed: a lead diameter the document
 * does not carry means no through-hole footprint, the same way a missing lead
 * span means no surface-mount one.
 */
export function throughHolePad(
  leadDiameterMm: number,
  densityLevel: DensityLevel = "B"
): { drillMm: number; padMm: number } {
  if (!(leadDiameterMm > 0)) {
    throw new LandPatternError([
      "the lead diameter, which is what the hole is sized from. No hole is invented for a lead nobody measured"
    ]);
  }
  const drillMm = leadDiameterMm + HOLE_ALLOWANCE[densityLevel];
  return { drillMm, padMm: drillMm + 2 * ANNULAR_RING[densityLevel] };
}

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
 * `contact` is the SEATED FOOT: the part of the lead that lies flat on the land,
 * which the standard calls T. It is read off the drawing like the other two.
 *
 * The distinction that matters, and the one that used to be wrong here: a
 * gull-wing drawing's dimension `L` is often the WHOLE formed lead including the
 * vertical run, not the seated foot. MS-012 and MS-013 both print L as 0.40 to
 * 1.27, and feeding that in puts the heel over a millimetre too far inboard. The
 * reader is asked specifically for the foot for exactly this reason, and
 * `ipc7351.test.ts` pins how much the two differ so nobody swaps one for the
 * other as a tidy-up.
 *
 * Until 2026-08-14 this was a per-family constant, fitted so the computed land
 * reproduced a published one, and carried in a hand-typed table keyed on package
 * name. That table is gone.
 */
export interface LeadDimensions {
  form: LeadForm;
  span: Range;
  /** The seated foot that lies on the land, read off the drawing. */
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
  // No-lead has no route here. IPC-7351B publishes its fillet goals per lead
  // form and only the gull-wing table is transcribed in this file; the rule that
  // used to serve no-lead was reverse-engineered from four TI drawings and was
  // retired on 2026-08-13 because it applied one vendor's house rule to every
  // vendor's parts. A no-lead package builds from its datasheet's own printed
  // footprint, and asks when the document prints none.
  if (lead.form === "nolead") {
    throw new LandPatternError([
      "no-lead fillet goals are not transcribed here. IPC-7351B publishes them per lead form and only gull-wing is entered; the rule that used to serve no-lead was reverse-engineered from four vendor drawings and applied one vendor's house rule to everyone's parts. A no-lead package builds from its datasheet's own printed footprint, or asks"
    ]);
  }

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

/**
 * Paste coverage as a fraction of the thermal land. MEASURED, not chosen.
 *
 * IPC-7093 puts the target between 50% and 80%, which is a band rather than a
 * number. What settles it is what the ecosystem actually cuts: 33 exposed-pad
 * footprints were parsed out of KiCad's official `Package_DFN_QFN` library on
 * 2026-08-14 and their coverage solved for, and every one of the 33 landed
 * between 0.640 and 0.658.
 *
 * So 0.65 is not the middle of a band picked to be safe. It is the figure the
 * published libraries hold, and it happens to sit mid-band.
 */
const TARGET_PASTE_COVERAGE = 0.65;

/**
 * Largest paste aperture before the grid is subdivided further.
 *
 * ## This one has no published source, and that is stated rather than hidden
 *
 * IPC-7093 fixes the COVERAGE and says the aperture should be subdivided. It
 * does not give a maximum, and neither does the practice: measured across the
 * same 33 reference footprints, the apertures run from 0.24 mm to 2.06 mm, and
 * two footprints with nearly identical pads get different grids (EP 1.6 x 2.56
 * gets one aperture of 1.29 x 2.06; EP 1.6 x 2.5 gets a 2 x 2 grid). The counts
 * are chosen per footprint by hand and no rule predicts them.
 *
 * That was established the hard way and it is worth recording. Six of the 33
 * were consistent with a maximum of exactly 1.35 mm, which reads like a
 * recovered constant and nearly shipped as one. Solving the same bound across
 * all 33 gives "at least 2.0639 and less than 0.4837", i.e. no maximum exists
 * that the library obeys. Fitting to the six would have been a rule derived from
 * what happened to be in front of me.
 *
 * So the subdivision is genuinely ours to choose, and the honest treatment is
 * the one `RULES.md` rule 3 prescribes for a value the document cannot answer
 * and that differs between processes: a setting, with the default stated as a
 * default. Coverage is held either way, so this changes how the paste is divided
 * and not how much of it there is.
 *
 * 1.5 mm is the default because it reproduces the reference grids on the pads
 * where the reference is unambiguous, and because a larger aperture is what
 * risks the solder bridging under the part that the subdivision exists to
 * prevent.
 */
const DEFAULT_MAX_APERTURE_MM = 1.5;

/**
 * Smallest aperture a stencil house will cut reliably at typical foil thickness.
 *
 * A process value like the one above: it describes the customer's stencil, not
 * the part.
 */
const MIN_APERTURE_MM = 0.25;

/**
 * Stencil limits are a PROCESS value, not a fact about the part.
 *
 * No datasheet states what your stencil house can cut, so these default to the
 * common figures and are overridable by anyone whose process differs. Same
 * treatment the IPC density level gets.
 */
export interface ThermalPadOptions {
  /** Smallest aperture the stencil can cut, mm. Defaults to 0.25. */
  minApertureMm?: number;
  /** Largest aperture before the grid subdivides further, mm. Defaults to 1.5. */
  maxApertureMm?: number;
}

export function thermalPadLand(
  padLengthMm: number,
  padWidthMm: number,
  options: ThermalPadOptions = {}
): ThermalPadLand {
  if (!(padLengthMm > 0) || !(padWidthMm > 0)) {
    throw new LandPatternError([
      "The exposed thermal pad's size is not known, so no thermal land can be laid out.",
      "It is drawing dimensions D2 and E2 on the package outline."
    ]);
  }

  // The grid ADAPTS to the stencil minimum rather than the part being refused
  // for it.
  //
  // This used to compute one grid and then throw if its apertures came out below
  // what a stencil can cut. But the grid is ours to choose: fewer, larger
  // apertures hold the same paste coverage and are manufacturable. Refusing the
  // whole footprint over a choice we were free to make differently reported our
  // arithmetic as the part's problem.
  //
  // Coverage is held at the IPC-7093 mid-band throughout, so coarsening the grid
  // changes how the paste is divided and not how much of it there is.
  const minimum = options.minApertureMm ?? MIN_APERTURE_MM;
  const maximum = options.maxApertureMm ?? DEFAULT_MAX_APERTURE_MM;
  // The COARSEST grid whose apertures still come out at or under the maximum.
  // Solved on the aperture rather than on the pad, because the aperture is the
  // thing being bounded: at 65% coverage an aperture is sqrt(0.65) of its cell.
  const cells = (extent: number) => Math.max(1, Math.ceil((extent * Math.sqrt(TARGET_PASTE_COVERAGE)) / maximum));
  let columns = cells(padLengthMm);
  let rows = cells(padWidthMm);
  const widthAt = (n: number) => (padLengthMm * Math.sqrt(TARGET_PASTE_COVERAGE)) / n;
  const heightAt = (n: number) => (padWidthMm * Math.sqrt(TARGET_PASTE_COVERAGE)) / n;
  while (columns > 1 && widthAt(columns) < minimum) columns -= 1;
  while (rows > 1 && heightAt(rows) < minimum) rows -= 1;

  const apertureW = widthAt(columns);
  const apertureH = heightAt(rows);

  // One aperture is the coarsest grid there is. Below the stencil minimum at
  // that point the PAD is too small to paste at all, which is a fact about the
  // part rather than about our grid, and it is worth saying plainly.
  if (apertureW < minimum || apertureH < minimum) {
    throw new LandPatternError([
      `This exposed pad is ${padLengthMm} x ${padWidthMm} mm, and even a single paste aperture over it comes out ${Math.min(apertureW, apertureH).toFixed(2)} mm, below the ${minimum} mm a stencil can cut reliably.`,
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
