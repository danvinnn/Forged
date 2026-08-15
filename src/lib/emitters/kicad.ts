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

import { type FootprintGeometry, type Pad, type SymbolGeometry } from "../geometry";
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

/**
 * The datasheet's own solder mask clearance, when it stated one.
 *
 * Emitted as `solder_mask_margin`, which KiCad applies per pad and which
 * overrides the board default. Omitted entirely when the datasheet was silent,
 * so a board house default still applies; writing 0 there would be a different
 * and much stronger instruction than "not stated".
 */
function maskMargin(pad: Pad): string {
  return pad.solderMaskMarginMm === undefined ? "" : ` (solder_mask_margin ${mm(pad.solderMaskMarginMm)})`;
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

/**
 * Line widths, from the KiCad Library Convention.
 *
 * F5.1 sets silkscreen at 0.12 mm, F5.2 the fabrication outline at 0.1 mm and
 * F5.3 the courtyard at 0.05 mm. Confirmed against the official
 * `Package_SO/SOIC-8_3.9x4.9mm_P1.27mm`, which uses exactly those three.
 */
const SILK_WIDTH_MM = 0.12;
const FAB_WIDTH_MM = 0.1;
const COURTYARD_WIDTH_MM = 0.05;

/**
 * How far the silkscreen centreline keeps clear of a pad.
 *
 * KLC F5.1 requires at least the line width of clearance between the drawn silk
 * and the pad. KiCad's generator holds 0.2 mm, which is more; measured off the
 * reference `SOIC-8_3.9x4.9mm_P1.27mm`, whose pads end at y = 2.205 and whose
 * silk stubs stop at 2.465, i.e. 0.26 mm from pad edge to line CENTRE, which is
 * 0.2 mm of gap plus half a line width.
 *
 * Taking the reference's figure rather than the convention's minimum, because
 * the minimum is what passes a check and this is what the ecosystem prints.
 */
const SILK_TO_PAD_MM = 0.2 + SILK_WIDTH_MM / 2;

/**
 * The pin-1 corner cut on the fabrication outline, as a fraction of the body.
 *
 * KiCad's own SOIC-8 chamfers its `F.Fab` polygon by 0.975 mm on a 3.9 mm body
 * edge, i.e. a quarter, capped so it stays a corner mark rather than eating the
 * outline. Both figures are read off that file.
 */
const FAB_CHAMFER_FRACTION = 0.25;
const FAB_CHAMFER_MAX_MM = 1.0;

/**
 * How far the silkscreen outline sits outside the body.
 *
 * Read off KiCad's own `SOIC-8_3.9x4.9mm_P1.27mm`: its 3.9 x 4.9 mm body is
 * half 1.95 x 2.45, and its silkscreen rectangle is half 2.06 x 2.56. Exactly
 * 0.11 mm on both, which is half the 0.12 line width plus 0.05 mm, so the drawn
 * EDGE clears the body outline rather than sitting on it.
 */
const SILK_BODY_OFFSET_MM = SILK_WIDTH_MM / 2 + 0.05;

/**
 * The silkscreen body outline, clipped clear of the pads.
 *
 * A footprint with no silkscreen is not a stylistic gap. The outline and the
 * pin-1 mark are what the assembly operator and the board inspector use to see
 * that a part is the right way round, and until 2026-08-14 this emitter drew a
 * single dot and nothing else.
 *
 * ## Clipped against the ROW, not against each pad
 *
 * An edge that crosses a lead row is cut back to the ends of that row, rather
 * than being sliced into the gaps between individual pads. Both rules keep the
 * required clearance; they differ in what they leave behind, and the difference
 * matters at fine pitch.
 *
 * KiCad's own SOIC-8 is the evidence. It draws six segments: a full top and
 * bottom edge, plus four stubs of 0.095 mm at the corners of the sides where the
 * lead rows end. It does NOT draw the seven inter-pad pieces a per-pad clip
 * would produce. On a 0.4 mm pitch QFP the per-pad rule yields dozens of
 * fragments a fraction of a millimetre long, which no screen prints cleanly and
 * which read as noise on the board.
 */
function silkscreenOutline(geometry: FootprintGeometry): string[] {
  const halfWidthMm = geometry.body.halfWidthMm + SILK_BODY_OFFSET_MM;
  const halfHeightMm = geometry.body.halfHeightMm + SILK_BODY_OFFSET_MM;
  if (!(halfWidthMm > 0) || !(halfHeightMm > 0)) return [];

  /** Pad extents grown by the required clearance. */
  const blockers = geometry.pads.map((pad) => ({
    x0: pad.centre.xMm - pad.widthMm / 2 - SILK_TO_PAD_MM,
    x1: pad.centre.xMm + pad.widthMm / 2 + SILK_TO_PAD_MM,
    y0: pad.centre.yMm - pad.heightMm / 2 - SILK_TO_PAD_MM,
    y1: pad.centre.yMm + pad.heightMm / 2 + SILK_TO_PAD_MM
  }));

  const lines: string[] = [];

  /**
   * One edge, cut back to clear every pad that crosses it.
   *
   * `crossing` are the pads in the way, projected onto the edge's own axis as
   * one merged span. Two pieces survive at most, one at each end.
   */
  function edge(from: number, to: number, crossing: Array<{ lo: number; hi: number }>, draw: (a: number, b: number) => void) {
    if (crossing.length === 0) {
      draw(from, to);
      return;
    }
    const lo = Math.min(...crossing.map((span) => span.lo));
    const hi = Math.max(...crossing.map((span) => span.hi));
    // Nothing survives when the row runs the whole length of the edge, which is
    // the normal case for a fine-pitch package's sides.
    if (lo > from) draw(from, Math.min(lo, to));
    if (hi < to) draw(Math.max(hi, from), to);
  }

  const horizontal = (y: number) =>
    edge(
      -halfWidthMm,
      halfWidthMm,
      blockers.filter((pad) => pad.y0 < y && pad.y1 > y).map((pad) => ({ lo: pad.x0, hi: pad.x1 })),
      (a, b) =>
        lines.push(
          `  (fp_line (start ${mm(a)} ${mm(y)}) (end ${mm(b)} ${mm(y)}) (layer "F.SilkS") (width ${SILK_WIDTH_MM}))`
        )
    );
  const vertical = (x: number) =>
    edge(
      -halfHeightMm,
      halfHeightMm,
      blockers.filter((pad) => pad.x0 < x && pad.x1 > x).map((pad) => ({ lo: pad.y0, hi: pad.y1 })),
      (a, b) =>
        lines.push(
          `  (fp_line (start ${mm(x)} ${mm(a)}) (end ${mm(x)} ${mm(b)}) (layer "F.SilkS") (width ${SILK_WIDTH_MM}))`
        )
    );

  horizontal(-halfHeightMm);
  horizontal(halfHeightMm);
  vertical(-halfWidthMm);
  vertical(halfWidthMm);
  return lines;
}

/**
 * The fabrication outline: the body, with the pin-1 corner cut off.
 *
 * The chamfer is how every reference footprint marks pin 1 on `F.Fab`, and it is
 * the mark that survives assembly, since silkscreen is often covered by the
 * part. Pin 1 sits at the top of the left-hand side on both arrangements this
 * generator builds, so the cut is on the top-left corner.
 */
function fabricationOutline(geometry: FootprintGeometry): string {
  const { halfWidthMm: w, halfHeightMm: h } = geometry.body;
  const cut = Math.min(FAB_CHAMFER_MAX_MM, Math.min(w, h) * 2 * FAB_CHAMFER_FRACTION);
  const points = [
    [-w + cut, -h],
    [w, -h],
    [w, h],
    [-w, h],
    [-w, -h + cut]
  ];
  const pts = points.map(([x, y]) => `(xy ${mm(x)} ${mm(y)})`).join(" ");
  return `  (fp_poly (pts ${pts}) (layer "F.Fab") (width ${FAB_WIDTH_MM}) (fill none))`;
}

export function emitKicadFootprint(geometry: FootprintGeometry, links: KicadLinks = {}): string {
  const lines = [
    `(footprint "${kicadString(geometry.name)}"`,
    "  (version 20240108)",
    "  (generator Forge)",
    '  (layer "F.Cu")',
    `  (descr "${kicadString(geometry.description)}")`,
    // Search keywords. Every reference footprint carries them, and without them
    // the part is unfindable in KiCad's own footprint browser except by its
    // exact name.
    `  (tags "${kicadString([geometry.provenance.family, geometry.partNumber].join(" "))}")`,
    // How the part mounts, stated. KiCad treats a footprint with no `attr` as
    // through-hole: a surface-mount part without it lands in the wrong DRC
    // category and is excluded from the position file the assembler works from.
    geometry.pads.some((pad) => pad.mounting === "through-hole") ? "  (attr through_hole)" : "  (attr smd)",
    `  (property "Reference" "U" (at 0 ${mm(-geometry.body.halfHeightMm - 1.2)} 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))`,
    `  (property "Value" "${kicadString(geometry.partNumber)}" (at 0 ${mm(geometry.body.halfHeightMm + 1.2)} 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))`,
    // The designator again, inside the body on the fabrication layer, which is
    // where it is read when the silkscreen is hidden under the part.
    `  (fp_text user "\${REFERENCE}" (at 0 0 0) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))`,
    fabricationOutline(geometry),
    `  (fp_rect (start ${mm(-geometry.courtyard.halfWidthMm)} ${mm(-geometry.courtyard.halfHeightMm)}) (end ${mm(geometry.courtyard.halfWidthMm)} ${mm(geometry.courtyard.halfHeightMm)}) (layer "F.CrtYd") (width ${COURTYARD_WIDTH_MM}) (fill none))`,
    ...silkscreenOutline(geometry),
    `  (fp_circle (center ${mm(geometry.pin1Marker.xMm)} ${mm(geometry.pin1Marker.yMm)}) (end ${mm(geometry.pin1Marker.xMm + 0.15)} ${mm(geometry.pin1Marker.yMm)}) (layer "F.SilkS") (width ${SILK_WIDTH_MM}) (fill solid))`
  ];

  for (const pad of geometry.pads) {
    // A pad whose paste does not follow its copper is spelled as TWO things in
    // KiCad: the copper land on `F.Cu`/`F.Mask` with no paste layer, then one
    // paste-only pad per aperture. Emitting the land on `F.Paste` as well would
    // paste it 1:1, which on a thermal pad floats the package off its leads.
    if (pad.pasteApertures && pad.pasteApertures.length > 0) {
      // The copper land, marked as what it is.
      //
      // `pad_prop_heatsink` and `zone_connect 2` are both on KiCad's own
      // `VQFN-16-1EP_3x3mm_P0.5mm_EP1.68x1.68mm`. The first tells the tools this
      // terminal exists to move heat rather than to carry a signal; the second
      // makes a copper pour connect to it solidly instead of through the thermal
      // relief spokes a normal pad gets, which would undo the point of the pad.
      lines.push(
        `  (pad "${kicadString(pad.number)}" smd ${pad.shape} (at ${mm(pad.centre.xMm)} ${mm(pad.centre.yMm)}) (size ${mm(pad.widthMm)} ${mm(pad.heightMm)}) (property pad_prop_heatsink) (layers "F.Cu" "F.Mask")${maskMargin(pad)} (zone_connect 2) (roundrect_rratio 0.25))`
      );
      for (const aperture of pad.pasteApertures) {
        // An EMPTY pad number, which is how the reference library spells a
        // paste-only aperture. Repeating the thermal pad's number here made each
        // aperture a second terminal with that number, so a footprint with a 4x4
        // grid claimed seventeen copies of one pin and KiCad's own
        // duplicate-pad-number checks fired on a correct footprint.
        lines.push(
          `  (pad "" smd rect (at ${mm(aperture.centre.xMm)} ${mm(aperture.centre.yMm)}) (size ${mm(aperture.widthMm)} ${mm(aperture.heightMm)}) (layers "F.Paste"))`
        );
      }
      continue;
    }
    // A PLATED HOLE, which is a different primitive from a land.
    //
    // On every copper layer and every mask layer, with a drill, and with NO
    // paste: a through-hole joint is made by wave or by hand, and paste in the
    // hole does nothing but foul it. The reference `DIP-8_W7.62mm` spells it
    // exactly this way, down to `remove_unused_layers no`, which stops the
    // fabricator dropping the annular ring on inner layers the pin does not
    // connect to.
    if (pad.mounting === "through-hole") {
      // No `?? 0` here. A hole of zero is not a hole, and emitting one would turn
      // a generator bug into a board with unplated pads that looks fine in CAD.
      // The geometry always carries the drill; if it ever does not, that is worth
      // failing loudly for.
      if (!(pad.drillMm && pad.drillMm > 0)) {
        throw new Error(`Pad ${pad.number} is through-hole with no drill size, so no footprint is written.`);
      }
      lines.push(
        `  (pad "${kicadString(pad.number)}" thru_hole ${pad.shape} (at ${mm(pad.centre.xMm)} ${mm(pad.centre.yMm)}) ` +
          `(size ${mm(pad.widthMm)} ${mm(pad.heightMm)}) (drill ${mm(pad.drillMm)}) (layers "*.Cu" "*.Mask")` +
          `${maskMargin(pad)} (remove_unused_layers no)${pad.shape === "roundrect" ? " (roundrect_rratio 0.25)" : ""})`
      );
      continue;
    }
    lines.push(
      `  (pad "${kicadString(pad.number)}" smd ${pad.shape} (at ${mm(pad.centre.xMm)} ${mm(pad.centre.yMm)}) (size ${mm(pad.widthMm)} ${mm(pad.heightMm)}) (layers "F.Cu" "F.Paste" "F.Mask")${maskMargin(pad)}${pad.shape === "roundrect" ? " (roundrect_rratio 0.25)" : ""})`
    );
  }

  // Thermal vias, as the datasheet's own land pattern drawing dimensions them.
  //
  // Emitted with an EMPTY pad number on every copper layer, which is how KiCad
  // represents a via inside a footprint. They must not carry the thermal pad's
  // number: that would make each one a separate terminal in the netlist, and a
  // ratsnest of phantom connections is worse than no vias at all.
  for (const via of geometry.thermalVias) {
    // COPPER LAYERS ONLY, with no mask opening, which is the whole point.
    //
    // These vias sit inside a solder land. An open via in a land wicks paste
    // down the barrel during reflow, starving the joint and leaving voids under
    // the pad; the pad is there to move heat, and a voided one does not. Mask
    // over the via is what stops it, and it is why the layer list here is not
    // the `*.Cu *.Mask` a normal through-hole pad gets.
    lines.push(
      `  (pad "" thru_hole circle (at ${mm(via.centre.xMm)} ${mm(via.centre.yMm)}) ` +
        `(size ${mm(via.padMm)} ${mm(via.padMm)}) (drill ${mm(via.drillMm)}) (layers "*.Cu"))`
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
  // The body's own centre line, which is not always the origin. See
  // `SymbolGeometry.bodyCentreYMm`: the pins hold the 100 mil grid and the body
  // moves, rather than the other way round.
  const centreYMm = geometry.bodyCentreYMm;
  const topMm = centreYMm + halfHeightMm;
  const bottomMm = centreYMm - halfHeightMm;
  const name = kicadString(geometry.name);

  const lines = [
    "(kicad_symbol_lib",
    "  (version 20211014)",
    "  (generator Forge)",
    `  (symbol "${name}"`,
    "    (pin_names (offset 0.508))",
    "    (in_bom yes)",
    "    (on_board yes)",
    `    (property "Reference" "U" (at ${mm(-halfWidthMm)} ${mm(topMm + 2.54)} 0) (effects (font (size 1.27 1.27)) (justify left)))`,
    `    (property "Value" "${kicadString(geometry.partNumber)}" (at ${mm(-halfWidthMm)} ${mm(bottomMm - 2.54)} 0) (effects (font (size 1.27 1.27)) (justify left)))`
  ];

  // Hidden, like every other Footprint property: it is a link, not a label. With
  // it the footprint arrives attached when the symbol is placed; without it the
  // user assigns one by hand for every part.
  if (links.footprintRef) {
    lines.push(
      `    (property "Footprint" "${kicadString(links.footprintRef)}" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))`
    );
  }

  // The four properties that make a symbol findable and checkable.
  //
  // All hidden, as they are on every reference symbol: they are metadata for the
  // chooser and the reviewer, not labels for the schematic sheet.
  //
  // `Datasheet` is the one that matters most for this product. A record whose
  // pin names were read by a model is only trustworthy because someone can open
  // the page they came from, and the link travels with the symbol into whatever
  // library it ends up in.
  const hidden = (name: string, value: string) =>
    `    (property "${kicadString(name)}" "${kicadString(value)}" (at 0 0 0) (effects (font (size 1.27 1.27)) hide))`;
  if (geometry.datasheetUrl) lines.push(hidden("Datasheet", geometry.datasheetUrl));
  if (geometry.description) lines.push(hidden("Description", geometry.description));
  if (geometry.keywords) lines.push(hidden("ki_keywords", geometry.keywords));
  // Which footprints this symbol accepts, so KiCad's footprint assignment tool
  // offers the right ones. Derived from the footprint we ship rather than from a
  // pattern of package names, so it can never point at something absent.
  if (links.footprintRef) {
    lines.push(hidden("ki_fp_filters", links.footprintRef.split(":").pop() ?? links.footprintRef));
  }

  // The graphics and pins go in a unit sub-symbol named `<symbol>_<unit>_<style>`,
  // which is what KiCad itself writes. KiCad's parser does accept them at the
  // top level and files them under unit 1 either way, so this is not a
  // correctness fix. It is a compatibility one: a symbol with no unit reads as
  // having no units at all to other tools that consume `.kicad_sym`, and a
  // library that only KiCad understands is a library with a footgun in it.
  lines.push(`    (symbol "${name}_1_1"`);
  lines.push(
    `      (rectangle (start ${mm(-halfWidthMm)} ${mm(topMm)}) (end ${mm(halfWidthMm)} ${mm(bottomMm)}) (stroke (width 0.254) (type solid)) (fill (type background)))`
  );

  for (const pin of geometry.pins) {
    // A left-hand pin points right (0 degrees), a right-hand pin points left.
    const angle = pin.side === "left" ? 0 : 180;
    lines.push(
      `      (pin ${kicadPinType(pin.electricalType)} line (at ${mm(pin.anchor.xMm)} ${mm(pin.anchor.yMm)} ${angle}) (length ${mm(pin.lengthMm)}) (name "${kicadString(pin.name)}" (effects (font (size 1.27 1.27)))) (number "${kicadString(pin.number)}" (effects (font (size 1.27 1.27)))))`
    );
  }

  lines.push("    )", "  )", ")");
  return lines.join("\n");
}
