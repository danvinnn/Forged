/**
 * Altium `.PcbLib` generator.
 *
 * Reads `FootprintGeometry` and nothing else. It is a peer of the KiCad
 * generator, not a conversion of it: the two share the geometry and no bytes.
 * That distinction is the reason this file exists, because the code it replaces
 * wrote the KiCad s-expression text under an Altium-looking name.
 *
 * The container is an OLE compound file with this shape, which is what Altium
 * itself writes:
 *
 *     /FileHeader                      identifies the file as a PCB binary library
 *     /Library/Header                  record count
 *     /Library/Data                    library parameters, then the footprint names
 *     /Library/ComponentParamsTOC/*    the table of contents Altium shows in the panel
 *     /Library/{LayerKindMapping,PadViaLibrary,Models,ModelsNoEmbed,Textures}/*
 *     /Library/EmbeddedFonts
 *     /<footprint>/Header              primitive count
 *     /<footprint>/Parameters          pattern name, height, description
 *     /<footprint>/WideStrings         Unicode copies of the text primitives
 *     /<footprint>/Data                the primitives, terminated by record id 0
 *
 * Altium refuses a malformed library silently: no error, no diagnostic, the
 * library simply does not appear. So nothing here is trusted because it looks
 * right. Every field is checked by pyaltiumlib, an independent reader, in
 * `__tests__/altium-pcblib.test.ts`, and the undocumented byte runs come from
 * files Altium wrote (see `templates.ts`).
 */

import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { type FootprintGeometry, type Pad } from "../../geometry";
import { ByteWriter, parameterSafe, storageName } from "./binary";
import { writeCompoundFile, type CompoundEntry } from "./container";
import { layerStackParameters } from "./layers";
import { ARC_TEMPLATE, PAD_MAIN_TEMPLATE, PAD_SIZE_SHAPE_TEMPLATE, TEXT_TEMPLATE, TRACK_TEMPLATE } from "./templates";
import { AltiumEmitError, MM_PER_MIL, toAltiumUnits, toAltiumY } from "./units";

/**
 * Altium layer numbers.
 *
 * These are not derived. Every Altium-written `.PcbLib` carries a `LAYERnNAME`
 * table in its header indexed by exactly this byte, and it reads
 * `LAYER1NAME=Top Layer`, `LAYER33NAME=Top Overlay`, `LAYER71NAME=Mechanical 15`
 * in all 89 files of the corpus. See `layers.ts`, which now emits that table.
 *
 * Only the copper layer is a manufacturing instruction. The other two are where
 * the drawing goes, and those choices are conventions: silkscreen on Top Overlay
 * is universal, and Mechanical 15 is where Altium's own IPC footprint wizard puts
 * the courtyard, which is also where all eleven manufacturer-authored libraries
 * in the corpus put theirs.
 */
const LAYER = {
  topCopper: 1,
  topOverlay: 33,
  /**
   * Top Paste. Index 35 in the layer name table above, and the layer chain
   * points it at Top Layer, which is the pair Altium expects.
   *
   * Needed because an exposed thermal pad must NOT be pasted 1:1: the solder
   * volume under a large land floats the package and lifts the perimeter leads
   * off their lands. The pattern is a grid of smaller apertures, and this writer
   * used to refuse every part that had one.
   */
  topPaste: 35,
  courtyard: 71,
  /**
   * Multi-Layer, where a plated through hole lives.
   *
   * A through-hole pad is not on Top Layer: it passes through the board and
   * exists on every copper layer at once, which Altium models as its own layer
   * rather than as a property of a copper one.
   *
   * Read off a real library rather than inferred. The vendored reader's own
   * layer table says `74=MultiLayer`, and Ultra Librarian's LM7805CT-NOPB
   * `.PcbLib` in `test-data/` puts all three of its TO-220 pads on 74.
   */
  multiLayer: 74
} as const;

/** Record ids, from `pcblib/footprint.py`. */
const RECORD = {
  arc: 1,
  pad: 2,
  track: 4,
  text: 5,
  componentBody: 12
} as const;

/** Mechanical 1, which is where Altium puts a component body. */
const BODY_LAYER = 57;

/**
 * Line widths for the drawn outlines, in mm.
 *
 * 0.15 for silkscreen is Altium's own documented figure for a component outline
 * on Top Overlay, which is why it differs from the 0.12 the KiCad convention
 * uses. The courtyard width is the same in both.
 */
const SILKSCREEN_WIDTH_MM = 0.15;
const COURTYARD_WIDTH_MM = 0.05;
const DESIGNATOR_HEIGHT_MM = 1.0;

/**
 * Silkscreen placement, the same rule the KiCad emitter documents.
 *
 * The outline sits just outside the body, and it is cut back to clear the lands:
 * silk printed across a pad is covered by solder and unreadable, and both tools'
 * conventions say the outline must survive assembly. Expressed in terms of this
 * emitter's own line width rather than shared as a constant, because the two
 * generators are peers and neither imports the other.
 */
const SILK_BODY_OFFSET_MM = SILKSCREEN_WIDTH_MM / 2 + 0.05;
const SILK_TO_PAD_MM = 0.2 + SILKSCREEN_WIDTH_MM / 2;

