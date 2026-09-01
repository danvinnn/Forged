/**
 * The format-neutral description of a generated part.
 *
 * This is the seam between "what shape is this part" and "how does tool X spell
 * it". Every output format reads these structures and nothing else; no format is
 * derived from another. That matters because the previous arrangement computed
 * geometry and KiCad s-expressions in the same breath, and Altium and Cadence
 * output was literally the KiCad text with a header glued on. A footprint is not
 * a KiCad file that other tools convert, it is a set of pads at coordinates that
 * every tool spells differently.
 *
 * Coordinates are millimetres, origin at the package centre, +x right and +y
 * down, matching how the land pattern is computed. An emitter that needs another
 * convention converts on the way out.
 */

import { type DensityLevel } from "./ipc7351";
import { type PinElectricalType } from "./types";

export interface Point {
  xMm: number;
  yMm: number;
}

/** An axis-aligned rectangle, centred on the origin unless stated otherwise. */
export interface Rect {
  halfWidthMm: number;
  halfHeightMm: number;
}

export interface Pad {
  /** The pin number this land belongs to, as printed in the datasheet. */
  number: string;
  centre: Point;
  widthMm: number;
  heightMm: number;
  /**
   * `roundrect` for a surface-mount land, `circle` for a plated hole.
   *
   * A through-hole pad is round because the lead is: the reference `DIP-8_W7.62mm`
   * draws pin 1 as a roundrect to mark it and every other pin as a circle, which
   * is the convention this follows.
   */
  shape: "roundrect" | "circle";
  mounting: "smd" | "through-hole";
  /**
   * Finished hole diameter, mm. Present on a through-hole pad and absent on a
   * land.
   *
   * From IPC-7251: the hole is the lead diameter plus an allowance chosen by
   * density level, 0.25 mm for level A, 0.20 for B and 0.15 for C. That is the
   * same three-level choice IPC-7351B makes for a surface-mount fillet, and it
   * is a property of the assembly process rather than of the part, so it comes
   * from the same setting.
   */
  drillMm?: number;
  /**
   * Solder paste apertures, when paste must NOT follow the copper.
   *
   * Absent on every lead land, where 1:1 is correct. Present only on an exposed
   * thermal pad, where 1:1 is a defect rather than a simplification: the solder
   * volume under a large land floats the package, lifting the perimeter leads
   * off their lands, and the excess escapes as balls. See `thermalPadLand`.
   *
   * An emitter that ignores this produces a footprint that looks right in CAD
   * and fails at reflow, so every emitter must either honour it or refuse.
   */
  /**
   * `centre` is in the FOOTPRINT's coordinates, the same frame as `Pad.centre`,
   * not an offset from the pad.
   *
   * Stated because two files have to agree about it and only worked by
   * accident: both emitters write it straight out as a footprint coordinate,
   * while `geometryViolations` tested `|aperture.centre| + w/2 <= pad.width/2`,
   * i.e. as a pad-relative offset. The two coincide only because every exposed
   * pad this generator builds sits on the origin, so an off-centre pad would
   * have made one of them silently wrong.
   */
  pasteApertures?: Array<{ centre: Point; widthMm: number; heightMm: number }>;
  /**
   * Solder mask clearance around this land, in millimetres, when the datasheet
   * states one.
   *
   * Absent means the datasheet did not say and the board house's default
   * applies, which is the correct behaviour for a number nobody stated. It is
   * NOT a zero: a zero here is a mask opening exactly the size of the copper,
   * which is a real and different instruction.
   *
   * Printed on 20 of 46 corpus land-pattern drawings, beside pad dimensions the
   * generator was already reading, and emitted by nothing until 2026-08-13.
   */
  solderMaskMarginMm?: number;
}

