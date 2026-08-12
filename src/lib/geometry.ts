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
  shape: "roundrect";
  /** Surface mount is the only mounting these families use. */
  mounting: "smd";
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
  pasteApertures?: Array<{ centre: Point; widthMm: number; heightMm: number }>;
}

/** What the footprint was computed from, carried through to every output. */
export interface FootprintProvenance {
  family: string;
  source: string;
  densityLevel: DensityLevel;
  padWidthMm: number;
  padLengthMm: number;
  centreToCentreMm: number;
  pitchMm: number;
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
  /** The rectangle the pins attach to. */
  body: Rect;
  pins: SymbolPin[];
}
