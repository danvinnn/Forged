import JSZip from "jszip";
import {
  resolveForExport,
  type ExportFormat,
  type PartRecord,
  type PinRecord,
  type ResolvedPart
} from "./types";
import {
  computeLandPattern,
  COURTYARD_EXCESS,
  LandPatternError,
  thermalPadLand,
  type DensityLevel,
  type LandPattern,
  type LeadDimensions,
  type ThermalPadLand
} from "./ipc7351";
import { resolvePackageDefinition, SUPPORTED_PACKAGE_FAMILIES, type PackageDefinition } from "./packages";
import {
  type FootprintGeometry,
  type Pad,
  type SymbolGeometry,
  type SymbolPin,
  type ThermalVia
} from "./geometry";
import { emitKicadFootprint, emitKicadSymbol } from "./emitters/kicad";
import { emitAltiumPcbLib, emitAltiumSchLib } from "./emitters/altium";

/**
 * A value the caller must supply because no document can.
 *
 * The point of this shape is that it is answerable. A refusal saying only that
 * a footprint cannot be generated leaves the user with nothing to do; a refusal
 * naming the field, its unit, and why the datasheet cannot supply it can be
 * rendered as a single labelled input.
 *
 * `scope` separates the two kinds. `install` is a property of the customer's
 * assembly line, so it is asked once and never again: the trim an assembler
 * forms leads to does not change between an op-amp and a microcontroller.
 * `part` would be asked per part, which is friction, and every one of those is
 * a parsing gap rather than a permanent field.
 */
export interface RequiredInput {
  /**
   * The `/api/export` request field that answers it.
   *
   * The land-pattern three and `leadSides` were added on 2026-08-13, when the
   * rule was settled: every number describing a part comes from that part's
   * datasheet, and where the document genuinely does not carry one we ASK. Until
   * then a package the family table had never heard of was a flat refusal, and
   * a package it HAD heard of was quietly given that table's invented lead
   * dimensions. Neither is the document speaking.
   */
  field:
    | "formedLeadSpanMm"
    | "landPadLengthMm"
    | "landPadWidthMm"
    | "landSpanMm"
    | "leadSides";
  /** Label for the input, in the user's language rather than the standard's. */
  label: string;
  /** Why no datasheet can answer it. Shown, not logged. */
  why: string;
  unit: "mm";
  scope: "install" | "part";
}

/**
 * Raised when a footprint cannot be generated to the standard.
 *
 * Two different situations reach here and the caller has to tell them apart,
 * because one is answerable and the other is not. When `needs` is populated the
 * user can supply the value and get their footprint. When it is empty the
 * package has no characterised land pattern, which is our gap to close and not
 * something they can type their way out of.
 */
/**
 * How much bigger than the package a printed land pattern may be.
 *
 * Lands sit a little outboard of the leads, so the pattern is always somewhat
 * larger than the body; 2x its largest dimension is far beyond any real
 * footprint and comfortably below a factor-of-ten misreading.
 */
const PRINTED_LAND_EXTENT_LIMIT = 2;

/**
 * The land pattern the datasheet PRINTS, turned into the shape the emitters use.
 *
 * Three numbers off the vendor's own recommended-footprint drawing: one land's
 * length and width, and the centre-to-centre distance between opposing rows.
 * Everything else follows arithmetically, so nothing is assumed and no standard
 * is consulted.
 *
 * Returns null unless all three are present and physically consistent. A
 * PARTIAL printed pattern is not a pattern: filling the gaps from a computed
 * one would mix two sources into a footprint that claims to be the vendor's.
 */
function printedLand(part: ResolvedPart, densityLevel: DensityLevel): LandPattern | null {
  const padLengthMm = part.dimensions.landPadLengthMm;
  const padWidthMm = part.dimensions.landPadWidthMm;
  const centreSpan = part.dimensions.landSpanMm;
  if (!padLengthMm || !padWidthMm || !centreSpan) return null;
  if (padLengthMm <= 0 || padWidthMm <= 0 || centreSpan <= 0) return null;

  // Opposing lands must not meet in the middle. If they would, one of the three
  // numbers describes something other than this footprint, and the drawing has
  // been misread rather than the package being strange.
  const gMinMm = centreSpan - padLengthMm;
  if (gMinMm <= 0) return null;

  // Two checks against the package's OWN dimensions, because nothing else looks
  // at these numbers any more.
  //
  // Until this path existed, a printed pattern was only ever used to veto a
  // computed one, so a misreading could not reach a board: the computation was
  // the thing being emitted. Now the printed pattern IS what is emitted, and a
  // decimal point read wrongly (1.5 as 15) would be emitted with it. These are
  // the cheapest independent facts available, and both come off the mechanical
  // drawing rather than from any standard.
  // THE BAND CHECK, where the drawing gives enough to compute it. See
  // `withinIpcBand`: a vendor pattern between Level C and Level A is a design
  // choice, one outside it is a misread. This is the industry's bound and it
  // supersedes the two invented ones below, which stay as a floor for documents
  // that print a footprint but no lead dimensions.
  const band = withinIpcBand(part, padLengthMm, centreSpan);
  if (band === false) return null;

  const pitchMm = part.dimensions.pitchMm;
  // Neighbouring lands in one row sit a pitch apart, so a land WIDER than the
  // pitch would merge with the one beside it. No footprint does this.
  if (pitchMm && pitchMm > 0 && padWidthMm >= pitchMm) return null;

  // And the whole pattern has to be the size of the part. A land span several
  // times the package's largest dimension is a misread rather than a footprint.
  const packageExtent = Math.max(
    part.dimensions.bodyLengthMm ?? 0,
    part.dimensions.bodyWidthMm ?? 0,
    part.dimensions.leadSpanMm?.maxMm ?? 0
  );
  if (packageExtent > 0 && centreSpan + padLengthMm > packageExtent * PRINTED_LAND_EXTENT_LIMIT) {
    return null;
  }

  const zMaxMm = centreSpan + padLengthMm;
  return {
    padWidthMm,
    padLengthMm,
    padCentreMm: centreSpan / 2,
    zMaxMm,
    gMinMm,
    // The courtyard is a keep-out convention for the board, not a dimension of
    // the part, and datasheets rarely print one. Derived the same way as for a
    // computed pattern, which is the only thing the density level touches here.
    courtyardHalfMm: zMaxMm / 2 + COURTYARD_EXCESS[densityLevel],
    densityLevel,
    source: "printed"
  };
}

export class FootprintUnavailableError extends Error {
  constructor(
    readonly reason: string,
    readonly supportedFamilies: string[] = SUPPORTED_PACKAGE_FAMILIES,
    readonly needs: RequiredInput[] = []
  ) {
    super(reason);
    this.name = "FootprintUnavailableError";
  }
}

// Escapers for values interpolated into generated CAD files. Extracted fields (part number,
// package type, manufacturer) are attacker-influenceable: they can arrive from a crafted datasheet
// resolved through a Layer 1 lookup. Both formats below use quoted string literals, so an
// unescaped quote or newline breaks out of the literal and injects structure into the file. This
// is the CADGEN_INPUT_SANITIZATION obligation, fixed at the sink.

// STEP Part 21 strings are single-quoted; a literal single quote is escaped by doubling it, and
// control characters (which have no valid place in these identifiers) are stripped.
function stepString(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/'/g, "''");
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "part";
}

