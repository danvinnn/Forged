/**
 * KiCad generator.
 *
 * One of three peers (KiCad, Altium, Cadence). It reads the format-neutral
 * geometry and knows nothing about the other formats, and none of them are
 * derived from it. That independence is the point: output for Altium and Cadence
 * used to be this file's text with a header glued on, which is not support for
 * those tools, it is a rename.
 *
 * KiCad does keep one incidental privilege: it is the only human-readable
 * output, so it is the thing to diff against when a binary generator misbehaves.
 * That is a debugging convenience, not a position in the pipeline.
 */

import { type FootprintGeometry, type SymbolGeometry } from "../geometry";
import { type PinRecord } from "../types";

/**
 * What the symbol and the footprint say about each other, and about the 3D body.
 *
 * These are not geometry, they are file references, so they arrive from the
 * exporter that knows the layout of the bundle rather than from the geometry.
 * Without them the user assigns the footprint by hand for every part, which is
 * the whole difference between a library that works on drop-in and one that
 * needs assembling first.
 */
export interface KicadLinks {
  /**
   * `nickname:footprint`, written into the symbol's Footprint property. The
   * nickname is the one KiCad derives by default when the user adds the
   * `.pretty` folder we ship, so the two agree without anyone typing anything.
   */
  footprintRef?: string;
  /** Path to the STEP body, relative to the project, for the footprint's 3D model. */
  modelPath?: string;
}

/**
 * KiCad s-expression strings are double-quoted with backslash escaping. Escape
 * backslash and quote, and strip raw newlines so a value cannot open a new token
 * on its own line. Extracted fields reach here from an attacker-influenceable
 * datasheet, so this is a security boundary, not tidiness.
 */
function kicadString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
}

function mm(value: number): string {
  return value.toFixed(3);
}

function kicadPinType(pinType: PinRecord["electricalType"]): string {
  switch (pinType) {
    case "power":
      return "power_in";
    case "input":
      return "input";
    case "output":
      return "output";
    case "bidirectional":
      return "bidirectional";
    case "passive":
      return "passive";
    case "nc":
      return "not_connected";
    default:
      return "unspecified";
  }
}

export function emitKicadFootprint(geometry: FootprintGeometry, links: KicadLinks = {}): string {
  const lines = [
    `(footprint "${kicadString(geometry.name)}"`,
    "  (version 20240108)",
    "  (generator Forge)",
    '  (layer "F.Cu")',
    `  (descr "${kicadString(geometry.description)}")`,
    `  (property "Reference" "U" (at 0 ${mm(-geometry.body.halfHeightMm - 1.2)} 0) (layer "F.SilkS") (effects (font (size 1 1))))`,
    `  (property "Value" "${kicadString(geometry.partNumber)}" (at 0 ${mm(geometry.body.halfHeightMm + 1.2)} 0) (layer "F.Fab") (effects (font (size 1 1))))`,
    `  (fp_rect (start ${mm(-geometry.body.halfWidthMm)} ${mm(-geometry.body.halfHeightMm)}) (end ${mm(geometry.body.halfWidthMm)} ${mm(geometry.body.halfHeightMm)}) (layer "F.Fab") (width 0.1) (fill none))`,
    `  (fp_rect (start ${mm(-geometry.courtyard.halfWidthMm)} ${mm(-geometry.courtyard.halfHeightMm)}) (end ${mm(geometry.courtyard.halfWidthMm)} ${mm(geometry.courtyard.halfHeightMm)}) (layer "F.CrtYd") (width 0.05) (fill none))`,
    `  (fp_circle (center ${mm(geometry.pin1Marker.xMm)} ${mm(geometry.pin1Marker.yMm)}) (end ${mm(geometry.pin1Marker.xMm + 0.15)} ${mm(geometry.pin1Marker.yMm)}) (layer "F.SilkS") (width 0.15) (fill solid))`
  ];

  for (const pad of geometry.pads) {
    lines.push(
      `  (pad "${kicadString(pad.number)}" smd ${pad.shape} (at ${mm(pad.centre.xMm)} ${mm(pad.centre.yMm)}) (size ${mm(pad.widthMm)} ${mm(pad.heightMm)}) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.25))`
    );
  }

  // The 3D body, referenced rather than embedded, which is how KiCad does it.
  // KIPRJMOD resolves to the project directory, so the reference holds as long
  // as the STEP file we ship alongside stays next to the project.
  if (links.modelPath) {
    lines.push(
      `  (model "${kicadString(links.modelPath)}"`,
      "    (offset (xyz 0 0 0))",
      "    (scale (xyz 1 1 1))",
      "    (rotate (xyz 0 0 0))",
      "  )"
    );
  }

  lines.push(")");
  return lines.join("\n");
}

export function emitKicadSymbol(geometry: SymbolGeometry, links: KicadLinks = {}): string {
  const { halfWidthMm, halfHeightMm } = geometry.body;
  const name = kicadString(geometry.name);

  const lines = [
    "(kicad_symbol_lib",
    "  (version 20211014)",
    "  (generator Forge)",
    `  (symbol "${name}"`,
    "    (pin_names (offset 0.508))",
    "    (in_bom yes)",
    "    (on_board yes)",
    `    (property "Reference" "U" (at ${mm(-halfWidthMm)} ${mm(halfHeightMm + 2.54)} 0) (effects (font (size 1.27 1.27)) (justify left)))`,
    `    (property "Value" "${kicadString(geometry.partNumber)}" (at ${mm(-halfWidthMm)} ${mm(-halfHeightMm - 2.54)} 0) (effects (font (size 1.27 1.27)) (justify left)))`
  ];

  // Hidden, like every other Footprint property: it is a link, not a label. With
  // it the footprint arrives attached when the symbol is placed; without it the
  // user assigns one by hand for every part.
  if (links.footprintRef) {
    lines.push(
      `    (property "Footprint" "${kicadString(links.footprintRef)}" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))`
    );
  }

  // The graphics and pins go in a unit sub-symbol named `<symbol>_<unit>_<style>`,
  // which is what KiCad itself writes. KiCad's parser does accept them at the
  // top level and files them under unit 1 either way, so this is not a
  // correctness fix. It is a compatibility one: a symbol with no unit reads as
  // having no units at all to other tools that consume `.kicad_sym`, and a
  // library that only KiCad understands is a library with a footgun in it.
  lines.push(`    (symbol "${name}_1_1"`);
  lines.push(
    `      (rectangle (start ${mm(-halfWidthMm)} ${mm(halfHeightMm)}) (end ${mm(halfWidthMm)} ${mm(-halfHeightMm)}) (stroke (width 0.254) (type solid)) (fill (type background)))`
  );

  for (const pin of geometry.pins) {
    // A left-hand pin points right (0 degrees), a right-hand pin points left.
    const angle = pin.side === "left" ? 0 : 180;
    lines.push(
      `      (pin ${kicadPinType(pin.electricalType)} line (at ${mm(pin.anchor.xMm)} ${mm(pin.anchor.yMm)} ${angle}) (length ${mm(pin.lengthMm)}) (name "${kicadString(pin.name)}" (effects (font (size 1.0 1.0)))) (number "${kicadString(pin.number)}" (effects (font (size 1.0 1.0)))))`
    );
  }

  lines.push("    )", "  )", ")");
  return lines.join("\n");
}
