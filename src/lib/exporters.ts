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
  throughHolePad,
  type DensityLevel,
  type LandPattern,
  type LeadDimensions,
  type ThermalPadLand
} from "./ipc7351";
import { landDisagreements } from "./vendorland";
import {
  type FootprintGeometry,
  type Pad,
  type SymbolGeometry,
  type SymbolPin,
  type ThermalVia
} from "./geometry";
import { confidenceChecks, summariseChecks } from "./confidence";
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
    | "bodyLengthMm"
    | "bodyWidthMm"
    | "bodyHeightMm"
    | "formedLeadSpanMm"
    | "landPadLengthMm"
    | "landPadWidthMm"
    | "landSpanMm"
    | "leadDiameterMm"
    | "leadSides"
    | "pitchMm"
    | "leadsPerSide"
    | "thermalPadLengthMm"
    | "thermalPadWidthMm"
    | "vacantLeadSlot";
  /** Label for the input, in the user's language rather than the standard's. */
  label: string;
  /** Why no datasheet can answer it. Shown, not logged. */
  why: string;
  /**
   * What kind of answer this is, so the caller can offer the right input and
   * validate it.
   *
   * `mm` is a millimetre figure. `count` is a whole number of leads or a grid
   * position. `counts` is the comma-separated per-side list. Every ask used to
   * declare itself `mm`, including "which position is empty" and "how many
   * sides", which meant the one control the UI offered was a millimetre box for
   * a value that is neither.
   */
  unit: "mm" | "count" | "counts";
  scope: "install" | "part";
  /**
   * The page of THIS datasheet the answer is printed on, when we know it.
   *
   * The point of the whole ask is that the document usually has the answer and
   * we failed to read it. Sending someone to "the vendor's application note" for
   * a number printed on page 47 of the PDF they just uploaded is the friction
   * this removes: the page is rendered beside the input, and the answer takes
   * seconds instead of a hunt.
   *
   * Null is a real answer and not a gap. `formedLeadSpanMm` has no page because
   * no datasheet contains it: the manufacturer ships the leads straight and
   * never bends them, so the seated span is a property of the assembler. Showing
   * a page there would be a lie about where to look.
   */
  page?: number | null;
  /** What that page IS, so the user knows what they are being shown. */
  pageLabel?: string;
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
    /**
     * What the caller can supply to get their footprint.
     *
     * There used to be a `supportedFamilies` list beside this, taken from a
     * hand-typed table of package families. With that table gone the list has no
     * referent: what is supported is any package whose datasheet prints a
     * footprint, or whose drawing gives a lead span, width, foot and pitch. That
     * is a property of the document, not a set of names, so naming names would
     * describe a boundary that no longer exists.
     */
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

/**
 * What the 3D body needs, and what to ask for when the reading did not supply it.
 *
 * A 3D body exists to answer one question: does the part fit. Under a heatsink,
 * beside a connector, inside an enclosure.
 *
 * Until 2026-08-15 an unread dimension was GUESSED from the pin count
 * (`Math.max(pinCount * 0.8, 4.0)`), which is the same invented arithmetic the
 * footprint path deleted long ago; it survived here because nobody looked in the
 * STEP builder. For an 8-pin SOIC it shipped a 6.4 x 4.4 x 1.5 mm box for a part
 * that is 4.9 x 3.9 x 1.75 mm. That solid PASSES a clearance check it should
 * fail, and nothing in the file says the numbers were made up.
 *
 * Every one of the three is dimensioned on the package outline drawing, so an
 * absence here is a reading we did not get rather than a document that was
 * silent. Measured over 66 real records on 2026-08-15: 62 carry all three, so
 * this asks on four.
 */
function askForBody(part: ResolvedPart): RequiredInput[] {
  const why =
    `The 3D body is what a mechanical check runs against, so it is built from the package's real ` +
    `size and never from an approximation. These are dimensioned on the package outline drawing.`;
  const wanted: Array<[RequiredInput["field"], number | null, string]> = [
    ["bodyLengthMm", part.dimensions.bodyLengthMm, "Body length"],
    ["bodyWidthMm", part.dimensions.bodyWidthMm, "Body width"],
    ["bodyHeightMm", part.dimensions.bodyHeightMm, "Body height"]
  ];
  return wanted
    .filter(([, value]) => value === null)
    .map(([field, , label]) => ({ field, label, why, unit: "mm" as const, scope: "part" as const }));
}