function formatStepNumber(value: number): string {
  const formatted = Number.isInteger(value) ? value.toFixed(1) : value.toFixed(6);
  return formatted.replace(/\.0+$/, ".").replace(/(\.\d*?)0+$/, "$1");
}

function stepPoint(x: number, y: number, z: number): string {
  return `(${formatStepNumber(x)},${formatStepNumber(y)},${formatStepNumber(z)})`;
}

function buildStepModel(part: ResolvedPart): { content: string; note: string; supported: boolean; fileName: string } {
  const lengthMm = part.dimensions.bodyLengthMm ?? Math.max(part.pinCount * 0.8, 4.0);
  const widthMm = part.dimensions.bodyWidthMm ?? Math.max(part.pinCount * 0.55, 3.0);
  const heightMm = part.dimensions.bodyHeightMm ?? 1.5;
  const halfLength = lengthMm / 2;
  const halfWidth = widthMm / 2;
  const halfHeight = heightMm / 2;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "");

  const points = [
    [-halfLength, -halfWidth, -halfHeight],
    [halfLength, -halfWidth, -halfHeight],
    [halfLength, halfWidth, -halfHeight],
    [-halfLength, halfWidth, -halfHeight],
    [-halfLength, -halfWidth, halfHeight],
    [halfLength, -halfWidth, halfHeight],
    [halfLength, halfWidth, halfHeight],
    [-halfLength, halfWidth, halfHeight]
  ] as const;

  const lines = [
    "ISO-10303-21;",
    "HEADER;",
    `FILE_DESCRIPTION(('Forge generated STEP package body for ${stepString(part.partNumber)}'),'2;1');`,
    `FILE_NAME('${stepString(part.partNumber)}.step','${now}',('Forge'),('Forge'),'Forge MVP','Forge','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    "ENDSEC;",
    "DATA;",
    "#1=APPLICATION_CONTEXT('mechanical design');",
    "#2=APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2001,#1);",
    "#3=PRODUCT_CONTEXT('',#1,'mechanical');",
    `#4=PRODUCT('${stepString(part.partNumber)}','${stepString(part.partNumber)} package body','',(#3));`,
    "#5=PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('1',$,#4,.MADE.);",
    "#6=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');",
    "#7=PRODUCT_DEFINITION('design',$,#5,#6);",
    "#8=PRODUCT_DEFINITION_SHAPE('',$,#7);",
    "#9=GEOMETRIC_REPRESENTATION_CONTEXT(3);"
  ];

  points.forEach((point, index) => {
    const pointId = index + 10;
    const vertexId = index + 20;
    lines.push(`#${pointId}=CARTESIAN_POINT('',${stepPoint(point[0], point[1], point[2])});`);
    lines.push(`#${vertexId}=VERTEX_POINT('',#${pointId});`);
  });

  const edges = [
    { id: 30, start: 20, end: 21, direction: [1, 0, 0], length: lengthMm },
    { id: 31, start: 21, end: 22, direction: [0, 1, 0], length: widthMm },
    { id: 32, start: 22, end: 23, direction: [-1, 0, 0], length: lengthMm },
    { id: 33, start: 23, end: 20, direction: [0, -1, 0], length: widthMm },
    { id: 34, start: 24, end: 25, direction: [1, 0, 0], length: lengthMm },
    { id: 35, start: 25, end: 26, direction: [0, 1, 0], length: widthMm },
    { id: 36, start: 26, end: 27, direction: [-1, 0, 0], length: lengthMm },
    { id: 37, start: 27, end: 24, direction: [0, -1, 0], length: widthMm },
    { id: 38, start: 20, end: 24, direction: [0, 0, 1], length: heightMm },
    { id: 39, start: 21, end: 25, direction: [0, 0, 1], length: heightMm },
    { id: 40, start: 22, end: 26, direction: [0, 0, 1], length: heightMm },
    { id: 41, start: 23, end: 27, direction: [0, 0, 1], length: heightMm }
  ];

  edges.forEach((edge) => {
    const lineId = edge.id + 100;
    const directionId = edge.id + 200;
    const vectorId = edge.id + 300;
    lines.push(`#${directionId}=DIRECTION('',(${formatStepNumber(edge.direction[0])},${formatStepNumber(edge.direction[1])},${formatStepNumber(edge.direction[2])}));`);
    lines.push(`#${vectorId}=VECTOR('',#${directionId},${formatStepNumber(edge.length)});`);
    lines.push(`#${lineId}=LINE('',#${edge.start},#${vectorId});`);
    lines.push(`#${edge.id}=EDGE_CURVE('',#${edge.start},#${edge.end},#${lineId},.T.);`);
  });

  const faces = [
    { id: 60, origin: stepPoint(0, 0, -halfHeight), normal: [0, 0, -1], reference: [1, 0, 0], loop: [33, 32, 31, 30] },
    { id: 61, origin: stepPoint(0, 0, halfHeight), normal: [0, 0, 1], reference: [1, 0, 0], loop: [34, 35, 36, 37] },
    { id: 62, origin: stepPoint(0, -halfWidth, 0), normal: [0, -1, 0], reference: [1, 0, 0], loop: [30, 39, 34, 38] },
    { id: 63, origin: stepPoint(0, halfWidth, 0), normal: [0, 1, 0], reference: [1, 0, 0], loop: [32, 41, 36, 40] },
    { id: 64, origin: stepPoint(-halfLength, 0, 0), normal: [-1, 0, 0], reference: [0, 1, 0], loop: [33, 40, 37, 38] },
    { id: 65, origin: stepPoint(halfLength, 0, 0), normal: [1, 0, 0], reference: [0, 1, 0], loop: [31, 39, 35, 41] }
  ];

  faces.forEach((face) => {
    const locationId = face.id + 100;
    const normalId = face.id + 200;
    const referenceId = face.id + 210;
    const axisId = face.id + 220;
    const planeId = face.id + 230;
    const loopId = face.id + 240;
    const boundId = face.id + 250;

    lines.push(`#${locationId}=CARTESIAN_POINT('',${face.origin});`);
    lines.push(`#${normalId}=DIRECTION('',(${formatStepNumber(face.normal[0])},${formatStepNumber(face.normal[1])},${formatStepNumber(face.normal[2])}));`);
    lines.push(`#${referenceId}=DIRECTION('',(${formatStepNumber(face.reference[0])},${formatStepNumber(face.reference[1])},${formatStepNumber(face.reference[2])}));`);
    lines.push(`#${axisId}=AXIS2_PLACEMENT_3D('',#${locationId},#${normalId},#${referenceId});`);
    lines.push(`#${planeId}=PLANE('',#${axisId});`);
    lines.push(`#${loopId}=EDGE_LOOP('',(${face.loop.map((edgeId) => `#${edgeId}`).join(",")}));`);
    lines.push(`#${boundId}=FACE_OUTER_BOUND('',#${loopId},.T.);`);
    lines.push(`#${face.id}=ADVANCED_FACE('',(#${boundId}),#${planeId},.T.);`);
  });

  lines.push("#70=CLOSED_SHELL('',(#60,#61,#62,#63,#64,#65));");
  lines.push("#71=MANIFOLD_SOLID_BREP('PackageBody',#70);");
  lines.push("#72=ADVANCED_BREP_SHAPE_REPRESENTATION('NONE',(#71),#9);");
  lines.push("#73=SHAPE_DEFINITION_REPRESENTATION(#8,#72);");
  lines.push("ENDSEC;");
  lines.push("END-ISO-10303-21;");

  return {
    content: lines.join("\n"),
    note: `Generated a real STEP Part 21 solid for ${part.partNumber}. The model is a simplified package body enclosure based on extracted body dimensions.`,
    supported: true,
    fileName: `${slugify(part.partNumber)}.step`
  };
}

