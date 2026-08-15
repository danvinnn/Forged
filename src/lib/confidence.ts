import { computeLandPattern, COURTYARD_EXCESS, type DensityLevel } from "./ipc7351";
import type { ResolvedPart } from "./types";

/**
 * How much to believe a record, from evidence already in hand.
 *
 * ## What this replaces
 *
 * Until 2026-08-14 the answer to "is this reading any good?" was the cross-check:
 * a deterministic parser read the document too, and where the two disagreed a
 * person was asked. That was a real signal and it is gone, because the parser was
 * measured to contribute nothing to any dimension and was deleted.
 *
 * A confidence NUMBER is not a replacement. "0.62" tells a reviewer nothing they
 * can act on, and averaging several unrelated checks into one figure destroys the
 * only useful part: which check failed. So this produces a LIST of named checks,
 * each of which either passed, failed with a specific reason, or could not run.
 *
 * ## The rule every check here obeys
 *
 * No new model calls, and no new sources. Every signal is either a fact about
 * the record we already hold or a comparison between two things already in it.
 * A check that needs to go and look something up is not a confidence signal, it
 * is another reader, and it would want its own justification.
 *
 * A check also has to be able to FAIL on a real record. Several obvious-sounding
 * ones were left out for failing that test: "the pin count is positive" cannot
 * fail, because the schema already refuses a record where it is not.
 */

export type CheckState =
  /** The evidence exists and agrees. */
  | "pass"
  /** The evidence exists and contradicts the record. */
  | "fail"
  /** The record does not carry what the check needs. Not a criticism. */
  | "unavailable";

export interface ConfidenceCheck {
  /** Stable identifier, for a UI and for a diff between two runs. */
  id: string;
  /** What was checked, in the reviewer's language. */
  label: string;
  state: CheckState;
  /**
   * What the check found. Written to be read on its own: a reviewer sees this
   * line and nothing else, so "lead span 6.4 mm is shorter than the 7.0 mm body"
   * is the standard, not "geometry inconsistent".
   */
  detail: string;
  /**
   * What goes wrong if this is ignored. Present on failures only, because a
   * passing check does not need to argue for itself.
   */
  consequence?: string;
}

/** A lead span must reach at least across the body it leaves. */
function spanCoversBody(part: ResolvedPart): ConfidenceCheck {
  const span = part.dimensions.leadSpanMm;
  const bodyWidth = part.dimensions.bodyWidthMm;
  const bodyLength = part.dimensions.bodyLengthMm;
  const base = { id: "span-covers-body", label: "Lead span reaches past the body" };
  if (!span || (bodyWidth === null && bodyLength === null)) {
    return { ...base, state: "unavailable", detail: "The drawing's lead span or body size was not read." };
  }
  // A dual package's span is measured ACROSS the narrow axis, so it is compared
  // against the smaller body dimension. Comparing against the larger one would
  // fail every rectangular package correctly read.
  const across = Math.min(...[bodyWidth, bodyLength].filter((value): value is number => value !== null));
  // The MAXIMUM span against the body, not the minimum.
  //
  // Measured on 66 real records 2026-08-14: comparing the minimum failed four
  // correct readings, every one of them the same shape. A drawing prints the
  // span as a tolerance range and the body as a single nominal, so a 4.0 mm body
  // with a 3.9 to 4.1 mm span is entirely consistent and the minimum is below
  // the nominal by construction. Only a span whose LARGEST value still ends
  // inside the body is unambiguously wrong.
  if (span.maxMm >= across) {
    return {
      ...base,
      state: "pass",
      detail: `Lead span ${span.minMm} to ${span.maxMm} mm against a ${across} mm body.`
    };
  }
  return {
    ...base,
    state: "fail",
    detail: `Lead span reaches only ${span.maxMm} mm, which is inside the ${across} mm body.`,
    consequence: "Leads cannot end inside the package they leave, so one of the two was read off the wrong dimension line. The lands would sit under the part."
  };
}

/** Two lands in one row cannot be wider than the pitch that separates them. */
function landsFitThePitch(part: ResolvedPart): ConfidenceCheck {
  const width = part.dimensions.landPadWidthMm;
  const pitch = part.dimensions.pitchMm;
  const base = { id: "lands-fit-pitch", label: "Neighbouring lands do not touch" };
  if (width === null || pitch === null) {
    return { ...base, state: "unavailable", detail: "No printed land width or no pitch was read." };
  }
  if (width < pitch) {
    return { ...base, state: "pass", detail: `${width} mm lands on a ${pitch} mm pitch.` };
  }
  return {
    ...base,
    state: "fail",
    detail: `A ${width} mm land on a ${pitch} mm pitch leaves no gap to its neighbour.`,
    consequence: "Adjacent lands would merge into one, which shorts the two pins together on every board built."
  };
}

