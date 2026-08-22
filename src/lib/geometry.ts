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

/** What the footprint was computed from, carried through to every output. */
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