/**
 * Splits pins onto the two sides of a dual-row package in physical order.
 *
 * Dual-row packages number counterclockwise seen from above: pin 1 at the top
 * left, down the left side, across the bottom, then UP the right side. The old
 * exporter ran both columns downward, which put pin 5 of an 8-pin SOIC at the
 * top right where pin 8 belongs. Every part exported before this fix has its
 * second row reversed, which is a miswired board, not a cosmetic defect.
 */
function dualRowSides(
  pinCount: number,
  /**
   * The grid position on the SHORTER row that carries no lead, 1-based in the
   * same top-to-bottom order the rows are drawn in. Read off the pinout; see
   * `dimensions.vacantLeadSlot`.
   */
  vacantSlot?: number | null
): { left: Array<number | null>; right: Array<number | null> } {
  const perSide = Math.ceil(pinCount / 2);
  const left: Array<number | null> = [];
  const right: Array<number | null> = [];

  for (let number = 1; number <= pinCount; number += 1) {
    if (number <= perSide) left.push(number);
    else right.push(number);
  }
  // The right column is read bottom to top, so reverse it into top-to-bottom
  // drawing order. This single line is the counterclockwise convention.
  right.reverse();

  // An odd lead count leaves the second row one short, and WHERE the gap sits
  // is a fact about the package that the pitch does not imply. On a 5-lead
  // SOT-23 the vacant position is the middle of the two-lead side: filling the
  // row from the top instead would put pin 4 where the package has nothing and
  // pin 5 where pin 4 belongs, which is a miswired board that looks correct in
  // CAD. This used to be an outright refusal; now the position is read.
  if (right.length < perSide && vacantSlot && vacantSlot >= 1 && vacantSlot <= perSide) {
    right.splice(vacantSlot - 1, 0, null);
  }

  return { left, right };
}

/**
 * Splits pins onto the four sides of a quad package in physical order.
 *
 * Quad packages number COUNTERCLOCKWISE seen from above, starting at the top of
 * the left-hand side: down the left, across the bottom, up the right, back
 * across the top. That is the same convention `dualRowSides` follows, continued
 * around two more corners.
 *
 * Read off the corner labels of TI's PN0080A drawing rather than assumed: it
 * prints 1 and 20 at the top and bottom of the left side, 21 and 40 at the left
 * and right of the bottom, 41 and 60 at the bottom and top of the right, and 61
 * and 80 at the right and left of the top.
 */
function quadRowSides(pinCount: number): {
  left: number[];
  bottom: number[];
  right: number[];
  top: number[];
} {
  const perSide = pinCount / 4;
  const side = (index: number) =>
    Array.from({ length: perSide }, (_, step) => index * perSide + step + 1);

  return {
    left: side(0),
    bottom: side(1),
    right: side(2),
    top: side(3)
  };
}

function pinByNumber(part: ResolvedPart): Map<string, PinRecord> {
  return new Map(part.pins.map((pin) => [String(pin.number), pin]));
}

/**
 * Builds the format-neutral symbol description.
 *
 * Pins keep their physical side rather than being sorted by electrical type. An
 * earlier version filtered inputs left and outputs right, then indexed both
 * sides off one running counter, so the two columns collided and outputs drifted
 * below the body. Grouping by function is a nicety; placing a pin at the wrong
 * coordinate is a defect.
 */
function buildSymbolGeometry(part: ResolvedPart): SymbolGeometry {
  // No vacant slot is passed, deliberately. A gap in the LEAD grid is a fact
  // about the package's physical layout; a schematic symbol has one pin per
  // electrical pin and no holes in it.
  const { left, right } = dualRowSides(part.pinCount);
  const byNumber = pinByNumber(part);
  const rows = Math.max(left.length, right.length);

  // 2.54 mm grid, one row per pin pair, with a row of clearance top and bottom.
  const pitchMm = 2.54;
  const halfHeightMm = ((rows + 1) * pitchMm) / 2;
  const halfWidthMm = 7.62;
  const lengthMm = 2.54;

  const pins: SymbolPin[] = [];
  const collect = (numbers: number[], side: "left" | "right") => {
    numbers.forEach((number, row) => {
      const pin = byNumber.get(String(number));
      if (!pin) return;
      pins.push({
        number: String(pin.number),
        name: pin.name,
        // Pins face outward, so the anchor sits one stub beyond the body edge.
        anchor: {
          xMm: side === "left" ? -(halfWidthMm + lengthMm) : halfWidthMm + lengthMm,
          yMm: halfHeightMm - pitchMm * (row + 1)
        },
        side,
        lengthMm,
        electricalType: pin.electricalType
      });
    });
  };
  collect(left.filter((n): n is number => n !== null), "left");
  collect(right.filter((n): n is number => n !== null), "right");

  return {
    name: part.partNumber,
    partNumber: part.partNumber,
    body: { halfWidthMm, halfHeightMm },
    pins
  };
}

/**
 * Builds the format-neutral footprint description, or refuses.
 *
 * There is no fallback path here on purpose. The version this replaced defaulted
 * an unknown pitch to 1.27 mm and sized pads with invented arithmetic
 * (`padWidth = pitch * 0.55`), producing a file indistinguishable from a real one
 * for a part whose pitch nobody had read.
 */