function buildStepModel(part: ResolvedPart): { content: string; note: string; supported: boolean; fileName: string } {
  const lengthMm = part.dimensions.bodyLengthMm;
  const widthMm = part.dimensions.bodyWidthMm;
  const heightMm = part.dimensions.bodyHeightMm;
  if (lengthMm === null || widthMm === null || heightMm === null) {
    // Unreachable from `createExportZip`, which asks first. Kept so a direct
    // caller cannot reintroduce a guessed solid by another route.
    throw new FootprintUnavailableError("The package body size was not read, so no 3D body is built.", askForBody(part));
  }
  const halfLength = lengthMm / 2;
  const halfWidth = widthMm / 2;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "");

  // THE BOARD SURFACE IS z = 0, AND THE PART SITS ON TOP OF IT.
  //
  // This body used to span -h/2 to +h/2, which centres it on the board plane and
  // buries half the package inside the PCB. Both KiCad and Altium place a 3D
  // model with its origin at the footprint origin and the board at zero, so the
  // error is visible the moment anyone opens the 3D view, and a mechanical
  // clearance check run against it is wrong by half the package height.
  //
  // Nothing here is an approximation: a surface-mount part's body sits on its
  // leads and its underside is at the board surface. The one simplification is
  // that the solid is the package outline without the leads, which is what the
  // note in the bundle says it is.
  const baseZ = 0;
  const topZ = heightMm;

  const points = [
    [-halfLength, -halfWidth, baseZ],
    [halfLength, -halfWidth, baseZ],
    [halfLength, halfWidth, baseZ],
    [-halfLength, halfWidth, baseZ],
    [-halfLength, -halfWidth, topZ],
    [halfLength, -halfWidth, topZ],
    [halfLength, halfWidth, topZ],
    [-halfLength, halfWidth, topZ]
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
    { id: 60, origin: stepPoint(0, 0, baseZ), normal: [0, 0, -1], reference: [1, 0, 0], loop: [33, 32, 31, 30] },
    { id: 61, origin: stepPoint(0, 0, topZ), normal: [0, 0, 1], reference: [1, 0, 0], loop: [34, 35, 36, 37] },
    { id: 62, origin: stepPoint(0, -halfWidth, heightMm / 2), normal: [0, -1, 0], reference: [1, 0, 0], loop: [30, 39, 34, 38] },
    { id: 63, origin: stepPoint(0, halfWidth, heightMm / 2), normal: [0, 1, 0], reference: [1, 0, 0], loop: [32, 41, 36, 40] },
    { id: 64, origin: stepPoint(-halfLength, 0, heightMm / 2), normal: [-1, 0, 0], reference: [0, 1, 0], loop: [33, 40, 37, 38] },
    { id: 65, origin: stepPoint(halfLength, 0, heightMm / 2), normal: [1, 0, 0], reference: [0, 1, 0], loop: [31, 39, 35, 41] }
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
    note: `Generated a real STEP Part 21 solid for ${part.partNumber}. The model is the package body enclosure from the extracted dimensions, seated on the board plane at z=0, without leads.`,
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
 *
 * `perSide` is how many leads each side carries, in that same order. It is
 * REQUIRED rather than derived from the count, because a count that does not
 * divide by four does not say which sides are short, and dividing anyway is what
 * this function used to do: `pinCount / 4` on a 22-lead part gave 5.5, which
 * `Array.from({ length: 5.5 })` silently truncated to five leads a side, and
 * `index * 5.5 + step + 1` then numbered pads `6.5` and `17.5`. That footprint
 * was emitted without complaint: twenty pads for twenty-two pins, four of them
 * numbered for pins that do not exist.
 */
function quadRowSides(
  perSide: readonly [number, number, number, number]
): { left: number[]; bottom: number[]; right: number[]; top: number[] } {
  let next = 1;
  const take = (count: number) => Array.from({ length: count }, () => next++);
  return {
    left: take(perSide[0]),
    bottom: take(perSide[1]),
    right: take(perSide[2]),
    top: take(perSide[3])
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

  // EVERY PIN ON THE 100 MIL GRID.
  //
  // KLC S4.1: "using a 100mil (2.54mm) grid, pin origin must lie on a grid
  // node". Confirmed against the official `MCP2551-I-SN`, whose four left pins
  // sit at 5.08, 2.54, -2.54 and -5.08.
  //
  // This emitter used to centre the pin block on the origin, which puts an EVEN
  // number of rows on odd multiples of 1.27: an 8-pin part came out at +/-3.81
  // and +/-1.27, every pin half a grid step off. A schematic drawn on the
  // standard grid then cannot connect a wire to any of them without nudging.
  //
  // The fix is to keep the pins on grid and let the BODY sit 1.27 mm off centre
  // when the row count is even. A symbol's origin is a placement handle, not a
  // centre of mass, and the reference libraries do exactly this.
  const pitchMm = 2.54;
  const topMm = Math.floor((rows - 1) / 2) * pitchMm;
  const bottomMm = topMm - (rows - 1) * pitchMm;
  // A row of clearance above the top pin and below the bottom one.
  const bodyTopMm = topMm + pitchMm;
  const bodyBottomMm = bottomMm - pitchMm;
  const halfHeightMm = (bodyTopMm - bodyBottomMm) / 2;
  const centreMm = (bodyTopMm + bodyBottomMm) / 2;
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
        // Y is expressed relative to the body centre, which is what the emitters
        // draw the rectangle around; see `SymbolGeometry`.
        anchor: {
          xMm: side === "left" ? -(halfWidthMm + lengthMm) : halfWidthMm + lengthMm,
          // Absolute, and therefore on the 100 mil grid. The body moves to suit;
          // see `SymbolGeometry.bodyCentreYMm`.
          yMm: topMm - pitchMm * row
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
    bodyCentreYMm: centreMm,
    pins,
    // What a library entry carries besides its pins. See `SymbolGeometry`.
    description: symbolDescription(part),
    datasheetUrl: part.sourceUrl ?? null,
    keywords: [part.manufacturer, part.packageType].filter(Boolean).join(" ")
  };
}

/**
 * The one-line description every library symbol carries.
 *
 * Read off the reference symbols rather than invented: `AD8021AR` carries
 * "Operational Amplifier, 4.5-24V single/dual supply, low noise, high speed,
 * SOIC-8", and `24LC256` and `MCP2551-I-SN` carry one too. It is what KiCad's
 * symbol chooser searches and displays, so a library without it is a library
 * that can only be navigated by exact part number.
 *
 * Built from what the record actually holds. Nothing here is a claim about the
 * part's function, because no datasheet field we read states one: making one up
 * would be the invention this project exists not to do. What it does state is
 * the manufacturer, the package and the pin count, which is what a person
 * scanning a list needs to tell two entries apart.
 */
function symbolDescription(part: ResolvedPart): string {
  const pieces = [part.manufacturer, `${part.partNumber}`, part.packageType, `${part.pinCount} pins`];
  return pieces.filter((piece) => piece && piece !== "Unknown" && piece !== "Unknown package").join(", ");
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
      // ASKS rather than refuses. The size is printed on the package outline as
      // dimensions D2 and E2, so this is not a document that failed to say; it
      // is a read that failed to happen, and telling the user "no footprint is
      // generated" reports our gap as the datasheet's.
      const why =
        `${part.partNumber} has an exposed thermal pad, which is a mandatory soldered feature. ` +
        `Its size is dimensions D2 and E2 on the package outline drawing and was not read from this document.`;
      throw new FootprintUnavailableError(
        why,
        [
          ...(length === null
            ? [{ field: "thermalPadLengthMm" as const, label: "Exposed pad length (D2)", why, unit: "mm" as const, scope: "part" as const }]
            : []),
          ...(width === null
            ? [{ field: "thermalPadWidthMm" as const, label: "Exposed pad width (E2)", why, unit: "mm" as const, scope: "part" as const }]
            : [])
        ]
      );
    }
  }

  // THROUGH-HOLE, which is a different footprint entirely.
  //
  // A plated hole is not a land with a hole added: it is sized from the LEAD
  // DIAMETER by IPC-7251, sits on every copper layer, and has no paste at all.
  // Nothing in the surface-mount path below describes it, which is why
  // `Pad.mounting` admitted only `"smd"` until 2026-08-14 and a PDIP had nowhere
  // to go however well its datasheet was read.
  //
  // Routed on what the drawing SHOWS rather than on the package name. A `DIP`
  // and a `SOIC` differ in more than three letters, and a name-based rule is the
  // thing the deleted family table did.
  if (part.dimensions.mounting === "through-hole") {
    return throughHoleFootprint(part, densityLevel);
  }

  // THE DATASHEET'S OWN FOOTPRINT, FIRST.
  //
  // The rule this obeys: every number describing a part comes from that part's
  // datasheet, and where the document genuinely does not carry one we ask.
  //
  // 36 of 39 hold-out datasheets print a recommended footprint on a named page.
  // Until 2026-08-12 none of it reached the pads: the pattern was computed from
  // IPC-7351B and a hand-typed family table, and the vendor's own drawing was
  // read only to VETO that computation. So the document stated the answer, the
  // code derived a substitute from outside information, and then checked the
  // substitute against the answer it had thrown away.
  //
  // When the document states the pads, their span, the pitch and how many sides
  // carry leads, nothing is left for anything else to contribute. IPC-7351B
  // still computes the courtyard, which is arithmetic applied to these numbers
  // rather than a claim about this part.
  const layout = datasheetLayout(part);
  const printed = printedLand(part, densityLevel);

  if (printed && layout) {
    return assemble(part, densityLevel, printed, layout);
  }

  // DERIVED FROM THIS PART'S OWN PACKAGE DRAWING.
  //
  // The document prints a package outline but no recommended footprint, which
  // is the common case: 40 of 46 corpus datasheets print an outline and only 27
  // print a land pattern. An engineer in this position runs the IPC wizard in
  // Altium or KiCad, types the drawing's dimensions in, and takes the result.
  // This is that operation.
  //
  // Every input is from this datasheet. IPC-7351B supplies the arithmetic, not
  // a claim about the part, which is the line that separates it from the family
  // table this replaced: the table asserted lead spans it had invented.
  const drawnLead = leadFromDrawing(part, formedLeadSpanMm);
  if (drawnLead && layout) {
    try {
      const derived = computeLandPattern(drawnLead, { densityLevel });
      if (!contradictsPrintedLand(part, derived)) {
        return assemble(part, densityLevel, derived, {
          ...layout,
          source: `IPC-7351B density ${densityLevel}, computed from this datasheet's own package drawing`
        });
      }
    } catch (error) {
      if (!(error instanceof LandPatternError)) throw error;
      // Fall through to the questions below. A pattern that cannot be computed
      // from what was read is not a dead end: the user can read the land off a
      // vendor application note, and we cannot invent it.
    }
  }

  // Nothing in the document answered it, so ASK.
  //
  // There is deliberately no table underneath this. A hand-typed family table
  // supplying lead spans it had invented was the last thing standing here, and
  // it was not a hypothetical: measured 2026-08-13, all 12 parts then shipping
  // from the tuned corpus were fed by it, and it refused SOT-23, SOT-10, TSOT
  // and LFCSP outright. TLV9061 prints its whole footprint and was refused for
  // having a package name the table had never heard of.
  throw new FootprintUnavailableError(
    `No land pattern could be read for ${part.packageType} from this datasheet, and none is derived from anything outside it. Supply the land pattern and it will be built from your numbers.`,
    askForLandPattern(part, formedLeadSpanMm)
  );
}

