/**
 * Does the LEAD actually sit on the LAND?
 *
 * ## The gap this closes
 *
 * Everything else in this project checks a number against another number. The
 * pinout is checked against a second reading of the pinout, the printed land
 * against a land IPC-7351B computes, the emitted copper against the record it
 * was built from. Not one of them lays the physical lead on top of the physical
 * pad and looks at whether there is metal underneath it.
 *
 * That overlay is the only question the board house and the reflow oven care
 * about. A footprint can be self-consistent, agree with its record, and sit
 * inside the IPC band, and still put a 0.51 mm lead on a 0.40 mm land, because
 * nothing compares those two figures. `leadWidthMm` was read on 39 corpus parts
 * and used in exactly two places, both of them band arithmetic on the toe-to-toe
 * extent. The side fillet was never computed anywhere.
 *
 * ## Why it is also a second source, not just a solder check
 *
 * The rule this product works to is that no value ships silently unless two
 * INDEPENDENT sources agree, where independent means read by different means.
 * The lands and the leads qualify:
 *
 *     the LANDS come from the recommended footprint the vendor printed
 *     the LEADS come from the package outline drawing
 *
 * Different page, different table, different draughtsman. Overlaying one on the
 * other is a genuine second reading of the copper, and it is sharper than the
 * band check that exists today: `withinIpcBand` constrains the toe-to-toe extent
 * Zmax alone, so a pattern with a correct overall reach but pads far too short
 * passes it while leaving no metal at all under the heel.
 *
 * ## The geometry
 *
 * For one row of leads, measured outward from the package centre line:
 *
 *     toe of the lead        at  span / 2
 *     heel of the lead       at  span / 2 - contact
 *     land outer edge        at  |centre| + length / 2
 *     land inner edge        at  |centre| - length / 2
 *
 *     toe fillet   = land outer edge - lead toe
 *     heel fillet  = lead heel - land inner edge
 *     side fillet  = (land width - lead width) / 2
 *
 * A negative toe fillet is a lead hanging over the end of its pad. A negative
 * heel fillet is a land that stops before the heel, which is the corner the
 * joint's strength actually comes from. A negative side fillet is a lead wider
 * than the copper it lands on. All three are manufacturing defects rather than
 * matters of taste, which is why this reports them separately from how they
 * compare to IPC's fillet GOALS.
 *
 * ## What is assessed for which lead form, and why the difference
 *
 * Every dimension here is a range, so the overlap is evaluated at each CONSISTENT
 * corner of the lead's tolerance box and the worst kept. Corners rather than a
 * worst-case fillet, because a fillet computed from the longest span and the
 * longest foot at once describes a lead that cannot exist: those two extremes
 * belong to different parts out of the same mould. Measured on the corpus, the
 * mixed-extreme version put eleven correct SOIC-8s at a negative heel fillet
 * purely because JEDEC MS-012 tolerances the foot from 0.40 to 1.27 mm.
 *
 * A GULL-WING lead's toe is at `leadSpanMm / 2`, which is what that dimension
 * means: tip to tip across the package. A rectangular quad states a second span
 * for its other axis, and where it does not, that axis is NOT assessed rather
 * than assessed against the first one. Falling back to the first span is what
 * put ADXL345's top and bottom lands 1 mm off their terminals in this file's
 * first draft, on a part whose footprint is correct on that axis.
 *
 * A NO-LEAD terminal has no span to be tip to tip: it is a pad on the underside
 * of the body, so its outer edge is the BODY edge and the drawing prints a body
 * dimension instead. `bodyWidthMm` is the x extent and `bodyLengthMm` the y,
 * which is the placer's convention. A PULL-BACK terminal sits inboard of the
 * body edge, so the outer edge computed this way is an upper bound: the heel
 * derived from it is therefore conservative and is kept, and the toe is not
 * asserted at all.
  */

import { type FootprintGeometry, type Pad, thermalPadNumber } from "./geometry";
import { type Range } from "./ipc7351";
import { type ResolvedPart } from "./types";