/** Opposing rows of lands cannot meet at the centre of the package. */
function landsClearTheCentre(part: ResolvedPart): ConfidenceCheck {
  const length = part.dimensions.landPadLengthMm;
  const span = part.dimensions.landSpanMm;
  const base = { id: "lands-clear-centre", label: "Opposing lands do not overlap" };
  if (length === null || span === null) {
    return { ...base, state: "unavailable", detail: "No printed land pattern was read." };
  }
  const gap = span - length;
  if (gap > 0) {
    return { ...base, state: "pass", detail: `${gap.toFixed(3)} mm of clear board between the two rows.` };
  }
  return {
    ...base,
    state: "fail",
    detail: `A ${length} mm land on a ${span} mm centre span puts the two rows ${(-gap).toFixed(3)} mm into each other.`,
    consequence: "Every pin on one side would be shorted to the pin opposite it."
  };
}

/** An exposed pad has to fit inside the body it is on the underside of. */
function thermalPadFitsBody(part: ResolvedPart): ConfidenceCheck {
  const padLength = part.dimensions.thermalPadLengthMm;
  const padWidth = part.dimensions.thermalPadWidthMm;
  const bodyLength = part.dimensions.bodyLengthMm;
  const bodyWidth = part.dimensions.bodyWidthMm;
  const base = { id: "thermal-pad-fits", label: "Exposed pad fits inside the body" };
  if (padLength === null || padWidth === null || bodyLength === null || bodyWidth === null) {
    return { ...base, state: "unavailable", detail: "No exposed pad, or no body size was read." };
  }
  if (padLength < bodyLength && padWidth < bodyWidth) {
    return {
      ...base,
      state: "pass",
      detail: `${padLength} x ${padWidth} mm pad on a ${bodyLength} x ${bodyWidth} mm body.`
    };
  }
  return {
    ...base,
    state: "fail",
    detail: `A ${padLength} x ${padWidth} mm pad does not fit a ${bodyLength} x ${bodyWidth} mm body.`,
    consequence: "The pad is on the underside of the package, so it cannot be larger. One of the two came off the wrong drawing, and the thermal land would be sized from it."
  };
}

/** The pin table and the pin count have to describe the same part. */
function pinTableMatchesCount(part: ResolvedPart): ConfidenceCheck {
  const base = { id: "pins-match-count", label: "Pin table matches the pin count" };
  const numbered = part.pins.filter((pin) => /^\d+$/.test(pin.number)).length;
  if (numbered === part.pinCount) {
    return { ...base, state: "pass", detail: `${numbered} numbered pins for a ${part.pinCount}-pin part.` };
  }
  return {
    ...base,
    state: "fail",
    detail: `The table holds ${numbered} numbered pins and the part is stated as ${part.pinCount}-pin.`,
    consequence: "One land per pin is generated from the table, so the footprint has the wrong number of pads or the symbol is missing a pin."
  };
}

/** Every pin number appears once, and the run has no holes in it. */
function pinNumbersAreComplete(part: ResolvedPart): ConfidenceCheck {
  const base = { id: "pin-numbers-complete", label: "Pin numbers run 1 to N with no gaps" };
  const numbers = part.pins.map((pin) => pin.number).filter((number) => /^\d+$/.test(number)).map(Number);
  if (numbers.length === 0) return { ...base, state: "unavailable", detail: "No numbered pins." };
  const seen = new Set(numbers);
  const duplicates = numbers.length !== seen.size;
  const missing: number[] = [];
  for (let number = 1; number <= Math.max(...numbers); number += 1) {
    if (!seen.has(number)) missing.push(number);
  }
  if (!duplicates && missing.length === 0) {
    return { ...base, state: "pass", detail: `1 to ${Math.max(...numbers)}, complete.` };
  }
  return {
    ...base,
    state: "fail",
    detail: duplicates
      ? "The same pin number appears more than once."
      : `No row for pin ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ", ..." : ""}.`,
    consequence: "A pin with no row gets no land and no symbol pin, so that connection simply does not exist on the board."
  };
}

/** The per-side lead counts have to add up to the part. */
function sidesAddUp(part: ResolvedPart): ConfidenceCheck {
  const base = { id: "sides-add-up", label: "Leads per side add up to the pin count" };
  const raw = part.dimensions.leadsPerSide;
  if (!raw) return { ...base, state: "unavailable", detail: "The drawing's per-side counts were not read." };
  const counts = raw.split(",").map((piece) => Number(piece.trim()));
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (counts.every((count) => Number.isInteger(count) && count >= 0) && total === part.pinCount) {
    return { ...base, state: "pass", detail: `${raw} adds to ${part.pinCount}.` };
  }
  return {
    ...base,
    state: "fail",
    detail: `${raw} adds to ${total}, and the part has ${part.pinCount} pins.`,
    consequence: "The pads are placed side by side from this list, so a wrong total puts leads where the package has none."
  };
}