/**
 * The largest a lead may be as a fraction of its pitch before the reading is
 * treated as a misread rather than as a strange package.
 *
 * Measured across every drawing read up to 2026-08-10: ISO7741 0.51/1.27,
 * INA240 0.30/0.65, ADS8688 0.23/0.5, ADS1115 0.30/0.5. The real ratio sits
 * between 40% and 60%, so three quarters clears all of them.
 *
 * What it catches: an ADS1115's DYN0010A drawing tags several max-over-min
 * pairs and a reader took `10X 0.45/0.25`, which is not the lead width. At 0.45
 * against a 0.5 pitch the leads would sit 0.05 mm apart, which no package does
 * and no stencil could print. Without this the part exported, and its pads came
 * out 0.44 mm longer and 0.22 mm wider than the pattern TI prints on page 55.
 */
const MAX_LEAD_WIDTH_FRACTION_OF_PITCH = 0.75;

/**
 * A through-hole footprint, from IPC-7251 and this part's own drawing.
 *
 * Two numbers do all the work: the lead diameter, which sizes the hole, and the
 * row spacing, which is what a through-hole drawing dimensions instead of a lead
 * span. Both are on the package outline; neither is invented, and a document
 * that states neither produces a question rather than a footprint.
 *
 * Pin 1 is a rectangular pad and the rest are round. That is the convention the
 * reference `DIP-8_W7.62mm` follows, and it is the only pin-1 mark that survives
 * on an assembled board where the silkscreen is under the part.
 */
