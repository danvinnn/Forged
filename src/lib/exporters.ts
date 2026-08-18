import JSZip from "jszip";
import {
  resolveForExport,
  type Citation,
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
import { declaredLeadCount, designatorToken, normaliseForMatch, outlineCodeDesignator, pinTableFor } from "./packagevariants";
import {
  type FootprintGeometry,
  type Pad,
  type SymbolGeometry,
  type SymbolPin,
  type ThermalVia
} from "./geometry";
import { confidenceChecks, FootprintInvalidError, summariseChecks, validateGeometry } from "./confidence";
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
    | "formedLeadContactMm"
    | "landPadLengthMm"
    | "landPadWidthMm"
    | "landSpanMm"
    | "landSpanCrossMm"
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
 * A check that threw DATA AWAY, recorded so it can be seen.
 *
 * ## Why a discard has to name itself
 *
 * Nearly every check below returns null rather than refusing, and the caller
 * then tells the user "no land pattern could be read for this package from this
 * datasheet". That sentence is true when the document is silent and FALSE when
 * the document printed a footprint and a check here rejected it, and until
 * 2026-08-16 the two were indistinguishable: to the user, to the bench, and to
 * anyone asking whether a given check still earns its place.
 *
 * That is the same shape as every other defect this product has had. An answer
 * arrives, something discards it, and the discard leaves no trace, so the
 * measurement blames the datasheet and the effort goes to reading harder.
 *
 * So a rejection is appended here, in the user's language, and the refusal
 * quotes it. Absence is NOT a discard: a document that never stated a land width
 * has nothing to throw away, and recording that would drown the signal.
 */
type Discards = string[];

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
function printedLand(
  part: ResolvedPart,
  densityLevel: DensityLevel,
  discards: Discards = [],
  /** Passed to the band check, which needs them for a straight-lead package. */
  formedLeadSpanMm?: number,
  formedLeadContactMm?: number
): LandPattern | null {
  const padLengthMm = part.dimensions.landPadLengthMm;
  const padWidthMm = part.dimensions.landPadWidthMm;
  const centreSpan = part.dimensions.landSpanMm;
  if (!padLengthMm || !padWidthMm || !centreSpan) return null;
  if (padLengthMm <= 0 || padWidthMm <= 0 || centreSpan <= 0) return null;

  // Opposing lands must not meet in the middle. If they would, one of the three
  // numbers describes something other than this footprint, and the drawing has
  // been misread rather than the package being strange.
  const gMinMm = centreSpan - padLengthMm;
  if (gMinMm <= 0) {
    discards.push(
      `the printed footprint was rejected: a ${padLengthMm} mm land on a ${centreSpan} mm centre span puts the ` +
        `two rows into each other, so one of the three was misread`
    );
    return null;
  }

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
  // A FINITE POSITIVE NUMBER or nothing. Tested for the value rather than
  // against null because a record can carry `undefined` here as easily as
  // `null` (an older stored part, a hand-built fixture, a partial object from
  // the export route) and `undefined / 2` is NaN, which then places lands at a
  // non-finite coordinate and makes the corner check silently unable to fire
  // (`x > NaN` is false). Both happened the first time this was written.
  //
  // Read BEFORE the band check so both axes can be checked against the
  // standard, rather than the main one alone.
  const rawCrossSpan = part.dimensions.landSpanCrossMm;
  const crossSpan = typeof rawCrossSpan === "number" && Number.isFinite(rawCrossSpan) ? rawCrossSpan : null;

  const band = withinIpcBand(part, padLengthMm, centreSpan, formedLeadSpanMm, formedLeadContactMm, crossSpan);
  if (band === false) {
    discards.push(
      `the printed footprint was rejected: it reaches ${(centreSpan + padLengthMm).toFixed(2)} mm toe to toe, ` +
        `outside what IPC-7351B's density levels would produce for the leads this drawing states`
    );
    return null;
  }

  const pitchMm = part.dimensions.pitchMm;
  // Neighbouring lands in one row sit a pitch apart, so a land WIDER than the
  // pitch would merge with the one beside it. No footprint does this.
  if (pitchMm && pitchMm > 0 && padWidthMm >= pitchMm) {
    discards.push(
      `the printed footprint was rejected: a ${padWidthMm} mm land on a ${pitchMm} mm pitch would touch its ` +
        `neighbour, so the land width or the pitch was misread`
    );
    return null;
  }


  // The OTHER axis, for a four-sided package that is not square. Range-checked
  // exactly like the main span, because it places copper on the same footing: a
  // cross span that puts the top and bottom rows through each other is a
  // misread, not an unusual package.
  if (crossSpan !== null && (crossSpan <= 0 || crossSpan - padLengthMm <= 0)) {
    discards.push(
      `the printed footprint was rejected: a ${padLengthMm} mm land on a ${crossSpan} mm cross-axis centre ` +
        `span puts the two rows into each other, so one of the two was misread`
    );
    return null;
  }

  // The WIDER axis governs the courtyard, which is a single half-extent. Using
  // the main span alone would draw a keep-out smaller than the copper whenever
  // the cross axis is the longer one, and a courtyard that does not contain its
  // own lands is the exact thing `validateGeometry` refuses.
  const zMaxMm = Math.max(centreSpan, crossSpan ?? 0) + padLengthMm;
  return {
    padWidthMm,
    padLengthMm,
    padCentreMm: centreSpan / 2,
    ...(crossSpan !== null && crossSpan !== centreSpan ? { padCentreCrossMm: crossSpan / 2 } : {}),
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

// STEP Part 21 strings are single-quoted, a literal single quote is escaped by
// doubling it, and BACKSLASH introduces Part 21's own control directives
// (`\X2\` and friends), so a stray one changes how a reader decodes the rest of
// the literal.
//
// EVERY control character, not three of them. The comment here said "control
// characters ... are stripped" while the code replaced `\r`, `\n` and `\t` only,
// so a designator carrying any other C0 character wrote it straight into the
// file. Both halves are now true: the whole C0 and C1 ranges go, and the escape
// introducer is doubled the way the standard doubles a quote.
function stepString(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "''");
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

/**
 * Exported so the solid's own invariants can be checked directly. The loop walk
 * inside it throws rather than writing a shell that does not close, and a test
 * that can only reach it through a zip cannot say which face failed.
 */
export function buildStepModel(part: ResolvedPart): { content: string; note: string; supported: boolean; fileName: string } {
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
    // A LINE's first argument is its point of origin, a CARTESIAN_POINT. This
    // passed `edge.start`, which is the VERTEX_POINT built ON that point, so
    // every line in the file referenced an entity of the wrong type. The points
    // are numbered 10..17 and their vertices 20..27, which is the offset undone
    // here rather than a second lookup table to keep in step.
    lines.push(`#${lineId}=LINE('',#${edge.start - 10},#${vectorId});`);
    lines.push(`#${edge.id}=EDGE_CURVE('',#${edge.start},#${edge.end},#${lineId},.T.);`);
  });

  /**
   * Walks a face's edge list head to tail and reports which way each edge runs.
   *
   * TWO defects made this necessary rather than a tidy-up.
   *
   * An `EDGE_LOOP` holds ORIENTED_EDGE entities, not EDGE_CURVE ones: an edge is
   * shared by exactly two faces and runs the opposite way round each of them, so
   * the orientation flag is what makes the shell closed rather than a bag of
   * curves. This wrote the EDGE_CURVE ids straight into the loop.
   *
   * And two of the six faces named an edge that is not on them: the -x face
   * carried the vertical edge at +x and the +x face carried the one at -x, so
   * the shell did not close. That is invisible in the text and immediate the
   * moment a CAD tool tries to sew the solid.
   *
   * Derived by walking rather than tabulated, so the orientations cannot drift
   * from the loops, and a loop that does not close throws instead of writing an
   * invalid solid. That is the only honest option here: a body a tool refuses to
   * open is worse than none.
   */
  const orientedLoop = (faceId: number, loop: number[]): Array<{ edge: number; sense: boolean }> => {
    const byId = new Map(edges.map((edge) => [edge.id, edge]));
    const first = byId.get(loop[0]);
    if (!first) throw new Error(`STEP face ${faceId} names edge ${loop[0]}, which does not exist.`);
    // The first edge sets the direction of travel: take it forwards, unless that
    // leaves the second edge unreachable from either of its ends.
    const second = byId.get(loop[1]);
    if (!second) throw new Error(`STEP face ${faceId} names edge ${loop[1]}, which does not exist.`);
    let at = second.start === first.end || second.end === first.end ? first.end : first.start;
    const forwards = at === first.end;
    const walked: Array<{ edge: number; sense: boolean }> = [{ edge: first.id, sense: forwards }];

    for (const id of loop.slice(1)) {
      const edge = byId.get(id);
      if (!edge) throw new Error(`STEP face ${faceId} names edge ${id}, which does not exist.`);
      if (edge.start === at) {
        walked.push({ edge: id, sense: true });
        at = edge.end;
      } else if (edge.end === at) {
        walked.push({ edge: id, sense: false });
        at = edge.start;
      } else {
        throw new Error(
          `STEP face ${faceId} is not a closed loop: edge ${id} runs ${edge.start} to ${edge.end} and the ` +
            `loop had reached vertex ${at}, so this face names an edge that is not on it.`
        );
      }
    }
    const closedAt = forwards ? first.start : first.end;
    if (at !== closedAt) {
      throw new Error(`STEP face ${faceId} does not close: the loop ends at vertex ${at} and began at ${closedAt}.`);
    }
    return walked;
  };

  const faces = [
    { id: 60, origin: stepPoint(0, 0, baseZ), normal: [0, 0, -1], reference: [1, 0, 0], loop: [33, 32, 31, 30] },
    { id: 61, origin: stepPoint(0, 0, topZ), normal: [0, 0, 1], reference: [1, 0, 0], loop: [34, 35, 36, 37] },
    { id: 62, origin: stepPoint(0, -halfWidth, heightMm / 2), normal: [0, -1, 0], reference: [1, 0, 0], loop: [30, 39, 34, 38] },
    { id: 63, origin: stepPoint(0, halfWidth, heightMm / 2), normal: [0, 1, 0], reference: [1, 0, 0], loop: [32, 41, 36, 40] },
    // Vertical edge 41 joins vertices 23 and 27, both at x = -halfLength, so it
    // belongs to THIS face; 40 joins 22 and 26 at x = +halfLength and belongs to
    // the one below. The two were the wrong way round, so neither face closed
    // and the shell was not a solid. Caught by the loop walk above.
    { id: 64, origin: stepPoint(-halfLength, 0, heightMm / 2), normal: [-1, 0, 0], reference: [0, 1, 0], loop: [33, 41, 37, 38] },
    { id: 65, origin: stepPoint(halfLength, 0, heightMm / 2), normal: [1, 0, 0], reference: [0, 1, 0], loop: [31, 40, 35, 39] }
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
    const oriented = orientedLoop(face.id, face.loop);
    oriented.forEach((step, index) => {
      lines.push(
        `#${face.id * 10 + index}=ORIENTED_EDGE('',*,*,#${step.edge},${step.sense ? ".T." : ".F."});`
      );
    });
    lines.push(
      `#${loopId}=EDGE_LOOP('',(${oriented.map((_, index) => `#${face.id * 10 + index}`).join(",")}));`
    );
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
  // sit on grid nodes 2.54 mm apart.
  //
  // The exact coordinates the reference uses are NOT what this produces and the
  // comment used to quote them as though they were: it cited 5.08, 2.54, -2.54,
  // -5.08 for a four-row symbol, and `topMm` below puts four rows at 2.54, 0,
  // -2.54, -5.08. Both are on the grid, which is the property KLC states and the
  // only one that matters; quoting a set of numbers the code does not emit
  // invites the next reader to "fix" a symbol that is already correct.
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
  supplied?: SuppliedDimensions,
  formedLeadContactMm?: number
): FootprintGeometry {
  part = withSupplied(part, supplied);

  // THE PACKAGE NAME AND THE PIN TABLE HAVE TO AGREE.
  //
  // A designator that states its own lead count is a fact about the package, and
  // a pin table with a different number of rows belongs to a different one.
  // Building from the pair produces a footprint with the wrong number of pads
  // under the right name, which is the defect this product can least afford: it
  // looks entirely ordinary in CAD and no confidence check covers it, because
  // every check runs on the inputs and the inputs are individually fine.
  //
  // Placed here rather than at any of the three call sites, because all three
  // reached it: the package chooser, `/api/export` with a `packageType`
  // override, and the UI relabel, which until 2026-08-16 answered a package
  // click with "the pinout was already read, so it was kept". `asPackage` now
  // swaps in the right table where the document printed one; this refuses what
  // is left rather than trusting that it did.
  //
  // `declaredLeadCount` answers null wherever the number in a name is not a lead
  // count, which is what stops this refusing correct parts: SOT-223, TO-220,
  // TO-92, SOT-563, SOD-123 and 2N2222 all answer null.
  const declared = declaredLeadCount(part.packageType);
  if (declared !== null && declared !== part.pinCount) {
    throw new FootprintUnavailableError(
      `${part.packageType} is a ${declared}-lead package and the pin table read from this datasheet has ` +
        `${part.pinCount} pins, so the two describe different packages. This document covers several, and the ` +
        `pinout on the record belongs to one of the others. Re-read the datasheet for ${part.packageType} to ` +
        `get its own pinout; no footprint is generated from a pin table that is not this package's.`,
      []
    );
  }

  // THE PACKAGE NAME AND THE OUTLINE DRAWING HAVE TO AGREE, for the same reason
  // and in the case the lead-count check above CANNOT reach.
  //
  // That check compares a declared lead count against the pin table, so it is
  // blind whenever the two packages have the same number of leads. Measured
  // 2026-08-17: asked for MAX232 in `SOIC (D)`, the reader returned
  // `packageOutlineCode` DW0016A and the geometry off that drawing, because this
  // document prints outlines for NS0016A and DW0016A and NONE for the narrow D.
  // Both are 16 lead, so nothing above fired, and it shipped a land span of
  // 9.3 mm where a narrow SOIC-16 is nearer 6. That is the failure this product
  // can least afford: ordinary-looking copper that no board will accept.
  //
  // The vendor's outline code CARRIES the designator as its leading letters, so
  // the record already contains both halves of the contradiction. `DW0016A`
  // against `SOIC (DW)` agrees; against `SOIC (D)` it does not.
  //
  // Only fires when it can PROVE a disagreement. Both parts must parse, so a
  // code that is not designator-prefixed simply does not reach the comparison
  // rather than refusing a part it cannot judge. Measured over the six
  // multi-package parts in the corpus it fires on exactly the one that is wrong
  // and none of the five that are right.
  const namedDesignator = designatorToken(part.packageType);
  const drawnDesignator = outlineCodeDesignator(part.packageOutlineCode);
  if (namedDesignator !== null && drawnDesignator !== null && namedDesignator !== drawnDesignator) {
    throw new FootprintUnavailableError(
      `${part.packageType} was asked for, but the dimensions on the record were read from outline drawing ` +
        `${part.packageOutlineCode}, which is package ${drawnDesignator} and not ${namedDesignator}. This ` +
        `datasheet covers several packages, and the one that was measured is not the one named. Re-read the ` +
        `datasheet for ${part.packageType}; where the document prints no outline for it, its footprint cannot ` +
        `be built from this document at all.`,
      []
    );
  }

  // THE DOCUMENT MUST ACTUALLY DRAW THE PACKAGE IT IS BEING ASKED TO BUILD.
  //
  // The check above proves a mismatch from the vendor's outline CODE, which only
  // Texas Instruments prints in a form that carries the designator. Measured
  // 2026-08-17: 24 of 49 corpus parts carry such a code, 5 describe a single
  // package so there is nothing to confuse, and 20 describe SEVERAL packages
  // with no code at all. Those twenty had no protection whatsoever.
  //
  // `drawnPackages` closes that by asking the model a question about the
  // DOCUMENT rather than about the request: which packages does this datasheet
  // print an outline drawing for. MAX232 answers NS0016A and DW0016A, and a
  // request for the narrow `SOIC (D)` is then provably unbuildable from this
  // document rather than quietly measured off the wide one.
  //
  // MATCHED LOOSELY AND DELIBERATELY. A drawing labels itself in whatever style
  // its vendor uses ("DW0016A", "8-Lead Plastic Small Outline (SO-8)", "SOIC-8"),
  // and the caller's package name is a different string for the same thing. So a
  // match is: either name contains the other's designator token, or one contains
  // the other once punctuation and case are stripped. Anything less forgiving
  // refuses correct parts, which is how the last two attempts at this failed.
  //
  // ABSENT MEANS UNKNOWN. A model that did not answer, or a document whose
  // drawings could not be identified, must never refuse a part: that would turn
  // every non-answer into a lost part, which is the opposite of the trade this
  // is making.
  //
  // AND IT ONLY FIRES WHERE THE TWO LABELS CAN BE COMPARED AT ALL.
  //
  // A refusal here loses the part outright, so it has to be a PROOF of
  // disagreement and not merely a failure to find agreement. Two labels that
  // share no comparable feature prove nothing: a package named by family and
  // lead count (`CFP (14)`) against a drawing named by a vendor outline code
  // (`HBH0014A`) have no word, no token and no punctuation in common, and the
  // match above returned false for both of them. `designatorToken` correctly
  // returns null for `(14)`, which is a lead count rather than an outline code,
  // and the guard read that "cannot tell" as "does not draw it" and refused a
  // correct part with its own drawing on the page.
  //
  // The one feature those two DO share is the lead count: `packagedrawing.ts`
  // records that a vendor outline code's four digits are the lead count, and a
  // designator like `CFP (14)` declares one in words. So a label is decidable
  // when it shares a normalised name, a designator token, or a declared lead
  // count with the request; otherwise it says nothing and the guard stays quiet.
  const drawn = part.drawnPackages;
  if (drawn !== undefined && drawn.length > 0 && part.packageType) {
    const wanted = normaliseForMatch(part.packageType);
    const wantedToken = designatorToken(part.packageType);
    const wantedLeads = declaredLeadCount(part.packageType) ?? part.pinCount;

    type Verdict = "match" | "mismatch" | "undecidable";
    const verdicts = drawn.map((label): Verdict => {
      const drawnNormal = normaliseForMatch(label);
      if (drawnNormal.includes(wanted) || wanted.includes(drawnNormal)) return "match";
      const token = designatorToken(label) ?? outlineCodeDesignator(label);
      if (wantedToken !== null && token !== null) {
        return token === wantedToken ? "match" : "mismatch";
      }
      // The lead count both sides can state, and the only comparison left when
      // the names share nothing. An outline code carries it in its four digits.
      const outlineLeads = /^[A-Za-z]{1,4}(\d{4})[A-Za-z]?$/.exec(label.trim())?.[1];
      const drawnLeads = outlineLeads !== undefined ? Number(outlineLeads) : declaredLeadCount(label);
      if (drawnLeads !== null && drawnLeads !== undefined && wantedLeads !== null) {
        return drawnLeads === wantedLeads ? "match" : "mismatch";
      }
      return "undecidable";
    });

    // Refused only when every drawing was DECIDABLE and every one said no.
    const matched = verdicts.includes("match") || verdicts.includes("undecidable");
    if (!matched) {
      throw new FootprintUnavailableError(
        `This datasheet prints an outline drawing for ${drawn.join(", ")}, and none of them is ` +
          `${part.packageType}. A footprint for ${part.packageType} cannot be measured from this document, ` +
          `so any dimensions on the record describe one of the other packages. Use the datasheet that draws ` +
          `${part.packageType}, or pick one of the packages this document does draw.`,
        []
      );
    }
  }

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
  // What was THROWN AWAY on the way to a refusal, so the refusal can say so.
  // See `Discards`: a check that rejects a printed footprint and returns null is
  // reported to the user as a datasheet that printed none.
  const discards: Discards = [];

  const layout = datasheetLayout(part);
  const printed = printedLand(part, densityLevel, discards, formedLeadSpanMm, formedLeadContactMm);

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
  const drawnLead = leadFromDrawing(part, formedLeadSpanMm, formedLeadContactMm, discards);
  if (drawnLead && layout) {
    try {
      const derived = computeLandPattern(drawnLead, { densityLevel });
      if (contradictsPrintedLand(part, derived)) {
        discards.push(
          `a land pattern computed from the package drawing was rejected because the footprint printed on ` +
            `page ${part.vendorLandPattern?.page} disagrees with it`
        );
      } else {
        return assemble(part, densityLevel, derived, {
          ...layout,
          source: `IPC-7351B density ${densityLevel}, computed from this datasheet's own package drawing`
        });
      }
    } catch (error) {
      if (!(error instanceof LandPatternError)) throw error;
      discards.push(`a land pattern could not be computed from the package drawing: ${error.message}`);
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
  // THE REASON HAS TO MATCH WHAT ACTUALLY HAPPENED, and there are three cases.
  //
  // "No land pattern could be read" is true only of the third. Saying it about
  // either of the others sends the user looking for a page they already have,
  // and hides a check from anyone asking whether it still earns its place.
  //
  // 1. A CHECK REJECTED what the document printed. Named, from `discards`.
  //
  // 2. The pattern was read and the LAYOUT was not. Measured on the tuned corpus
  //    2026-08-16: an ADS1115 carries its whole printed footprint (1.45 x 0.3 mm
  //    lands on a 4.4 mm span) and is missing only `leadSides`, so
  //    `datasheetLayout` returns null and the part was refused with the sentence
  //    below. The datasheet printed the footprint. Telling its reader it did not,
  //    and then asking an apparently unrelated question, is the same defect as a
  //    silent discard wearing different clothes.
  //
  // 3. The document genuinely did not say. The original sentence, unchanged.
  const readPattern = printed !== null;
  throw new FootprintUnavailableError(
    discards.length > 0
      ? `${part.packageType}: ${discards.join("; ")}. Nothing else in this datasheet supplies a land pattern, ` +
          `and none is derived from anything outside it. Supply it and it will be built from your numbers.`
      : readPattern
        ? `This datasheet's own recommended footprint for ${part.packageType} was read (${part.dimensions.landPadLengthMm} x ` +
          `${part.dimensions.landPadWidthMm} mm lands on a ${part.dimensions.landSpanMm} mm centre span), but how the pads are ` +
          `ARRANGED was not: that comes from the pitch and how many sides carry leads. Answer what is missing and the ` +
          `footprint is built from the numbers already read off the page.`
        : `No land pattern could be read for ${part.packageType} from this datasheet, and none is derived from anything outside it. Supply the land pattern and it will be built from your numbers.`,
    askForLandPattern(part, formedLeadSpanMm, formedLeadContactMm)
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
  // HOW MANY ROWS OF PINS, read rather than assumed.
  //
  // This path hardcoded `arrangement: "dual"` until an audit on 2026-08-16, and
  // never looked at `leadSides` at all. So a package with a single line of pins
  // was built as two opposing rows on a row spacing it does not have: a 3-lead
  // TO-220 came out with pins 1 and 2 in one column and pin 3 in the other. It
  // did not refuse, no confidence check covers it (`sides-add-up` reads
  // `leadsPerSide`, which is usually unread), and the result looks entirely
  // ordinary in CAD. A silently wrong footprint is the worst thing this product
  // can emit, and it also inflates SHIPS, which is the number the hold-out
  // exists to keep honest.
  //
  // The surface-mount path has always taken the arrangement from the drawing,
  // in `datasheetLayout`. The rule is the same on both paths and now each one
  // states it: the arrangement is read, and where it was not read there is a
  // question rather than a default.
  //
  // `leadSides` admits only 2 or 4, so a one-sided package cannot be REPRESENTED
  // as one side: the prompt tells the model to answer null for it and the schema
  // would reject a 1 in any case. Null is therefore the state a TO-220 arrives
  // in, and it was the exact state that fell through to two rows. The `why` says
  // plainly that a single line of pins is not built, so someone holding a
  // three-pin regulator is told where they stand instead of being asked a
  // question their package has no answer to.
  // 1 or 2 rows. Single-row became buildable on 2026-08-17, when `leadSides`
  // was widened to admit it: until then TO-220, TO-92 and SIP could not be
  // REPRESENTED, so they refused however well the datasheet was read.
  //
  // Still refused where nobody read it. Null is not a default, and null was the
  // exact state that once fell through to two rows.
  const rows = part.dimensions.leadSides;
  if (rows !== 1 && rows !== 2) {
    const why =
      `${part.partNumber} mounts through the board, and how many rows its pins form was not read. ` +
      `A DIP is two opposing rows; a TO-220, TO-92 or SIP is a single line. Both are built, but which ` +
      `one this is has to be read rather than assumed: guessing two rows would place pins where this ` +
      `package has none.`;
    throw new FootprintUnavailableError(why, [
      { field: "leadSides", label: "Rows of pins (1 for a TO-220 or SIP, 2 for a DIP)", why, unit: "count", scope: "part" }
    ]);
  }

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
  // A SINGLE ROW HAS NO ROW SPACING. Asking for it would be a question the
  // package cannot answer, which is the defect shape this codebase keeps
  // finding: `leadForm` offered two of three values, a flat pack was asked for a
  // foot its drawing never prints, and here a TO-220 would be asked how far
  // apart its two rows sit.
  if (rows === 2 && rowSpacingMm === null) {
    needs.push({ field: "landSpanMm", label: "Row spacing, centre to centre", why, unit: "mm", scope: "part" });
  }
  if (pitchMm === null) {
    needs.push({ field: "pitchMm", label: "Pin pitch along the row", why, unit: "mm", scope: "part" });
  }
  if (needs.length > 0 || lead === null || (rows === 2 && rowSpacingMm === null) || pitchMm === null) {
    throw new FootprintUnavailableError(why, needs);
  }

  const hole = throughHolePad(lead, densityLevel);

  // On a single row the pads sit ON the centre line, so there is no span between
  // opposing rows: the centre is zero and the extent across the row is one pad.
  // Writing `rowSpacingMm / 2` here for a one-row part is precisely how a
  // 3-lead regulator became two columns.
  const singleRow = rows === 1;
  const spanMm = singleRow ? 0 : (rowSpacingMm as number);

  return assemble(
    part,
    densityLevel,
    {
      padWidthMm: hole.padMm,
      padLengthMm: hole.padMm,
      padCentreMm: spanMm / 2,
      zMaxMm: spanMm + hole.padMm,
      gMinMm: singleRow ? hole.padMm : spanMm - hole.padMm,
      courtyardHalfMm: (spanMm + hole.padMm) / 2 + COURTYARD_EXCESS[densityLevel],
      densityLevel
    },
    {
      arrangement: singleRow ? "single" : "dual",
      pitchMm,
      family: part.packageType,
      source: singleRow
        ? `IPC-7251 density ${densityLevel}, from a ${lead} mm lead on a single row at ${pitchMm} mm pitch read off this datasheet`
        : `IPC-7251 density ${densityLevel}, from a ${lead} mm lead on a ${spanMm} mm row spacing read off this datasheet`
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
function leadFromDrawing(
  part: ResolvedPart,
  formedLeadSpanMm?: number,
  formedLeadContactMm?: number,
  discards: Discards = []
): LeadDimensions | null {
  const form = part.dimensions.leadForm;
  const width = part.dimensions.leadWidthMm;

  // A STRAIGHT lead has no seated foot to measure, so its datasheet prints none.
  //
  // Confirmed by hand on 2026-08-17 against two drawings: TI's PW0008A prints
  // the foot as 0.50-0.75 on Detail A, because a gull-wing lead arrives already
  // formed. HBH0014A, a ceramic flat pack, prints no such dimension anywhere,
  // because its leads leave the body straight and the assembler forms them.
  //
  // This function demanded a contact length from every lead form, so every
  // ceramic flat pack failed the computed land path for want of a number no
  // manufacturer can print. Same shape as the `leadForm` prompt gap: we required
  // something that does not exist. The foot is made by the assembler's forming
  // die, exactly like the seated span beside it, so it is asked for once per
  // assembler rather than invented.
  //
  // If a published standard turns out to specify the formed foot for flat packs,
  // that source replaces the question. None was found, and guessing a fillet
  // input is how a wrong land ships.
  const contact =
    form === "straight"
      ? formedLeadContactMm && Number.isFinite(formedLeadContactMm) && formedLeadContactMm > 0
        ? { minMm: formedLeadContactMm, maxMm: formedLeadContactMm }
        : null
      : part.dimensions.leadContactMm;
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
  if (pitchMm && pitchMm > 0 && width.maxMm > MAX_LEAD_WIDTH_FRACTION_OF_PITCH * pitchMm) {
    discards.push(
      `the package drawing's lead dimensions were rejected: a ${width.maxMm} mm lead on a ${pitchMm} mm pitch ` +
        `leaves almost no gap to its neighbour, so one of the two was misread`
    );
    return null;
  }

  // THE SECOND SPAN, for a four-sided package that is not square.
  //
  // Only the outline's own cross span counts, and only on a gull-wing lead: a
  // `straight` part's spans are both set by the assembler's forming die, and
  // one formed span is what is asked for, so there is no second number to use.
  // Absent leaves `computeLandPattern` placing both axes at one distance, which
  // is what it did for every package before this field existed and is still
  // correct for a square.
  const spanCross = form === "gullwing" ? part.dimensions.leadSpanCrossMm : null;
  const usableCross =
    spanCross && spanCross.minMm > 0 && spanCross.maxMm >= spanCross.minMm ? spanCross : null;

  return {
    form: "gullwing",
    span,
    ...(usableCross ? { spanCross: { minMm: usableCross.minMm, maxMm: usableCross.maxMm } } : {}),
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
function withinIpcBand(
  part: ResolvedPart,
  padLengthMm: number,
  centreSpan: number,
  /**
   * The seated geometry the ASSEMBLER supplies, for a package that ships with
   * straight leads.
   *
   * Threaded through from 2026-08-18. This called `leadFromDrawing(part)` with
   * neither, so a `straight` part never yielded a lead and the band check
   * silently returned null for it even once the user had answered both
   * questions. Ceramic flat packs are most of this product's market, so the one
   * check with an industry bound behind it was unavailable on exactly the
   * packages it matters most for.
   */
  formedLeadSpanMm?: number,
  formedLeadContactMm?: number,
  /** The cross-axis centre span, where the printed footprint states one. */
  crossSpan?: number | null
): boolean | null {
  const lead = leadFromDrawing(part, formedLeadSpanMm, formedLeadContactMm);
  if (!lead) return null;
  try {
    const most = computeLandPattern(lead, { densityLevel: "A" });
    const least = computeLandPattern(lead, { densityLevel: "C" });
    // Compared on the toe-to-toe extent, which is the dimension both density
    // levels move most and the one a misread decimal point distorts first.
    const inBand = (span: number, leastZ: number, mostZ: number) => {
      const zMax = span + padLengthMm;
      return zMax >= leastZ - BAND_TOLERANCE_MM && zMax <= mostZ + BAND_TOLERANCE_MM;
    };
    if (!inBand(centreSpan, least.zMaxMm, most.zMaxMm)) return false;

    // AND THE OTHER AXIS. A rectangular quad has two centre spans and this
    // checked one, so a misread decimal point on the second was unchallenged:
    // the axis nothing looked at is the axis a wrong number survives on.
    // Checked against the band the CROSS lead span produces, which is the
    // matching pair, and skipped where either number is absent, because a
    // missing input is not a disagreement.
    if (typeof crossSpan === "number" && Number.isFinite(crossSpan) && lead.spanCross) {
      const crossLead = { ...lead, span: lead.spanCross };
      const mostCross = computeLandPattern(crossLead, { densityLevel: "A" });
      const leastCross = computeLandPattern(crossLead, { densityLevel: "C" });
      if (!inBand(crossSpan, leastCross.zMaxMm, mostCross.zMaxMm)) return false;
    }
    return true;
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
  /**
   * The cross-axis centre span. Askable and suppliable because the record
   * accepts it: a four-sided package has two and a null was being read as "the
   * same as the other one", which is a guess dressed as a reading.
   */
  landSpanCrossMm?: number;
  leadDiameterMm?: number;
  pitchMm?: number;
  leadSides?: 1 | 2 | 4;
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
      landSpanCrossMm: fill(part.dimensions.landSpanCrossMm, supplied.landSpanCrossMm),
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
function askForLandPattern(
  part: ResolvedPart,
  formedLeadSpanMm?: number,
  formedLeadContactMm?: number
): RequiredInput[] {
  const needs: RequiredInput[] = [];

  // A part that ships with STRAIGHT leads is one question away, not four: its
  // drawing gives the lead width and the foot, and only the seated span depends
  // on how the assembler trims and forms them. Asked first, and asked alone,
  // because supplying it makes the rest derivable.
  //
  // This is nearly every rad-hard ceramic flat pack, so it is the opposite of a
  // corner case for this product's customers.
  if (part.dimensions.leadForm === "straight" && (!formedLeadSpanMm || !formedLeadContactMm)) {
    const why =
      `${part.packageType} ships with its leads straight and the assembler trims and forms them, so ` +
      `the seated geometry is set by your process. No datasheet prints these, because the manufacturer ` +
      `never bends the leads.`;
    const needs: RequiredInput[] = [];
    // Both are properties of the forming die, so both are asked once per
    // assembler rather than once per part. Asked TOGETHER, because a flat pack
    // needs both and walking the user down one number at a time across two
    // export attempts is worse than one question with two boxes.
    if (!formedLeadSpanMm) {
      needs.push({
        field: "formedLeadSpanMm",
        label: "Formed lead span, toe to toe",
        why,
        unit: "mm",
        scope: "install"
      });
    }
    // Added 2026-08-17. The drawing prints no seated foot for an unformed lead,
    // and `leadFromDrawing` demanded one anyway, so every ceramic flat pack
    // failed the computed land path on a number that cannot exist.
    if (!formedLeadContactMm) {
      needs.push({
        field: "formedLeadContactMm",
        label: "Formed foot length, where the lead sits on the pad",
        why: `${why} The foot is what the land is sized around, and it is made by your forming die rather than by the manufacturer.`,
        unit: "mm",
        scope: "install"
      });
    }
    return needs;
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
  // THE SECOND SPAN, on a four-sided package, and asked rather than assumed.
  //
  // A quad has two centre spans and the record carried one. An unread cross
  // span was being read as "the same as the other one", which is correct only
  // for a square and silently wrong for every rectangular quad: the copper was
  // placed at the wrong distance and nothing said so. Where the two axes really
  // are equal the answer is the same number typed twice, which is one question
  // rather than a wrong footprint.
  //
  // Asked only for `leadSides === 4`, because a two-sided or one-sided package
  // genuinely has one span and asking would be friction with no answer behind it.
  if (part.dimensions.leadSides === 4 && part.dimensions.landSpanCrossMm === null) {
    needs.push({
      field: "landSpanCrossMm",
      label: "Centre-to-centre span across the other axis",
      why:
        `${part.packageType} carries leads on all four sides, so its footprint has TWO centre spans, one per ` +
        `axis. Most four-sided packages are rectangular and the two differ; where they are equal, enter the ` +
        `same number again rather than leaving it, because assuming they are equal is how a rectangular part ` +
        `gets square copper.`,
      unit: "mm",
      scope: "part",
      page: landPage,
      pageLabel: landLabel
    });
  }
  if (part.dimensions.leadSides !== 1 && part.dimensions.leadSides !== 2 && part.dimensions.leadSides !== 4) {
    needs.push({
      field: "leadSides",
      // 1 was missing here until 2026-08-18 while the through-hole ask beside it
      // offered it, so a single line of pins was unanswerable on the surface-
      // mount path: the label named two of the three values the record accepts.
      label: "Sides carrying leads (1 for a TO-220 or SIP, 2 for a DIP or SOIC, 4 for a QFP)",
      why: `The package drawing shows this, but it was not read for ${part.packageType}. A single line of leads along one edge is 1; two opposing rows is 2; leads on all four sides is 4.`,
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
  arrangement: "single" | "dual" | "quad";
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
  // 1, 2 or 4. Three is a real package shape and not one the pad placer builds,
  // and null means nobody read it; both refuse here rather than being rounded to
  // the nearest arrangement, which is how a 3-lead TO-220 once shipped as two
  // columns 5 mm apart.
  if (!pitchMm || pitchMm <= 0 || (sides !== 1 && sides !== 2 && sides !== 4)) return null;
  return {
    arrangement: sides === 4 ? "quad" : sides === 1 ? "single" : "dual",
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
  const perSideCount = quad
    ? Math.max(...quadSides!)
    : definition.arrangement === "single"
      ? part.pinCount
      : Math.ceil(part.pinCount / 2);
  const rowSpanMm = (perSideCount - 1) * definition.pitchMm;

  // THE FIRST row's own extent, which is the one pin 1 sits on.
  //
  // The pin-1 marker used `rowSpanMm`, the WIDEST row, so on a quad whose first
  // side is not the widest the marker was placed beside a different side's
  // lands. `quadSides[0]` is the side pin 1 is on by construction, and on every
  // dual, single and square-sided package this is the same number as
  // `rowSpanMm`, which is why nothing noticed.
  const firstRowSpanMm = quad
    ? (quadSides![0] - 1) * definition.pitchMm
    : rowSpanMm;

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
      //
      // ONLY FOR THE VARIANT WE ACTUALLY EMIT, which is the non-solder-mask-
      // defined one: copper defines the land and the mask opening is larger, so
      // the figure is a positive expansion and `solderMaskMarginMm` means what
      // the fabricator will read.
      //
      // A solder-mask-defined land is the other way round. The mask opening is
      // SMALLER than the copper and defines the pad, so the printed figure is an
      // overlap rather than an expansion. Writing it as a positive margin opens
      // the mask wider exactly where it should be narrower.
      //
      // Both figures are printed side by side on the same drawing, and the
      // prompt asks the model to report the pair together for this reason. Until
      // 2026-08-16 `solderMaskDefined` was read, stored, projected through
      // `resolveForExport` and consumed by NOTHING, so whichever variant the
      // model chose was applied as an expansion regardless. That is the fifth
      // instance of collecting an answer and not using it, and the only one so
      // far where not using it produced a wrong number rather than a gap.
      //
      // No mask-defined land is emitted instead of approximating one: expressing
      // it needs a mask aperture smaller than the copper, which neither emitter
      // writes today, and a note says so rather than silently dropping it.
      ...(part.dimensions.solderMaskExpansionMm === null ||
      part.dimensions.solderMaskDefined === "solder-mask-defined"
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
      // LENGTH ALONG THE BODY'S LENGTH, which on both arrangements this builds
      // is Y: a dual package runs its lead rows down the left and right, so the
      // body's long axis is vertical, and `bodyLengthMm` becomes the courtyard's
      // and the outline's Y half-extent.
      //
      // `thermalPadLand(padLengthMm, padWidthMm)` returns them as
      // `{ widthMm: padLengthMm, heightMm: padWidthMm }`, i.e. length on X. Two
      // fields both called "length" on opposite axes, so the pad came out turned
      // ninety degrees from the package it is on the underside of, and shipped:
      // a rotated pad usually still fits between the lead rows, so no invariant
      // fires and nothing looks unusual in CAD.
      //
      // D2 is measured parallel to D on a package outline drawing and
      // `bodyLengthMm` is D, so length-along-length is what the drawing means.
      // `thermalPadFitsBody` in `confidence.ts` already compares length against
      // length, so the record check and the generator disagreed and this was the
      // wrong half. Swapped at the call rather than inside `thermalPadLand`,
      // whose own argument order is documented against the drawing's letters.
      const solved = thermalPadLand(length, width);
      thermal = {
        ...solved,
        widthMm: solved.heightMm,
        heightMm: solved.widthMm,
        apertures: solved.apertures.map((aperture) => ({
          xMm: aperture.yMm,
          yMm: aperture.xMm,
          widthMm: aperture.heightMm,
          heightMm: aperture.widthMm
        }))
      };
    } catch (error) {
      if (error instanceof LandPatternError) throw new FootprintUnavailableError(error.message);
      throw error;
    }

    // THE PAD'S NUMBER IS ONE PAST THE LAST LEAD, and it is not looked up.
    //
    // This searched `part.pins` for a non-numeric designator (`EP`, `PAD`,
    // `TAB`) and fell back. The search can never match: `normalizeModelPins`
    // removes every non-numeric row before it reaches `part.pins` and records
    // the fact as `exposedPad`, which is the flag this branch is guarded on. So
    // the lookup was dead and the fallback was the whole behaviour, while the
    // line read as though a vendor's own label could survive into the file.
    //
    // The fallback is also the right answer on its own terms: `geometryViolations`
    // expects exactly `pinCount + 1` for the pad, and a vendor label like `EP`
    // would fail that check.
    pads.push({
      number: String(part.pinCount + 1),
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

    // A ROW OF LANDS HAS TO FIT INSIDE THE SPAN THAT HOLDS IT.
    //
    // On a quad the outermost land of one side sits alongside the outermost land
    // of the next, and their corners meet. Derived rather than tuned. A side's
    // lands occupy `(n-1) * pitch`, each reaches `padWidth/2` further along it,
    // and the perpendicular row's inner edge sits at `centreSpan/2 -
    // padLength/2`. Overlap needs the two lands to intersect on BOTH axes, and
    // each axis is bounded by a DIFFERENT side's extent, so the corner shorts
    // exactly when
    //
    //     min(extentA, extentB) + padWidth + padLength  >  centreSpan
    //
    // MIN, not max, and that distinction is the whole check. The first version
    // used the largest side for both axes and refused `quad-38-unequal`, a
    // legitimate 12,7,12,7 part whose corners are clear precisely because the
    // seven-land side is short. Both conditions must hold, so the SHORTER side
    // of each adjacent pair is what binds.
    //
    // Checked BEFORE placing, because the output invariant already catches the
    // result and reports it as "lands 1 and 24 overlap", which is the symptom.
    // Nothing here is a new refusal: it is the same one, said usefully.
    const extentMm = (count: number) => Math.max(0, count - 1) * definition.pitchMm;
    const adjacent: Array<[number[], number[]]> = [
      [left, bottom],
      [bottom, right],
      [right, top],
      [top, left]
    ];
    const bindingMm = Math.max(
      ...adjacent.map(([a, b]) => Math.min(extentMm(a.length), extentMm(b.length)))
    );
    const needsMm = bindingMm + land.padWidthMm + land.padLengthMm;
    // THE SMALLER of the two axes, because a corner is where they meet and the
    // tighter one decides. On a square quad the two are the same number and this
    // is the check it always was; on a rectangle, testing only the long axis
    // would pass a footprint whose short axis shorts.
    const crossCentreMm = land.padCentreCrossMm ?? land.padCentreMm;
    const centreSpanMm = Math.min(land.padCentreMm, crossCentreMm) * 2;
    if (needsMm > centreSpanMm) {
      throw new FootprintInvalidError([
        `the corner lands of this quad would short: two adjacent sides put lands ${bindingMm.toFixed(2)} mm ` +
          `along at ${definition.pitchMm} mm pitch, and with a ${land.padWidthMm} mm land width and a ` +
          `${land.padLengthMm} mm land length they need ${needsMm.toFixed(2)} mm of centre span to stay apart. ` +
          `The span read for this package is ${centreSpanMm.toFixed(2)} mm. The centre span is the value to ` +
          `check first: the pitch and the pin count corroborate each other and it does not.`
      ]);
    }


    // Counterclockwise from the top of the left side. `+y` is DOWN here, so the
    // left side runs down the page, the bottom runs left to right, and the right
    // and top run back the other way; see `quadRowSides`.
    // The left and right rows sit on the axis `landSpanMm` measures, which is the
    // one `landPadLengthMm` runs along. The top and bottom rows sit on the OTHER
    // axis, and until 2026-08-17 they used the same number, which is correct only
    // for a square. `padCentreCrossMm` is absent for two-sided packages and for
    // square quads, where falling back to `padCentreMm` is exactly right.
    const at = (side: number[], index: number) => alongSide(side.length, index);
    left.forEach((number, index) => push(number, -land.padCentreMm, at(left, index), "x"));
    bottom.forEach((number, index) => push(number, at(bottom, index), crossCentreMm, "y"));
    right.forEach((number, index) => push(number, land.padCentreMm, -at(right, index), "x"));
    top.forEach((number, index) => push(number, -at(top, index), -crossCentreMm, "y"));
  } else if (definition.arrangement === "single") {
    // ONE LINE OF PINS, which is what a TO-220, TO-92 or SIP is.
    //
    // Centred on the origin and stepped along x, so pin 1 is leftmost. There is
    // no opposing row and therefore no centre span: the pads sit ON the line,
    // not either side of it, which is exactly the fact that made two rows wrong.
    //
    // The long axis is "y", across the row, for the same reason it is on a
    // dual's left column: the lead runs outward from the body, and on a single
    // row the body is on one side of the line.
    const single = Array.from({ length: part.pinCount }, (_, index) => index + 1);
    single.forEach((number, index) => push(number, (index - (single.length - 1) / 2) * definition.pitchMm, 0, "y"));
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
  // A quad's two extents are each bounded by LANDS rather than by one row of
  // them, so the dual fallbacks do not describe it: `rowSpanMm` is one side's
  // lead span, which is smaller than the body, and `gMinMm` is the inner gap
  // between one opposing pair.
  //
  // AND THE TWO AXES ARE NOT THE SAME NUMBER. This said "a quad package is
  // square by construction here" and used `gMinMm`, the main axis's gap, as the
  // fallback for both. That stopped being true when the cross span was read: on
  // a rectangular quad the silkscreen came out square around rectangular copper.
  // The cross axis's own inner gap is `2 * padCentreCrossMm - padLengthMm`, by
  // the same arithmetic that produced `gMinMm` for the main one.
  const crossGapMm =
    land.padCentreCrossMm !== undefined ? land.padCentreCrossMm * 2 - land.padLengthMm : land.gMinMm;
  const bodyHalfLengthMm = quad
    ? (part.dimensions.bodyLengthMm ?? crossGapMm) / 2
    : (part.dimensions.bodyLengthMm ?? rowSpanMm + definition.pitchMm) / 2;
  const bodyHalfWidthMm = (part.dimensions.bodyWidthMm ?? land.gMinMm) / 2;

  // How far the lands actually reach, which is what the courtyard has to clear.
  // Paste apertures are inside their own copper and thermal vias inside the pad,
  // so the lands bound everything.
  const padHalfExtentXMm = Math.max(
    0,
    ...pads.map((pad) => Math.abs(pad.centre.xMm) + pad.widthMm / 2)
  );
  const padHalfExtentYMm = Math.max(
    0,
    ...pads.map((pad) => Math.abs(pad.centre.yMm) + pad.heightMm / 2)
  );

  return {
    name: `${slugify(part.partNumber)}-${slugify(definition.family)}`,
    // What the pads actually ARE, stated as the claim it is. "The manufacturer
    // recommends this footprint" and "we derived this from IPC-7351B" are
    // different assertions, and a reviewer signing off a board is entitled to
    // know which one they are being handed.
    description:
      land.source === "printed"
        ? `${part.partNumber} ${definition.family}. Lands are the RECOMMENDED FOOTPRINT PRINTED IN THIS DATASHEET (${land.padLengthMm} x ${land.padWidthMm} mm on a ${(land.padCentreMm * 2).toFixed(3)} mm centre span${
            // Both spans, where the package has two. A description that names one
            // is a wrong statement about a rectangular quad, not a short one.
            land.padCentreCrossMm !== undefined
              ? ` by ${(land.padCentreCrossMm * 2).toFixed(3)} mm across the other axis`
              : ""
          }), not computed from a standard. Courtyard uses IPC-7351B density ${densityLevel}.`
        : `${part.partNumber} ${definition.family}, IPC-7351B density level ${densityLevel}. Lead data: ${definition.source}`,
    partNumber: part.partNumber,
    pads,
    body: { halfWidthMm: bodyHalfWidthMm, halfHeightMm: bodyHalfLengthMm },
    // The keep-out has to clear the LANDS, and on a quad they reach the same
    // distance out on all four sides. Taking the height from the body, as the
    // dual case does, would draw a courtyard inside the top and bottom lands.
    // Sized from what it must CONTAIN, in both axes.
    //
    // The height used to come from the BODY on a dual package, and the comment
    // above says why that is wrong on a quad without noticing it is the same
    // mistake on a dual: a lead row longer than the body puts the end lands
    // outside their own keep-out. The board designer trusts the courtyard and
    // places the neighbour on top of a pad.
    //
    // Found on 2026-08-16 by the footprint's own invariants (`validateGeometry`),
    // on the first run after they were added. Nothing had checked that the
    // courtyard contains the lands, on any package.
    //
    // Taking the larger of the body and the actual land extent is also closer to
    // what IPC-7351B means by a courtyard: it is the land pattern's extent plus
    // an excess per density level, and the body is only ever the bound when it
    // is the wider of the two.
    //
    // The density level's own excess, not a hardcoded 0.25. They agree at
    // density B, which is why the constant survived unnoticed, and they differ
    // by a factor of four between A and C: a customer who chose level A to buy
    // solder-joint robustness was getting a courtyard sized for level B in one
    // axis and level A in the other.
    courtyard: {
      halfWidthMm: Math.max(land.courtyardHalfMm, padHalfExtentXMm + COURTYARD_EXCESS[densityLevel]),
      halfHeightMm: Math.max(
        quad ? land.courtyardHalfMm : bodyHalfLengthMm + COURTYARD_EXCESS[densityLevel],
        padHalfExtentYMm + COURTYARD_EXCESS[densityLevel]
      )
    },
    // Outside pin 1, wherever pin 1 actually is.
    //
    // On a dual or a quad that is the top of the LEFT column, so the marker goes
    // left of the column and above the first land. On a SINGLE row every pad
    // sits on the centre line and pin 1 is the LEFTMOST, so the same formula put
    // the marker at x = 0, in the middle of the row and nearer pin 2 than pin 1.
    // The footprint's own invariant caught that: "the pin-1 marker sits closer
    // to another land than to pin 1".
    //
    // Derived from the placement rather than assumed: the marker is offset from
    // the pad that carries pin 1, on the side away from pin 2.
    pin1Marker:
      definition.arrangement === "single"
        ? {
            xMm: -((part.pinCount - 1) / 2) * definition.pitchMm - definition.pitchMm * 0.7,
            yMm: -(land.padLengthMm / 2) - definition.pitchMm * 0.4
          }
        : {
            xMm: -land.padCentreMm,
            // THE SIDE PIN 1 IS ON, not the widest side.
            //
            // `rowSpanMm` is the extent of the LONGEST row, which on a quad
            // whose first side is not the longest put the marker beside a
            // different side's lands. Pin 1 sits at the top of the left column,
            // so the row that matters is the left one, and `firstRowSpanMm` is
            // that row's own extent. They are the same number on every dual
            // package and on a square quad, which is why this went unseen.
            yMm: -firstRowSpanMm / 2 - definition.pitchMm * 0.7
          },
    thermalVias,
    provenance: {
      family: definition.family,
      source: definition.source,
      densityLevel,
      padWidthMm: Number(land.padWidthMm.toFixed(3)),
      padLengthMm: Number(land.padLengthMm.toFixed(3)),
      centreToCentreMm: Number((land.padCentreMm * 2).toFixed(3)),
      // THE OTHER AXIS, when the two differ. The provenance block is what a
      // reviewer reads six months later to see what was built, and on a
      // rectangular quad it stated one span for a footprint with two: the file
      // described itself as square while its own pads were not.
      ...(land.padCentreCrossMm !== undefined
        ? { centreToCentreCrossMm: Number((land.padCentreCrossMm * 2).toFixed(3)) }
        : {}),
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
  /**
   * Seated FOOT length in mm for the same families, and for the same reason: an
   * unformed lead has no foot until the assembler's die makes one, so no
   * datasheet prints it. Verified by hand against two drawings on 2026-08-17.
   */
  formedLeadContactMm?: number;
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

  // The user's answers are applied HERE, before anything reads the record, so
  // the footprint and the 3D body see the same numbers. They used to be applied
  // only inside the footprint builder, which meant a supplied body dimension
  // never reached the solid.
  //
  // `buildFootprintGeometry` applies them again, and that is deliberate rather
  // than a leftover: `packageOptions` reaches it directly and has answers of its
  // own to pass. `withSupplied` fills BLANKS only, so applying it twice to the
  // same record is the identity, and the alternative is one entry point silently
  // ignoring what the caller typed.
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
    footprint = buildFootprintGeometry(part, densityLevel, options.formedLeadSpanMm, options.supplied, options.formedLeadContactMm);
    // THE FOOTPRINT CHECKS ITSELF BEFORE ANY FILE IS WRITTEN.
    //
    // Every check in `confidenceChecks` runs on the RECORD, and both of the
    // wrong footprints this product has produced passed all of them: the inputs
    // were individually fine and the ARRANGEMENT was wrong. A TO-220 came out as
    // two opposing rows; a twenty-pin table came out under a twenty-eight pin
    // package's name. Neither is visible in a record and both are obvious in the
    // pads.
    //
    // This throws rather than warns. A footprint whose lands overlap is a short
    // circuit, not a footprint with a caveat, and an engineer would want it
    // withheld rather than shipped beside a note they can click past. It is also
    // a defect in Forge rather than in the datasheet, so it is not a question
    // the user can answer and must not be dressed as one.
    validateGeometry(footprint, part);
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
  const checks = confidenceChecks(part);

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
  // THE PIN TABLE IS PACKAGE DATA TOO.
  //
  // Everything below this line was already understood: those values were read
  // off the drawings for ONE package and describe the wrong pages against a
  // different designator, so they are dropped. The pin table is exactly the same
  // kind of value and was the one thing carried across unchanged.
  //
  // That is not a hypothetical. Measured over the cached hold-out answers on
  // 2026-08-16, 21 of the 56 cached documents describe more than one package with
  // its own pin table and TEN of them differ in LEAD COUNT: an ADS1256 is an SSOP-20 or
  // an SSOP-28, an SN74HC595 a 16-pin SOIC or a 20-pin FK, an LT1013 an 8, 14 or
  // 16 lead part. Relabelling carried twenty pins into a twenty-eight pin
  // package and built a twenty-pad footprint under its name.
  //
  // Where the document printed a table for THIS package, it replaces the one
  // above. Where it did not, the pins are left alone and the count check in
  // `buildFootprintGeometry` refuses anything that still contradicts.
  const table = pinTableFor(part.pinTablesByPackage, designator);
  return {
    ...part,
    packageType: designator,
    ...(table ? { pins: table.pins, pinCount: table.pins.length } : {}),
    packageOutlineCode: null,
    jedecOutline: null,
    vendorLandPattern: null,
    // A thermal pad belongs to one package of a family and not to its siblings,
    // so it comes from THAT PACKAGE'S OWN TABLE where the document printed one.
    //
    // It used to be set to false unconditionally, and the comment here named the
    // consequence while accepting it: claiming the QFN lacks the SOIC's pad
    // emits a footprint missing a mandatory soldered feature. That was the only
    // honest answer while the flag lived on the record, because one flag has to
    // be wrong for one of two packages that disagree. Recorded per table since
    // 2026-08-16, so there is a right answer to carry and this carries it.
    //
    // Still false where the document printed no table for this package: nothing
    // states it either way, and `buildFootprintGeometry` refuses a pinout that
    // contradicts the designator regardless.
    exposedPad: table?.exposedPad ?? false,
    dimensions: blank
  };
}

/** What the caller has already answered, carried into every option. */
export interface OptionAnswers {
  formedLeadSpanMm?: number;
  formedLeadContactMm?: number;
  supplied?: SuppliedDimensions;
}

/**
 * Runs the real footprint build for one designator and classifies the outcome.
 */
function optionFor(
  part: ResolvedPart,
  variant: { designator: string; family: string; leadCount: number | null },
  drawingIsThisPackage: boolean,
  /**
   * Everything the caller has ALREADY answered.
   *
   * The chooser exists so a click's outcome cannot drift from what the export
   * does, and it was building each option as if nothing had been supplied: a
   * package the user had already answered every question for was reported as
   * `needs-input`, which is the exact drift `optionFor` documents itself as
   * preventing.
   */
  answers: OptionAnswers = {}
): PackageOption {
  const candidate = drawingIsThisPackage
    ? { ...part, packageType: variant.designator }
    : asPackage(part, variant.designator);

  const base = { designator: variant.designator, family: variant.family, leadCount: variant.leadCount };
  try {
    buildFootprintGeometry(
      candidate,
      "B",
      answers.formedLeadSpanMm,
      answers.supplied,
      answers.formedLeadContactMm
    );
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
 * The chooser for a document that gave a pinout PER PACKAGE and no single one.
 *
 * ## The deadlock this ends
 *
 * A family datasheet whose part number does not name a package gets `pins` and
 * `pinCount` null, correctly: the model is told not to pick among several
 * pinouts, because guessing one becomes a footprint. It returns them all,
 * labelled, in `pinTablesByPackage`.
 *
 * `resolveForExport` then refused the record for having no pins, `packageOptions`
 * returned `ok: false`, and the user was shown "the reading is missing pins" for
 * a document whose pinouts were sitting on the record. The chooser refused to
 * offer the very choice that would have answered the question, which is the
 * deadlock the field was added to break and never did.
 *
 * Measured 2026-08-16 over the hold-out: TWELVE of the fifty-one parts with a
 * reading are in exactly this state, every one of them counted as "no pins, no
 * count". Only four genuinely had no pinout at all.
 *
 * ## Why it is safe to build from these
 *
 * Each table is located on a real page by `mergeModelValues` before it is
 * stored, using the same check the main pin table passes, with quarantined
 * regions cut first. A table that matches no page keeps a null citation, and
 * `resolveForExport` refuses it here exactly as it would anywhere else. Nothing
 * is trusted because it is convenient.
 *
 * Only fires when the pinout is the ONLY thing missing. A record also short of a
 * body size has a different problem and gets the plain refusal, so this cannot
 * quietly paper over an unrelated gap.
 */
function optionsFromPerPackageTables(
  record: PartRecord,
  resolved: Extract<ReturnType<typeof resolveForExport>, { ok: false }>,
  answers: OptionAnswers = {}
): PackageChoice | null {
  const tables = record.pinTablesByPackage;
  if (!tables || tables.length === 0) return null;

  const blocked = [...resolved.missing, ...(resolved.untraceable ?? [])];
  if (blocked.length === 0) return null;
  if (!blocked.every((field) => field === "pins" || field === "pinCount")) return null;

  const options = record.packageVariants.map((variant) => {
    const base = { designator: variant.designator, family: variant.family, leadCount: variant.leadCount };
    const table = pinTableFor(tables, variant.designator);
    if (!table) {
      return {
        ...base,
        status: "unsupported" as const,
        needs: [],
        reason:
          `This document gives a pinout for each package it describes, and none of them matches ` +
          `${variant.designator}. Re-reading the datasheet for this package is what would settle it.`
      };
    }
    const forThisPackage = withPinTable(record, table);
    const usable = resolveForExport(forThisPackage);
    if (!usable.ok) {
      const why = usable.missing.length > 0 ? usable.missing : (usable.untraceable ?? []);
      return {
        ...base,
        status: "unsupported" as const,
        needs: [],
        reason: `${variant.designator}'s own pin table is on the record but cannot be used: ${why.join(", ")}.`
      };
    }
    return optionFor(usable.part, variant, false, answers);
  });

  return { ok: true, options };
}

/** The record as it stands for ONE package, carrying that package's own pinout. */
function withPinTable(
  record: PartRecord,
  table: { packageType: string; pins: PinRecord[]; exposedPad?: boolean; citation?: Citation | null }
): PartRecord {
  // `vlm`, because a model read it, and the citation is the page the merge
  // LOCATED it on rather than one the model claimed. A null citation leaves the
  // value untraceable and the export refuses it, which is the intended outcome.
  const provenance = {
    confidence: table.citation ? 0.5 : null,
    method: "vlm" as const,
    citation: table.citation ?? null
  };
  return {
    ...record,
    pins: { value: table.pins, ...provenance },
    pinCount: { value: table.pins.length, ...provenance },
    // The pad this package has, rather than whatever the record carried from
    // whichever package the reading happened to settle on. See `asPackage`.
    exposedPad: table.exposedPad ?? record.exposedPad
  };
}

/**
 * Every package the document offers this part, each with what it would produce.
 *
 * The record-level check runs ONCE rather than per option, because nothing in
 * `resolveForExport` reads the designator: a missing pin table blocks every
 * package equally, and reporting that against each option in turn would present
 * one problem as several and imply a different choice might avoid it.
 */
export function packageOptions(record: PartRecord, answers: OptionAnswers = {}): PackageChoice {
  const resolved = resolveForExport(record);
  if (!resolved.ok) {
    const perPackage = optionsFromPerPackageTables(record, resolved, answers);
    if (perPackage) return perPackage;
    const blocked = resolved.missing.length > 0 ? resolved.missing : (resolved.untraceable ?? []);
    return { ok: false, blockedBy: blocked };
  }

  const chosen = record.packageType.value;
  return {
    ok: true,
    options: record.packageVariants.map((variant) =>
      optionFor(resolved.part, variant, variant.designator === chosen, answers)
    )
  };
}