/** How much of the lead lands on copper, as a fraction of the lead itself. */
export interface Overlap {
  /** Of the seated foot's length, along the direction the lead runs. */
  alongFoot: number;
  /** Of the lead's width, across the row. 1 means the copper is at least as wide. */
  acrossWidth: number;
}

/** One land whose lead does not sit properly on it. */
export interface JointFinding {
  padNumber: string;
  at: "foot" | "width";
  /** The overlap fraction, between 0 and 1. */
  fraction: number;
  /** A reviewer's sentence, naming both numbers. */
  detail: string;
}

export interface JointReport {
  /** How many lands were overlaid. Zero means the check did not run. */
  overlaid: number;
  /** How many were skipped because their axis states no span. */
  skipped: number;
  /** Why it did not run at all, when it did not. Null when it ran. */
  unavailable: string | null;
  /** The worst overlap found anywhere on the footprint. */
  worst: Overlap;
  findings: JointFinding[];
}

/**
 * How little of the seated foot may sit on copper before this is a finding.
 *
 * SWEPT, not chosen. `bench:joints` prints the sweep this came from: every
 * footprint in the corpus measured as built, and then again with each defect
 * shape this product has actually shipped injected into its record - a decimal
 * point on the land span, the land's two axes exchanged, a sibling package's
 * pattern, inches read as millimetres, a decimal point on the lead span.
 *
 *   bar   correct parts flagged   defect records flagged
 *   0.95        22 of 60                 71 of 269
 *   0.80        20 of 60                 71 of 269
 *   0.70         4 of 60                 71 of 269
 *   0.60         2 of 60                 71 of 269
 *   0.50         1 of 60                 70 of 269
 *
 * The correct population falls off a cliff between 0.80 and 0.70 and the defect
 * population does not move at all across the whole range, which is what a real
 * separation looks like. 0.60 sits in the middle of the flat part rather than on
 * either edge of it.
 *
 * The cluster this admits is genuine and worth naming: eleven SOIC-8s sit at
 * 0.768 because JEDEC MS-012 tolerances the seated foot from 0.40 to 1.27 mm and
 * every vendor lays out its land for the middle of that. A bar above 0.80 would
 * report the industry's most standard footprint as defective, on eleven parts,
 * which is a check that teaches its reader to click past it.
 */
const MIN_FOOT_ON_COPPER = 0.6;

/**
 * Slack on a comparison of two printed figures, in mm.
 *
 * Not a manufacturing tolerance. Both numbers come off drawings that print two
 * or three decimal places and are often converted from inches on the way, so two
 * figures meant to be equal differ in the last digit. A micron cannot hide a
 * real overhang, which is measured in tenths.
 */
const ROUNDING_MM = 0.001;

/**
 * Which axis a land's lead runs along.
 *
 * Read off the land's own shape rather than from the arrangement, because the
 * placer states the invariant that makes it readable: "a land is LONG in the
 * direction the lead runs, which is outward from the body". A SQUARE land breaks
 * the tie by position, which is correct for every arrangement built here: a lead
 * row sits further out along its outward axis than it spreads along the row,
 * because the leads have to fit across the face of the body they leave.
 */
function outwardAxis(pad: Pad): "x" | "y" | null {
  if (pad.widthMm > pad.heightMm + ROUNDING_MM) return "x";
  if (pad.heightMm > pad.widthMm + ROUNDING_MM) return "y";
  const { xMm, yMm } = pad.centre;
  if (Math.abs(xMm) > Math.abs(yMm) + ROUNDING_MM) return "x";
  if (Math.abs(yMm) > Math.abs(xMm) + ROUNDING_MM) return "y";
  return null;
}

function usable(range: Range | null | undefined): range is Range {
  return (
    !!range &&
    Number.isFinite(range.minMm) &&
    Number.isFinite(range.maxMm) &&
    range.minMm > 0 &&
    range.maxMm >= range.minMm
  );
}