function throughHoleFootprint(part: ResolvedPart, densityLevel: DensityLevel): FootprintGeometry {
  const lead = part.dimensions.leadDiameterMm;
  const pitchMm = part.dimensions.pitchMm;
  const rowSpacingMm = part.dimensions.landSpanMm ?? part.dimensions.leadSpanMm?.minMm ?? null;

  const needs: RequiredInput[] = [];
  const why =
    `${part.partNumber} mounts through the board, so its footprint is holes rather than lands. ` +
    `IPC-7251 sizes a hole from the lead it takes, and the row spacing is what the drawing gives ` +
    `in place of a lead span.`;
  // Each question names the field that ACTUALLY receives the answer.
  //
  // Two of these three named the wrong one when this path was written: the lead
  // diameter was asked for as `landPadWidthMm` and the pitch as
  // `landPadLengthMm`. Supplying either would have filled a land dimension and
  // left the value it was asked for still missing, so the same question would
  // come back forever. That is the identical defect the surface-mount asks had
  // until 2026-08-14, reintroduced within a day, and the rule-3 sweep is what
  // found it.
  if (lead === null) {
    needs.push({ field: "leadDiameterMm", label: "Lead diameter", why, unit: "mm", scope: "part" });
  }
  if (rowSpacingMm === null) {
    needs.push({ field: "landSpanMm", label: "Row spacing, centre to centre", why, unit: "mm", scope: "part" });
  }
  if (pitchMm === null) {
    needs.push({ field: "pitchMm", label: "Pin pitch along the row", why, unit: "mm", scope: "part" });
  }
  if (needs.length > 0 || lead === null || rowSpacingMm === null || pitchMm === null) {
    throw new FootprintUnavailableError(why, needs);
  }

  const hole = throughHolePad(lead, densityLevel);
  return assemble(
    part,
    densityLevel,
    {
      padWidthMm: hole.padMm,
      padLengthMm: hole.padMm,
      padCentreMm: rowSpacingMm / 2,
      zMaxMm: rowSpacingMm + hole.padMm,
      gMinMm: rowSpacingMm - hole.padMm,
      courtyardHalfMm: (rowSpacingMm + hole.padMm) / 2 + COURTYARD_EXCESS[densityLevel],
      densityLevel
    },
    {
      arrangement: "dual",
      pitchMm,
      family: part.packageType,
      source: `IPC-7251 density ${densityLevel}, from a ${lead} mm lead on a ${rowSpacingMm} mm row spacing read off this datasheet`
    },
    { drillMm: hole.drillMm }
  );
}