function buildFootprintGeometry(
  part: ResolvedPart,
  densityLevel: DensityLevel,
  formedLeadSpanMm?: number,
  supplied?: SuppliedDimensions
): FootprintGeometry {
  part = withSupplied(part, supplied);
  // An exposed thermal pad is laid out when its size is known, and refused when
  // it is not. It is a mandatory soldered feature: the numbered lands alone are
  // a footprint the board house builds wrong.
  //
  // Refusing outright is what this did until the pad could actually be built.
  // The size comes from drawing dimensions D2 and E2, which are arrows, so only
  // a reader that can see the page supplies them.
  if (part.exposedPad) {
    const length = part.dimensions.thermalPadLengthMm;
    const width = part.dimensions.thermalPadWidthMm;
    if (length === null || width === null) {
      throw new FootprintUnavailableError(
        `${part.partNumber} has an exposed thermal pad and its size was not read. The pad is a mandatory soldered feature, so the numbered pins alone would be a footprint missing it, and no footprint is generated. The size is drawing dimensions D2 and E2 on the package outline.`,
        SUPPORTED_PACKAGE_FAMILIES
      );
    }
  }

  // THE DATASHEET'S OWN FOOTPRINT, FIRST, AND WITHOUT CONSULTING ANY TABLE.
  //
  // The rule this obeys: every number describing a part comes from that part's
  // datasheet, and where the document genuinely does not carry one we ask. A
  // hand-typed family table supplying lead spans it invented is the opposite of
  // that, and it was not a hypothetical: measured 2026-08-13, all 12 parts that
  // shipped from the tuned corpus were fed by the table, and the table refused
  // SOT-23, SOT-10, TSOT and LFCSP outright. TLV9061 prints its whole footprint
  // (1.1 x 0.6 mm lands on a 1.9 mm centre span) and was refused for having a
  // package name the table had never heard of, because the lookup below threw
  // 77 lines before the printed pattern was ever consulted.
  //
  // When the document states the pads, their span, the pitch and how many sides
  // carry leads, nothing is left for a table to contribute. IPC-7351B still
  // computes the courtyard, which is arithmetic applied to these numbers rather
  // than a claim about this part.
  const printed = printedLand(part, densityLevel);
  const fromDatasheet = printed ? datasheetLayout(part) : null;

  if (printed && fromDatasheet) {
    return assemble(part, densityLevel, printed, fromDatasheet);
  }

  // DERIVED FROM THIS PART'S OWN PACKAGE DRAWING, still without a table.
  //
  // The document prints a package outline but no recommended footprint, which
  // is the common case: 40 of 46 corpus datasheets print an outline and only 27
  // print a land pattern. An engineer in this position runs the IPC wizard in
  // Altium or KiCad, types the drawing's dimensions in, and takes the result.
  // This is that operation.
  //
  // Every input is from this datasheet. IPC-7351B supplies the arithmetic, not
  // a claim about the part, which is the line that separates it from the family
  // table it replaces: the table asserted lead spans it had invented.
  const drawnLead = leadFromDrawing(part);
  if (drawnLead && fromDatasheetLayoutOnly(part)) {
    try {
      const derived = computeLandPattern(drawnLead, { densityLevel });
      return assemble(part, densityLevel, derived, {
        ...fromDatasheetLayoutOnly(part)!,
        source: `IPC-7351B density ${densityLevel}, computed from this datasheet's own package drawing`
      });
    } catch (error) {
      if (!(error instanceof LandPatternError)) throw error;
      // Fall through to the table, which may still know this family.
    }
  }

  // The package, checked against this part's own mechanical drawing. Shared with
  // the parse route so the land pattern the UI reports on is the one the export
  // actually builds; see resolvePackageDefinition.
  const lookup = resolvePackageDefinition(part.packageType, part.pinCount, {
    outlineCode: part.packageOutlineCode,
    leadForm: part.dimensions.leadForm,
    pitchMm: part.dimensions.pitchMm,
    leadWidthMm: part.dimensions.leadWidthMm,
    leadSpanMm: part.dimensions.leadSpanMm,
    leadLengthMm: part.dimensions.leadLengthMm,
    leadContactMm: part.dimensions.leadContactMm,
    // The body is the land reference for a NO-LEAD package, whose terminals end
    // at the body edge. The gull-wing route ignores these.
    bodyLengthMm: part.dimensions.bodyLengthMm,
    bodyWidthMm: part.dimensions.bodyWidthMm,
    vendorLandMm: part.vendorLandPattern?.valuesMm ?? null
  });
  if (!lookup.ok) {
    // The document did not give us a footprint and the table has no entry. That
    // is not a dead end any more: it is a question, because the user can read
    // these off a vendor application note and we cannot invent them.
    throw new FootprintUnavailableError(
      `${lookup.failure.reason} This datasheet prints no recommended footprint either, so there is nothing to read. Supply the land pattern and it will be built from your numbers.`,
      lookup.failure.supported,
      askForLandPattern(part)
    );
  }

  const definition: PackageDefinition = lookup.definition;

  // A ceramic flat pack arrives with straight leads 22.7 mm tip to tip and is
  // trimmed and formed by the assembler, so its seated span is a property of the
  // board process, not of the part. Guessing one would put every pad in a place
  // nobody chose.
  let lead = definition.lead;
  if (definition.spanFromLeadForm) {
    if (!formedLeadSpanMm || !Number.isFinite(formedLeadSpanMm) || formedLeadSpanMm <= 0) {
      throw new FootprintUnavailableError(
        `${definition.family} ships with untrimmed leads, so its seated lead span depends on how you trim and form them and cannot be read off the datasheet. Supply the formed toe-to-toe span (formedLeadSpanMm) to generate a footprint.`,
        SUPPORTED_PACKAGE_FAMILIES,
        [
          {
            field: "formedLeadSpanMm",
            label: "Formed lead span, toe to toe",
            why: `A ${definition.family} ships with its leads straight and the assembler trims and forms them, so the seated span is set by your process. No datasheet prints it, because the manufacturer never bends them.`,
            unit: "mm",
            // Once per assembler, not once per part. An assembler forms to a
            // convention and every flat pack they build uses it.
            scope: "install"
          }
        ]
      );
    }
    // The formed span is a single figure from a trim process, so it carries the
    // process tolerance rather than a drawing's min/max.
    lead = {
      ...definition.lead,
      span: { minMm: formedLeadSpanMm - 0.2, maxMm: formedLeadSpanMm + 0.2 }
    };
  }

  // The datasheet's OWN recommended footprint, where it prints one, IS the
  // answer. Everything below it is what to do when the document is silent.
  //
  // 36 of 39 hold-out datasheets print this on a named page. Until 2026-08-12
  // none of it reached the footprint: the pattern was computed from IPC-7351B
  // and a hand-typed family table, and the vendor's own drawing was read only
  // to VETO that computation. So the document stated the answer, the code
  // derived a substitute from outside information, and then checked the
  // substitute against the answer it had thrown away. It also meant a TI house
  // rule could be applied to an ST part while ST's own numbers sat unread two
  // pages later.
  let land: LandPattern | null = printedLand(part, densityLevel);

  if (!land) {
    try {
      land = computeLandPattern(lead, { densityLevel });
    } catch (error) {
      if (error instanceof LandPatternError) throw new FootprintUnavailableError(error.message);
      throw error;
    }
  }

  return assemble(part, densityLevel, land, {
    arrangement: definition.arrangement,
    pitchMm: definition.pitchMm,
    family: definition.family,
    source: definition.source
  });
}

/**
 * The lead geometry IPC-7351B needs, taken from this part's OWN drawing.
 *
 * The same four values the hand-typed family table used to supply per family,
 * except read off the document in front of us. `contact` is the foot that sits
 * on the pad (drawing dimension L), `span` the tip-to-tip extent, `width` the
 * lead width; all three are printed on any package outline and all three were
 * already being extracted.
 *
 * Gull-wing only, and that is a hard limit rather than a simplification.
 * IPC-7351B publishes fillet goals per lead form, and only the gull-wing table
 * is entered in `ipc7351.ts`. A no-lead package routed through here would be
 * computed against goals that are not its own, which is precisely the mistake
 * the vendor-specific rule being removed alongside this made.
 */
function leadFromDrawing(part: ResolvedPart): LeadDimensions | null {
  if (part.dimensions.leadForm !== "gullwing") return null;
  const span = part.dimensions.leadSpanMm;
  const width = part.dimensions.leadWidthMm;
  const contact = part.dimensions.leadContactMm;
  if (!span || !width || !contact) return null;
  return {
    form: "gullwing",
    span: { minMm: span.minMm, maxMm: span.maxMm },
    contact: { minMm: contact.minMm, maxMm: contact.maxMm },
    width: { minMm: width.minMm, maxMm: width.maxMm }
  };
}