/**
 * Derives the redundant "v7 layer id" that every primitive carries alongside its
 * layer byte. It has to agree with the layer or the primitive is inconsistent.
 * Encoding from AltiumSharp's `V7LayerId`, checked against the golden files.
 */
function v7LayerId(layer: number): number {
  if (layer === 32) return 0x0100ffff;
  if (layer >= 1 && layer <= 31) return 0x01000000 + layer;
  if (layer >= 39 && layer <= 54) return 0x01010000 + (layer - 38);
  if (layer >= 57 && layer <= 72) return 0x01020000 + (layer - 56);
  switch (layer) {
    case 33:
      return 0x01030006;
    case 34:
      return 0x01030007;
    case 35:
      return 0x01030008;
    case 36:
      return 0x01030009;
    case 37:
      return 0x0103000a;
    case 38:
      return 0x0103000b;
    case 55:
      return 0x0103000c;
    case 56:
      return 0x0103000d;
    case 73:
      return 0x0103000e;
    default:
      return 0x0103000f;
  }
}

/**
 * Identity values Altium stores on a pad.
 *
 * Derived from the library and pad rather than randomly generated, so exporting
 * the same part twice produces the same bytes. A file that differs run to run
 * cannot be diffed against the last one that was checked, and for a part that
 * ends up on flight hardware that is worth more than the novelty of a random
 * GUID.
 */
function identityGuid(seed: string): Buffer {
  const guid = Buffer.from(createHash("sha256").update(seed).digest().subarray(0, 16));
  guid[7] = (guid[7] & 0x0f) | 0x40;
  guid[8] = (guid[8] & 0x3f) | 0x80;
  return guid;
}

/** The library's eight-character identifier, from the same deterministic source. */
function libraryUniqueId(seed: string): string {
  const digest = createHash("sha256").update(`library:${seed}`).digest();
  let id = "";
  for (let index = 0; index < 8; index += 1) {
    id += String.fromCharCode(65 + (digest[index] % 26));
  }
  return id;
}

interface Point {
  xMm: number;
  yMm: number;
}