/**
 * How much of one lead lands on one pad, at the worst consistent corner of the
 * lead's tolerance box.
 *
 * Exported because it is the whole calculation, and a test that can only reach
 * it through a built footprint cannot pin the arithmetic.
 */
export function overlapOn(
  pad: Pad,
  axis: "x" | "y",
  /** Where the lead's outer edge sits, measured from the package centre line. */
  outerEdge: Range,
  contact: Range,
  width: Range
): Overlap {
  const centre = Math.abs(axis === "x" ? pad.centre.xMm : pad.centre.yMm);
  const alongMm = axis === "x" ? pad.widthMm : pad.heightMm;
  const acrossMm = axis === "x" ? pad.heightMm : pad.widthMm;
  const landOuter = centre + alongMm / 2;
  const landInner = centre - alongMm / 2;

  let alongFoot = Infinity;
  for (const toe of [outerEdge.minMm, outerEdge.maxMm]) {
    for (const foot of [contact.minMm, contact.maxMm]) {
      const heel = toe - foot;
      const onCopper = Math.max(0, Math.min(landOuter, toe) - Math.max(landInner, heel));
      alongFoot = Math.min(alongFoot, onCopper / foot);
    }
  }

  // AGAINST THE NARROWEST LEAD THE PART CAN HAVE, which is the comparison that
  // means something. A land narrower than the WIDEST permitted lead is a design
  // choice every QFN vendor makes, and flagging it reports six correct TI
  // packages. A land narrower than the NARROWEST permitted lead cannot cover the
  // terminal on any part that leaves the factory, which is a contradiction
  // between two pages of one datasheet rather than a preference.
  const acrossWidth = Math.min(acrossMm, width.minMm) / width.minMm;
  return { alongFoot, acrossWidth };
}

/** Where the lead's outer edge sits on one axis, or null if the record does not say. */
function outerEdgeOn(part: ResolvedPart, axis: "x" | "y", formedLeadSpanMm?: number): Range | null {
  const d = part.dimensions;
  const half = (range: Range): Range => ({ minMm: range.minMm / 2, maxMm: range.maxMm / 2 });

  // A NO-LEAD terminal's outer edge is the body edge. `bodyWidthMm` is the x
  // extent and `bodyLengthMm` the y, which is the placer's convention.
  if (d.leadForm === "nolead") {
    const bodyMm = axis === "x" ? d.bodyWidthMm : d.bodyLengthMm;
    if (bodyMm === null || !(bodyMm > 0)) return null;
    return { minMm: bodyMm / 2, maxMm: bodyMm / 2 };
  }

  // A STRAIGHT lead is formed by the assembler, so its seated span is an answer
  // rather than a reading, and one answer covers both axes.
  if (d.leadForm === "straight") {
    if (!(formedLeadSpanMm !== undefined && Number.isFinite(formedLeadSpanMm) && formedLeadSpanMm > 0)) return null;
    return { minMm: formedLeadSpanMm / 2, maxMm: formedLeadSpanMm / 2 };
  }

  if (axis === "y") {
    // A quad's second axis, and ONLY from its own span. See the module note: a
    // rectangular package assessed against its other axis's span reports a
    // correct footprint as a millimetre out.
    if (usable(d.leadSpanCrossMm)) return half(d.leadSpanCrossMm);
    // Square, so one span serves both. Squareness is decided from the BODY,
    // which the drawing always states, rather than assumed from silence.
    const square =
      d.bodyLengthMm !== null &&
      d.bodyWidthMm !== null &&
      Math.abs(d.bodyLengthMm - d.bodyWidthMm) <= 0.05;
    if (!square) return null;
  }
  return usable(d.leadSpanMm) ? half(d.leadSpanMm) : null;
}

/**
 * Lay every lead onto its land and report the ones that miss.
 *
 * Runs on any footprint whose part carries lead dimensions, whatever the lands
 * were built from. It is at its most valuable on a footprint taken from a
 * PRINTED pattern, because there the lands and the leads are two separate
 * readings of two separate pages, and this is the only thing that compares them.
 */