/**
 * The lead geometry IPC-7351B needs, taken from this part's OWN drawing.
 *
 * `span` is the tip-to-tip extent, `contact` the foot that sits on the pad
 * (drawing dimension L) and `width` the lead width. All three are printed on any
 * package outline and all three come from the document in front of us. This
 * replaced a hand-typed family table that asserted them per family name.
 *
 * The RANGES are used, not their midpoints. Collapsing a min-max pair to one
 * figure is the worked example of an assumption in `RULES.md`, and the standard
 * consumes the spread directly: it is one of the two inputs to the RSS term.
 *
 * ## Lead form decides whether there is an answer here at all
 *
 * `gullwing` computes. IPC-7351B publishes fillet goals per lead form and only
 * the gull-wing table is transcribed in `ipc7351.ts`.
 *
 * `straight` is a part that ships UNTRIMMED, which is nearly every rad-hard
 * ceramic flat pack: TI's HKU0010A drawing shows leads 22.7 mm tip to tip on a
 * 7 mm body, and the assembler trims and forms them. Its seated span is a
 * property of the board process, so the drawing's span is not the answer and
 * feeding it in would place every pad 8 mm too far out. The caller supplies the
 * formed span instead, and it is taken as an exact figure rather than widened by
 * an invented process tolerance.
 *
 * `nolead` and an UNREAD form both return null. An unread form is not an
 * assumption of gull-wing: applied to a no-lead package the gull-wing model
 * computes a fillet around a lead that does not exist, and the result looks
 * entirely plausible in CAD.
 */
function leadFromDrawing(part: ResolvedPart, formedLeadSpanMm?: number): LeadDimensions | null {
  const form = part.dimensions.leadForm;
  const width = part.dimensions.leadWidthMm;
  const contact = part.dimensions.leadContactMm;
  if (!width || !contact) return null;

  const span =
    form === "straight"
      ? formedLeadSpanMm && Number.isFinite(formedLeadSpanMm) && formedLeadSpanMm > 0
        ? { minMm: formedLeadSpanMm, maxMm: formedLeadSpanMm }
        : null
      : form === "gullwing"
        ? part.dimensions.leadSpanMm
        : null;
  if (!span || span.minMm <= 0 || span.maxMm < span.minMm) return null;
  if (width.minMm <= 0 || width.maxMm < width.minMm) return null;

  // A lead cannot occupy most of the pitch that separates it from its
  // neighbour. See MAX_LEAD_WIDTH_FRACTION_OF_PITCH.
  const pitchMm = part.dimensions.pitchMm;
  if (pitchMm && pitchMm > 0 && width.maxMm > MAX_LEAD_WIDTH_FRACTION_OF_PITCH * pitchMm) return null;

  return {
    form: "gullwing",
    span,
    contact: { minMm: contact.minMm, maxMm: contact.maxMm },
    width: { minMm: width.minMm, maxMm: width.maxMm }
  };
}

/**
 * Refuses a computed pattern the datasheet's own printed one contradicts.
 *
 * The only independent check a drawing-derived pattern has. Every number came
 * from one drawing read minutes ago, and if the page two sheets later prints a
 * different land, the reading or the lead form is wrong.
 *
 * It is what caught the ADS1115 without anyone naming a package family: its
 * inputs were all correct and hand-verified, its lead form was not, and the
 * computed land came out 0.44 mm from the 0.82 mm TI prints on page 55. The same
 * check clears an ADS8688 landing 0.02 mm from its own printed pattern.
 */