/**
 * A plated through hole under an exposed thermal pad.
 *
 * Not a `Pad`: it carries no pin, sits on every copper layer, and its job is to
 * move heat into the board rather than to solder a lead. Emitting it as a pad
 * would put it in the netlist as a terminal the part does not have.
 *
 * Read off the datasheet's own land pattern drawing, which states the drill
 * diameter and the grid spacing (30 of 46 corpus datasheets do). Absent when the
 * document did not say, which is not the same as "no vias are needed": it means
 * we were not told, and the board designer decides.
 */
export interface ThermalVia {
  centre: Point;
  /** Finished drill diameter, mm. */
  drillMm: number;
  /** Annular copper diameter, mm. */
  padMm: number;
}

/**
 * The pad number an exposed thermal pad is given: one past the last lead.
 *
 * ONE DEFINITION, because this was written out by hand in four places and two of
 * them had already drifted. `bench:copper` looked for a pad numbered `"EP"` while
 * `emitThermalPad` numbers it `pinCount + 1`, so the check written to catch a
 * rotated thermal pad matched nothing and had never run on any part since the day
 * it was added.
 *
 * The convention itself: a vendor label like `EP` or `PAD` cannot be used,
 * because `geometryViolations` requires the pad set to be exactly 1..N plus this
 * one, and every CAD tool expects the same.
 */
/**
 * A terminal addressed by GRID POSITION: a row letter and a column number.
 *
 * `A1`, `B12`, `AA3`. The addressing scheme of every ball-, land- and
 * column-grid array, whatever the vendor calls the package. Matched on the SHAPE
 * rather than on a package name, so it covers any grid-addressed part rather
 * than the one that prompted it.
 *
 * Deliberately NOT `EP`, `DAP` or `TAB`: those are letters with no column
 * number, and the extraction reader tests its thermal-pad vocabulary first.
 */
const GRID_DESIGNATOR = /^[A-Za-z]{1,2}\d{1,3}$/;

/**
 * Whether a pin table addresses its terminals by grid position.
 *
 * Here rather than in the extraction layer because both halves of the product
 * need it and neither owns it: the reader keeps such a pinout instead of
 * throwing it away, and the generator refuses the FOOTPRINT for one, because it
 * places lands in rows along the sides of a package and a grid is none of those.
 * A second copy of this rule would let those two disagree about what a BGA is.
 */
/**
 * The row letters a grid array uses, in order.
 *
 * JEDEC's convention, and the reason for the gaps is that the omitted letters
 * are the ones that read as digits or as each other on a drawing: I as 1, O as
 * 0, Q as O, S as 5, X as a cross-hair, Z as 2. Every vendor's BGA follows it,
 * which is what makes a row letter positional rather than merely a label.
 *
 * The alphabet is the whole point. Ordering the rows a part HAPPENS to have
 * would place them correctly only while none is missing, and a depopulated grid
 * - a BGA with a whole row left out under the die - would then be compressed
 * into a footprint whose every ball after the gap is a pitch out of place.
 */
const JEDEC_ROW_LETTERS = "ABCDEFGHJKLMNPRTUVWY";

/**
 * A row letter's absolute position in the grid, or null when it is not one.
 *
 * Two-letter rows continue past the alphabet the way JEDEC continues them: `AA`
 * follows `Y`, then `AB`, `AC`. Refused rather than guessed when a letter is not
 * in the alphabet at all, because a designator this cannot place is one that
 * would be placed WRONGLY, and a ball a pitch out of position is a board that
 * looks correct and does not work.
 */
export function gridRowIndex(row: string): number | null {
  const letters = row.toUpperCase();
  if (letters.length === 1) {
    const index = JEDEC_ROW_LETTERS.indexOf(letters);
    return index < 0 ? null : index;
  }
  if (letters.length === 2) {
    const first = JEDEC_ROW_LETTERS.indexOf(letters[0]);
    const second = JEDEC_ROW_LETTERS.indexOf(letters[1]);
    if (first < 0 || second < 0) return null;
    return JEDEC_ROW_LETTERS.length + first * JEDEC_ROW_LETTERS.length + second;
  }
  return null;
}

