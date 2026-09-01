/**
 * Altium `.SchLib` generator.
 *
 * The schematic library is a different format from the footprint library, not a
 * variation on it. The container is the same OLE compound file, but a symbol is
 * a stream of records framed as `[uint16 length][uint16 big-endian type]`, where
 * type 0 is a `|KEY=VALUE` parameter record and type 1 is a binary pin.
 *
 * Two conventions are worth stating because they are not guessable and both come
 * from reading libraries Altium wrote:
 *
 *  - Schematic coordinates are in units of 10 mil (0.254 mm), Y counting up.
 *    Pins have to land on that grid or a wire cannot attach to them, so an
 *    off-grid symbol is refused rather than nudged.
 *  - A pin's stored location is the end that touches the body, and the pin
 *    extends outward from there by its length. The `flipped` flag is what makes
 *    a pin extend to the left. Altium's own files place left-hand pins at the
 *    body's left edge with that flag set, and pyaltiumlib's label placement
 *    agrees, which is what settles it.
 *
 * Checked by pyaltiumlib in `__tests__/altium-schlib.test.ts`, for the same
 * reason as the footprint library: Altium says nothing when it refuses a file.
 */

import { createHash } from "node:crypto";
import { type SymbolGeometry, type SymbolPin } from "../../geometry";
import { type PinElectricalType } from "../../types";
import { ByteWriter, encodeAltiumText, parameterSafe, storageName } from "./binary";
import { writeCompoundFile } from "./container";
import { AltiumEmitError } from "./units";

/** One schematic unit is 10 mil. The whole format counts in these. */
const MM_PER_SCHEMATIC_UNIT = 0.254;

/**
 * How far a coordinate may sit off the schematic grid before the symbol is
 * refused. Altium connects a wire to a pin only when both are on grid, so
 * quietly rounding an off-grid pin produces a symbol that looks wired and is
 * not.
 */
const GRID_TOLERANCE_MM = 0.01;

const RECORD = {
  component: 1,
  rectangle: 14,
  designator: 34,
  parameter: 41,
  implementationList: 44,
  implementation: 45,
  mapDefinerList: 46,
  implementationParameters: 48
} as const;

/** Pin flags, decoded in pyaltiumlib's `SchematicPin.parse`. */
const PIN_FLAG = {
  flipped: 0x02,
  showName: 0x08,
  showDesignator: 0x10,
  // Set on every pin in the libraries Altium wrote. Its meaning is not
  // documented; it is preserved rather than dropped.
  reserved: 0x20
} as const;

/** Trailing bytes every pin record carries after its designator, from Altium's files. */
const PIN_TAIL = Buffer.from([0x00, 0x03, 0x7c, 0x26, 0x7c, 0x00]);

/**
 * Altium's eight electrical types, from `SchematicPinElectricalType`:
 * 0 Input, 1 IO, 2 Output, 3 OpenCollector, 4 Passive, 5 HiZ, 6 OpenEmitter,
 * 7 Power.
 *
 * Altium has no "not connected" and no "unspecified"; both become Passive, which
 * is what an Altium library does for an unconnected pin. That is a mapping, not
 * a fact about the part, so the pin name still carries whatever the datasheet
 * called it.
 *
 * OPEN COLLECTOR AND OPEN EMITTER ARE NOT IN THAT CATEGORY. Altium has both, and
 * both were falling through to Passive - so an open-drain pin that must not be
 * driven arrived in the schematic as one that may be, and Altium's own rule
 * check had nothing to object to. Found 2026-08-30 alongside the same loss in
 * the KiCad emitter, which is where the type is now taken from the datasheet
 * rather than thrown away.
 */
function electricalType(type: PinElectricalType): number {
  switch (type) {
    case "input":
      return 0;
    case "bidirectional":
      return 1;
    case "output":
      return 2;
    case "open_collector":
      return 3;
    case "open_emitter":
      return 6;
    case "power":
      return 7;
    case "passive":
    case "nc":
    default:
      return 4;
  }
}