/**
 * Whether a printed pattern sits inside the band IPC-7351B would allow.
 *
 * The practitioner rule, from the PCB Libraries forum where the IPC-7351
 * authors post: "Any mfr. recommended pattern that is between the Least and
 * Most density level is OK to use." Level C is the least material, Level A the
 * most, so a vendor pattern that lands between them is a legitimate design
 * choice and a pattern outside them is a misread or a house rule we should not
 * silently adopt.
 *
 * This replaces three checks I invented on 2026-08-12 (pads must not meet, pad
 * narrower than pitch, overall size sanity). Those were reasonable but were my
 * judgment; this is the industry's, and it is a tighter bound.
 *
 * Returns null when the band cannot be computed, which is not a failure: a
 * datasheet that prints a footprint but no lead dimensions is common, and the
 * invented guards still run underneath as a floor.
 */
function withinIpcBand(part: ResolvedPart, padLengthMm: number, centreSpan: number): boolean | null {
  const lead = leadFromDrawing(part);
  if (!lead) return null;
  try {
    const most = computeLandPattern(lead, { densityLevel: "A" });
    const least = computeLandPattern(lead, { densityLevel: "C" });
    const zMax = centreSpan + padLengthMm;
    // Compared on the toe-to-toe extent, which is the dimension both density
    // levels move most and the one a misread decimal point distorts first.
    return zMax >= least.zMaxMm - BAND_TOLERANCE_MM && zMax <= most.zMaxMm + BAND_TOLERANCE_MM;
  } catch {
    return null;
  }
}

/**
 * Slack on the band edges, in mm.
 *
 * The band is computed from the drawing's own tolerances and the vendor's
 * pattern was computed from theirs, so exact coincidence at the boundary is not
 * expected. Wide enough that a legitimate pattern sitting on Level C is not
 * rejected, far too small to admit a factor-of-ten misread.
 */
const BAND_TOLERANCE_MM = 0.3;

/**
 * Choices that belong to the BOARD and the assembly process, not to the part.
 *
 * The rule this serves: everything about the part comes from the datasheet;
 * everything about the solder joint comes from the datasheet where it printed a
 * recommended footprint, and otherwise from a setting that defaults to the
 * industry standard. Nothing is invented.
 *
 * A datasheet cannot answer any of these, because the vendor does not know the
 * reflow profile, the stencil or the reliability target. Leaving them as
 * constants in the code was the same thing as answering them on the user's
 * behalf without saying so.
 */
export interface ForgeSettings {
  /**
   * IPC-7351B density level: `A` most material, `B` nominal, `C` least.
   *
   * Unset means the industry nominal. Set per project by anyone whose assembly
   * process wants otherwise, e.g. `A` where boards are hand-reworked.
   */
  densityLevel?: DensityLevel;
}

/**
 * Process-wide defaults.
 *
 * Read per call rather than captured at import so a host can set them at any
 * point, and deliberately narrow: this is the seam a project-level settings
 * store plugs into, not the store itself.
 */
export function settingsDefault(): ForgeSettings {
  const level = process.env.FORGE_DENSITY_LEVEL;
  return level === "A" || level === "B" || level === "C" ? { densityLevel: level } : {};
}

/**
 * Numbers the USER supplied, answering what their datasheet did not carry.
 *
 * The other half of `askForLandPattern`. Asking a question with no way to
 * answer it is worse than refusing outright, so every field that can be asked
 * for here can also be supplied here, and the two lists are kept in step by
 * `RequiredInput["field"]`.
 *
 * These are applied to the record BEFORE anything reads it, so the rest of the
 * generator cannot tell a supplied number from a read one. What it can tell,
 * and what the record records, is the provenance: a supplied land says so.
 */
export interface SuppliedDimensions {
  landPadLengthMm?: number;
  landPadWidthMm?: number;
  landSpanMm?: number;
  leadSides?: 2 | 4;
}

/** A copy of the part with the user's answers filled in where the datasheet was silent. */
function withSupplied(part: ResolvedPart, supplied: SuppliedDimensions | undefined): ResolvedPart {
  if (!supplied) return part;
  // Only fills BLANKS. A number the datasheet stated is never overwritten by a
  // typed one: the document is the authority, and a user answering a question
  // they were not asked must not be able to silently redefine a read value.
  const fill = <T,>(read: T | null, given: T | undefined): T | null => (read === null ? given ?? null : read);
  return {
    ...part,
    dimensions: {
      ...part.dimensions,
      landPadLengthMm: fill(part.dimensions.landPadLengthMm, supplied.landPadLengthMm),
      landPadWidthMm: fill(part.dimensions.landPadWidthMm, supplied.landPadWidthMm),
      landSpanMm: fill(part.dimensions.landSpanMm, supplied.landSpanMm),
      leadSides: fill(part.dimensions.leadSides, supplied.leadSides)
    }
  };
}

/**
 * What to ask for, when the datasheet prints no footprint we could read.
 *
 * Only the values actually missing are asked for, so a document that gave two
 * of the three land numbers is one question away rather than four. Every entry
 * says WHY the datasheet cannot answer it, because "type a number" with no
 * reason is how a tool trains people to type anything.
 */
function askForLandPattern(part: ResolvedPart): RequiredInput[] {
  const needs: RequiredInput[] = [];
  const why =
    `This datasheet does not print a recommended footprint for ${part.packageType}, ` +
    `and no land pattern is derived from anything outside it. Take these three from the ` +
    `vendor's application note or your own library.`;

  if (part.dimensions.landPadLengthMm === null) {
    needs.push({ field: "landPadLengthMm", label: "Land length, along the lead", why, unit: "mm", scope: "part" });
  }
  if (part.dimensions.landPadWidthMm === null) {
    needs.push({ field: "landPadWidthMm", label: "Land width, across the lead", why, unit: "mm", scope: "part" });
  }
  if (part.dimensions.landSpanMm === null) {
    needs.push({ field: "landSpanMm", label: "Centre-to-centre span between opposing rows", why, unit: "mm", scope: "part" });
  }
  if (part.dimensions.leadSides !== 2 && part.dimensions.leadSides !== 4) {
    needs.push({
      field: "leadSides",
      label: "Sides carrying leads (2 or 4)",
      why: `The package drawing shows this, but it was not read for ${part.packageType}. Two opposing rows is 2; leads on all four sides is 4.`,
      unit: "mm",
      scope: "part"
    });
  }
  return needs;
}

/**
 * Everything the pad layout needs that is NOT the land pattern itself.
 *
 * Four values, and the point of naming them is that this is the complete list.
 * The family table was carrying these four plus a set of invented lead
 * dimensions; once the datasheet supplies the land pattern directly, the lead
 * dimensions have no consumer and only these remain. All four are printed on
 * any package drawing.
 */
interface PadLayout {
  arrangement: "dual" | "quad";
  pitchMm: number;
  /** Named for the record and the file name. The datasheet's own designator. */
  family: string;
  /** Where the numbers came from. Required: a layout without a source is a guess. */
  source: string;
}

/**
 * The layout, taken entirely from the part's own datasheet.
 *
 * Null when the document did not give enough, which is the signal to fall back
 * to the table rather than to guess. `leadSides` is the only genuinely new
 * requirement: pitch, pin count and the land pattern were already being read.
 */
/** The layout alone, for the derived path where there is no printed pattern. */
function fromDatasheetLayoutOnly(part: ResolvedPart): PadLayout | null {
  return datasheetLayout(part);
}