export function isGridAddressed(pins: readonly { number: string }[]): boolean {
  return pins.length > 0 && pins.every((pin) => GRID_DESIGNATOR.test(pin.number));
}

/** One terminal's designator, as a grid position, or null when it is not one. */
export function gridPosition(designator: string): { row: string; column: number } | null {
  const match = /^([A-Za-z]{1,2})(\d{1,3})$/.exec(designator.trim());
  return match ? { row: match[1].toUpperCase(), column: Number(match[2]) } : null;
}

export function thermalPadNumber(pinCount: number): string {
  return String(pinCount + 1);
}

/** What the footprint was computed from, carried through to every output. */
/** Which reading produced the pads, and which one checked them. */
export type LandSource =
  /** The recommended footprint the datasheet printed, read off its own page. */
  | "printed"
  /** Computed by IPC-7351B from this datasheet's package outline drawing. */
  | "ipc7351b"
  /** Plated holes sized by IPC-7251 from the lead diameter. */
  | "ipc7251";

export interface Corroboration {
  /** The reading the pads were built from. */
  from: LandSource;
  /** The independent reading they were checked against, or null when there is none. */
  against: LandSource | null;
  /** True only when a second source exists AND agrees. Never true on `against: null`. */
  agrees: boolean;
  /**
   * A short slug naming the outcome, for grouping.
   *
   * Stated by the generator rather than inferred from `detail` downstream. A
   * consumer sniffing the sentence for a word is a consumer that breaks when the
   * sentence is reworded, and this one is user-facing prose.
   */
  because: string;
  /** What the comparison found, in a reviewer's language. */
  detail: string;
}

export interface FootprintProvenance {
  family: string;
  source: string;
  densityLevel: DensityLevel;
  padWidthMm: number;
  padLengthMm: number;
  centreToCentreMm: number;
  /**
   * The same distance across the OTHER axis, for a four-sided package whose two
   * axes differ. Absent means the two are equal, which is every two-sided
   * package and every square quad.
   *
   * The provenance block is what a reviewer reads to see what was built, and it
   * carried one span for a footprint that has two: the file described itself as
   * square while its own pads were not.
   */
  centreToCentreCrossMm?: number;
  pitchMm: number;
  /**
   * The shape the lands were actually laid out in.
   *
   * Recorded rather than re-derived. `datasheetLayout` decides this from
   * `leadSides` and the pad placement follows it, so anything downstream that
   * needs to know which axis a lead ROW runs along has to either be told or
   * guess from the coordinates. Guessing is what `geometryViolations` did on its
   * first attempt at the row-fits-body invariant, and it read a top-row land and
   * a bottom-row land that happened to share an x as a single 14.9 mm column on
   * a 12 mm body: a false violation on a correct footprint.
   *
   * A reviewer reading the provenance block is owed it for the same reason they
   * are owed the pitch and the span: it is a decision this generator made about
   * their package, and it is not otherwise stated anywhere in the output.
   */
  arrangement: "single" | "dual" | "quad" | "grid";
  /**
   * THE SECOND, INDEPENDENT SOURCE FOR THIS COPPER, and what it said.
   *
   * The product's rule is that no value ships silently unless two independent
   * sources agree on it, and the pads are the value that matters most. There are
   * exactly two readings of a land pattern available in a datasheet, and they
   * fail differently:
   *
   *     the RECOMMENDED FOOTPRINT the vendor printed, read off its own page
   *     one COMPUTED by IPC-7351B from the package outline's lead dimensions
   *
   * Different page, different numbers, and a standard's arithmetic in between.
   * A misread on one does not reproduce on the other, which is what makes their
   * agreement worth anything.
   *
   * Until 2026-08-27 the comparison ran on one path only. `contradictsPrintedLand`
   * checked a COMPUTED pattern against the printed page, so on the 48 of 64
   * footprints built FROM the printed page it never ran at all: the pads that
   * came from the strongest source were the pads nothing checked. Both patterns
   * are now built on both paths and compared, and the answer is recorded here so
   * the reviewer, the export gate and the bench all read the same one.
   */
  corroboration: Corroboration;
  /**
   * What was READ OFF THE DATASHEET and then thrown away on the way to this
   * footprint. Empty on the ordinary path.
   *
   * Here because a discard that ends in a refusal is named in the refusal, and a
   * discard that ends in a SUCCESSFUL fallback used to leave no trace at all.
   * That asymmetry made `bench:guards` report every plausibility guard as
   * "never fires" while one of them was firing on DRV8825 on every single run:
   * the printed footprint was rejected, IPC-7351B computed a pattern instead,
   * the export succeeded, and the only instrument that could have said so only
   * looked at exports that threw.
   *
   * A reviewer reading the provenance six months later is owed the same fact:
   * this footprint is not the one the datasheet printed, and here is why not.
   */
  discards: string[];
}