/** A pad, as Altium spells it: designator, two identity GUIDs, four blocks and a stack. */
function padRecord(
  pad: Pad,
  seed: string,
  options: { layer?: number; suppressPaste?: boolean; suppressMask?: boolean } = {}
): Buffer {
  // A PLATED THROUGH HOLE, which is a different primitive from a land.
  //
  // Everything this needs was read off a file Altium's own ecosystem wrote:
  // Ultra Librarian's LM7805CT-NOPB `.PcbLib`, checked in under `test-data/`.
  // Its three TO-220 pads read back as layer 74, base shapes 1/1/1 (Round),
  // a 47 mil hole in a 67 mil pad, plated, with no parser warnings. Those are
  // the four things that differ from a surface-mount land, and nothing here is
  // inferred from the format's documentation.
  const throughHole = pad.mounting === "through-hole";
  if (throughHole && !(pad.drillMm && pad.drillMm > 0)) {
    throw new AltiumEmitError(
      `Pad ${pad.number} is through-hole with no drill size. A hole of zero is not a hole, and writing one would produce unplated pads that look correct on screen.`
    );
  }
  const layer = options.layer ?? (throughHole ? LAYER.multiLayer : LAYER.topCopper);
  const shape: string = pad.shape;
  if (shape !== "roundrect" && shape !== "circle") {
    throw new AltiumEmitError(`Pad ${pad.number} has shape "${shape}", which this generator cannot write.`);
  }
  if (!(pad.widthMm > 0) || !(pad.heightMm > 0)) {
    throw new AltiumEmitError(`Pad ${pad.number} has a non-positive size (${pad.widthMm} x ${pad.heightMm} mm).`);
  }

  const sizeX = toAltiumUnits(pad.widthMm);
  const sizeY = toAltiumUnits(pad.heightMm);

  // First block: layer, position, the three stacked sizes, base shapes.
  const main = Buffer.from(PAD_MAIN_TEMPLATE);
  main[0] = layer;
  main.writeInt32LE(toAltiumUnits(pad.centre.xMm), 13);
  main.writeInt32LE(toAltiumY(pad.centre.yMm), 17);
  for (const offset of [21, 29, 37]) {
    main.writeInt32LE(sizeX, offset);
    main.writeInt32LE(sizeY, offset + 4);
  }
  // The hole. Zero for a land, the finished drill for a through-hole pad.
  main.writeInt32LE(throughHole ? toAltiumUnits(pad.drillMm as number) : 0, 45);
  // The three base shapes at 49-51. The template ships 1 (Round), which is also
  // how Altium encodes a ROUNDED RECTANGLE: the base stays round and the real
  // shape lives in the per-layer stack below. A round through-hole pad wants
  // Round in both places, which is what the reference file shows.
  main.writeDoubleLE(0, 52); // no rotation: the land pattern is already axis-aligned
  // PLATED, at offset 60. Derived from the reader's own field order rather than
  // guessed: 13 common + 8 location + 24 sizes + 4 hole + 3 shapes + 8 rotation.
  // Without it the hole is written but read back as unplated, which is a hole
  // with no copper in the barrel: mechanically present, electrically absent.
  if (throughHole) main[60] = 1;

  // The solder mask clearance the DATASHEET stated, where it stated one.
  //
  // Two fields, and both are needed: the value at 94, and the "manual" flag at
  // 106 that tells Altium to use it instead of the rule from the board's design
  // rules. Writing the value without the flag stores a number Altium ignores.
  //
  // Offsets are from the byte map in ALTIUM.md and check out against the three
  // this file already writes blind: hole_size at 45, rotation at 52 and the v7
  // layer id at 114 all fall exactly where that map puts them.
  //
  // Left untouched when the datasheet said nothing, so the board's own rule
  // applies. That is a different instruction from a clearance of zero, and the
  // KiCad emitter draws the same distinction.
  if (pad.solderMaskMarginMm !== undefined) {
    main.writeInt32LE(toAltiumUnits(pad.solderMaskMarginMm), 94);
    main[106] = 1;
  }

  // Paste is suppressed on the copper pad when the apertures are drawn
  // separately, so the two do not both contribute solder. A large negative
  // expansion shrinks the paste opening away; the manual flag at 105 is what
  // makes Altium use it instead of the board rule.
  if (options.suppressPaste) {
    main.writeInt32LE(-toAltiumUnits(10), 90);
    main[105] = 1;
  }

  // TENTED, for a thermal via. Same mechanism as the paste suppression above,
  // one field over: the value at 94 with the manual flag at 106, which this
  // writer already uses for the datasheet's own mask clearance.
  //
  // A via inside a solder land must be covered. An open barrel wicks paste down
  // during reflow, starving the joint and leaving voids under the pad that is
  // there to move heat. The KiCad emitter says the same thing and expresses it
  // by writing the via on copper layers with no mask layer at all; Altium has no
  // per-pad layer list, so the opening is closed instead.
  if (options.suppressMask) {
    main.writeInt32LE(-toAltiumUnits(10), 94);
    main[106] = 1;
  }
  main.writeUInt32LE(v7LayerId(layer), 114);
  identityGuid(`${seed}:pad:${pad.number}`).copy(main, 126);
  identityGuid(`${seed}:stack`).copy(main, 142);

  // Second block: the per-layer size and shape stack. This is where the rounded
  // rectangle actually lives; the first block's base shape stays "round".
  const stack = Buffer.from(PAD_SIZE_SHAPE_TEMPLATE);
  // The per-layer shapes ship as 9 (rounded rectangle). A circular pad overrides
  // them to 1 (Round), matching the reference file, whose pads read back as
  // 1/1/1 on every layer.
  if (shape === "circle") {
    for (let entry = 0; entry < 32; entry += 1) stack[532 + entry] = 1;
  }
  for (let layer = 0; layer < 29; layer += 1) {
    stack.writeInt32LE(sizeX, layer * 4);
    stack.writeInt32LE(sizeY, 116 + layer * 4);
  }
  stack.writeInt32LE(sizeX, 641);
  stack.writeInt32LE(sizeY, 645);

  return new ByteWriter()
    .u8(RECORD.pad)
    .stringBlock(pad.number)
    .block(Buffer.from([0]))
    .stringBlock("|&|0")
    .block(Buffer.from([0]))
    .block(main)
    .block(stack)
    .toBuffer();
}

function trackRecord(layer: number, from: Point, to: Point, widthMm: number): Buffer {
  const block = Buffer.from(TRACK_TEMPLATE);
  block[0] = layer;
  block.writeInt32LE(toAltiumUnits(from.xMm), 13);
  block.writeInt32LE(toAltiumY(from.yMm), 17);
  block.writeInt32LE(toAltiumUnits(to.xMm), 21);
  block.writeInt32LE(toAltiumY(to.yMm), 25);
  block.writeInt32LE(toAltiumUnits(widthMm), 29);
  block.writeUInt32LE(v7LayerId(layer), 41);
  return new ByteWriter().u8(RECORD.track).block(block).toBuffer();
}

/** The four sides of a rectangle, as tracks. Altium has no rectangle primitive. */
function rectangleTracks(layer: number, halfWidthMm: number, halfHeightMm: number, widthMm: number): Buffer[] {
  const left = -halfWidthMm;
  const right = halfWidthMm;
  const top = -halfHeightMm;
  const bottom = halfHeightMm;
  const corners: Point[] = [
    { xMm: left, yMm: top },
    { xMm: right, yMm: top },
    { xMm: right, yMm: bottom },
    { xMm: left, yMm: bottom }
  ];
  return corners.map((corner, index) => trackRecord(layer, corner, corners[(index + 1) % corners.length], widthMm));
}

/**
 * The silkscreen body outline, cut back to clear the pads.
 *
 * Altium's own convention is the same as KiCad's: silk goes on Top Overlay and
 * must be visible after assembly, which means it does not run across a land. This
 * emitter drew a plain body rectangle, so on any package whose lands overhang the
 * body, which is every gull-wing package, the outline ran straight through the
 * copper.
 *
 * The rule and the clearances are the ones the KiCad emitter documents against
 * the reference library, applied here rather than reimplemented differently. The
 * two generators are peers and neither derives from the other, but a convention
 * read off a published library is a fact about libraries, not about KiCad.
 */
