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
  courtyard: 71
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

/** Line widths for the drawn outlines, in mm. The same values the KiCad emitter uses. */
const SILKSCREEN_WIDTH_MM = 0.15;
const COURTYARD_WIDTH_MM = 0.05;
const DESIGNATOR_HEIGHT_MM = 1.0;

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
function padRecord(pad: Pad, seed: string): Buffer {
  const mounting: string = pad.mounting;
  if (mounting !== "smd") {
    throw new AltiumEmitError(
      `Pad ${pad.number} is ${mounting}; this generator writes surface-mount lands only and will not guess a hole size.`
    );
  }
  const shape: string = pad.shape;
  if (shape !== "roundrect") {
    throw new AltiumEmitError(`Pad ${pad.number} has shape "${shape}", which this generator cannot write.`);
  }
  if (!(pad.widthMm > 0) || !(pad.heightMm > 0)) {
    throw new AltiumEmitError(`Pad ${pad.number} has a non-positive size (${pad.widthMm} x ${pad.heightMm} mm).`);
  }

  const sizeX = toAltiumUnits(pad.widthMm);
  const sizeY = toAltiumUnits(pad.heightMm);

  // First block: layer, position, the three stacked sizes, base shapes.
  const main = Buffer.from(PAD_MAIN_TEMPLATE);
  main[0] = LAYER.topCopper;
  main.writeInt32LE(toAltiumUnits(pad.centre.xMm), 13);
  main.writeInt32LE(toAltiumY(pad.centre.yMm), 17);
  for (const offset of [21, 29, 37]) {
    main.writeInt32LE(sizeX, offset);
    main.writeInt32LE(sizeY, offset + 4);
  }
  main.writeInt32LE(0, 45); // no hole: this is a surface-mount land
  main.writeDoubleLE(0, 52); // no rotation: the land pattern is already axis-aligned
  main.writeUInt32LE(v7LayerId(LAYER.topCopper), 114);
  identityGuid(`${seed}:pad:${pad.number}`).copy(main, 126);
  identityGuid(`${seed}:stack`).copy(main, 142);

  // Second block: the per-layer size and shape stack. This is where the rounded
  // rectangle actually lives; the first block's base shape stays "round".
  const stack = Buffer.from(PAD_SIZE_SHAPE_TEMPLATE);
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
 * The solid is a box built from half-height Z coordinates, so the height is
 * twice the largest one. This parses what was written rather than taking the
 * dimension separately, so the body's declared height and its geometry cannot
 * disagree.
 */
function stepHeightMm(step: string): number {
  let maxZ = 0;
  for (const match of step.matchAll(/CARTESIAN_POINT\('',\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)\)/g)) {
    maxZ = Math.max(maxZ, Math.abs(Number(match[3])));
  }
  return Number.isFinite(maxZ) ? maxZ * 2 : 0;
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
function componentParamsTocStream(footprintName: string, padCount: number, description: string): Buffer {
  const line = `Name=${footprintName}|Pad Count=${padCount}|Height=0|Description=${description}\r\n`;
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
    ...geometry.pads.map((pad) => padRecord(pad, seed)),
    ...rectangleTracks(LAYER.topOverlay, geometry.body.halfWidthMm, geometry.body.halfHeightMm, SILKSCREEN_WIDTH_MM),
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
      ["HEIGHT", "0mil"],
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
  add("/Library/ComponentParamsTOC/Data", componentParamsTocStream(footprintName, geometry.pads.length, description));
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