export interface FootprintGeometry {
  /** Stable identifier for the footprint in a library. */
  name: string;
  /** One line saying what this is and what it was built from. */
  description: string;
  partNumber: string;
  pads: Pad[];
  /** Package body, drawn on the fabrication layer. */
  body: Rect;
  /** Keep-out extent, sized by the IPC density level. */
  courtyard: Rect;
  /** Where the pin-1 dot goes. Without it a correct footprint can be placed rotated. */
  pin1Marker: Point;
  /** Thermal vias under the exposed pad, when the datasheet stated them. Empty otherwise. */
  thermalVias: ThermalVia[];
  provenance: FootprintProvenance;
}

export interface SymbolPin {
  number: string;
  name: string;
  /** Anchor point, at the far end of the pin stub. */
  anchor: Point;
  side: "left" | "right";
  lengthMm: number;
  electricalType: PinElectricalType;
}

/**
 * A schematic symbol.
 *
 * One exception to the convention above, stated here because it has already
 * caught an emitter out: symbol Y counts UP, not down. Pin 1 sits at the largest
 * Y, which is the top of the drawing, matching how every schematic tool draws.
 * The footprint keeps +y down, because that is how the land pattern is computed.
 * An emitter converts on the way out and needs to know which of the two it is
 * holding.
 */
export interface SymbolGeometry {
  name: string;
  partNumber: string;
  /** The rectangle the pins attach to, as half-extents about `bodyCentreYMm`. */
  body: Rect;
  /**
   * Where the body's centre line sits, in Y.
   *
   * Not always zero, and this is the point. KLC S4.1 requires every pin origin
   * to sit on a 100 mil grid node, and an EVEN number of pin rows cannot be both
   * centred on the origin and on that grid: four rows at 2.54 mm pitch land on
   * +/-1.27 and +/-3.81, every one of them half a step off, and a schematic drawn
   * on the standard grid then cannot connect a wire without nudging.
   *
   * So the pins keep the grid and the body moves. A symbol's origin is a
   * placement handle rather than a centre of mass, and the reference libraries
   * treat it that way.
   */
  bodyCentreYMm: number;
  pins: SymbolPin[];
  /**
   * What a library entry carries besides its geometry.
   *
   * Measured against the official KiCad symbols on 2026-08-14: every one of
   * `AD8021AR`, `24LC256` and `MCP2551-I-SN` carries seven properties, and this
   * generator was emitting three. The four missing ones are not decoration.
   * `Description` and `ki_keywords` are what the symbol chooser searches, so a
   * library without them can only be navigated by exact part number, and
   * `Datasheet` is the link a reviewer follows to check a pin name against the
   * document it came from.
   *
   * Optional because a format that has no equivalent field simply skips them,
   * and because a record with no source URL genuinely has no datasheet link.
   */
  description?: string;
  /** The document this part was read from. Null when it was a local upload. */
  datasheetUrl?: string | null;
  /** Search terms for the symbol chooser. */
  keywords?: string;
}