function datasheetLayout(part: ResolvedPart): PadLayout | null {
  const pitchMm = part.dimensions.pitchMm;
  const sides = part.dimensions.leadSides;
  if (!pitchMm || pitchMm <= 0 || (sides !== 2 && sides !== 4)) return null;
  return {
    arrangement: sides === 4 ? "quad" : "dual",
    pitchMm,
    family: part.packageType,
    source: "the recommended footprint printed in this datasheet"
  };
}

function assemble(
  part: ResolvedPart,
  densityLevel: DensityLevel,
  land: LandPattern,
  definition: PadLayout
): FootprintGeometry {
  // The two rules that decide whether the pads can be PLACED at all. They were
  // below the table lookup and are now above both paths, because they are facts
  // about arranging pins, not about which table an entry came from.
  if (definition.arrangement === "dual" && part.pinCount % 2 !== 0 && !part.dimensions.vacantLeadSlot) {
    throw new FootprintUnavailableError(
      `${definition.family} is described here as two opposing rows, and ${part.pinCount} is an odd number of leads, so one row is a lead short. Which position it leaves empty is drawn on the pinout but was not read, and guessing it would put a lead where the package has none. No footprint is generated.`,
      SUPPORTED_PACKAGE_FAMILIES,
      [
        {
          field: "leadSides",
          label: `Which position on the short row is empty (1 to ${Math.ceil(part.pinCount / 2)})`,
          why: `${part.partNumber} has ${part.pinCount} leads in two rows, so one row has a gap. The pinout drawing shows where; it was not read here.`,
          unit: "mm",
          scope: "part"
        }
      ]
    );
  }
  if (definition.arrangement === "quad" && part.pinCount % 4 !== 0) {
    throw new FootprintUnavailableError(
      `${definition.family} has four rows of leads, and ${part.pinCount} does not divide equally between them. Which side carries the odd lead is a package convention rather than something the pitch implies, so no footprint is generated.`,
      SUPPORTED_PACKAGE_FAMILIES
    );
  }

  const byNumber = pinByNumber(part);
  const pads: Pad[] = [];
  const quad = definition.arrangement === "quad";

  // Leads per side, which on a quad is a quarter of the count and on a dual is
  // half of it. The span between the first and last lead of one side follows.
  const perSideCount = quad ? part.pinCount / 4 : Math.ceil(part.pinCount / 2);
  const rowSpanMm = (perSideCount - 1) * definition.pitchMm;

  const push = (number: number | null, xMm: number, yMm: number, along: "x" | "y") => {
    // A vacant grid position gets no pad. The slot still consumes its place in
    // the row, which is the whole point: the leads either side of it keep their
    // real positions.
    if (number === null) return;
    const pin = byNumber.get(String(number));
    pads.push({
      number: String(pin?.number ?? number),
      centre: { xMm, yMm },
      // A land is LONG in the direction the lead runs, which is outward from the
      // body. On the left and right sides that is x; on the top and bottom it is
      // the same land turned 90 degrees, which needs no rotation field because a
      // land is an axis-aligned rectangle.
      widthMm: along === "x" ? land.padLengthMm : land.padWidthMm,
      heightMm: along === "x" ? land.padWidthMm : land.padLengthMm,
      shape: "roundrect",
      mounting: "smd",
      // The datasheet's own mask clearance, when it printed one. Undefined and
      // not zero when it did not: "not stated" and "zero clearance" are
      // different instructions to a fabricator.
      ...(part.dimensions.solderMaskExpansionMm === null
        ? {}
        : { solderMaskMarginMm: part.dimensions.solderMaskExpansionMm })
    });
  };

  // The thermal land, last, so its pad number follows the numbered leads.
  //
  // Numbered from the pin table where the datasheet gives the pad a designator,
  // and `pinCount + 1` where it does not, which is the convention every CAD tool
  // expects. The paste is an ARRAY rather than the copper outline; see
  // `thermalPadLand` for why 1:1 paste is a defect rather than a simplification.
  const emitThermalPad = () => {
    if (!part.exposedPad) return;
    const length = part.dimensions.thermalPadLengthMm;
    const width = part.dimensions.thermalPadWidthMm;
    if (length === null || width === null) return;

    let thermal: ThermalPadLand;
    try {
      thermal = thermalPadLand(length, width);
    } catch (error) {
      if (error instanceof LandPatternError) throw new FootprintUnavailableError(error.message);
      throw error;
    }

    const designator = part.pins.find((pin) => !/^\d+$/.test(pin.number))?.number;
    pads.push({
      number: designator ?? String(part.pinCount + 1),
      centre: { xMm: 0, yMm: 0 },
      widthMm: thermal.widthMm,
      heightMm: thermal.heightMm,
      shape: "roundrect",
      mounting: "smd",
      pasteApertures: thermal.apertures.map((aperture) => ({
        centre: { xMm: aperture.xMm, yMm: aperture.yMm },
        widthMm: aperture.widthMm,
        heightMm: aperture.heightMm
      }))
    });
  };

  /** Position of the nth lead along its own side, measured from the centre. */
  const step = (index: number) => -rowSpanMm / 2 + index * definition.pitchMm;

  if (quad) {
    const { left, bottom, right, top } = quadRowSides(part.pinCount);

    // Counterclockwise from the top of the left side. `+y` is DOWN here, so the
    // left side runs down the page, the bottom runs left to right, and the right
    // and top run back the other way; see `quadRowSides`.
    left.forEach((number, index) => push(number, -land.padCentreMm, step(index), "x"));
    bottom.forEach((number, index) => push(number, step(index), land.padCentreMm, "y"));
    right.forEach((number, index) => push(number, land.padCentreMm, -step(index), "x"));
    top.forEach((number, index) => push(number, -step(index), -land.padCentreMm, "y"));
  } else {
    const { left, right } = dualRowSides(part.pinCount, part.dimensions.vacantLeadSlot);
    left.forEach((number, index) => push(number, -land.padCentreMm, step(index), "x"));
    right.forEach((number, index) => push(number, land.padCentreMm, step(index), "x"));
  }

  emitThermalPad();

  // THERMAL VIAS, on the grid the datasheet prints.
  //
  // 30 of 46 corpus datasheets state these and nothing carried them into an
  // output until 2026-08-13. For an exposed-pad part they are not decoration:
  // the pad is soldered to the board to move heat, and without vias the heat
  // has nowhere to go. TI's own drawing says so directly, "This package is
  // designed to be soldered to a thermal pad on the board".
  //
  // The grid is filled from the centre outwards so it stays symmetric at any
  // count, and clipped to sit fully within the pad: a via crossing the pad edge
  // would wick solder off the joint.
  const thermalVias: ThermalVia[] = [];
  const viaDrill = part.dimensions.thermalViaDiameterMm;
  const viaPitch = part.dimensions.thermalViaPitchMm;
  const padL = part.dimensions.thermalPadLengthMm;
  const padW = part.dimensions.thermalPadWidthMm;
  if (part.exposedPad && viaDrill && viaPitch && viaPitch > 0 && padL && padW) {
    const viaPad = viaDrill * 2;
    // How many fit, leaving a full annulus inside the pad edge on every side.
    const fit = (extent: number) => Math.max(1, Math.floor((extent - viaPad) / viaPitch) + 1);
    const nx = fit(padL);
    const ny = fit(padW);
    for (let ix = 0; ix < nx; ix += 1) {
      for (let iy = 0; iy < ny; iy += 1) {
        thermalVias.push({
          centre: {
            xMm: (ix - (nx - 1) / 2) * viaPitch,
            yMm: (iy - (ny - 1) / 2) * viaPitch
          },
          drillMm: viaDrill,
          padMm: viaPad
        });
      }
    }
  }

  // The silkscreen body follows the extracted dimensions where they are known and
  // the land extents otherwise. It is decoration; the pads are the instruction.
  //
  // A quad package is square by construction here, and BOTH of its extents are
  // bounded by lands rather than by one row of them, so the dual fallbacks do not
  // describe it: `rowSpanMm` is one side's lead span, which is smaller than the
  // body, and `gMinMm` is the gap between two opposing rows in one axis only.
  // The inner gap is the right fallback for both axes on a quad, because all four
  // rows sit the same distance out.
  const bodyHalfLengthMm = quad
    ? (part.dimensions.bodyLengthMm ?? land.gMinMm) / 2
    : (part.dimensions.bodyLengthMm ?? rowSpanMm + definition.pitchMm) / 2;
  const bodyHalfWidthMm = (part.dimensions.bodyWidthMm ?? land.gMinMm) / 2;

  return {
    name: `${slugify(part.partNumber)}-${slugify(definition.family)}`,
    // What the pads actually ARE, stated as the claim it is. "The manufacturer
    // recommends this footprint" and "we derived this from IPC-7351B" are
    // different assertions, and a reviewer signing off a board is entitled to
    // know which one they are being handed.
    description:
      land.source === "printed"
        ? `${part.partNumber} ${definition.family}. Lands are the RECOMMENDED FOOTPRINT PRINTED IN THIS DATASHEET (${land.padLengthMm} x ${land.padWidthMm} mm on a ${(land.padCentreMm * 2).toFixed(3)} mm centre span), not computed from a standard. Courtyard uses IPC-7351B density ${densityLevel}.`
        : `${part.partNumber} ${definition.family}, IPC-7351B density level ${densityLevel}. Lead data: ${definition.source}`,
    partNumber: part.partNumber,
    pads,
    body: { halfWidthMm: bodyHalfWidthMm, halfHeightMm: bodyHalfLengthMm },
    // The keep-out has to clear the LANDS, and on a quad they reach the same
    // distance out on all four sides. Taking the height from the body, as the
    // dual case does, would draw a courtyard inside the top and bottom lands.
    courtyard: {
      halfWidthMm: land.courtyardHalfMm,
      halfHeightMm: quad ? land.courtyardHalfMm : bodyHalfLengthMm + 0.25
    },
    // Outside pin 1, which sits at the top of the LEFT side on both arrangements.
    pin1Marker: {
      xMm: -land.padCentreMm,
      yMm: -rowSpanMm / 2 - definition.pitchMm * 0.7
    },
    thermalVias,
    provenance: {
      family: definition.family,
      source: definition.source,
      densityLevel,
      padWidthMm: Number(land.padWidthMm.toFixed(3)),
      padLengthMm: Number(land.padLengthMm.toFixed(3)),
      centreToCentreMm: Number((land.padCentreMm * 2).toFixed(3)),
      pitchMm: definition.pitchMm
    }
  };
}