function silkscreenTracks(geometry: FootprintGeometry): Buffer[] {
  const halfWidth = geometry.body.halfWidthMm + SILK_BODY_OFFSET_MM;
  const halfHeight = geometry.body.halfHeightMm + SILK_BODY_OFFSET_MM;
  if (!(halfWidth > 0) || !(halfHeight > 0)) return [];

  const blockers = geometry.pads.map((pad) => ({
    x0: pad.centre.xMm - pad.widthMm / 2 - SILK_TO_PAD_MM,
    x1: pad.centre.xMm + pad.widthMm / 2 + SILK_TO_PAD_MM,
    y0: pad.centre.yMm - pad.heightMm / 2 - SILK_TO_PAD_MM,
    y1: pad.centre.yMm + pad.heightMm / 2 + SILK_TO_PAD_MM
  }));

  const tracks: Buffer[] = [];
  const edge = (
    from: number,
    to: number,
    crossing: Array<{ lo: number; hi: number }>,
    draw: (a: number, b: number) => void
  ) => {
    if (crossing.length === 0) {
      draw(from, to);
      return;
    }
    const lo = Math.min(...crossing.map((span) => span.lo));
    const hi = Math.max(...crossing.map((span) => span.hi));
    if (lo > from) draw(from, Math.min(lo, to));
    if (hi < to) draw(Math.max(hi, from), to);
  };

  // An edge the pads ENGULF is moved clear rather than deleted, to whichever
  // side sits closer to where the body actually is. Without this a through-hole
  // package gets no outline at all: its holes sit outside the body on one axis
  // and past its ends on the other, so every edge crosses a pad and clipping
  // erases all four. The KiCad emitter documents the same rule and the same
  // reference measurement.
  const survives = (at: number, from: number, to: number, along: "x" | "y") => {
    const crossing = blockers
      .filter((pad) => (along === "x" ? pad.y0 < at && pad.y1 > at : pad.x0 < at && pad.x1 > at))
      .map((pad) => (along === "x" ? { lo: pad.x0, hi: pad.x1 } : { lo: pad.y0, hi: pad.y1 }));
    if (crossing.length === 0) return true;
    return Math.min(...crossing.map((s) => s.lo)) > from || Math.max(...crossing.map((s) => s.hi)) < to;
  };
  const clearOf = (at: number, spans: Array<{ lo: number; hi: number }>) => {
    const crossing = spans.filter((span) => span.lo < at && span.hi > at);
    if (crossing.length === 0) return at;
    const inward = Math.max(...crossing.map((span) => span.hi));
    const outward = Math.min(...crossing.map((span) => span.lo));
    return Math.abs(at - outward) <= Math.abs(at - inward) ? outward : inward;
  };

  const spansY = blockers.map((pad) => ({ lo: pad.y0, hi: pad.y1 }));
  const spansX = blockers.map((pad) => ({ lo: pad.x0, hi: pad.x1 }));
  const top = survives(-halfHeight, -halfWidth, halfWidth, "x") ? -halfHeight : clearOf(-halfHeight, spansY);
  const bottom = survives(halfHeight, -halfWidth, halfWidth, "x") ? halfHeight : clearOf(halfHeight, spansY);
  const left = survives(-halfWidth, -halfHeight, halfHeight, "y") ? -halfWidth : clearOf(-halfWidth, spansX);
  const right = survives(halfWidth, -halfHeight, halfHeight, "y") ? halfWidth : clearOf(halfWidth, spansX);

  for (const y of [top, bottom]) {
    edge(
      left,
      right,
      blockers.filter((pad) => pad.y0 < y && pad.y1 > y).map((pad) => ({ lo: pad.x0, hi: pad.x1 })),
      (a, b) => tracks.push(trackRecord(LAYER.topOverlay, { xMm: a, yMm: y }, { xMm: b, yMm: y }, SILKSCREEN_WIDTH_MM))
    );
  }
  for (const x of [left, right]) {
    edge(
      top,
      bottom,
      blockers.filter((pad) => pad.x0 < x && pad.x1 > x).map((pad) => ({ lo: pad.y0, hi: pad.y1 })),
      (a, b) => tracks.push(trackRecord(LAYER.topOverlay, { xMm: x, yMm: a }, { xMm: x, yMm: b }, SILKSCREEN_WIDTH_MM))
    );
  }
  return tracks;
}

/** A full circle, used for the pin-1 dot. Altium draws circles as 0 to 360 degree arcs. */
function circleRecord(layer: number, centre: Point, radiusMm: number, widthMm: number): Buffer {
  const block = Buffer.from(ARC_TEMPLATE);
  block[0] = layer;
  block.writeInt32LE(toAltiumUnits(centre.xMm), 13);
  block.writeInt32LE(toAltiumY(centre.yMm), 17);
  block.writeInt32LE(toAltiumUnits(radiusMm), 21);
  block.writeDoubleLE(0, 25);
  block.writeDoubleLE(360, 33);
  block.writeInt32LE(toAltiumUnits(widthMm), 41);
  block.writeUInt32LE(v7LayerId(layer), 52);
  return new ByteWriter().u8(RECORD.arc).block(block).toBuffer();
}

