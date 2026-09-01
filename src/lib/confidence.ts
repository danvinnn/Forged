import { computeLandPattern, COURTYARD_EXCESS } from "./ipc7351";
import type { ResolvedPart } from "./types";
import { isGridAddressed, thermalPadNumber } from "./geometry";
import type { FootprintGeometry, SymbolGeometry } from "./geometry";

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

/**
 * Opposing rows of lands cannot meet at the centre of the package.
 *
 * BOTH AXES. A four-sided package has two centre spans and this checked one, so
 * a reviewer looking at a rectangular quad was told the pattern was clear when
 * the axis nobody checked could have its rows through each other. The output
 * invariant catches the resulting overlap at build time, which is why this was
 * a visibility gap rather than wrong copper, and a check that reports on half a
 * footprint is worse than one that says it could not run.
 */
function landsClearTheCentre(part: ResolvedPart): ConfidenceCheck {
  const length = part.dimensions.landPadLengthMm;
  const span = part.dimensions.landSpanMm;
  const crossSpan = part.dimensions.landSpanCrossMm;
  const base = { id: "lands-clear-centre", label: "Opposing lands do not overlap" };
  if (length === null || span === null) {
    return { ...base, state: "unavailable", detail: "No printed land pattern was read." };
  }
  // WHAT IS ACTUALLY IN THE GAP.
  //
  // This measured the distance between opposing rows and called the whole of it
  // "clear board", without ever asking what sits in the middle. On a package
  // with an exposed pad, most of it does.
  //
  // TPS7A4700 built from a 3.9 mm centre span: gap 3.150 mm, exposed pad 3.150
  // mm square. Twenty lead lands abutting the ground pad, and this check
  // reported "3.150 mm of clear board between the opposing rows" - the exact
  // width of the copper filling it. A PCB librarian found it on 2026-08-28 by
  // unpacking the file and measuring, and rightly called the check blind.
  //
  // `thermalPadWidthMm` is the pad's x extent and `thermalPadLengthMm` its y,
  // which is the placer's convention and the same one `bench:copper` states.
  // `landSpanMm` is the x spread and `landSpanCrossMm` the y, so each axis is
  // compared against the pad extent that actually lies across it.
  const padAcross = part.exposedPad ? part.dimensions.thermalPadWidthMm ?? 0 : 0;
  const padAlong = part.exposedPad ? part.dimensions.thermalPadLengthMm ?? 0 : 0;
  const axes: Array<{ what: string; span: number; occupied: number }> = [
    { what: "the two rows", span, occupied: padAcross }
  ];
  if (crossSpan !== null) axes.push({ what: "the other two rows", span: crossSpan, occupied: padAlong });

  for (const axis of axes) {
    const gap = axis.span - length;
    if (gap <= 0) {
      return {
        ...base,
        state: "fail",
        detail: `A ${length} mm land on a ${axis.span} mm centre span puts ${axis.what} ${(-gap).toFixed(3)} mm into each other.`,
        consequence: "Every pin on one side would be shorted to the pin opposite it."
      };
    }
    // The pad sits centred in the gap, so the board either side of it is half
    // what is left over.
    const clearance = (gap - axis.occupied) / 2;
    if (axis.occupied > 0 && clearance <= 0) {
      return {
        ...base,
        state: "fail",
        detail:
          `A ${length} mm land on a ${axis.span} mm centre span leaves ${gap.toFixed(3)} mm between ${axis.what}, ` +
          `and the exposed pad is ${axis.occupied} mm across it. There is ${clearance <= 0 ? "no" : ""} board left ` +
          `between them${clearance < 0 ? `, by ${(-clearance).toFixed(3)} mm` : ""}.`,
        consequence:
          "Every lead land would be continuous copper with the exposed pad, which is usually ground: every pin shorted at once."
      };
    }
  }
  const gaps = axes
    .map((axis) =>
      axis.occupied > 0
        ? `${((axis.span - length - axis.occupied) / 2).toFixed(3)} mm`
        : `${(axis.span - length).toFixed(3)} mm`
    )
    .join(" and ");
  return {
    ...base,
    state: "pass",
    detail: padAcross > 0 || padAlong > 0
      ? `${gaps} of clear board between the lead lands and the exposed pad.`
      : `${gaps} of clear board between the opposing rows.`
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
  // A GRID POSITION IS A DESIGNATOR TOO. Counting only `/^\d+$/` reported every
  // ball-grid part as a table of zero pins against a stated count of a hundred
  // and forty-three, which is a failed check on a pinout that is entirely
  // correct. `isGridAddressed` decides on the SHAPE of the table rather than on
  // the package name; see `geometry.ts`.
  const numbered = isGridAddressed(part.pins)
    ? part.pins.length
    : part.pins.filter((pin) => /^\d+$/.test(pin.number)).length;
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
function printedPatternInBand(part: ResolvedPart): ConfidenceCheck {
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
    // The BAND, not one level, so the message must not name one. It said
    // "(density B)", which told a reviewer a level had been applied when the
    // check computes levels A and C and compares against the range between them.
    return { ...base, state: "unavailable", detail: "The lead dimensions do not compute a land pattern to compare against." };
  }
}

/** Every check, in the order a reviewer should read them. */
export function confidenceChecks(part: ResolvedPart): ConfidenceCheck[] {
  return [
    pinTableMatchesCount(part),
    pinNumbersAreComplete(part),
    sidesAddUp(part),
    landsClearTheCentre(part),
    landsFitThePitch(part),
    spanCoversBody(part),
    thermalPadFitsBody(part),
    printedPatternInBand(part)
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

// ---------------------------------------------------------------------------
// The FOOTPRINT, rather than the reading it came from
// ---------------------------------------------------------------------------

/**
 * Everything above checks the RECORD: values read off a datasheet, and whether
 * they contradict each other. Nothing checked the thing actually built from
 * them, and that gap is not theoretical. Both of the wrong footprints this
 * product has produced passed every check above, because in both cases the
 * inputs were individually fine and the ARRANGEMENT was wrong:
 *
 *   - a TO-220's three pins laid out as two opposing rows, because the
 *     through-hole path assumed two rows and never read `leadSides`
 *   - a twenty-pin table built under a twenty-eight pin package's name, because
 *     relabelling a part carried the wrong package's pinout across
 *
 * A reviewer cannot see either in a record. They are visible immediately in the
 * pads.
 *
 * ## Why these REFUSE rather than warn
 *
 * These are statements about the FOOTPRINT rather than about the reading, which
 * is what everything above is. A footprint whose lands overlap is not a
 * footprint with a caveat; it is a short circuit, and an engineer would want it
 * withheld rather than shipped with a note they might click past.
 *
 * What a violation does NOT establish is whose fault it is. Overlapping lands
 * come from a generator bug or from a misread dimension, and the geometry cannot
 * tell the two apart: on the first run of these checks, two quad packages were
 * caught with all four CORNER lands overlapping, and the likely cause was a
 * centre span read too small rather than anything in the placement. The message
 * says both and points at the values a user can actually correct.
 *
 * So `validateGeometry` throws, and `confidenceChecks` never sees them. They are
 * reported in the manifest as evidence of what was verified, which is what a
 * reviewer opening the zip six months later actually needs.
 *
 * Mutation testing is what proves these can fail: `npm run bench:mutation`
 * breaks the generator in twenty ways and every one of them trips something.
 */
export class FootprintInvalidError extends Error {
  constructor(readonly violations: string[]) {
    super(
      `The generated footprint is not valid and was not written:\n  ${violations.join("\n  ")}\n` +
        `Either a dimension was misread or this is a defect in Forge, and which cannot be told ` +
        `from the geometry alone. Check the land pattern values against the page they were read ` +
        `from; correcting one in the review panel rebuilds it. No file is produced meanwhile.`
    );
    this.name = "FootprintInvalidError";
  }
}

/** A pad's extent along each axis, for the overlap and containment checks. */
function extent(pad: { centre: { xMm: number; yMm: number }; widthMm: number; heightMm: number }) {
  return {
    x0: pad.centre.xMm - pad.widthMm / 2,
    x1: pad.centre.xMm + pad.widthMm / 2,
    y0: pad.centre.yMm - pad.heightMm / 2,
    y1: pad.centre.yMm + pad.heightMm / 2
  };
}

/**
 * Floating-point slack around ZERO CLEARANCE.
 *
 * It used to read "two lands that share an edge exactly are not overlapping",
 * and the test below required a strict overlap wider than this before calling a
 * short. That sentence is true about rectangles and false about copper: two
 * features that share an edge are one continuous region, and a fabricator etches
 * them as one.
 *
 * TPS7A4700 is what it cost. Built from a 3.9 mm centre span its twenty lead
 * lands have an inner edge at 1.575 mm, and its 3.15 mm exposed pad has a half
 * extent of 1.575 mm. They abut exactly, all twenty of them, so every signal pin
 * is continuous copper with the ground pad - and this check reported no problem
 * at all, because nothing overlapped by more than a micron.
 *
 * Found 2026-08-28 by a PCB librarian who unpacked the file and measured it:
 * "a wrong footprint that announces itself is a nuisance; a wrong footprint that
 * passes its own checks is a recall."
 *
 * The slack is now what its name says, an allowance for arithmetic in the last
 * decimal, and it is applied around zero rather than as permission to touch. No
 * minimum clearance is invented here: this asserts only that copper which meets
 * is joined, which is arithmetic rather than a judgement about a fab.
 */
const TOUCHING_MM = 1e-6;

/**
 * The footprint's own invariants, checked against the part it claims to be.
 *
 * Returns the violations rather than throwing, so a caller that wants to report
 * them (the package chooser, a bench) can, and `validateGeometry` throws for the
 * caller that must not ship.
 */
export function geometryViolations(geometry: FootprintGeometry, part: ResolvedPart): string[] {
  const problems: string[] = [];
  // Paste-only apertures carry no pin number and are not lands.
  const lands = geometry.pads.filter((pad) => pad.number !== "");

  // ONE LAND PER PIN, AND NO OTHERS.
  //
  // The check the SSOP-28 defect needed. A pad for a pin the part does not have
  // connects to nothing; a pin with no pad is a connection that silently does
  // not exist.
  //
  // Taken from `pinCount` rather than from the pins array, because that is what
  // the pad placer numbers from: `dualRowSides(part.pinCount)` produces 1..N.
  // Checking against the pin TABLE instead made this fire on a record whose
  // table was empty but whose count was known, which is a different defect and
  // one `pins-match-count` above already reports.
  //
  // A GRID-ADDRESSED PART IS CHECKED AGAINST ITS OWN DESIGNATORS. `A1` is not
  // 1..N and never will be, so the numbered set would report every land on a
  // ball-grid array as belonging to no pin of the part. The guarantee is
  // unchanged and it is the same sentence: one land per terminal the table
  // lists, and no others. The reason the numbered path reads `pinCount` instead
  // - a known count with an empty table - cannot arise here, because a grid's
  // designators ARE the count.
  const grid = isGridAddressed(part.pins);
  const wanted = grid
    ? new Set(part.pins.map((pin) => pin.number))
    : new Set(Array.from({ length: part.pinCount }, (_, index) => String(index + 1)));
  if (part.exposedPad && !grid) wanted.add(thermalPadNumber(part.pinCount));
  const seen = new Map<string, number>();
  for (const pad of lands) seen.set(pad.number, (seen.get(pad.number) ?? 0) + 1);

  for (const number of wanted) {
    const count = seen.get(number) ?? 0;
    if (count !== 1) problems.push(`pin ${number} has ${count} lands, not one`);
  }
  for (const [number, count] of seen) {
    if (!wanted.has(number)) problems.push(`land "${number}" belongs to no pin of this part (${count} of them)`);
  }

  // AND EVERY PIN THE TABLE LISTS HAS ONE.
  //
  // The check above runs against `pinCount`, because that is what the pad placer
  // numbers from, and its own note explains why: keying off the pins array made
  // it fire on a record with a known count and an empty table. That is right and
  // it leaves a hole, because a table can hold a number the count does not reach.
  //
  // Measured 2026-08-16 with a pin renamed from 8 to 9 in the record panel,
  // which the UI allows inline: the footprint came out with pads 1..8 and the
  // symbol with seven pins, and every check passed. The pads satisfy `wanted`
  // exactly, so nothing above sees it; pin 9 simply does not exist on the board
  // and pad 8 connects to nothing in the netlist.
  //
  // This is the same defect as a gapped per-package table, arriving by a third
  // door. `mergeModelValues` guards the model path and `partSchema` guards the
  // export route, and both are guards on the INPUT, so each new door needs its
  // own. This one is on the OUTPUT, where there is only ever one door: whatever
  // produced the record, the footprint and the symbol have to describe the same
  // set of pins.
  //
  // Skipped for an empty table, which is a different and already-reported gap.
  for (const pin of part.pins) {
    if (!grid && !/^\d+$/.test(pin.number)) continue;
    if (!seen.has(pin.number)) {
      problems.push(
        `the pin table lists pin ${pin.number} and no land was placed for it, so that connection does not exist`
      );
    }
  }

  // NO TWO LANDS TOUCH. This is what a wrong pitch, a wrong span or a wrong
  // side-count all produce, whichever of them is at fault.
  for (let left = 0; left < lands.length; left += 1) {
    for (let right = left + 1; right < lands.length; right += 1) {
      const a = extent(lands[left]);
      const b = extent(lands[right]);
      // MEETING COUNTS, NOT ONLY CROSSING. See `TOUCHING_MM`.
      const joined =
        a.x0 <= b.x1 + TOUCHING_MM &&
        b.x0 <= a.x1 + TOUCHING_MM &&
        a.y0 <= b.y1 + TOUCHING_MM &&
        b.y0 <= a.y1 + TOUCHING_MM;
      if (joined) {
        const apart =
          Math.max(a.x0 - b.x1, b.x0 - a.x1, a.y0 - b.y1, b.y0 - a.y1);
        problems.push(
          apart >= -TOUCHING_MM
            ? `lands ${lands[left].number} and ${lands[right].number} meet edge to edge, so they are one piece of copper`
            : `lands ${lands[left].number} and ${lands[right].number} overlap, which shorts them together`
        );
      }
    }
  }

  // A SINGLE ROW OF LANDS CANNOT BE FOUR TIMES THE PACKAGE IT COMES OUT OF.
  //
  // LIVE ON LT1013, found 2026-08-25. Its 8-lead TO-5 metal can builds EIGHT
  // PADS IN A STRAIGHT LINE 35.56 MM LONG on a body 8.95 mm across, and ships:
  // nothing refuses it, no confidence check covers it, and it looks like an
  // ordinary SIP in CAD. The cause is that 5.08 mm on a metal can drawing is the
  // LEAD CIRCLE DIAMETER, and this generator has no circular arrangement, so it
  // was read as a linear pitch and laid out as a row. The chooser offered that
  // package under two names and both built.
  //
  // ONLY THE SINGLE ROW, and the reason is which reading can be checked against
  // which. On a single row the pads come from the pitch and the count alone:
  // there is no lead span and no printed land pattern, so the body is the ONLY
  // independent measurement of the same package and a disagreement convicts the
  // placement. On a dual or a quad the land span is read off the datasheet's own
  // printed footprint, which measures the package independently, so the body is
  // not the arbiter there and this must not be extended to them.
  //
  // AND THE ROW MAY LEGITIMATELY OVERHANG THE BODY, BY ABOUT A PITCH.
  //
  // The bound is `body + pitch` rather than `body`, and that slack is taken from
  // a hand-read drawing rather than invented. CQZ12805, VA10820's 128-lead
  // ceramic LQFP, prints a 12.40 mm lead row on a 12.00 mm ceramic body - both
  // measured off page 32 by a person - because a lead frame brazed to a ceramic
  // body overhangs it. That is 0.4 mm, exactly the pitch, and it is a correct
  // package rather than a defect.
  //
  // A strict `row > body` was written first, on the reasoning that leads emerge
  // from the body so the row cannot be longer. The reasoning is wrong for any
  // package whose leads are carried on a frame, and `bench:dimensions` is what
  // said so. LT1013 clears the widened bound by a factor of two and a half:
  // 35.56 mm against 8.95 + 5.08.
  const bodyAlongRowMm = part.dimensions.bodyLengthMm;
  const pitchMm = geometry.provenance.pitchMm;
  if (geometry.provenance.arrangement === "single" && bodyAlongRowMm !== null && lands.length > 1) {
    const xs = lands.map((pad) => pad.centre.xMm);
    const rowMm = Math.max(...xs) - Math.min(...xs);
    if (rowMm > bodyAlongRowMm + pitchMm + TOUCHING_MM) {
      problems.push(
        `the ${lands.length} lands form a single row ${rowMm.toFixed(2)} mm long on a body ` +
          `${bodyAlongRowMm} mm across, so they cannot all be leads coming out of it. Either the ` +
          `${pitchMm} mm pitch is not a spacing along a row - a metal can spaces its leads around a ` +
          `circle, and its drawing gives that circle's diameter - or the body was misread`
      );
    }
  }

  // THE COURTYARD IS THE KEEP-OUT. One drawn inside its own lands is worse than
  // none: the board designer trusts it and places the neighbouring part on a pad.
  for (const pad of geometry.pads) {
    const box = extent(pad);
    const outside =
      Math.abs(box.x0) > geometry.courtyard.halfWidthMm + TOUCHING_MM ||
      Math.abs(box.x1) > geometry.courtyard.halfWidthMm + TOUCHING_MM ||
      Math.abs(box.y0) > geometry.courtyard.halfHeightMm + TOUCHING_MM ||
      Math.abs(box.y1) > geometry.courtyard.halfHeightMm + TOUCHING_MM;
    if (outside) problems.push(`land ${pad.number || "(paste)"} reaches outside the courtyard`);
  }

  // AND THE BODY, which is the other half of what IPC-7351B says a courtyard
  // contains: the maximum extent of the land pattern AND the component.
  //
  // Only the lands were checked. Found 2026-08-30 by `bench:outputs`, which
  // swelled the silkscreen body past the courtyard on 86 footprints and had all
  // 86 pass the gate. The body is the silkscreen outline and the 3D solid, so
  // one bigger than its own keep-out prints over the neighbouring part's copper
  // and collides with it in the 3D view, and the board designer trusting the
  // courtyard has been told the part is smaller than it is.
  //
  // `assemble` already sizes the courtyard from the body on both axes, so this
  // is an internal consistency check rather than a new rule: it can only fire on
  // a footprint that contradicts its own construction. Measured on the corpus at
  // 0 of 86 as built, which is what `bench:courtyard` independently reports.
  if (
    geometry.body.halfWidthMm > geometry.courtyard.halfWidthMm + TOUCHING_MM ||
    geometry.body.halfHeightMm > geometry.courtyard.halfHeightMm + TOUCHING_MM
  ) {
    problems.push(
      `the package body is ${(geometry.body.halfWidthMm * 2).toFixed(2)} x ${(geometry.body.halfHeightMm * 2).toFixed(2)} mm ` +
        `and reaches outside its own courtyard, which is ${(geometry.courtyard.halfWidthMm * 2).toFixed(2)} x ` +
        `${(geometry.courtyard.halfHeightMm * 2).toFixed(2)} mm`
    );
  }

  // EVERY THERMAL VIA SITS ON THE PAD IT DRAINS.
  //
  // Nothing in this file mentioned `thermalVias` at all until 2026-08-30, so the
  // one part in the corpus that emits them - TPS54360, six of them - shipped a
  // via array nothing had looked at. A via is COPPER and a hole: one drifting
  // off the thermal pad drills through the board where no land is, and one
  // drifting far enough reaches a lead land and shorts the pad to a signal.
  //
  // Checked against the thermal pad's own extent rather than a tolerance,
  // because the relationship is exact: the vias exist to carry heat out of that
  // pad, so a via not on it is not a thermal via.
  //
  // Found by `bench:outputs`, which derives its field list from what the
  // emitters dereference rather than from memory. This was the one field on the
  // emitted surface with no check anywhere.
  const pad = geometry.pads.find((entry) => entry.number === thermalPadNumber(part.pinCount));
  if (pad) {
    for (const via of geometry.thermalVias) {
      const outside =
        Math.abs(via.centre.xMm - pad.centre.xMm) + via.padMm / 2 > pad.widthMm / 2 + TOUCHING_MM ||
        Math.abs(via.centre.yMm - pad.centre.yMm) + via.padMm / 2 > pad.heightMm / 2 + TOUCHING_MM;
      if (outside) {
        problems.push(
          `a thermal via at (${via.centre.xMm.toFixed(3)}, ${via.centre.yMm.toFixed(3)}) reaches outside the ` +
            `exposed pad it drains, which is ${pad.widthMm} x ${pad.heightMm} mm at ` +
            `(${pad.centre.xMm.toFixed(3)}, ${pad.centre.yMm.toFixed(3)})`
        );
        break;
      }
    }
  }

  // A PLATED HOLE IS NOT PASTED. That joint is made by wave or by hand, and
  // paste in the barrel only fouls it.
  //
  // Note what is NOT checked here, because it cannot be: whether an ordinary
  // land carries paste at all. That is spelled in the EMITTER's layer list, not
  // in this geometry, and the geometry has no field for it. Mutation testing
  // found exactly that hole on 2026-08-16 (deleting `F.Paste` from every SMD pad
  // left the suite green) and it is covered where it lives, by an invariant over
  // the emitted file in `footprint-invariants.test.ts`. Pretending to check it
  // here would be worse than not checking it.
  for (const pad of lands) {
    if (pad.mounting === "through-hole" && (pad.pasteApertures?.length ?? 0) > 0) {
      problems.push(`plated hole ${pad.number} carries paste apertures`);
    }
  }

  // A thermal pad's paste must sit INSIDE its copper. Paste past the edge is
  // solder with nowhere to wet, and it is what bridges to the perimeter pins.
  for (const pad of lands) {
    for (const aperture of pad.pasteApertures ?? []) {
      // MEASURED FROM THE PAD, in the footprint frame both emitters write.
      //
      // This compared the aperture's absolute coordinate against half the pad's
      // size, i.e. treated the centre as a pad-relative offset. Every exposed
      // pad this generator builds sits on the origin, so the two readings
      // coincided and the check appeared to work; on an off-centre pad it would
      // have passed apertures lying entirely outside the copper. See
      // `Pad.pasteApertures`, which now states the frame.
      const offsetXMm = aperture.centre.xMm - pad.centre.xMm;
      const offsetYMm = aperture.centre.yMm - pad.centre.yMm;
      const inside =
        Math.abs(offsetXMm) + aperture.widthMm / 2 <= pad.widthMm / 2 + TOUCHING_MM &&
        Math.abs(offsetYMm) + aperture.heightMm / 2 <= pad.heightMm / 2 + TOUCHING_MM;
      if (!inside) problems.push(`a paste aperture on land ${pad.number} reaches past the copper`);
    }
  }

  // PIN 1 HAS TO BE FINDABLE. A correct footprint placed rotated is as wrong as
  // an incorrect one, and the marker is the only thing that says which way round.
  //
  // A GRID ARRAY'S FIRST TERMINAL IS CALLED A1. The check is the same and only
  // the name differs, and it matters MORE here: every land is hidden under the
  // body once the part is placed and the package is square, so it can be fitted
  // four ways that look identical on the assembled board.
  const firstNumber = grid ? "A1" : "1";
  const one = lands.find((pad) => pad.number === firstNumber);
  if (!one) {
    problems.push(`there is no land for pin ${firstNumber}`);
  } else {
    const distance = Math.hypot(geometry.pin1Marker.xMm - one.centre.xMm, geometry.pin1Marker.yMm - one.centre.yMm);
    const nearest = Math.min(
      ...lands
        .filter((pad) => pad.number !== firstNumber)
        .map((pad) => Math.hypot(geometry.pin1Marker.xMm - pad.centre.xMm, geometry.pin1Marker.yMm - pad.centre.yMm))
    );
    if (Number.isFinite(nearest) && distance > nearest + TOUCHING_MM) {
      problems.push(`the pin-1 marker sits closer to another land than to pin ${firstNumber}`);
    }
  }

  // EVERY NUMBER HAS TO BE A NUMBER. A NaN in an s-expression is a file KiCad
  // will not open, and the only way to find out is to try.
  for (const pad of geometry.pads) {
    for (const [what, value] of [
      ["x", pad.centre.xMm],
      ["y", pad.centre.yMm],
      ["width", pad.widthMm],
      ["height", pad.heightMm]
    ] as const) {
      if (!Number.isFinite(value)) problems.push(`land ${pad.number || "(paste)"} has a non-finite ${what}`);
    }
    if (pad.mounting === "through-hole" && !(pad.drillMm && pad.drillMm > 0)) {
      problems.push(`plated hole ${pad.number} has no drill size`);
    }
  }

  return problems;
}

/**
 * The SYMBOL's invariants, checked against the part it claims to be.
 *
 * ## Why this exists separately
 *
 * `geometryViolations` is an invariant over the FOOTPRINT, and the netlist is
 * made by the footprint and the symbol together: a connection exists only where
 * both name the same pin. Everything in this file checked one half.
 *
 * `buildSymbolGeometry` collects its pins by walking 1..`pinCount` and looking
 * each number up in the pin table, and a number the table does not carry is
 * SKIPPED - one `if (!pin) return;` with no note and no refusal. So a record
 * whose table is gapped shipped a footprint with N lands beside a symbol with
 * fewer pins, and nothing anywhere said so: the footprint's own checks pass,
 * because the pads are numbered from `pinCount` and every pin the table DOES
 * list has one.
 *
 * `types.ts` has carried a comment about this exact hole - a record edited to
 * eight pads against SEVEN symbol pins, "validateGeometry cannot catch it" -
 * since 2026-08-16. It could not, because it was only ever shown the footprint.
 *
 * The input guards do not close it. `mergeModelValues` holds a model pin table
 * to `isGapFreeSequence` and `partSchema` guards the export route, but both are
 * guards on the INPUT and this product has now been caught three times by a
 * fourth door: a per-package table, a package relabel, an inline edit in the
 * review panel. An invariant on the OUTPUT has one door however the record got
 * there, which is the argument `geometryViolations` already makes for itself.
 */
export function symbolViolations(symbol: SymbolGeometry, part: ResolvedPart): string[] {
  const problems: string[] = [];
  const drawn = new Map<string, number>();
  for (const pin of symbol.pins) drawn.set(pin.number, (drawn.get(pin.number) ?? 0) + 1);

  // A GRID-ADDRESSED PART IS CHECKED AGAINST ITS OWN DESIGNATORS.
  //
  // The rule below counts 1..`pinCount` because that is what the FOOTPRINT
  // places, and it is the right rule for every package this generator can lay
  // out. A grid array has no pin called 1: its terminals are `A1`, `B2`, `M12`,
  // and no footprint is emitted for one at all. Running the numbered rule would
  // report a hundred and forty-three missing pins on a symbol that draws every
  // terminal the datasheet lists.
  //
  // The guarantee is unchanged and is stated in the same terms: one symbol pin
  // per terminal, exactly once, and nothing drawn that the table does not list.
  if (isGridAddressed(part.pins)) {
    const listed = new Set(part.pins.map((pin) => pin.number));
    for (const pin of part.pins) {
      const count = drawn.get(pin.number) ?? 0;
      if (count !== 1) {
        problems.push(
          `the pin table lists terminal ${pin.number} ("${pin.name}") and the symbol draws it ${count} times, ` +
            `so that connection does not exist in the schematic`
        );
      }
    }
    for (const [number] of drawn) {
      if (listed.has(number)) continue;
      problems.push(`the symbol draws a pin ${number} that the pin table does not list`);
    }
    // AND THEN THE SAME NAME AND ANCHOR CHECKS AS EVERY OTHER PART.
    //
    // This used to return here, and `bench:symbol` found what that let through:
    // rename one of LP5907's DSBGA pins on the way out, or draw two of them on
    // one point, and nothing said a word. Both were reported on all 106 other
    // parts, which is exactly how a hole like this survives - the check works,
    // and one branch never reaches it.
    //
    // What is grid-specific is only which numbers the symbol has to carry.
    // A name drawn differently from the record and two stubs on one point are
    // the same defects on a BGA as on a SOIC.
    return [
      ...problems,
      ...renamedPins(symbol, new Map(part.pins.map((entry) => [entry.number, entry.name]))),
      ...sharedAnchors(symbol),
      ...pinsWithNothingToWire(symbol)
    ];
  }

  // ONE SYMBOL PIN PER LAND THE FOOTPRINT PLACES. A pin the symbol omits is a
  // connection that exists on the board and not in the schematic, which is the
  // failure a netlist cannot survive and no geometric check can see.
  //
  // COUNTED FROM `pinCount`, not from the pins array, and this is the whole
  // check. The pads are numbered 1..N from `pinCount` - `geometryViolations`
  // says so and says why - so that is the set the symbol has to match. Asking
  // the pins array instead misses the only case that matters: a table missing
  // pin 2 on a three-pin part draws pins 1 and 3, and every pin the TABLE lists
  // is then present and correct. Three lands, two pins, nothing to report.
  const named = new Map<string, string>();
  for (const pin of part.pins) {
    if (/^\d+$/.test(pin.number)) named.set(pin.number, pin.name);
  }
  for (let number = 1; number <= part.pinCount; number += 1) {
    const key = String(number);
    const count = drawn.get(key) ?? 0;
    if (count === 1) continue;
    const label = named.has(key) ? ` ("${named.get(key)}")` : ", which the pin table does not list,";
    problems.push(
      `the footprint places a land for pin ${key}${label} and the symbol draws it ${count} times, ` +
        `so that connection does not exist in the schematic`
    );
  }
  // THE EXPOSED PAD IS NOT A SCHEMATIC PIN, and it is the one row that may sit
  // past the lead count without being an error.
  //
  // Texas Instruments numbers the pad as an ordinary row - a PowerPAD SOIC-8 has
  // a NINTH called `9` - and `geometryViolations` already allows a land at that
  // number on an exposed-pad part for exactly this reason. It carries no signal,
  // so this generator draws no stub for it, and reporting the absent stub would
  // refuse every PowerPAD part in the corpus.
  const padNumber = part.exposedPad ? thermalPadNumber(part.pinCount) : null;

  // A pin the TABLE carries that no land and no symbol pin reaches. The
  // footprint's own checks report the missing land; this reports the missing
  // stub, so a reader is not told half of it.
  for (const [number, name] of named) {
    if (Number(number) <= part.pinCount || number === padNumber) continue;
    problems.push(
      `the pin table lists pin ${number} ("${name}"), which is past this part's ${part.pinCount} pins, ` +
        `and the symbol does not draw it`
    );
  }
  for (const [number] of drawn) {
    if (Number(number) >= 1 && Number(number) <= part.pinCount) continue;
    problems.push(`the symbol draws pin ${number}, which is not one of this part's ${part.pinCount} pins`);
  }

  problems.push(...renamedPins(symbol, named));

  problems.push(...sharedAnchors(symbol));
  problems.push(...pinsWithNothingToWire(symbol));

  return problems;
}

/**
 * A symbol pin drawn under a different name from the one the record holds.
 *
 * A wire connected to the wrong net by a reviewer reading the schematic, and
 * invisible in every view they would open to check.
 */
function renamedPins(symbol: SymbolGeometry, named: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  for (const pin of symbol.pins) {
    const expected = named.get(pin.number);
    if (expected !== undefined && expected !== pin.name) {
      problems.push(`symbol pin ${pin.number} is drawn as "${pin.name}" and the record reads "${expected}"`);
    }
  }
  return problems;
}

/**
 * EVERY PIN HAS SOMETHING TO ATTACH A WIRE TO.
 *
 * A pin of zero length is a connection point with no stub: it draws as a bare
 * label, and the net attached to it in the schematic is attached to nothing.
 *
 * The Altium emitter already refuses one - `schlib.ts` throws "has no length, so
 * it has nothing to attach a wire to" - and the KiCad emitter does not, so the
 * same symbol was writable in one format and refused in the other. Found
 * 2026-08-30 by `bench:outputs`: zeroing one pin's length passed the export gate
 * on 86 of 86 symbols. A rule the two formats disagree about belongs in the gate
 * they share, not in one emitter.
 *
 * Non-finite as well as zero, for the reason the land sizes are checked the same
 * way: a NaN reaches the file as the characters `NaN`.
 */
function pinsWithNothingToWire(symbol: SymbolGeometry): string[] {
  return symbol.pins
    .filter((pin) => !Number.isFinite(pin.lengthMm) || pin.lengthMm <= 0)
    .map(
      (pin) =>
        `symbol pin ${pin.number} ("${pin.name}") is ${pin.lengthMm} mm long, so there is nothing to attach a wire to`
    );
}

/**
 * NO TWO PINS ON ONE POINT. Two stubs at the same anchor are a short the moment
 * a wire touches either, and they look like one pin on the sheet.
 */
function sharedAnchors(symbol: SymbolGeometry): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const pin of symbol.pins) {
    const at = `${pin.anchor.xMm.toFixed(4)},${pin.anchor.yMm.toFixed(4)}`;
    const other = seen.get(at);
    if (other !== undefined) {
      problems.push(`symbol pins ${other} and ${pin.number} share one anchor point, which shorts them`);
    }
    seen.set(at, pin.number);
  }
  return problems;
}

/** Throws unless the SYMBOL is one this generator is willing to stand behind. */
export function validateSymbol(symbol: SymbolGeometry, part: ResolvedPart): void {
  const violations = symbolViolations(symbol, part);
  if (violations.length > 0) throw new FootprintInvalidError(violations);
}

/** Throws unless the footprint is one this generator is willing to stand behind. */
export function validateGeometry(geometry: FootprintGeometry, part: ResolvedPart): void {
  const violations = geometryViolations(geometry, part);
  if (violations.length > 0) throw new FootprintInvalidError(violations);
}