/** Converts millimetres to schematic units, refusing anything off the grid. */
function toSchematicUnits(millimetres: number, what: string): number {
  if (!Number.isFinite(millimetres)) {
    throw new AltiumEmitError(`${what} is ${millimetres} mm, which is not a coordinate.`);
  }
  const exact = millimetres / MM_PER_SCHEMATIC_UNIT;
  const units = Math.round(exact);
  if (Math.abs(exact - units) * MM_PER_SCHEMATIC_UNIT > GRID_TOLERANCE_MM) {
    throw new AltiumEmitError(
      `${what} is ${millimetres} mm, which is off Altium's 0.254 mm schematic grid. A pin off the grid cannot be wired, so this symbol is not written.`
    );
  }
  if (units < -32768 || units > 32767) {
    throw new AltiumEmitError(`${what} is ${millimetres} mm, beyond what a schematic coordinate can hold.`);
  }
  return units;
}

function uniqueId(seed: string): string {
  const digest = createHash("sha256").update(seed).digest();
  let id = "";
  for (let index = 0; index < 8; index += 1) id += String.fromCharCode(65 + (digest[index] % 26));
  return id;
}

/** A `|KEY=VALUE` record: type 0, length-framed. */
function parameterRecord(parameters: Array<[string, string]>): Buffer {
  const text = parameters.map(([key, value]) => `|${key}=${value}`).join("");
  const payload = Buffer.concat([encodeAltiumText(text), Buffer.from([0])]);
  if (payload.length > 0xffff) {
    throw new AltiumEmitError(`A schematic record grew to ${payload.length} bytes; the format allows 65535.`);
  }
  return new ByteWriter().u16(payload.length).u8(0).u8(0).bytes(payload).toBuffer();
}

/**
 * A pin: type 1, and the only binary record in the format. Field order from
 * pyaltiumlib's `SchematicPin.parse`, values checked against Altium's own pins.
 */
function pinRecord(pin: SymbolPin): Buffer {
  const name = encodeAltiumText(pin.name);
  const designator = encodeAltiumText(pin.number);
  if (name.length > 255 || designator.length > 255) {
    throw new AltiumEmitError(`Pin ${pin.number} has a name or number longer than a schematic pin can hold.`);
  }

  const lengthUnits = toSchematicUnits(pin.lengthMm, `Pin ${pin.number} length`);
  if (lengthUnits <= 0) {
    throw new AltiumEmitError(`Pin ${pin.number} has no length, so it has nothing to attach a wire to.`);
  }

  // The stored location is where the pin meets the body, and the geometry's
  // anchor is the far end, so walk back along the pin by its length.
  const bodyEdgeMm = pin.side === "left" ? pin.anchor.xMm + pin.lengthMm : pin.anchor.xMm - pin.lengthMm;
  const x = toSchematicUnits(bodyEdgeMm, `Pin ${pin.number} x`);
  // No flip here, unlike the footprint library. `SymbolGeometry` already
  // counts Y upward, the same direction Altium's schematic does, which is
  // why the KiCad symbol emitter passes it straight through too. Flipping it
  // would put pin 1 at the bottom and mirror the symbol against its own
  // footprint.
  const y = toSchematicUnits(pin.anchor.yMm, `Pin ${pin.number} y`);

  let flags = PIN_FLAG.showName | PIN_FLAG.showDesignator | PIN_FLAG.reserved;
  if (pin.side === "left") flags |= PIN_FLAG.flipped;

  const body = new ByteWriter()
    .u32(2) // record id 2, a pin
    .u8(0)
    .u16(1) // owner part: this symbol has one part
    .u8(0) // display mode
    .u8(0) // symbol on the inner edge
    .u8(0) // symbol on the outer edge
    .u8(0) // symbol inside
    .u8(0) // symbol outside
    .u8(0) // description length: none
    .u8(1)
    .u8(electricalType(pin.electricalType))
    .u8(flags)
    .u16(lengthUnits)
    .i16(x)
    .i16(y)
    .u32(0) // colour: inherit the library default
    .u8(name.length)
    .bytes(name)
    .u8(designator.length)
    .bytes(designator)
    .bytes(PIN_TAIL)
    .toBuffer();

  return new ByteWriter().u16(body.length).u8(0).u8(1).bytes(body).toBuffer();
}

/**
 * The footprint link, as four records.
 *
 * This is what makes the placed symbol arrive with its footprint already
 * attached instead of the user browsing for one per part.
 *
 * The important detail is what is NOT written. Altium can pin the link to a
 * specific library file with `MODELDATAFILEKIND1` and `MODELDATAFILEENTITY1`,
 * and then the link dangles the moment the file is renamed or moved. Writing
 * `DATAFILECOUNT=0` instead leaves Altium to resolve `MODELNAME` against
 * whatever libraries are loaded. That is what real Altium libraries do: every
 * one of the 23 components in the reference library checked names a model and
 * no file.
 *
 * The empty `RECORD=46` is the pin-mapping container. It stays empty because our
 * schematic pin designators and our pad designators are the same strings, which
 * is the trivial case Altium expects.
 */