export function solderJoint(
  geometry: FootprintGeometry,
  part: ResolvedPart,
  formedLeadSpanMm?: number,
  formedLeadContactMm?: number
): JointReport {
  const perfect: Overlap = { alongFoot: 1, acrossWidth: 1 };
  const none = (why: string): JointReport => ({
    overlaid: 0,
    skipped: 0,
    unavailable: why,
    worst: perfect,
    findings: []
  });

  const d = part.dimensions;
  const width = d.leadWidthMm;
  const contact = d.leadForm === "straight"
    ? formedLeadContactMm !== undefined && Number.isFinite(formedLeadContactMm) && formedLeadContactMm > 0
      ? { minMm: formedLeadContactMm, maxMm: formedLeadContactMm }
      : null
    : d.leadContactMm;
  if (!usable(width) || !usable(contact)) {
    return none("the package drawing's lead width and seated foot were not both read");
  }

  // A GRID package has no formed lead to overlay. Its terminals are balls or
  // pads on the underside sized by a ball diameter, not by a span and a foot.
  // Saying so is different from finding nothing wrong.
  if (geometry.provenance.arrangement === "grid") {
    return none("a grid array has no formed lead to lay on its land");
  }

  const padNumber = thermalPadNumber(part.pinCount);
  const lands = geometry.pads.filter(
    (pad) =>
      pad.mounting === "smd" &&
      pad.number !== "EP" &&
      !(part.exposedPad && pad.number === padNumber)
  );
  if (lands.length === 0) return none("this footprint has no surface-mount lead lands");

  const edges = {
    x: outerEdgeOn(part, "x", formedLeadSpanMm),
    y: outerEdgeOn(part, "y", formedLeadSpanMm)
  };
  if (edges.x === null && edges.y === null) {
    return none("the drawing states no span or body to place the lead's outer edge from");
  }

  const worst: Overlap = { ...perfect };
  const findings: JointFinding[] = [];
  let overlaid = 0;
  let skipped = 0;

  for (const pad of lands) {
    const axis = outwardAxis(pad);
    if (axis === null) {
      skipped += 1;
      continue;
    }
    const outerEdge = edges[axis];
    if (outerEdge === null) {
      skipped += 1;
      continue;
    }
    const overlap = overlapOn(pad, axis, outerEdge, contact, width);
    overlaid += 1;
    worst.alongFoot = Math.min(worst.alongFoot, overlap.alongFoot);
    worst.acrossWidth = Math.min(worst.acrossWidth, overlap.acrossWidth);

    const alongMm = axis === "x" ? pad.widthMm : pad.heightMm;
    const acrossMm = axis === "x" ? pad.heightMm : pad.widthMm;
    if (overlap.alongFoot < MIN_FOOT_ON_COPPER) {
      findings.push({
        padNumber: pad.number,
        at: "foot",
        fraction: overlap.alongFoot,
        detail:
          `only ${(overlap.alongFoot * 100).toFixed(0)}% of the seated foot lands on copper: the lead reaches ` +
          `${outerEdge.minMm.toFixed(3)} mm from the centre line and its ${alongMm.toFixed(3)} mm land runs from ` +
          `${(Math.abs(axis === "x" ? pad.centre.xMm : pad.centre.yMm) - alongMm / 2).toFixed(3)} to ` +
          `${(Math.abs(axis === "x" ? pad.centre.xMm : pad.centre.yMm) + alongMm / 2).toFixed(3)} mm`
      });
    }
    if (overlap.acrossWidth < 1 - ROUNDING_MM) {
      findings.push({
        padNumber: pad.number,
        at: "width",
        fraction: overlap.acrossWidth,
        detail:
          `the land is ${acrossMm.toFixed(3)} mm across and the lead is at least ${width.minMm.toFixed(3)} mm wide, ` +
          `so the narrowest lead this part can have still overhangs its copper`
      });
    }
  }

  if (overlaid === 0) return none("no land on this footprint could be given an outward direction and a span");
  return { overlaid, skipped, unavailable: null, worst, findings };
}