/**
 * Raised when a format has no generator yet.
 *
 * This is a refusal, not a degraded export. The previous behaviour emitted
 * `<part>.altium.symbol.txt` containing the KiCad text under a header saying it
 * was not really an Altium file, which is worse than nothing: it looks like a
 * deliverable in a file listing and it is not one.
 */
export class GeneratorUnavailableError extends Error {
  constructor(
    readonly format: ExportFormat,
    readonly available: ExportFormat[]
  ) {
    super(
      `No native ${format} generator exists yet. Forge does not emit a renamed file from another tool in its place. Available today: ${available.join(", ")}.`
    );
    this.name = "GeneratorUnavailableError";
  }
}

// Content is text for the formats that are text and bytes for the formats that
// are not. Altium's libraries are OLE compound files, so widening this was
// unavoidable; the alternative is a base64 round trip that hides what the file
// actually is.
type GeneratedFile = { name: string; content: string | Buffer };
type Generator = (
  baseName: string,
  symbol: SymbolGeometry,
  footprint: FootprintGeometry,
  /** The package solid, for formats that can carry it inside the library. */
  step: { name: string; text: string }
) => GeneratedFile[];

/**
 * The format generators, as peers.
 *
 * Adding Altium or Cadence means adding an entry here that reads the same
 * geometry. Neither will be derived from the KiCad output; see emitters/kicad.ts
 * for why that distinction is load-bearing.
 */
const GENERATORS: Partial<Record<ExportFormat, Generator>> = {
  // The footprint goes in a `.pretty` folder rather than loose, because that is
  // the shape KiCad expects a footprint library to have. Adding that folder gives
  // it the nickname `baseName` by default, which is exactly the nickname the
  // symbol's Footprint property names, so the link resolves without the user
  // typing anything.
  kicad: (baseName, symbol, footprint) => [
    {
      name: `${baseName}.kicad_sym`,
      content: emitKicadSymbol(symbol, { footprintRef: `${baseName}:${footprint.name}` })
    },
    {
      name: `${baseName}.pretty/${footprint.name}.kicad_mod`,
      content: emitKicadFootprint(footprint, { modelPath: `\${KIPRJMOD}/${baseName}.step` })
    }
  ],
  // Altium embeds the 3D body inside the footprint library, so the one file
  // carries copper and solid together and nothing has to be attached by hand.
  altium: (baseName, symbol, footprint, step) => [
    { name: `${baseName}.SchLib`, content: emitAltiumSchLib(symbol, { footprintName: footprint.name }) },
    { name: `${baseName}.PcbLib`, content: emitAltiumPcbLib(footprint, { stepModel: step }) }
  ]
};

export interface ExportOptions {
  /** IPC-7351B density level. B is the standard's default. */
  densityLevel?: DensityLevel;
  /**
   * Seated toe-to-toe span in mm for a package whose leads the assembler trims
   * and forms, i.e. ceramic flat packs. Required for those families and ignored
   * for the rest, whose span is fixed by the package.
   */
  formedLeadSpanMm?: number;
  /** Answers to what the datasheet did not print. See SuppliedDimensions. */
  supplied?: SuppliedDimensions;
}