function contradictsPrintedLand(part: ResolvedPart, land: LandPattern): boolean {
  const printed = part.vendorLandPattern?.valuesMm;
  if (!printed || printed.length === 0) return false;
  return landDisagreements(printed, land).length > 0;
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
 * Numerical slack on the band edges, in mm. NOT a judgment about patterns.
 *
 * The practitioner rule is stated without slack: a pattern "between the Least
 * and Most density level" is acceptable. This was 0.3 mm, a number I chose by
 * reasoning rather than measuring, which made it the one invented figure left
 * in the footprint path.
 *
 * Measured 2026-08-13 across every TUNED part with both a printed pattern and
 * lead dimensions on file: 8 of 8 vendor patterns fall inside the raw band with
 * zero slack. The band does not need widening to admit real footprints, so it
 * is not widened.
 *
 * What remains is 10 microns of floating-point tolerance, which is two orders
 * of magnitude below anything a fabricator can hold and cannot admit a misread.
 *
 * Deliberately measured on the tuned set alone. Four hold-out parts also had the
 * numbers on file and three of them fell outside; using those to pick a
 * threshold would be tuning against the hold-out, which is the one thing that
 * corpus exists to prevent.
 */
const BAND_TOLERANCE_MM = 0.01;

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
  bodyLengthMm?: number;
  bodyWidthMm?: number;
  bodyHeightMm?: number;
  landPadLengthMm?: number;
  landPadWidthMm?: number;
  landSpanMm?: number;
  leadDiameterMm?: number;
  pitchMm?: number;
  leadSides?: 2 | 4;
  leadsPerSide?: string;
  thermalPadLengthMm?: number;
  thermalPadWidthMm?: number;
  vacantLeadSlot?: number;
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
      bodyLengthMm: fill(part.dimensions.bodyLengthMm, supplied.bodyLengthMm),
      bodyWidthMm: fill(part.dimensions.bodyWidthMm, supplied.bodyWidthMm),
      bodyHeightMm: fill(part.dimensions.bodyHeightMm, supplied.bodyHeightMm),
      landPadLengthMm: fill(part.dimensions.landPadLengthMm, supplied.landPadLengthMm),
      landPadWidthMm: fill(part.dimensions.landPadWidthMm, supplied.landPadWidthMm),
      landSpanMm: fill(part.dimensions.landSpanMm, supplied.landSpanMm),
      leadDiameterMm: fill(part.dimensions.leadDiameterMm, supplied.leadDiameterMm),
      pitchMm: fill(part.dimensions.pitchMm, supplied.pitchMm),
      leadSides: fill(part.dimensions.leadSides, supplied.leadSides),
      leadsPerSide: fill(part.dimensions.leadsPerSide, supplied.leadsPerSide),
      thermalPadLengthMm: fill(part.dimensions.thermalPadLengthMm, supplied.thermalPadLengthMm),
      thermalPadWidthMm: fill(part.dimensions.thermalPadWidthMm, supplied.thermalPadWidthMm),
      vacantLeadSlot: fill(part.dimensions.vacantLeadSlot, supplied.vacantLeadSlot)
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
function askForLandPattern(part: ResolvedPart, formedLeadSpanMm?: number): RequiredInput[] {
  const needs: RequiredInput[] = [];

  // A part that ships with STRAIGHT leads is one question away, not four: its
  // drawing gives the lead width and the foot, and only the seated span depends
  // on how the assembler trims and forms them. Asked first, and asked alone,
  // because supplying it makes the rest derivable.
  //
  // This is nearly every rad-hard ceramic flat pack, so it is the opposite of a
  // corner case for this product's customers.
  if (part.dimensions.leadForm === "straight" && !formedLeadSpanMm) {
    return [
      {
        field: "formedLeadSpanMm",
        label: "Formed lead span, toe to toe",
        why: `${part.packageType} ships with its leads straight and the assembler trims and forms them, so the seated span is set by your process. No datasheet prints it, because the manufacturer never bends them.`,
        unit: "mm",
        // Once per assembler, not once per part. An assembler forms to a
        // convention and every flat pack they build uses it.
        scope: "install"
      }
    ];
  }

  const why =
    `This datasheet does not print a recommended footprint for ${part.packageType}, ` +
    `and no land pattern is derived from anything outside it. Take these three from the ` +
    `vendor's application note or your own library.`;

  // Where the answer is, when the document turned out to have it after all.
  //
  // `vendorLandPattern` is the page a land-pattern drawing was found on. It used
  // to be a veto: its callouts were compared against a computed pattern and the
  // part was refused on a disagreement, which meant asking the user for three
  // numbers printed on a page we had already located. Pointing at that page is
  // what the document being non-silent actually entitles them to.
  const landPage = part.vendorLandPattern?.page ?? null;
  const landLabel = "Recommended footprint printed in this datasheet";

  if (part.dimensions.landPadLengthMm === null) {
    needs.push({ field: "landPadLengthMm", label: "Land length, along the lead", why, unit: "mm", scope: "part", page: landPage, pageLabel: landLabel });
  }
  if (part.dimensions.landPadWidthMm === null) {
    needs.push({ field: "landPadWidthMm", label: "Land width, across the lead", why, unit: "mm", scope: "part", page: landPage, pageLabel: landLabel });
  }
  if (part.dimensions.landSpanMm === null) {
    needs.push({ field: "landSpanMm", label: "Centre-to-centre span between opposing rows", why, unit: "mm", scope: "part", page: landPage, pageLabel: landLabel });
  }
  if (part.dimensions.leadSides !== 2 && part.dimensions.leadSides !== 4) {
    needs.push({
      field: "leadSides",
      label: "Sides carrying leads (2 or 4)",
      why: `The package drawing shows this, but it was not read for ${part.packageType}. Two opposing rows is 2; leads on all four sides is 4.`,
      unit: "count",
      scope: "part"
    });
  }
  return needs;
}

/**
 * The per-side lead counts the drawing states, checked against the pin count.
 *
 * Null when unread or when it does not describe this part, which is the signal
 * to ask rather than to trust it: a list that sums to the wrong total is a
 * misread, and placing pads from it would put leads where the package has none.
 */
function sidesFrom(raw: string | null, pinCount: number, sides: number): number[] | null {
  if (!raw) return null;
  const counts = raw.split(",").map((piece) => Number(piece.trim()));
  if (counts.length !== sides) return null;
  if (counts.some((count) => !Number.isInteger(count) || count < 0)) return null;
  return counts.reduce((sum, count) => sum + count, 0) === pinCount ? counts : null;
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
  definition: PadLayout,
  /** Present for a through-hole part: the finished hole every pad carries. */
  hole?: { drillMm: number }
): FootprintGeometry {
  // The two rules that decide whether the pads can be PLACED at all. They were
  // below the table lookup and are now above both paths, because they are facts
  // about arranging pins, not about which table an entry came from.
  if (definition.arrangement === "dual" && part.pinCount % 2 !== 0 && !part.dimensions.vacantLeadSlot) {
    throw new FootprintUnavailableError(
      `${definition.family} is described here as two opposing rows, and ${part.pinCount} is an odd number of leads, so one row is a lead short. Which position it leaves empty is drawn on the pinout but was not read, and guessing it would put a lead where the package has none. No footprint is generated.`,
      [
        {
          // NOT `leadSides`, which is what this asked for until 2026-08-14. The
          // question is which grid position is empty and the answer went into a
          // field that counts how many sides carry leads, so supplying it left
          // the refusal exactly where it was.
          field: "vacantLeadSlot",
          label: `Which position on the short row is empty (1 to ${Math.ceil(part.pinCount / 2)})`,
          why: `${part.partNumber} has ${part.pinCount} leads in two rows, so one row has a gap. The pinout drawing shows where; it was not read here.`,
          unit: "count",
          scope: "part"
        }
      ]
    );
  }
  // How the leads divide between the four sides.
  //
  // READ FIRST. `leadsPerSide` is the drawing's own answer, and it is only asked
  // of the user when nothing could read it. Where the count divides by four and
  // the drawing said nothing, equal sides is not an assumption: four equal rows
  // is what "quad, and the count divides" means.
  //
  // The result is USED, which is the fix. It used to be computed, checked, and
  // then discarded by a pad placer that divided the count by four regardless.
  let quadSides: [number, number, number, number] | null = null;
  if (definition.arrangement === "quad") {
    const divided = sidesFrom(part.dimensions.leadsPerSide, part.pinCount, 4);
    if (divided) {
      quadSides = [divided[0], divided[1], divided[2], divided[3]];
    } else if (part.pinCount % 4 === 0) {
      const quarter = part.pinCount / 4;
      quadSides = [quarter, quarter, quarter, quarter];
    } else {
      const why =
        `${definition.family} has leads on four sides and ${part.pinCount} does not divide equally between them, ` +
        `so at least one side is short. Which side is drawn on the pinout, and it was not read from this document.`;
      throw new FootprintUnavailableError(why, [
        { field: "leadsPerSide", label: "Leads on each side from pin 1, e.g. 6,6,6,5", why, unit: "counts", scope: "part" }
      ]);
    }
  }

  const byNumber = pinByNumber(part);
  const pads: Pad[] = [];
  const quad = definition.arrangement === "quad";

  // The widest row, which is what the pin-1 marker and the silkscreen fall back
  // to. On a quad with unequal sides the four rows have different spans, so each
  // side is stepped from its OWN count; see `alongSide`.
  const perSideCount = quad ? Math.max(...quadSides!) : Math.ceil(part.pinCount / 2);
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
      shape: "roundrect" as "roundrect" | "circle",
      mounting: "smd" as "smd" | "through-hole",
      // The datasheet's own mask clearance, when it printed one. Undefined and
      // not zero when it did not: "not stated" and "zero clearance" are
      // different instructions to a fabricator.
      ...(part.dimensions.solderMaskExpansionMm === null
        ? {}
        : { solderMaskMarginMm: part.dimensions.solderMaskExpansionMm }),
      // A PLATED HOLE, which overrides the three above rather than adding to
      // them. Spread LAST on purpose: an earlier spread is silently overwritten
      // by the literal keys that follow it, which is exactly what happened on the
      // first attempt and produced a through-hole part whose pads all said `smd`.
      ...(hole
        ? {
            // Pin 1 rectangular and the rest round, as the reference DIP draws
            // them. On an assembled board this is the only pin-1 mark still
            // visible, because the silkscreen is under the part.
            shape: (number === 1 ? "roundrect" : "circle") as "roundrect" | "circle",
            mounting: "through-hole" as const,
            drillMm: hole.drillMm
          }
        : {})
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

  /**
   * Position of the nth lead along its own side, measured from that side's
   * centre line.
   *
   * Each side is centred on ITSELF rather than on the widest row, which is what
   * the packages do. Read off KiCad's QFN-38-1EP_4x6mm_P0.4mm: its long sides
   * carry twelve leads at -2.2 to +2.2 and its short sides seven at -1.2 to
   * +1.2, both symmetric about zero, with the odd count putting a lead on the
   * centre line. Same arrangement the 5-lead SOT-23 shows on a dual package.
   */
  const alongSide = (count: number, index: number) =>
    (index - (count - 1) / 2) * definition.pitchMm;
  /** The equal-row case, which is every dual package and most quads. */
  const step = (index: number) => -rowSpanMm / 2 + index * definition.pitchMm;

  if (quad) {
    const { left, bottom, right, top } = quadRowSides(quadSides!);

    // Counterclockwise from the top of the left side. `+y` is DOWN here, so the
    // left side runs down the page, the bottom runs left to right, and the right
    // and top run back the other way; see `quadRowSides`.
    const at = (side: number[], index: number) => alongSide(side.length, index);
    left.forEach((number, index) => push(number, -land.padCentreMm, at(left, index), "x"));
    bottom.forEach((number, index) => push(number, at(bottom, index), land.padCentreMm, "y"));
    right.forEach((number, index) => push(number, land.padCentreMm, -at(right, index), "x"));
    top.forEach((number, index) => push(number, -at(top, index), -land.padCentreMm, "y"));
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
      // The density level's own excess, not a hardcoded 0.25. They agree at
      // density B, which is why the constant survived unnoticed, and they differ
      // by a factor of four between A and C: a customer who chose level A to buy
      // solder-joint robustness was getting a courtyard sized for level B in one
      // axis and level A in the other.
      halfHeightMm: quad ? land.courtyardHalfMm : bodyHalfLengthMm + COURTYARD_EXCESS[densityLevel]
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

  // The user's answers are applied ONCE, here, so the footprint and the 3D body
  // see the same record. They used to be applied inside the footprint builder,
  // which meant a supplied body dimension never reached the solid.
  part = withSupplied(part, options.supplied);

  // EVERY question at once, rather than one per round trip.
  //
  // The footprint and the 3D body fail independently, and asking for one and then
  // the other turns a part needing four numbers into four separate refusals. The
  // user answers what is missing in one pass.
  const needs: RequiredInput[] = [];
  let footprint: FootprintGeometry | null = null;
  // The footprint's own reason, kept verbatim. It is the specific one, and it is
  // what a reader needs: "has an exposed thermal pad, which is a mandatory
  // soldered feature" says something a count of outstanding values does not.
  let reason: string | null = null;
  try {
    footprint = buildFootprintGeometry(part, densityLevel, options.formedLeadSpanMm);
  } catch (error) {
    // An UNANSWERABLE refusal is not a question and must not be softened into
    // one: it fails the export here, as it always has.
    if (!(error instanceof FootprintUnavailableError) || error.needs.length === 0) throw error;
    needs.push(...error.needs);
    reason = error.reason;
  }
  needs.push(...askForBody(part));
  if (needs.length > 0) {
    throw new FootprintUnavailableError(
      reason ??
        `${part.partNumber} is complete apart from its package body size, which the 3D model is built from.`,
      needs
    );
  }

  const stepModel = buildStepModel(part);
  const files: GeneratedFile[] = [];

  // A footprint that cannot be built to the standard fails the export rather
  // than degrading it. A bundle that quietly ships a symbol and a 3D body while
  // omitting the footprint reads as success to anyone who does not check the
  // file list.
  if (!footprint) throw new FootprintUnavailableError("No footprint was built.", []);
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

  // What was checked about this record, and what those checks found.
  //
  // In the manifest rather than only in the UI, because the manifest is what
  // travels with the files into someone else's library. A reviewer opening the
  // zip six months later can see which checks ran and which could not, without
  // re-reading the datasheet.
  const checks = confidenceChecks(part, densityLevel);

  zip.file(
    "manifest.json",
    JSON.stringify(
      {
        partNumber: part.partNumber,
        manufacturer: part.manufacturer,
        exportFormat: format,
        generatedAt: new Date().toISOString(),
        checks: { summary: summariseChecks(checks), detail: checks },
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
    checks,
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
 * The same part, relabelled as a DIFFERENT package, with everything that
 * described the old one removed.
 *
 * ## Why this is all-or-nothing
 *
 * Every geometric value on the record was read off the drawings for ONE
 * package: the one the document resolved to. Against a different designator
 * they describe the wrong pages. That was already understood for the outline
 * code, the pitch and the lead width, which two separate call sites each dropped
 * their own subset of. Neither dropped the three that matter most.
 *
 * `landPadLengthMm`, `landPadWidthMm` and `landSpanMm` come off the recommended
 * footprint drawing, and since 2026-08-12 they ARE the pads. Carrying them onto
 * another package meant the chooser reported `ships` for an option it would
 * build out of a different package's copper, and the export route built it.
 * `leadSides`, `leadsPerSide`, `vacantLeadSlot`, the thermal pad, the mask
 * expansion and the via grid are per-package in exactly the same way.
 *
 * So the rule is stated once, here, as a whitelist of what SURVIVES rather than
 * a list of what to drop. A field added to the record later is per-package until
 * someone says otherwise, which is the safe direction for the mistake to run in.
 *
 * The pin table survives because it is what the caller already has: a package
 * choice re-reads the document when the record is incomplete, and where it is
 * complete the pins were read for a named package and the caller is relabelling
 * it deliberately.
 */
export function asPackage(part: ResolvedPart, designator: string): ResolvedPart {
  if (designator === part.packageType) return part;
  const blank = Object.fromEntries(
    Object.keys(part.dimensions).map((key) => [key, null])
  ) as ResolvedPart["dimensions"];
  return {
    ...part,
    packageType: designator,
    packageOutlineCode: null,
    jedecOutline: null,
    vendorLandPattern: null,
    // A thermal pad belongs to one package of a family and not to its siblings.
    // Claiming the SOIC has the QFN's would refuse it; claiming the QFN lacks
    // the SOIC's would emit a footprint missing a mandatory soldered feature.
    exposedPad: false,
    dimensions: blank
  };
}

/**
 * Runs the real footprint build for one designator and classifies the outcome.
 */
function optionFor(
  part: ResolvedPart,
  variant: { designator: string; family: string; leadCount: number | null },
  drawingIsThisPackage: boolean,
  formedLeadSpanMm?: number
): PackageOption {
  const candidate = drawingIsThisPackage
    ? { ...part, packageType: variant.designator }
    : asPackage(part, variant.designator);

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