/**
 * A text primitive. Altium anchors PCB text at the bottom left of the string, so
 * the caller passes that corner rather than a centre.
 */
function textRecord(
  layer: number,
  text: string,
  corner: Point,
  heightMm: number,
  strokeWidthMm: number,
  wideStringIndex: number
): Buffer {
  const block = Buffer.from(TEXT_TEMPLATE);
  block[0] = layer;
  block.writeInt32LE(toAltiumUnits(corner.xMm), 13);
  block.writeInt32LE(toAltiumY(corner.yMm), 17);
  block.writeInt32LE(toAltiumUnits(heightMm), 21);
  block.writeUInt16LE(0, 25); // the default stroke font, which needs nothing embedded
  block.writeDoubleLE(0, 27);
  block.writeInt32LE(toAltiumUnits(strokeWidthMm), 36);
  block.writeInt32LE(wideStringIndex, 115);
  // The text frame. Altium recomputes it when it lays the string out; it is
  // filled in so a reader asking for the extent of this primitive gets an
  // answer of roughly the right size rather than a degenerate box.
  block.writeInt32LE(toAltiumUnits(estimatedTextWidthMm(text, heightMm)), 124);
  block.writeInt32LE(toAltiumUnits(heightMm), 128);
  block.writeUInt32LE(v7LayerId(layer), 226);
  return new ByteWriter().u8(RECORD.text).block(block).stringBlock(text).toBuffer();
}

/** Stroke-font characters are about six tenths as wide as they are tall. */
function estimatedTextWidthMm(text: string, heightMm: number): number {
  return text.length * heightMm * 0.6;
}

/**
 * Altium's checksum over an embedded 3D model: a position-weighted byte sum of
 * the uncompressed STEP text, where byte 0 weighs 1 and byte i weighs i.
 *
 * Reverse-engineered rather than documented, so it is checked rather than
 * trusted: run against the STEP inside Altium's own `BODY_3D_STEP.PcbLib` it
 * reproduces the 1468567647 that file stores.
 */
function modelChecksum(step: Buffer): number {
  let checksum = 0;
  for (let index = 0; index < step.length; index += 1) {
    checksum = (checksum + step[index] * (index === 0 ? 1 : index)) >>> 0;
  }
  return checksum;
}

/**
 * The component body: the record that ties the footprint to an embedded 3D
 * model, on Mechanical 1 where Altium puts one.
 *
 * The parameter keys and their exact formatting come from a body Altium wrote.
 * `MODELID` has to match the model's id in `/Library/Models/Data` or the body
 * references nothing, and `MODEL.CHECKSUM` has to match the model's or Altium
 * treats the embedded payload as stale.
 */
function componentBodyRecord(
  modelId: string,
  modelName: string,
  checksum: number,
  heightMm: number,
  outline: Point[]
): Buffer {
  const mil = (millimetres: number) => `${Number((millimetres / MM_PER_MIL).toFixed(4))}mil`;

  const parameters = [
    ["V7_LAYER", "MECHANICAL1"],
    ["NAME", " "],
    ["KIND", "0"],
    ["SUBPOLYINDEX", "-1"],
    ["UNIONINDEX", "0"],
    ["ARCRESOLUTION", "0.5mil"],
    ["ISSHAPEBASED", "FALSE"],
    ["CAVITYHEIGHT", "0mil"],
    ["STANDOFFHEIGHT", "0mil"],
    ["OVERALLHEIGHT", mil(heightMm)],
    ["BODYPROJECTION", "0"],
    ["ARCRESOLUTION", "0.5mil"],
    ["BODYCOLOR3D", "8421504"],
    ["BODYOPACITY3D", "1.000"],
    ["IDENTIFIER", ""],
    ["TEXTURE", ""],
    ["TEXTURECENTERX", "0mil"],
    ["TEXTURECENTERY", "0mil"],
    ["TEXTURESIZEX", "0mil"],
    ["TEXTURESIZEY", "0mil"],
    ["TEXTUREROTATION", " 0.00000000000000E+0000"],
    ["MODELID", modelId],
    ["MODEL.CHECKSUM", String(checksum)],
    ["MODEL.EMBED", "TRUE"],
    ["MODEL.NAME", modelName],
    ["MODEL.2D.X", "0mil"],
    ["MODEL.2D.Y", "0mil"],
    ["MODEL.2D.ROTATION", "0.000"],
    ["MODEL.3D.ROTX", "0.000"],
    ["MODEL.3D.ROTY", "0.000"],
    ["MODEL.3D.ROTZ", "0.000"],
    ["MODEL.3D.DZ", "0mil"],
    ["MODEL.MODELTYPE", "1"],
    ["MODEL.MODELSOURCE", "Undefined"]
  ] as Array<[string, string]>;

  // ARCRESOLUTION appears twice, which is what Altium writes, so the parameter
  // text is built by hand rather than through a map that would drop one.
  const text = parameters.map(([key, value]) => `|${key}=${value}`).join("").slice(1);
  const payload = Buffer.concat([Buffer.from(text, "latin1"), Buffer.from([0])]);

  const body = new ByteWriter()
    .bytes(commonHeader(BODY_LAYER))
    .u32(0)
    .u8(0)
    .block(payload)
    .u32(outline.length);
  // Outline vertices are doubles holding internal units, not coordinates.
  for (const point of outline) {
    body.double(toAltiumUnits(point.xMm)).double(toAltiumY(point.yMm));
  }

  return new ByteWriter().u8(RECORD.componentBody).block(body.toBuffer()).toBuffer();
}

