/**
 * Altium internal coordinates.
 *
 * Altium stores PCB coordinates as a signed 32-bit integer whose unit is one
 * ten-thousandth of a mil. pyaltiumlib's `Coordinate.parse_bin` divides the
 * on-disk integer by 10000 and treats the result as mils, which fixes the
 * encoding from the reader's side:
 *
 *     internal = round(mm / 0.0254 * 10000)
 *
 * This is the single most dangerous number in the format. A file written in
 * millimetres times 10000 parses cleanly, reports plausible geometry, and is
 * wrong by a factor of 25.4. Nothing downstream can detect it. Hence the unit
 * test that pins a worked example, and hence this module existing at all rather
 * than the expression being inlined at each call site.
 */

/** Raised when geometry cannot be expressed in the format. The export fails; it never approximates. */
export class AltiumEmitError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "AltiumEmitError";
  }
}

/** One mil in millimetres, by definition. */
export const MM_PER_MIL = 0.0254;

/** Internal units per mil, from pyaltiumlib's `datatypes/coordinate.py`. */
export const UNITS_PER_MIL = 10000;

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/**
 * Converts millimetres to Altium internal units.
 *
 * Refuses rather than clamping: a coordinate that does not fit the field is a
 * footprint nobody can fabricate, and a silently truncated one is worse than a
 * failed export.
 */
export function toAltiumUnits(millimetres: number): number {
  if (!Number.isFinite(millimetres)) {
    throw new AltiumEmitError(`Cannot express ${millimetres} mm as an Altium coordinate.`);
  }

  const units = Math.round((millimetres / MM_PER_MIL) * UNITS_PER_MIL);
  if (units < INT32_MIN || units > INT32_MAX) {
    throw new AltiumEmitError(
      `${millimetres} mm is outside the range Altium can store in a coordinate field.`
    );
  }
  return units;
}

/**
 * The inverse, for tests and for reading back what was written. Lossy by one
 * unit at most, which is 2.54 nanometres.
 */
export function fromAltiumUnits(units: number): number {
  return (units / UNITS_PER_MIL) * MM_PER_MIL;
}

/**
 * Converts a geometry Y coordinate to Altium's.
 *
 * `FootprintGeometry` is +y down, matching how the land pattern is computed and
 * how KiCad reads. Altium's PCB space is +y up. The flip belongs here, on the
 * way out, not in the geometry: the seam stays format-neutral.
 */
export function toAltiumY(millimetres: number): number {
  const units = toAltiumUnits(millimetres);
  // Negating zero gives -0, which serialises the same but compares unequal to 0
  // and reads as a sign in a diff. Keep it plain.
  return units === 0 ? 0 : -units;
}
