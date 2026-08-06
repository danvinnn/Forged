import JSZip from "jszip";
import { type ExportFormat, type PinRecord, type ResolvedPart } from "./types";
import { computeLandPattern, LandPatternError, type DensityLevel, type LandPattern } from "./ipc7351";
import { resolvePackageDefinition, SUPPORTED_PACKAGE_FAMILIES, type PackageDefinition } from "./packages";
import {
  type FootprintGeometry,
  type FootprintProvenance,
  type Pad,
  type SymbolGeometry,
  type SymbolPin
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
  /** The `/api/export` request field that answers it. */
  field: "formedLeadSpanMm";
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

// KiCad s-expression strings are double-quoted with backslash escaping. Escape backslash and quote,
// and strip raw newlines so a value cannot open a new token on its own line.
function kicadString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
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
function dualRowSides(pinCount: number): { left: number[]; right: number[] } {
  const perSide = Math.ceil(pinCount / 2);
  const left: number[] = [];
  const right: number[] = [];

  for (let number = 1; number <= pinCount; number += 1) {
    if (number <= perSide) left.push(number);
    else right.push(number);
  }
  // The right column is read bottom to top, so reverse it into top-to-bottom
  // drawing order. This single line is the counterclockwise convention.
  right.reverse();

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
 * Builds the format-neutral symbol description.
 *
 * Pins keep their physical side rather than being sorted by electrical type. An
 * earlier version filtered inputs left and outputs right, then indexed both
 * sides off one running counter, so the two columns collided and outputs drifted
 * below the body. Grouping by function is a nicety; placing a pin at the wrong
 * coordinate is a defect.
 */
function buildSymbolGeometry(part: ResolvedPart): SymbolGeometry {
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
  collect(left, "left");
  collect(right, "right");

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
  formedLeadSpanMm?: number
): FootprintGeometry {
  // The package, checked against this part's own mechanical drawing. Shared with
  // the parse route so the land pattern the UI reports on is the one the export
  // actually builds; see resolvePackageDefinition.
  const lookup = resolvePackageDefinition(part.packageType, part.pinCount, {
    outlineCode: part.packageOutlineCode,
    pitchMm: part.dimensions.pitchMm,
    leadWidthMm: part.dimensions.leadWidthMm,
    leadSpanMm: part.dimensions.leadSpanMm,
    leadLengthMm: part.dimensions.leadLengthMm,
    leadContactMm: part.dimensions.leadContactMm
  });
  if (!lookup.ok) throw new FootprintUnavailableError(lookup.failure.reason, lookup.failure.supported);

  const definition: PackageDefinition = lookup.definition;

  // An ODD lead count means the two rows are not the same length, and where the
  // shorter row's missing position sits is a package convention this table does
  // not carry. On a five-lead SOT-23 (JEDEC MO-178) the two-lead side occupies
  // the OUTER positions and the middle one is empty; on a three-lead it is the
  // single lead that is centred. Those are different rules and neither follows
  // from the pitch.
  //
  // `dualRowSides` splits 5 into [1,2,3] and [5,4] correctly, and the pad loop
  // then indexes each row from its own top, which puts pin 4 in the middle-right
  // position that a real SOT-23-5 leaves empty. That is a miswired board rather
  // than a cosmetic defect, so it refuses. No characterised family has an odd
  // count today, which is why this has never fired; it exists so that adding one
  // cannot silently produce the wrong pad.
  if (definition.arrangement === "dual" && part.pinCount % 2 !== 0) {
    throw new FootprintUnavailableError(
      `${definition.family} is described here as two opposing rows, and ${part.pinCount} is an odd number of leads, so the rows are unequal. Which position the shorter row leaves empty is a package convention rather than something the pitch implies, and it is not recorded for this family, so no footprint is generated.`,
      SUPPORTED_PACKAGE_FAMILIES
    );
  }

  // The same rule one corner further round. A quad package divides its leads
  // equally between four sides, and a count that does not divide by four means
  // some side is short; which one, and where the gap sits, is a package
  // convention this table does not carry.
  if (definition.arrangement === "quad" && part.pinCount % 4 !== 0) {
    throw new FootprintUnavailableError(
      `${definition.family} has four rows of leads, and ${part.pinCount} does not divide equally between them. Which side carries the odd lead is a package convention rather than something the pitch implies, so no footprint is generated.`,
      SUPPORTED_PACKAGE_FAMILIES
    );
  }

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

  let land: LandPattern;
  try {
    land = computeLandPattern(lead, { densityLevel });
  } catch (error) {
    if (error instanceof LandPatternError) throw new FootprintUnavailableError(error.message);
    throw error;
  }

  const byNumber = pinByNumber(part);
  const pads: Pad[] = [];
  const quad = definition.arrangement === "quad";

  // Leads per side, which on a quad is a quarter of the count and on a dual is
  // half of it. The span between the first and last lead of one side follows.
  const perSideCount = quad ? part.pinCount / 4 : Math.ceil(part.pinCount / 2);
  const rowSpanMm = (perSideCount - 1) * definition.pitchMm;

  const push = (number: number, xMm: number, yMm: number, along: "x" | "y") => {
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
      mounting: "smd"
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
    const { left, right } = dualRowSides(part.pinCount);
    left.forEach((number, index) => push(number, -land.padCentreMm, step(index), "x"));
    right.forEach((number, index) => push(number, land.padCentreMm, step(index), "x"));
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
    description: `${part.partNumber} ${definition.family}, IPC-7351B density level ${densityLevel}. Lead data: ${definition.source}`,
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
}

export async function createExportZip(
  part: ResolvedPart,
  format: ExportFormat,
  options: ExportOptions = {}
) {
  const zip = new JSZip();
  const baseName = slugify(part.partNumber);
  const densityLevel = options.densityLevel ?? "B";
  const stepModel = buildStepModel(part);
  const files: GeneratedFile[] = [];

  // The geometry is computed once, in no particular format. Deliberately NOT
  // wrapped in a try/catch: a footprint that cannot be built to the standard must
  // fail the export, not degrade it. A bundle that quietly ships a symbol and a
  // 3D body while omitting the footprint reads as success to anyone who does not
  // check the file list.
  const footprint = buildFootprintGeometry(part, densityLevel, options.formedLeadSpanMm);
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