function implementationRecords(footprintName: string): Buffer[] {
  return [
    parameterRecord([["RECORD", String(RECORD.implementationList)]]),
    parameterRecord([
      ["RECORD", String(RECORD.implementation)],
      ["OWNERINDEX", "1"],
      ["INDEXINSHEET", "-1"],
      ["OWNERPARTID", "-1"],
      ["MODELNAME", footprintName],
      ["MODELTYPE", "PCBLIB"],
      ["DATAFILECOUNT", "0"],
      ["ISCURRENT", "T"]
    ]),
    parameterRecord([["RECORD", String(RECORD.mapDefinerList)]]),
    parameterRecord([["RECORD", String(RECORD.implementationParameters)]])
  ];
}

export interface AltiumSymbolLinks {
  /**
   * The footprint this symbol should place with, by name. Resolved by Altium
   * against any loaded library, so it survives the file being renamed.
   */
  footprintName?: string;
}

/**
 * Builds the `.SchLib` for one symbol.
 *
 * Refuses rather than approximating, the same as the footprint library: a symbol
 * whose pins cannot be placed correctly is not written at all.
 */
export function emitAltiumSchLib(geometry: SymbolGeometry, links: AltiumSymbolLinks = {}): Buffer {
  if (geometry.pins.length === 0) {
    throw new AltiumEmitError(`Symbol "${geometry.name}" has no pins, so it cannot be wired to anything.`);
  }

  const name = parameterSafe(geometry.name);
  const partNumber = parameterSafe(geometry.partNumber);
  const seed = `${name}|${partNumber}`;

  const halfWidth = toSchematicUnits(geometry.body.halfWidthMm, "Symbol body half width");
  const halfHeight = toSchematicUnits(geometry.body.halfHeightMm, "Symbol body half height");
  // The body's own centre line, which is not always the origin: an even number of
  // pin rows cannot be both centred and on the 100 mil grid, and the pins keep the
  // grid. See `SymbolGeometry.bodyCentreYMm`.
  const centreY = toSchematicUnits(geometry.bodyCentreYMm, "Symbol body centre");
  const bodyTop = centreY + halfHeight;
  const bodyBottom = centreY - halfHeight;

  const records: Buffer[] = [];

  records.push(
    parameterRecord([
      ["RECORD", String(RECORD.component)],
      ["LibReference", name],
      // The library panel's description column, and what Altium searches. It was
      // the part number, which every other field on the record already carries;
      // a search for "op-amp SOIC-8" matched nothing in a library of them.
      ["ComponentDescription", parameterSafe(geometry.description ?? partNumber)],
      ["PartCount", "1"],
      ["DisplayModeCount", "1"],
      ["IndexInSheet", "-1"],
      ["OwnerPartId", "-1"],
      ["CurrentPartId", "1"],
      ["LibraryPath", "*"],
      ["SourceLibraryName", "*"],
      ["SheetPartFileName", "*"],
      ["TargetFileName", "*"],
      ["UniqueID", uniqueId(`${seed}:component`)],
      ["AreaColor", "11599871"],
      ["Color", "128"],
      ["PartIDLocked", "T"],
      ["AllPinCount", String(geometry.pins.length)]
    ])
  );

  for (const pin of geometry.pins) records.push(pinRecord(pin));

  records.push(
    parameterRecord([
      ["RECORD", String(RECORD.rectangle)],
      // Altium's own spelling, one "s" short. Correcting it would make the key
      // one Altium does not read.
      ["IsNotAccesible", "T"],
      ["IndexInSheet", String(geometry.pins.length)],
      ["OwnerPartId", "1"],
      ["Location.X", String(-halfWidth)],
      ["Location.Y", String(bodyBottom)],
      ["Corner.X", String(halfWidth)],
      ["Corner.Y", String(bodyTop)],
      ["LineWidth", "1"],
      ["AreaColor", "16777215"],
      ["UniqueID", uniqueId(`${seed}:body`)]
    ])
  );

  // "U?" is what Altium puts in a library symbol: the question mark is what the
  // schematic editor replaces when the part is annotated.
  records.push(
    parameterRecord([
      ["RECORD", String(RECORD.designator)],
      ["IndexInSheet", "-1"],
      ["OwnerPartId", "-1"],
      ["Location.X", String(-halfWidth)],
      ["Location.Y", String(bodyTop + 1)],
      ["Color", "8388608"],
      ["FontID", "1"],
      ["Text", "U?"],
      ["Name", "Designator"],
      ["ReadOnlyState", "1"],
      ["UniqueID", uniqueId(`${seed}:designator`)]
    ])
  );

  records.push(
    parameterRecord([
      ["RECORD", String(RECORD.parameter)],
      ["IndexInSheet", "-1"],
      ["OwnerPartId", "-1"],
      ["Location.X", String(-halfWidth)],
      ["Location.Y", String(bodyBottom - 3)],
      ["Color", "8388608"],
      ["FontID", "1"],
      ["Text", partNumber],
      ["Name", "Comment"],
      ["UniqueID", uniqueId(`${seed}:comment`)]
    ])
  );

  // The link back to the document this part was read from.
  //
  // A hidden parameter, which is how Altium carries a datasheet reference: it
  // shows in the properties panel and travels with the part into a schematic.
  // This product's whole claim is that every value is traceable to a page of a
  // PDF, and until 2026-08-14 the Altium output shipped without the address of
  // that PDF anywhere in it.
  if (geometry.datasheetUrl) {
    records.push(
      parameterRecord([
        ["RECORD", String(RECORD.parameter)],
        ["IndexInSheet", "-1"],
        ["OwnerPartId", "-1"],
        ["Location.X", String(-halfWidth)],
        ["Location.Y", String(bodyBottom - 6)],
        ["Color", "8388608"],
        ["FontID", "1"],
        ["Text", parameterSafe(geometry.datasheetUrl)],
        ["Name", "Datasheet"],
        ["IsHidden", "T"],
        ["UniqueID", uniqueId(`${seed}:datasheet`)]
      ])
    );
  }

  // The footprint link, when the exporter knows which footprint this symbol
  // belongs to. Without it Altium places a symbol with no model attached.
  if (links.footprintName) {
    records.push(...implementationRecords(parameterSafe(links.footprintName)));
  } else {
    records.push(parameterRecord([["RECORD", String(RECORD.implementationList)]]));
  }

  const data = new ByteWriter();
  for (const record of records) data.bytes(record);

  const fileHeader = new ByteWriter()
    .parameterBlock([
      ["HEADER", "Protel for Windows - Schematic Library Editor Binary File Version 5.0"],
      // One more than the number of records, which is the relation in every
      // Altium-written library checked.
      ["Weight", String(records.length + 1)],
      ["MinorVersion", "9"],
      ["UniqueID", uniqueId(`${seed}:library`)],
      ["FontIdCount", "1"],
      ["Size1", "10"],
      ["FontName1", "Times New Roman"],
      ["UseMBCS", "T"],
      ["IsBOC", "T"],
      ["SheetStyle", "9"],
      ["BorderOn", "T"],
      ["SheetNumberSpaceSize", "12"],
      ["AreaColor", "16317695"],
      ["SnapGridOn", "T"],
      ["SnapGridSize", "10"],
      ["VisibleGridOn", "T"],
      ["VisibleGridSize", "10"],
      ["CustomX", "18000"],
      ["CustomY", "18000"],
      ["UseCustomSheet", "T"],
      ["ReferenceZonesOn", "T"],
      ["Display_Unit", "0"],
      ["CompCount", "1"],
      ["LibRef0", name],
      // The description again, in the SECOND place the format stores it.
      //
      // `ComponentDescription` on the component record carries it and its own
      // note says why: set to the part number, which every other field already
      // holds, a search for "op-amp SOIC-8" matched nothing in a library full of
      // them. That was fixed there and this copy was left as the part number, so
      // the library INDEX still describes every component by a string that
      // identifies it and says nothing about it. Altium reads this one when it
      // lists a library's contents without opening each component.
      ["CompDescr0", parameterSafe(geometry.description ?? partNumber)],
      ["PartCount0", "1"]
    ])
    .toBuffer();

  const storage = new ByteWriter().parameterBlock([["HEADER", "Icon storage"]]).toBuffer();

  return writeCompoundFile([
    ["/FileHeader", fileHeader],
    ["/Storage", storage],
    [`/${storageName(name)}/Data`, data.toBuffer()]
  ]);
}