/**
 * The 13-byte header every primitive starts with: layer, flags, then ten 0xFF
 * bytes that both readers check for.
 */
function commonHeader(layer: number): Buffer {
  const header = Buffer.alloc(13, 0xff);
  header[0] = layer;
  header[1] = 0x0c; // unlocked, and the bit Altium sets on everything it saves
  header[2] = 0x00;
  return header;
}

/** `/Library/Models/Data`: one parameter block per embedded model. */
function modelsDataStream(modelId: string, modelName: string, checksum: number): Buffer {
  // No leading separator on this one, unlike every other parameter block in the
  // format. That is how Altium writes it.
  const text = [
    `EMBED=TRUE`,
    `MODELSOURCE=Undefined`,
    `ID=${modelId}`,
    `ROTX=0.000`,
    `ROTY=0.000`,
    `ROTZ=0.000`,
    `DZ=0`,
    `CHECKSUM=${checksum}`,
    `NAME=${modelName}`
  ].join("|");
  return new ByteWriter().block(Buffer.concat([Buffer.from(text, "latin1"), Buffer.from([0])])).toBuffer();
}


/**
 * Prepares an embedded model: a stable id, the compressed payload, and the
 * checksum both the model store and the body record have to agree on.
 *
 * The height is what the body stands proud of the board, and it is taken from
 * the STEP itself rather than invented: the solid we generate is a box, so its
 * Z extent is the package height. If the text does not yield one, the body is
 * still written with a zero height rather than a guessed one.
 */
function buildModel(step: { name: string; text: string }, seed: string) {
  const text = Buffer.from(step.text, "utf8");
  const guid = identityGuid(`${seed}:model`).toString("hex").toUpperCase();
  const id = `{${guid.slice(0, 8)}-${guid.slice(8, 12)}-${guid.slice(12, 16)}-${guid.slice(16, 20)}-${guid.slice(20, 32)}}`;
  return {
    id,
    name: step.name,
    checksum: modelChecksum(text),
    compressed: deflateSync(text, { level: 9 }),
    heightMm: stepHeightMm(step.text)
  };
}

/**
 * Reads the package height back out of the STEP text.
 *
 * The solid's Z EXTENT, which is what "stands proud of the board" means.
 *
 * This used to double the largest absolute Z, because the box was built
 * symmetrically about zero and half of it was therefore below the board. That
 * was corrected on 2026-08-14: the body now sits on the board plane, spanning 0
 * to the package height, and doubling the maximum would report twice the real
 * height. Measuring the extent is right either way and does not care which
 * convention the solid uses.
 *
 * This parses what was written rather than taking the dimension separately, so
 * the body's declared height and its geometry cannot disagree.
 */
function stepHeightMm(step: string): number {
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const match of step.matchAll(/CARTESIAN_POINT\('',\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)\)/g)) {
    const z = Number(match[3]);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return Number.isFinite(minZ) && Number.isFinite(maxZ) ? maxZ - minZ : 0;
}

/**
 * `/Library/Data`: the library parameters, then a count and one name per footprint.
 *
 * The layer table is not decoration. A mechanical layer that the document does
 * not enable is not drawn, and Altium's default enables Mechanical 1 alone, so
 * without this the courtyard on Mechanical 15 would be present in the file and
 * invisible on screen. See `layers.ts`.
 */
function libraryDataStream(footprintName: string): Buffer {
  return new ByteWriter()
    .parameterBlock([
      ["HEADER", "PCB 6.0 Binary Library File"],
      ["KIND", "Protel_Advanced_PCB_Library"],
      ["VERSION", "3.00"],
      ...layerStackParameters([BODY_LAYER, LAYER.courtyard])
    ])
    .u32(1)
    .stringBlock(footprintName)
    .toBuffer();
}

/**
 * `/FileHeader`. Not a block like everything else: a uint32 count, then a Pascal
 * string, then the format version as a bare double, then the library's id.
 * pyaltiumlib requires the string to contain "PCB" and "Binary Library File" or
 * it will not identify the file at all.
 */
function fileHeaderStream(uniqueId: string): Buffer {
  const version = "PCB 6.0 Binary Library File";
  return new ByteWriter()
    .u32(version.length)
    .bytes(pascal(version))
    .double(5.01)
    .u32(uniqueId.length)
    .bytes(pascal(uniqueId))
    .toBuffer();
}

function pascal(value: string): Buffer {
  const encoded = Buffer.from(value, "latin1");
  return Buffer.concat([Buffer.from([encoded.length]), encoded]);
}

function u32Stream(value: number): Buffer {
  return new ByteWriter().u32(value).toBuffer();
}