/**
 * The datasheet's own printed footprint, against what IPC-7351B would allow.
 *
 * The practitioner rule, from the PCB Libraries forum where the IPC-7351 authors
 * post: any manufacturer pattern between the Least and Most density levels is
 * fine to use. So a printed pattern inside the band is a design choice, and one
 * outside it is a misread of the drawing.
 *
 * This is the check the generator already runs as a VETO. Surfacing it here as
 * well is not duplication: the generator's version decides whether to build, and
 * this one tells a reviewer why a part that built is worth trusting.
 */
function printedPatternInBand(part: ResolvedPart, densityLevel: DensityLevel): ConfidenceCheck {
  const base = { id: "printed-in-band", label: "Printed footprint agrees with IPC-7351B" };
  const padLength = part.dimensions.landPadLengthMm;
  const centreSpan = part.dimensions.landSpanMm;
  const span = part.dimensions.leadSpanMm;
  const width = part.dimensions.leadWidthMm;
  const contact = part.dimensions.leadContactMm;
  if (padLength === null || centreSpan === null || !span || !width || !contact) {
    return {
      ...base,
      state: "unavailable",
      detail: "The document does not print both a footprint and the lead dimensions to check it against."
    };
  }
  // GULL-WING ONLY, and this is the same limit the generator works to.
  //
  // The band is computed from IPC-7351B's fillet goals, and only the gull-wing
  // table is transcribed in `ipc7351.ts`. A no-lead package has no lead to span
  // anything: its "span" is the body edge, so the model produces a band the real
  // pattern is correctly outside of.
  //
  // Measured on the same 66 records: without this gate the check failed six
  // readings and every one was a QFN or DFN, two of them by 0.01 mm. A check
  // that fires on correct answers spends the reviewer's attention and teaches
  // them to click past it.
  if (part.dimensions.leadForm !== "gullwing") {
    return {
      ...base,
      state: "unavailable",
      detail: "IPC-7351B's band is published per lead form and only the gull-wing goals are transcribed here."
    };
  }
  try {
    const lead = { form: "gullwing" as const, span, width, contact };
    const most = computeLandPattern(lead, { densityLevel: "A" });
    const least = computeLandPattern(lead, { densityLevel: "C" });
    const zMax = centreSpan + padLength;
    if (zMax >= least.zMaxMm && zMax <= most.zMaxMm) {
      return {
        ...base,
        state: "pass",
        detail: `The printed pattern reaches ${zMax.toFixed(2)} mm toe to toe, inside the ${least.zMaxMm.toFixed(2)} to ${most.zMaxMm.toFixed(2)} mm the standard allows.`
      };
    }
    return {
      ...base,
      state: "fail",
      detail: `The printed pattern reaches ${zMax.toFixed(2)} mm toe to toe, outside the ${least.zMaxMm.toFixed(2)} to ${most.zMaxMm.toFixed(2)} mm the standard allows for these leads.`,
      consequence: "Either a dimension was misread or this vendor's house rule is well outside normal practice. Both are worth a look before the board is cut."
    };
  } catch {
    return { ...base, state: "unavailable", detail: `The lead dimensions do not compute a land pattern to compare against (density ${densityLevel}).` };
  }
}

/** Every check, in the order a reviewer should read them. */
export function confidenceChecks(part: ResolvedPart, densityLevel: DensityLevel = "B"): ConfidenceCheck[] {
  return [
    pinTableMatchesCount(part),
    pinNumbersAreComplete(part),
    sidesAddUp(part),
    landsClearTheCentre(part),
    landsFitThePitch(part),
    spanCoversBody(part),
    thermalPadFitsBody(part),
    printedPatternInBand(part, densityLevel)
  ];
}

/**
 * A one-line summary, for a manifest or a log.
 *
 * Deliberately not a score. "3 of 8 checks could not run" is a fact a reviewer
 * can act on; a number derived from it is not.
 */
export function summariseChecks(checks: readonly ConfidenceCheck[]): string {
  const failed = checks.filter((check) => check.state === "fail");
  const passed = checks.filter((check) => check.state === "pass").length;
  const unavailable = checks.filter((check) => check.state === "unavailable").length;
  if (failed.length > 0) {
    return `${failed.length} check${failed.length === 1 ? "" : "s"} FAILED (${failed
      .map((check) => check.id)
      .join(", ")}); ${passed} passed, ${unavailable} could not run.`;
  }
  return `${passed} of ${checks.length} checks passed, ${unavailable} could not run on this record.`;
}

/** Re-exported so a caller sizing a courtyard and a caller checking one agree. */
export { COURTYARD_EXCESS };