export async function createExportZip(
  part: ResolvedPart,
  format: ExportFormat,
  options: ExportOptions = {}
) {
  const zip = new JSZip();
  const baseName = slugify(part.partNumber);
  // THE JOINT, not the part.
  //
  // Density level IS the solder fillet choice: A is the most material, C the
  // least, and IPC-7351B publishes different fillet goals for each. It is a
  // property of the assembly process rather than of the component, which is why
  // no datasheet states it and why it cannot be derived from one.
  //
  // So it comes from a setting, and only defaults to the industry nominal when
  // nobody has chosen. Hardcoding it silently made a process decision on the
  // user's behalf on every part ever generated; the default is the same value,
  // but it is now a default rather than a fact.
  const densityLevel = options.densityLevel ?? settingsDefault().densityLevel ?? "B";
  const stepModel = buildStepModel(part);
  const files: GeneratedFile[] = [];

  // The geometry is computed once, in no particular format. Deliberately NOT
  // wrapped in a try/catch: a footprint that cannot be built to the standard must
  // fail the export, not degrade it. A bundle that quietly ships a symbol and a
  // 3D body while omitting the footprint reads as success to anyone who does not
  // check the file list.
  const footprint = buildFootprintGeometry(part, densityLevel, options.formedLeadSpanMm, options.supplied);
  const symbol = buildSymbolGeometry(part);

  // One generator per format, each reading the geometry above and nothing else.
  // Formats are peers: none is produced by converting another.
  const generator = GENERATORS[format];
  if (!generator) {
    throw new GeneratorUnavailableError(format, Object.keys(GENERATORS) as ExportFormat[]);
  }
  files.push(...generator(baseName, symbol, footprint, { name: stepModel.fileName, text: stepModel.content }));

  files.push({ name: stepModel.fileName, content: stepModel.content });
  files.push({
    name: `${baseName}.json`,
    content: JSON.stringify(
      {
        ...part,
        exportFormat: format,
        footprint: footprint.provenance,
        stepSupported: stepModel.supported,
        stepNote: stepModel.note
      },
      null,
      2
    )
  });

  zip.file(
    "manifest.json",
    JSON.stringify(
      {
        partNumber: part.partNumber,
        manufacturer: part.manufacturer,
        exportFormat: format,
        generatedAt: new Date().toISOString(),
        // The footprint is the file someone will fabricate from, so the manifest
        // states what it was computed from rather than making them open it.
        footprint: footprint.provenance,
        files: files.map((file) => file.name)
      },
      null,
      2
    )
  );

  for (const file of files) {
    zip.file(file.name, file.content);
  }

  return {
    buffer: await zip.generateAsync({ type: "nodebuffer" }),
    stepSupported: stepModel.supported,
    stepNote: stepModel.note,
    footprint: footprint.provenance,
    files: files.map((file) => file.name)
  };
}
/**
 * What clicking a package in the chooser would actually do.
 *
 * ## Why this exists
 *
 * The chooser was offering packages nobody could build. Measured over the 45
 * cached datasheets on 2026-08-09: of 95 offered designators, 21 produced a
 * bundle, 7 produced one after a single number, and **67 produced nothing at
 * all**. Twenty-one parts offered a choice in which EVERY option was dead. A
 * TSV321 listed six packages and no click on any of them yielded a file.
 *
 * That is a worse failure than refusing outright. A refusal is information; a
 * live-looking dropdown that cannot answer is a promise the product does not
 * keep, and the user only finds out after choosing.
 *
 * ## What the measurement actually showed
 *
 * The obvious fix was to drop the dead entries, on the reasoning that we should
 * only offer packages the datasheet covers. The reason that is NOT what this
 * does is that none of the 67 were the datasheet's fault. They split two ways:
 *
 *   37  the record itself is incomplete (`pinCount,pins` or `pins`), so nothing
 *       would ship whichever package were picked. Not a property of the option.
 *   30  the family has no characterised land pattern here: QFN, SON, LGA, BGA,
 *       SOT, PDIP, MiniSO. Ours to close, and the datasheet describes them fine.
 *
 * So hiding them would hide our own two gaps behind a story about the document,
 * and the count of what we cannot build would stop being visible anywhere. The
 * honest version is to keep every package the document offers and say what each
 * one will do, which is what a person reading the datasheet themselves would
 * know before they clicked.
 *
 * ## Why it runs the real generator
 *
 * `buildFootprintGeometry` is the function the export calls. Asking it is the
 * only way this cannot drift from what actually happens on click; a predicate
 * that reimplemented the family table would eventually disagree with it, and it
 * would disagree by promising a footprint that then fails.
 */
export type PackageOptionStatus =
  /** Produces a bundle now. */
  | "ships"
  /** Produces one once the caller supplies `needs`. */
  | "needs-input"
  /** Cannot be built, for the reason given. */
  | "unsupported";

export interface PackageOption {
  designator: string;
  family: string;
  leadCount: number | null;
  status: PackageOptionStatus;
  /** Populated for `needs-input`, empty otherwise. */
  needs: RequiredInput[];
  /** Populated for `unsupported`, null otherwise. */
  reason: string | null;
}

export type PackageChoice =
  /**
   * The record cannot export whatever is chosen, so there is no choice to put.
   * `blockedBy` names the fields, which is what to show instead of a dropdown.
   */
  | { ok: false; blockedBy: string[] }
  | { ok: true; options: PackageOption[] };

/**
 * Runs the real footprint build for one designator and classifies the outcome.
 */
function optionFor(
  part: ResolvedPart,
  variant: { designator: string; family: string; leadCount: number | null },
  drawingIsThisPackage: boolean,
  formedLeadSpanMm?: number
): PackageOption {
  // The outline code and the drawn pitch and width were read off the ONE drawing
  // confirmed to match the extracted designator. Against a different package
  // they describe the wrong part of the document, so they are dropped there.
  // Keeping them for the package the record already resolved to is not
  // symmetry-breaking for its own sake: that is the package they were verified
  // against, and dropping them would report a worse answer than the export gives.
  const candidate: ResolvedPart = drawingIsThisPackage
    ? { ...part, packageType: variant.designator }
    : {
        ...part,
        packageType: variant.designator,
        packageOutlineCode: null,
        // Read for the RESOLVED package, so against a different one it is a
        // different drawing's land and would refuse a correct pattern.
        vendorLandPattern: null,
        dimensions: { ...part.dimensions, pitchMm: null, leadWidthMm: null }
      };

  const base = { designator: variant.designator, family: variant.family, leadCount: variant.leadCount };
  try {
    buildFootprintGeometry(candidate, "B", formedLeadSpanMm);
    return { ...base, status: "ships", needs: [], reason: null };
  } catch (error) {
    if (error instanceof FootprintUnavailableError) {
      return error.needs.length > 0
        ? { ...base, status: "needs-input", needs: error.needs, reason: null }
        : { ...base, status: "unsupported", needs: [], reason: error.reason };
    }
    // Anything else is a defect rather than a refusal, and reporting it as an
    // unbuildable package would bury it. It is still not allowed to fail the
    // parse, so it is reported in the option's own reason.
    return {
      ...base,
      status: "unsupported",
      needs: [],
      reason: error instanceof Error ? error.message : "The footprint generator failed."
    };
  }
}

/**
 * Every package the document offers this part, each with what it would produce.
 *
 * The record-level check runs ONCE rather than per option, because nothing in
 * `resolveForExport` reads the designator: a missing pin table blocks every
 * package equally, and reporting that against each option in turn would present
 * one problem as several and imply a different choice might avoid it.
 */
export function packageOptions(record: PartRecord, formedLeadSpanMm?: number): PackageChoice {
  const resolved = resolveForExport(record);
  if (!resolved.ok) {
    const blocked = resolved.missing.length > 0 ? resolved.missing : (resolved.untraceable ?? []);
    return { ok: false, blockedBy: blocked };
  }

  const chosen = record.packageType.value;
  return {
    ok: true,
    options: record.packageVariants.map((variant) =>
      optionFor(resolved.part, variant, variant.designator === chosen, formedLeadSpanMm)
    )
  };
}