/** The panel's table of contents. One `\r\n`-terminated line per footprint. */
function componentParamsTocStream(
  footprintName: string,
  padCount: number,
  description: string,
  /**
   * How far the part stands off the board, in millimetres.
   *
   * Altium shows this in the library panel and uses it for height-clearance
   * checks against mechanical keep-outs. It was hardcoded to 0 while the same
   * height was already being computed for the 3D body two functions away, so the
   * panel reported every part as flat and any height rule passed everything.
   */
  heightMm: number
): Buffer {
  const line = `Name=${footprintName}|Pad Count=${padCount}|Height=${heightMm.toFixed(3)}|Description=${description}\r\n`;
  const payload = Buffer.concat([Buffer.from(line, "latin1"), Buffer.from([0])]);
  return new ByteWriter().block(payload).toBuffer();
}

/** `/Library/LayerKindMapping/Data`: a format version, then an empty mapping table. */
function layerKindMappingStream(): Buffer {
  const version = Buffer.concat([Buffer.from("1.0", "utf16le"), Buffer.from([0, 0])]);
  return new ByteWriter().block(version).u32(0).u32(0).toBuffer();
}

function padViaLibraryStream(seed: string): Buffer {
  const digest = createHash("sha256").update(`padvia:${seed}`).digest("hex").toUpperCase();
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
  return new ByteWriter()
    .parameterBlock([
      ["PADVIALIBRARY.LIBRARYID", `{${id}}`],
      ["PADVIALIBRARY.LIBRARYNAME", "<Local>"],
      ["PADVIALIBRARY.DISPLAYUNITS", "1"]
    ])
    .toBuffer();
}

/**
 * Builds the `.PcbLib` for one footprint.
 *
 * Refuses rather than approximating. A footprint that cannot be written
 * correctly fails the export; there is no partial library, because a library
 * that opens and is subtly wrong is worse than one that never arrived.
 */
export interface AltiumFootprintExtras {
  /**
   * The package body as STEP Part 21 text, embedded in the library so the one
   * file carries copper and solid together. Without it the user attaches the
   * 3D model by hand, once per part, which is the same friction the footprint
   * link removes on the schematic side.
   */
  stepModel?: { name: string; text: string };
}

export function emitAltiumPcbLib(geometry: FootprintGeometry, extras: AltiumFootprintExtras = {}): Buffer {
  // A pad whose paste must not follow its copper cannot be spelled in this
  // writer yet, and emitting it as an ordinary pad would paste a thermal land
  // 1:1: the solder volume floats the package and lifts the perimeter leads off
  // their lands. Refusing is the only honest option, because the file would look
  // correct in Altium and fail at reflow.

  if (geometry.pads.length === 0) {
    throw new AltiumEmitError(`Footprint "${geometry.name}" has no pads, so there is nothing to fabricate from.`);
  }

  const footprintName = parameterSafe(geometry.name);
  const description = parameterSafe(geometry.description);
  const storage = storageName(footprintName);
  const seed = `${footprintName}|${geometry.partNumber}`;

  const designator = ".Designator";
  // Above the courtyard, so it never sits on a pad. Geometry is +y down, so up
  // the page is the more negative y.
  const designatorCorner: Point = {
    xMm: -estimatedTextWidthMm(designator, DESIGNATOR_HEIGHT_MM) / 2,
    yMm: -(geometry.courtyard.halfHeightMm + DESIGNATOR_HEIGHT_MM * 0.4)
  };

  const records: Buffer[] = [
    // Copper. A pad carrying its own paste apertures has paste suppressed here
    // and drawn below, so the thermal land is not pasted solid.
    ...geometry.pads.map((pad) =>
      padRecord(pad, seed, { suppressPaste: (pad.pasteApertures?.length ?? 0) > 0 })
    ),
    // The apertures themselves, on Top Paste. Emitted as pads because that is
    // the only primitive this writer has and it is what Altium reads back.
    ...geometry.pads.flatMap((pad) =>
      (pad.pasteApertures ?? []).map((aperture, index) =>
        padRecord(
          {
            number: "",
            centre: aperture.centre,
            widthMm: aperture.widthMm,
            heightMm: aperture.heightMm,
            shape: "roundrect",
            mounting: "smd"
          },
          `${seed}:paste:${pad.number}:${index}`,
          { layer: LAYER.topPaste }
        )
      )
    ),
    // Thermal vias, where the datasheet dimensioned them.
    //
    // A VIA IS A HOLE. This wrote them as `mounting: "smd"` with no drill, so
    // `padRecord` stored a hole size of zero and left the plated flag clear:
    // every via came out a solid disc of copper on the top layer. A via with no
    // barrel conducts no heat into the board, which is the entire reason the
    // datasheet dimensions them, and it is invisible on screen because the pad
    // is there and the right size.
    //
    // The KiCad emitter has always written these as plated holes on every copper
    // layer. This is the same via, spelled the way Altium spells it: Multi-Layer
    // by `padRecord`, round like the drill, and tented so the barrel does not
    // wick paste out of the joint above it.
    //
    // The test that covered this asserted only that the bytes differed from a
    // footprint with no vias, which a solid copper disc satisfies perfectly.
    ...geometry.thermalVias.map((via, index) =>
      padRecord(
        {
          number: "",
          centre: via.centre,
          widthMm: via.padMm,
          heightMm: via.padMm,
          shape: "circle",
          mounting: "through-hole",
          drillMm: via.drillMm
        },
        `${seed}:via:${index}`,
        { suppressMask: true }
      )
    ),
    ...silkscreenTracks(geometry),
    ...rectangleTracks(
      LAYER.courtyard,
      geometry.courtyard.halfWidthMm,
      geometry.courtyard.halfHeightMm,
      COURTYARD_WIDTH_MM
    ),
    // Without a pin-1 marker a correct footprint can be placed rotated.
    circleRecord(LAYER.topOverlay, geometry.pin1Marker, SILKSCREEN_WIDTH_MM, SILKSCREEN_WIDTH_MM * 2),
    textRecord(LAYER.topOverlay, designator, designatorCorner, DESIGNATOR_HEIGHT_MM, SILKSCREEN_WIDTH_MM, 0)
  ];

  // The 3D body, embedded rather than referenced. The model id ties the body
  // record to the model store, and the checksum ties both to these exact bytes.
  const model = extras.stepModel ? buildModel(extras.stepModel, seed) : null;
  if (model) {
    records.push(
      componentBodyRecord(model.id, model.name, model.checksum, model.heightMm, [
        { xMm: -geometry.body.halfWidthMm, yMm: -geometry.body.halfHeightMm },
        { xMm: geometry.body.halfWidthMm, yMm: -geometry.body.halfHeightMm },
        { xMm: geometry.body.halfWidthMm, yMm: geometry.body.halfHeightMm },
        { xMm: -geometry.body.halfWidthMm, yMm: geometry.body.halfHeightMm }
      ])
    );
  }

  // No terminator byte. Every Altium-written footprint stream ends the instant
  // its last record ends, and a trailing 0x00 is read as an unknown primitive id
  // by a strict reader, which then tries to skip a block that is not there and
  // rejects the whole library. pyaltiumlib happens to stop on a zero id, which is
  // why this looked correct for so long.
  const data = new ByteWriter().stringBlock(footprintName);
  for (const record of records) data.bytes(record);

  const parameters = new ByteWriter()
    .parameterBlock([
      ["PATTERN", footprintName],
      // The real height, in the SECOND place the format stores it.
      //
      // `componentParamsTocStream` carries the same number and its own note
      // records why: hardcoded to zero, the panel reports every part as flat and
      // any height-clearance rule against a mechanical keep-out passes
      // everything. That was found and fixed there, and this copy was left at
      // `0mil`, so the defect survived in one of the two places the format asks
      // for it. Altium reads this one as the footprint's own property.
      ["HEIGHT", `${Number(((model?.heightMm ?? 0) / MM_PER_MIL).toFixed(4))}mil`],
      ["DESCRIPTION", description],
      ["ITEMGUID", ""],
      ["REVISIONGUID", ""]
    ])
    .toBuffer();

  // The Unicode copy of every text primitive, in the order they were written.
  const wideStrings = new ByteWriter()
    .parameterBlock([["ENCODEDTEXT0", [...designator].map((character) => character.charCodeAt(0)).join(",")]])
    .toBuffer();

  const streams: CompoundEntry[] = [];
  const add = (path: string, content: Buffer) => {
    streams.push([path, content]);
  };

  add("/FileHeader", fileHeaderStream(libraryUniqueId(seed)));
  add("/Library/Header", u32Stream(1));
  add("/Library/Data", libraryDataStream(footprintName));
  add("/Library/ComponentParamsTOC/Header", u32Stream(1));
  add(
    "/Library/ComponentParamsTOC/Data",
    componentParamsTocStream(footprintName, geometry.pads.length, description, model?.heightMm ?? 0)
  );
  add("/Library/LayerKindMapping/Header", u32Stream(1));
  add("/Library/LayerKindMapping/Data", layerKindMappingStream());
  add("/Library/PadViaLibrary/Header", u32Stream(0));
  add("/Library/PadViaLibrary/Data", padViaLibraryStream(seed));
  if (model) {
    add("/Library/Models/Header", u32Stream(1));
    add("/Library/Models/Data", modelsDataStream(model.id, model.name, model.checksum));
    // Numbered per model, holding the STEP text zlib-compressed.
    add("/Library/Models/0", model.compressed);
  } else {
    add("/Library/Models/Header", u32Stream(0));
    add("/Library/Models/Data", Buffer.alloc(0));
  }
  for (const empty of ["ModelsNoEmbed", "Textures"]) {
    add(`/Library/${empty}/Header`, u32Stream(0));
    add(`/Library/${empty}/Data`, Buffer.alloc(0));
  }
  add("/Library/EmbeddedFonts", u32Stream(0));

  add(`/${storage}/Header`, u32Stream(records.length));
  add(`/${storage}/Parameters`, parameters);
  add(`/${storage}/WideStrings`, wideStrings);
  add(`/${storage}/Data`, data.toBuffer());

  // Altium maps a footprint whose name does not survive truncation back to its
  // storage through this stream. Written only when the two differ, which is
  // also when Altium writes it.
  if (storage !== footprintName) {
    add(
      "/SectionKeys",
      new ByteWriter().u32(1).stringBlock(footprintName).stringBlock(storage).toBuffer()
    );
  }

  return writeCompoundFile(streams);
}
