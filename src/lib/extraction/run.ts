// The extraction pipeline, in one place.
//
// Before this, the parse route and both benches each repeated the same four
// steps by hand: build a request, render some pages, call the model, merge. They
// drifted, and the drift was expensive. The vendor land-pattern guard was wired
// into the route and not into `extractPartRecord`, so the bench shipped an
// ADS1115 footprint the route would have refused. A pipeline that exists as a
// convention rather than as a function will do that again.
//
// ## Two passes, and why
//
// PASS 1 sends the WHOLE document as text and nothing else. Everything that can
// be read from text is read here, and the model also names the pages it wants to
// LOOK at.
//
// PASS 2 renders only those pages and asks again. A mechanical drawing states
// its dimensions as labels beside dimension lines, and which dimension a label
// belongs to is carried by the arrows, which are graphics. The text layer has
// the numbers without what they measure, so those values are unreadable from
// text and readable from a render.
//
// The model chooses the pages. Every previous attempt to choose them for it lost
// whole parts: TS922 and TSZ121 both had their pinout on a page that was never
// sent, and the model said so in its own notes.
//
// Air-gap safe: no networking here. The model is injected.

import { MAX_PAGES_TO_MODEL } from "./contracts";
import { SecondPassFailedError } from "./contracts";
import type { ExtractionModel, ExtractionRequest, ExtractionResult } from "./contracts";
import type { DatasheetText } from "../pdftext";
import type { PartRecord } from "../types";
import { buildExtractionRequest, withRenderedPages } from "./request";
import type { RenderedPage } from "../pagerender";
import { mergeModelValues, type MergeOutcome } from "./merge";
import {
  declaredLeadCount,
  familyToken,
  namesPackageFamily,
  normalizeOutlineCode,
  packageCodeOf,
  sameOutlineCode,
  spellOut,
  PACKAGE_FAMILY_PATTERN
} from "../packagevariants";

// One budget, defined in `contracts.ts` beside the prompt that has to state it.
const MAX_RENDERED_PAGES = MAX_PAGES_TO_MODEL;

export interface ExtractionRun extends MergeOutcome {
  /** Pages that were rendered and sent, for the review panel and the record. */
  renderedPages: number[];
  /**
   * The RENDERS themselves, so a caller that wants to show the user the page a
   * value came from does not pay to rasterise it a second time.
   *
   * Both routes rendered these pages here, kept only the page NUMBERS, and then
   * called `renderPages` again on the same pages for the review panel, each with
   * a comment saying that re-rendering a page already rasterised for the model
   * would be pure waste. It is the plainest form of "we had it and threw it
   * away", and it spent the route's own 30 second budget on every part.
   */
  renderedImages: RenderedPage[];
  /** Whether a second pass happened at all. False means the text was enough. */
  lookedAtPages: boolean;
}

/**
 * Second-pass values win over first-pass ones, EXCEPT for a pin list the first
 * pass already read.
 *
 * For a dimension, pass 2 is the same reader answering with more evidence. A
 * value guessed from a text fragment and then read off the drawing is one
 * opinion improved, not two opinions, and recording it as a disagreement would
 * put a question in front of the user that nobody needs to answer. Measured on
 * the 2026-08-17 corpus run, this is not a nicety: RHF1201's front page implies
 * `gullwing` and its package drawing on page 33 shows `straight`, and REF5025's
 * page-1 prose says 6.9mm where the drawing says 7.035mm. The drawing is right
 * both times. Pass 2 must keep winning these.
 *
 * A PIN LIST is different, and the rule for it is about WHERE pass 2 answered
 * from. `withRenderedPages` sends only the rendered pages, so pass 2 often
 * cannot see the pin table pass 1 used and answers from a pinout FIGURE
 * instead. That is not the same evidence at higher resolution, it is a
 * different and poorer source: a figure carries no electrical types and no
 * descriptions, and its labels have to be matched to positions by eye.
 *
 * So pass 2 may improve a pin list only where it cites THE SAME PAGE pass 1
 * did. Measured over the three parts where the passes disagree, and it is right
 * on all three:
 *
 *   RHF310A   both page 2   pass 2 corrects `-VCC` to `VCC-`
 *   RHF1201   6 then 5      pass 2 breaks `D11(MSB)` into `(MSB)D11`, 48 types lost
 *   LIS3DH    9 then 8      pass 2 rotates the labels one position
 *
 * Two narrower rules were tried first and measured worse, both recorded so they
 * are not retried. Holding pass 1 for EVERY field whose page was not rendered
 * scores 20/21 on pin names but drops fields-complete from 53% to 39%, because
 * pass 1 answers dimensions from front-page prose and pass 2 answers them from
 * the drawing: it re-broke RHF1201's `leadForm` back to `gullwing` and REF5025's
 * body length to the page-1 6.9mm over the drawing's 7.035mm. Always keeping
 * pass 1's pins is dominated by both, 18/20 and 49%, because it throws away
 * RHF310A's correction.
 *
 * Pass 2 still fills pins the first pass did not read at all, which is most of
 * what the pin pass is for.
 */
/**
 * Two passes' views of the same package, joined on the designator.
 *
 * Matched on a letters-and-digits key so `VQFN (RGE)` from one pass and
 * `VQFN-RGE` from the other are one package. A designator only one pass mentions
 * keeps its own entry: a document can tabulate a pinout for a package whose
 * drawing it does not print, and the reverse, and neither is a reason to drop
 * what was read.
 *
 * Field by field rather than object by object, because the halves do not
 * overlap: whichever pass answered a field is the one that could read it.
 */
/**
 * Which already-merged entry describes the SAME package as this one, or null.
 *
 * ## Why this cannot be string similarity
 *
 * `SOIC (D)` and `SOIC (DW)` are different packages whose lead spans differ by
 * 4.3 mm. Any rule that joins two names because they look alike will eventually
 * hand one package another's pinout, which is a wrong footprint under a real
 * part number and is worse than the split entries it set out to fix.
 *
 * So this is a PROOF, built only out of things both halves can be checked on:
 *
 *   the lead COUNT  a pin table knows how many rows it has; a drawing entry
 *                   knows how many leads it measured
 *   the vendor CODE the short parenthesised or leading token, `PWP`, `D`, `RGT`
 *   the FAMILY word `HTSSOP`, `SOIC`, `VQFN`
 *
 * Two entries name one package when they AGREE on at least one of these, DISAGREE
 * on none, and the match picks out exactly one candidate. Anything else stays
 * separate and the chooser behaves exactly as it does today.
 *
 * That last clause is what keeps `SOIC (D)` away from `SOIC (DW)`: the family
 * agrees and the CODE disagrees, so the whole match fails on the disagreement
 * rather than passing on the agreement.
 */
function sameDesignator(
  entry: NonNullable<ExtractionResult["packagesInThisDocument"]>[number],
  held: Map<string, NonNullable<ExtractionResult["packagesInThisDocument"]>[number]>,
  partNumber?: string
): string | null {
  // A SIBLING DEVICE'S ENTRY IS NOT THIS PART'S PACKAGE.
  //
  // Family datasheets label their pin tables with the device they belong to, and
  // the siblings share package names with each other. Left alone, that puts one
  // device's netlist inside another's footprint:
  //
  //     ADM3202   "20-lead SSOP (ADM1385)" joined pass 2's measured "20-lead SSOP"
  //     OPA1612   "D (OPA1611)" and "D (OPA1612)" both matched "SOIC (D)"
  //
  // The first shipped. The second did not, because two candidates made the match
  // ambiguous and it refused, which is the right answer arrived at by luck.
  //
  // Both are settled by the document's own words: a label naming a device other
  // than the one asked for describes that other device. A label naming no device
  // is unaffected, which is most of them.
  if (!isThisPart(entry.packageType, partNumber)) return null;
  // A LABEL COVERING SEVERAL PACKAGES CANNOT ABSORB ONE PACKAGE'S MEASUREMENTS.
  //
  // A pin table's caption routinely names every package that shares an
  // assignment: `16-lead PDIP/SOIC_N/TSSOP/SOIC_W`, `D, N, NS, J, DB, or PW
  // Package`. That is a true statement about the PINOUT, which really is shared,
  // and a false one about any body size, because those four packages have four
  // different bodies.
  //
  // Caught on the first run of this matcher, 2026-08-19: joining them attached
  // the PDIP's measurements to the shared entry, and `pinTableFor` matches a
  // TSSOP against that same entry by containment, so a TSSOP would have been
  // built from a PDIP's body. That is the wrong-footprint-under-a-real-part-number
  // failure this whole function is written to avoid, so it is refused outright
  // rather than made cleverer.
  if (namesSeveralPackages(entry.packageType)) return null;
  const mine = featuresOf(entry);
  // A candidate must be JOINABLE: two pin tables are two packages, not one
  // package seen twice, and merging them would silently drop a pinout.
  const hits: string[] = [];
  for (const [otherKey, other] of held) {
    // TWO PIN TABLES ARE USUALLY TWO PACKAGES, and since 2026-08-20 not always.
    //
    // This refused any pair where both halves carried the same KIND of content,
    // on the reasoning that merging them would silently drop a pinout. That was
    // right while only pass 1 could return a pin table. Pass 2 was then given
    // somewhere to put a pinout it reads off a rendered figure, and both halves
    // of one package started arriving with pins:
    //
    //     LM5117  pass 1 "HTSSOP (20)" 20 pins   pass 2 "HTSSOP (PWP)" 20 pins
    //
    // The rule then split one package into two entries, each holding half of
    // what is needed to build it. A blanket check about content is the wrong
    // question: whether these are one package is exactly what the PROOF below
    // decides, and it is stricter than this was.
    //
    // DIMENSIONS still block, and the asymmetry is deliberate. Two measured
    // entries are two bodies, and the proof cannot separate a `SOIC (D)` from a
    // `SOIC (DW)` whose codes the model did not report; a wrong body is copper
    // in the wrong place. Two pin tables that the proof calls one package are
    // the same terminals read twice, and the precedence rule below already
    // keeps pass 1's.
    const has = (value: unknown) => Array.isArray(value) ? value.length > 0 : value !== undefined && Object.keys(value as object).length > 0;
    if (has(entry.dimensions) && has(other.dimensions)) continue;
    // A pin table may only meet another when both state a lead count and agree
    // on it. Without that this would be judging two pinouts on the name alone.
    if (has(entry.pins) && has(other.pins)) {
      const oneCount = featuresOf(entry).leads;
      const otherCount = featuresOf(other).leads;
      if (oneCount === null || otherCount === null || oneCount !== otherCount) continue;
    }
    if (namesSeveralPackages(other.packageType)) continue;
    if (!isThisPart(other.packageType, partNumber)) continue;
    const theirs = featuresOf(other);
    // A LEAD COUNT IS NOT AN IDENTITY.
    //
    // Agreement had to come from any one of the three, and "both have 8 leads"
    // is shared by every 8-pin package ever made. It never fired while two pin
    // tables were refused outright, and the moment that was relaxed on
    // 2026-08-20 it chained four of OP27's packages into one entry:
    //
    //     8-Lead TO-99  aka  ["8-Lead PDIP", "8-Lead CERDIP", "8-Lead SOIC"]
    //
    // A TO-99 is a metal can, a CERDIP is a ceramic through-hole body and a SOIC
    // is a 3.9mm surface-mount one. `8-Lead CERDIP` gets away with it because
    // its family reads as NULL - `\bDIP\b` does not match inside "CERDIP", the
    // word-boundary trap again - so the only thing left to compare was the
    // count, and the count agreed.
    //
    // So the count may now CORROBORATE or CONTRADICT, and can no longer be the
    // whole case. The identity has to come from the vendor code or the family,
    // which are the two things that actually name a package.
    // THE DRAWING CODE DECIDES, IN BOTH DIRECTIONS, WHEN BOTH ENTRIES HAVE ONE.
    //
    // Added 2026-08-20. Everything below infers an identity from the caption the
    // model wrote, because until now that was all an entry had. A vendor drawing
    // code is not an inference: `D0008A` is one drawing, and the document prints
    // it beside the dimensions we are trying to match.
    //
    // It contradicts as well as agrees, which is the half that protects us. Two
    // entries carrying DIFFERENT codes are different drawings however alike
    // their captions read, and that is precisely the `SOIC (D)` against
    // `SOIC (DW)` case the dimensions guard above exists to avoid: a wrong body
    // is copper in the wrong place. THS3491 really did answer `DDA0008B` on one
    // run and `RGT0016C` on another.
    const outlineAgrees = mine.outline !== null && theirs.outline !== null && sameOutlineCode(mine.outline, theirs.outline);
    const outlineContradicts = mine.outline !== null && theirs.outline !== null && !outlineAgrees;
    if (outlineContradicts) continue;

    let agreedOnIdentity = outlineAgrees;
    let contradicted = false;
    for (const part of ["code", "family", "leads"] as const) {
      const a = mine[part];
      const b = theirs[part];
      if (a === null || b === null) continue;
      if (a === b) {
        if (part !== "leads") agreedOnIdentity = true;
      } else contradicted = true;
    }
    if (agreedOnIdentity && !contradicted) hits.push(otherKey);
  }
  // Exactly one, or nothing. Two candidates means the document cannot tell them
  // apart either, and picking is the guess this exists to avoid.
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Whether one label names more than one package.
 *
 * Split on the separators vendors actually print between package names, then
 * count how many fragments name a package family. Two or more means the label
 * is about a set, and a set has no single body size.
 */
function namesSeveralPackages(name: string): boolean {
  // Underscores become spaces first. `namesPackageFamily` matches on a word
  // boundary and `_` is a word character, so `SOIC_W` hides the family from it
  // and a two-package label read as one. That is the word-boundary trap this
  // codebase has hit before; see LEARNINGS section 2.
  const fragments = fragmentsOf(name);
  if (fragments.length < 2) return false;
  // A fragment counts as a package if it names a FAMILY or is a bare vendor
  // CODE. TI captions a shared pinout as `DB, DGV, DW, N, NS, PW, RGY`, seven
  // packages and not one family word between them, which the family test alone
  // reads as a single package with a strange name.
  const bareCode = /^[A-Z]{1,4}\d{0,2}$/;
  const named = fragments.filter((fragment) => namesPackageFamily(fragment) || bareCode.test(fragment));
  return named.length > 1;
}

/** The checkable features of one entry: its code, its family and its lead count. */
function featuresOf(entry: NonNullable<ExtractionResult["packagesInThisDocument"]>[number]): {
  outline: string | null;
  code: string | null;
  family: string | null;
  leads: number | null;
} {
  const name = entry.packageType ?? "";
  // The lead count a pin table PROVES by its own row count, else the one the
  // drawing measured, else the one the name declares.
  //
  // ROWS ARE NOT LEADS. A pin table routinely carries a row for the exposed
  // thermal pad, and a package drawing's lead count never does, so counting
  // every row makes the two halves of one package CONTRADICT each other by
  // exactly one and the join then refuses them:
  //
  //     LM5117  pins "HTSSOP (20)" 21 rows   dims "HTSSOP (PWP)" leadCount 20
  //             pins "WQFN (24)"   25 rows   dims "WQFN (RTW)"   leadCount 24
  //
  // Both extra rows are `{"number": "EP", "name": "EP"}`. Counting only rows
  // whose designator is a NUMBER is the same rule `normalizeModelPins` already
  // applies when it separates a pad from a lead, so the two cannot disagree
  // about what a lead is.
  const rows = Array.isArray(entry.pins)
    ? entry.pins.filter((pin) => /^\d+$/.test(String((pin as { number?: unknown }).number ?? "").trim())).length
    : 0;
  const measured = entry.dimensions?.["dimensions.leadCount"]?.value;
  const leads =
    rows > 0 ? rows : typeof measured === "number" && Number.isInteger(measured) ? measured : declaredLeadCount(name);
  return {
    // The drawing code the model reported for THIS entry, when it reported one.
    // Distinct from `code` below, which is a designator inferred from the NAME:
    // this one is ink on a drawing and is the strongest identity an entry has.
    outline: normalizeOutlineCode(entry.outlineCode),
    code: packageCodeOf(name),
    family: familyToken(spellOut(name)),
    leads: leads !== null && leads > 0 ? leads : null
  };
}


function mergePackageEntries(
  first: ExtractionResult["packagesInThisDocument"],
  second: ExtractionResult["packagesInThisDocument"],
  partNumber?: string
): ExtractionResult["packagesInThisDocument"] {
  if (!first && !second) return undefined;
  const key = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const byKey = new Map<string, NonNullable<ExtractionResult["packagesInThisDocument"]>[number]>();
  for (const entry of [...(first ?? []), ...(second ?? [])]) {
    // THE SAME PACKAGE UNDER TWO NAMES.
    //
    // Each pass names a package after the part of the document it was reading,
    // and nothing ever told either what to call one. The pin-table pass reads
    // the pinout section, the drawing pass reads the outline, and they disagree:
    //
    //     pins "HTSSOP (20)"     dims "HTSSOP (PWP)"
    //     pins "D (OPA1612)"     dims "SOIC (D)"
    //     pins "RGT (VQFN, 16)"  dims "VQFN (16)"
    //
    // Measured 2026-08-19 over the cached hold-out answers: TWELVE of the
    // fifty-four parts carry their pin table and their measurements in separate
    // entries describing one package, and ten of the thirteen parts that cannot
    // ship even when the user answers every question are this. The chooser looks
    // up the ordering table's name, finds the measurements-only half, and tells
    // the user no pin table was found with the pin table in the row above.
    //
    // Fixing it in the PROMPT was tried three times and lost the population
    // every time; see the record above `candidates` in `models/prompt.ts`. So it
    // is fixed here, where the two vocabularies actually meet.
    // KEYED ON THE DRAWING CODE WHEN THE ENTRY HAS ONE.
    //
    // `key` folds a caption down to its letters and digits, which makes
    // "SOIC (D)" and "SOIC(D)" one key and leaves "SOT (DYN)" and
    // "SOT-5X3 (DYN)" as two. Those are the same package, and ADS1115 returns
    // one spelling on one run and the other on the next.
    //
    // A code is not a caption, so it does not drift. Prefixed rather than used
    // raw so a code can never collide with a caption that happens to fold to the
    // same letters.
    const code = normalizeOutlineCode(entry.outlineCode);
    const merged = code ? `outline:${key(code)}` : key(entry.packageType);
    const existing = byKey.get(merged) ? merged : sameDesignator(entry, byKey, partNumber);
    if (existing === null) {
      byKey.set(merged, { ...entry });
      continue;
    }
    const held = byKey.get(existing)!;
    // WHICHEVER PASS COULD ACTUALLY SEE THE THING WINS, per half.
    //
    // Pass 1 has the whole document and is the authority on PIN TABLES: pass 2
    // sees only a handful of rendered pages and cannot know it is looking at a
    // partial table. Pass 2 has the drawings and is the authority on
    // DIMENSIONS, for the reason the second pass exists at all, which is that a
    // dimension line's meaning is carried by arrows and not by text.
    //
    // Written out rather than left to iteration order. The order happens to give
    // the right answer today only because pass 1 is not asked for per-package
    // dimensions, and a rule that holds by accident stops holding silently.
    // WHICH PASS EACH HALF CAME FROM, decided by IDENTITY rather than by name.
    //
    // This used to ask whether `first` contains an entry with the same
    // designator, which was true exactly when the two passes agreed about the
    // name. Now that they may be joined despite disagreeing, that question
    // answers about the wrong entry: it returned pass 2's reading as pass 1's
    // and let a text-layer pitch beat a drawing-read one. Caught by the test
    // that pins the precedence rule.
    const entryIsFromFirst = (first ?? []).includes(entry);
    const fromFirst = entryIsFromFirst ? entry : held;
    const fromSecond = entryIsFromFirst ? held : entry;
    const pins = fromFirst.pins ?? fromSecond.pins;
    const dimensions = { ...(fromFirst.dimensions ?? {}), ...(fromSecond.dimensions ?? {}) };
    byKey.set(existing, {
      // The name the CONSUMER will look this up by.
      //
      // The chooser asks `pinTableFor` with the designator harvested from the
      // ordering table and the package drawings, so a joined entry has to be
      // filed under the DRAWING half's name. Whichever half carried the
      // measurements is that half, by definition: measurements come off a
      // drawing, and a drawing states the name in its own title block.
      //
      // This used to keep the LONGER of the two names, on the reasoning that
      // the drawing's is more specific. It usually is, and when it is not the
      // part silently stops shipping: OPA1612 joined `D (OPA1612)` to
      // `SOIC (D)` correctly and then filed it as `D (OPA1612)`, which no
      // designator in the document matches, so the chooser reported "this
      // document gives a pinout for each package and none of them matches SOIC"
      // about a pinout it was holding. Length was a proxy for the question, and
      // the question can be asked directly.
      packageType: nameFromTheDrawing(fromFirst, fromSecond) ?? (held.packageType.length >= entry.packageType.length ? held.packageType : entry.packageType),
      // BOTH NAMES ARE KEPT, because the consumer speaks a third vocabulary.
      //
      // See `alsoKnownAs`. Choosing one name was tried both ways and each way
      // loses a part the other keeps: filing OPA1612's joined entry under its
      // pin section's `D (OPA1612)` hides it from a chooser asking for
      // `SOIC (D)`, and filing OPA192's under its drawing's `SOT-23 (5)` hides
      // it from one asking for `SOT-23 (DBV)`.
      alsoKnownAs: [...new Set([held.packageType, entry.packageType, ...(held.alsoKnownAs ?? []), ...(entry.alsoKnownAs ?? [])])],
      // The drawing code survives the join, from whichever half read a drawing.
      // The two halves cannot disagree here: `sameDesignator` refuses to join
      // entries whose codes contradict, so at most one code is in play.
      ...(held.outlineCode || entry.outlineCode
        ? { outlineCode: held.outlineCode ?? entry.outlineCode }
        : {}),
      ...(pins ? { pins } : {}),
      ...(Object.keys(dimensions).length > 0 ? { dimensions } : {})
    });
  }
  return byKey.size > 0 ? shareCaptionedPinTables([...byKey.values()], partNumber) : undefined;
}

/**
 * A pin table captioned with SEVERAL packages, handed to each package it names.
 *
 * ## The thing the document is actually saying
 *
 * A caption like `D, N, NS, J, DB, or PW Package` or
 * `16-lead PDIP/SOIC_N/TSSOP/SOIC_W` is a statement that those packages SHARE
 * one pin assignment. That is true, it is the document's own words, and it is
 * the single most common way a pinout is published. Five of the twenty hold-out
 * documents whose two passes both said something about packages state their
 * pinout exactly this way.
 *
 * `sameDesignator` refuses to JOIN such a label to one package, and must keep
 * refusing: a label naming four packages cannot lend its body size to any of
 * them, because those four packages have four different bodies. But the pins
 * are not the body. Refusing the pins as well threw away a pinout the document
 * states plainly, and left every one of those packages reported as "drawings
 * were read, but no pin table was found" with the pin table sitting one row
 * above on the same record.
 *
 * So the dimensions stay put and the PINS are copied to each package the
 * caption names. Nothing is invented: a package receives a pin table only when
 * the caption names its family or its vendor code AND the two lead counts
 * agree.
 *
 * ## The sibling device, which is why this is not just string matching
 *
 * These captions routinely belong to a DIFFERENT device in the same family:
 *
 *     ADM3202   "16-lead PDIP/SOIC_N/TSSOP/SOIC_W (ADM3202)"   ours
 *               "18-lead PDIP/SOIC_W (ADM3222)"                a sibling
 *               "20-lead SSOP/TSSOP (ADM3222)"                 a sibling
 *
 * Distributing the ADM3222 rows would put a sibling's netlist under the part
 * number the user asked for, with a correct footprint around it, which is the
 * wrong-netlist failure this file already refuses a whole extra model pass to
 * avoid. A caption that names a device other than the requested one is
 * therefore not this part's pinout and is dropped.
 */
function shareCaptionedPinTables(
  entries: NonNullable<ExtractionResult["packagesInThisDocument"]>,
  partNumber?: string
): NonNullable<ExtractionResult["packagesInThisDocument"]> {
  const hasPins = (entry: (typeof entries)[number]) => Array.isArray(entry.pins) && entry.pins.length > 0;
  const hasDims = (entry: (typeof entries)[number]) => Object.keys(entry.dimensions ?? {}).length > 0;

  // A shared caption carries pins and no measurements. One that carries
  // measurements too has already been joined to a single package and is not a
  // statement about several.
  const shared = entries.filter(
    (entry) =>
      namesSeveralPackages(entry.packageType) &&
      hasPins(entry) &&
      !hasDims(entry) &&
      isThisPart(entry.packageType, partNumber)
  );
  if (shared.length === 0) return entries;

  return entries.map((entry) => {
    // Only a package that has been MEASURED and has no pinout of its own. An
    // entry that already read its own pin table keeps it: a per-package table
    // beats a shared caption every time, because the caption can only be right
    // about what the packages have in common.
    if (hasPins(entry) || !hasDims(entry)) return entry;
    if (namesSeveralPackages(entry.packageType)) return entry;
    const mine = featuresOf(entry);
    if (mine.leads === null) return entry;
    const hits = shared.filter((caption) => {
      const theirs = featuresOf(caption);
      if (theirs.leads !== mine.leads) return false;
      return captionNames(caption.packageType, mine.family, mine.code);
    });
    if (hits.length !== 1) return entry;
    return { ...entry, pins: hits[0].pins };
  });
}

/**
 * Whether a multi-package caption names this particular package.
 *
 * By FAMILY (`16-lead PDIP/SOIC_N/...` names a PDIP) or by vendor CODE
 * (`D, N, NS, J, DB, or PW` names the one whose drawing is `PW0016A`), because
 * captions are written both ways and a document that uses codes uses them
 * everywhere.
 */
function captionNames(caption: string, family: string | null, code: string | null): boolean {
  for (const fragment of fragmentsOf(caption)) {
    if (family !== null && familyToken(fragment) === family) return true;
    if (code !== null && packageCodeOf(fragment) === code) return true;
    if (code !== null && fragment.toUpperCase() === code) return true;
  }
  return false;
}

/**
 * Whether a label is about the requested device rather than one of its siblings.
 *
 * True when the label names no device at all, which is the common case: a
 * caption is usually about packages and says nothing about which die is in
 * them. False only when it names a device and that device is not this one.
 *
 * With no part number in hand this cannot judge, and says so by allowing the
 * label. That is the same answer it gives today, so a caller without a part
 * number is no worse off than before.
 */
function isThisPart(label: string, partNumber?: string): boolean {
  const named = devicesNamed(label);
  if (named.length === 0) return true;
  const mine = (partNumber ?? "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!mine) return true;
  return named.some((device) => device.includes(mine) || mine.includes(device));
}

/**
 * The device part numbers a label mentions, normalised to letters and digits.
 *
 * A device token is letters then digits, at least two of each side by side, and
 * never a package family or a lead-count phrase. `ADM3202`, `ADA4522-1` and
 * `OPA2192` are devices; `SOIC_N`, `16-lead` and `SOT-23` are not.
 */
function devicesNamed(label: string): string[] {
  const withoutFamilies = (label ?? "").replace(new RegExp(PACKAGE_FAMILY_PATTERN, "gi"), " ");
  const found: string[] = [];
  for (const token of withoutFamilies.split(/[^A-Za-z0-9-]+/)) {
    const trimmed = token.replace(/^-+|-+$/g, "");
    if (!/^[A-Za-z]{2,}\d/.test(trimmed)) continue;
    if (trimmed.replace(/[^A-Za-z0-9]/g, "").length < 5) continue;
    found.push(trimmed.replace(/[^A-Za-z0-9]/g, "").toUpperCase());
  }
  return found;
}

/** One label split into the package names it lists. */
function fragmentsOf(name: string): string[] {
  return spellOut(name)
    .split(/[/;,]|\s+or\s+/)
    .map((piece) => piece.trim().replace(/\s+Packages?$/i, "").trim())
    .filter(Boolean);
}

/**
 * The name of whichever half of a joined package carried its MEASUREMENTS, or
 * null when neither did.
 *
 * Preferring the second pass by position would be the same rule most of the
 * time and wrong exactly when it matters: two entries from the same pass can be
 * joined, and then "second" means nothing.
 */
function nameFromTheDrawing(
  fromFirst: NonNullable<ExtractionResult["packagesInThisDocument"]>[number],
  fromSecond: NonNullable<ExtractionResult["packagesInThisDocument"]>[number]
): string | null {
  if (Object.keys(fromSecond.dimensions ?? {}).length > 0) return fromSecond.packageType;
  if (Object.keys(fromFirst.dimensions ?? {}).length > 0) return fromFirst.packageType;
  return null;
}

/** Exported for the tests that pin the two-pass join. */
export const combineForTest = (first: ExtractionResult, second: ExtractionResult, partNumber?: string): ExtractionResult =>
  combine(first, second, partNumber);

/**
 * The second pass, asked ONE more time before it is allowed to fail.
 *
 * `callWithRetry` in `transport.ts` already retries three times inside a single
 * call, and it is not enough here: ADM3202 failed on four separate bench runs
 * on 2026-08-19 and 20, roughly a dozen provider attempts, then succeeded on the
 * fifth with no code change. Whatever is being hit clears on a timescale longer
 * than the transport backoff, so one further attempt at THIS level buys a
 * measurably different outcome.
 *
 * Exactly one, and the cost is why. This pass carries about a megabyte of
 * images and is the expensive half of a part; a loop here would multiply the
 * worst case for a document that may simply be too big. Two attempts is the
 * difference between "we gave up at the first refusal" and "we tried again",
 * which is the whole complaint.
 *
 * Exported so the retry can be tested directly: reaching it through
 * `runExtraction` needs a renderable PDF, and the behaviour under test is not
 * about rendering.
 *
 * Logged on both the retry and the final failure. Until now a second-pass
 * failure produced no note, no error and no log line anywhere, so nobody could
 * say whether this happens once a week or once a day.
 */
export async function askTwice(
  model: ExtractionModel,
  request: ExtractionRequest,
  pageCount: number
): Promise<ExtractionResult> {
  try {
    return await model.extract(request);
  } catch (first) {
    console.warn(
      `[extraction] drawing pass failed on ${request.fileName} (${pageCount} page(s)); retrying once: ` +
        `${first instanceof Error ? first.message.slice(0, 200) : String(first)}`
    );
    try {
      return await model.extract(request);
    } catch (second) {
      const message = second instanceof Error ? second.message : String(second);
      console.error(
        `[extraction] drawing pass failed TWICE on ${request.fileName} (${pageCount} page(s)): ${message.slice(0, 300)}`
      );
      throw new SecondPassFailedError(
        `The package drawings could not be read on this attempt. The dimensions a footprint is built from ` +
          `are measured off those drawings, so no record is produced rather than one built from the text ` +
          `layer. This is usually temporary: try again.`,
        2
      );
    }
  }
}

function combine(first: ExtractionResult, second: ExtractionResult, partNumber?: string): ExtractionResult {
  const values = { ...first.values, ...second.values };
  const firstPins = first.values.pins;
  const secondPins = second.values.pins;
  if (
    firstPins !== undefined &&
    secondPins !== undefined &&
    firstPins.page !== secondPins.page &&
    !samePinNames(firstPins.value, secondPins.value)
  ) {
    values.pins = firstPins;
  }
  // A DECLINE from either pass is a decline, and it was being dropped here.
  //
  // `declined` exists to tell "the model looked and the document is silent" from
  // "nobody asked", and its own contract note names the investigation that cost:
  // `leadForm` came back empty for 37 of 81 parts because the prompt offered two
  // of the three values, and there was no way to see it. This function built a
  // result without the field, so `mergeModelValues` read `result.declined ?? []`
  // as empty on every real run and the note was never written. Only a direct
  // call to merge, which is tests, ever saw one.
  const declined = [...new Set([...(first.declined ?? []), ...(second.declined ?? [])])].filter(
    // A field pass 2 ANSWERED is not declined, whatever pass 1 said about it.
    (field) => values[field] === undefined
  );

  return {
    values,
    ...(declined.length > 0 ? { declined } : {}),
    notes: [...(first.notes ?? []), ...(second.notes ?? [])],
    // MERGED BY PACKAGE, not replaced.
    //
    // The two passes answer different halves of the same question. Pass 1 has
    // the whole text and reports each package's PIN TABLE; pass 2 has the
    // rendered drawings and reports each package's MEASUREMENTS, which is the
    // only pass that can read them. Taking pass 2's list whole, as this did,
    // threw away every pin table the moment the second half started arriving.
    packagesInThisDocument: mergePackageEntries(first.packagesInThisDocument, second.packagesInThisDocument, partNumber),
    // Same reasoning as the tables above: read once, by the pass that had the
    // whole document. Pass 2 sees only the rendered pages, so it cannot know
    // which drawings the rest of the document contains and must not overwrite a
    // complete answer with a partial one.
    drawnPackages: first.drawnPackages ?? second.drawnPackages,
    usage:
      first.usage || second.usage
        ? {
            inputTokens: (first.usage?.inputTokens ?? 0) + (second.usage?.inputTokens ?? 0),
            outputTokens: (first.usage?.outputTokens ?? 0) + (second.usage?.outputTokens ?? 0)
          }
        : undefined,
    // EVERY BILLED ATTEMPT, both passes. `usage` was summed here and `attempts`
    // was dropped beside it, so a caller counting spend through `runExtraction`
    // saw undefined. That is the same under-report `attempts` was added to close:
    // a 503 retried twice is three charges and one answer.
    ...(first.attempts !== undefined || second.attempts !== undefined
      ? { attempts: (first.attempts ?? 0) + (second.attempts ?? 0) }
      : {})
  };
}

/**
 * Whether two pin lists say the same thing about the pins.
 *
 * There is nothing to choose between readings that agree, and choosing anyway
 * has a cost. MSP430F5529's pin table is not verifiable from the text layer on
 * ANY page: `locatePinTable` scans the whole document and finds nothing, so
 * pass 1's list carries no citation and `isUntraceable` refuses the export.
 * Pass 2's identical list is citable purely because page 10 was rendered and
 * sent. Preferring pass 1 there swapped a shipping part for the same answer
 * nobody could check.
 *
 * So the pass-1 preference applies only where the two actually DISAGREE. Names
 * and numbers only: pass 2 routinely drops electrical types and descriptions
 * because a figure does not carry them, and that is not a disagreement about
 * the pinout.
 */
function samePinNames(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const key = (pin: unknown) => {
    const row = pin as { number?: unknown; name?: unknown };
    return `${String(row.number ?? "")}\u0000${String(row.name ?? "")}`;
  };
  return left.every((pin, index) => key(pin) === key(right[index]));
}

/** Pages the model asked for, cleaned: real page numbers, in order, no repeats, capped. */
function requestedPages(result: ExtractionResult, doc: DatasheetText): number[] {
  const exists = new Set(doc.pages.map((page) => page.page));
  const asked = result.pagesWorthRendering ?? [];
  const clean = [...new Set(asked)]
    .filter((page) => Number.isInteger(page) && exists.has(page))
    .sort((left, right) => left - right);
  return clean.slice(0, MAX_RENDERED_PAGES);
}

// TWO WAYS OF CHOOSING PAGES FOR THE MODEL WERE MEASURED AND REJECTED, both on
// 2026-08-17, both aimed at the datasheet's printed land pattern. Recorded so
// neither is rebuilt on the same reasoning.
//
// The premise was that the model names the package OUTLINE page while the
// printed footprint sits one page later, so the three land values were being
// asked for and never shown. The number that killed it: of 53 cached answers
// carrying both a land page and a page request, the land page was ALREADY among
// the pages the model asked for in 49.
//
//   ADDING THE PAGE AFTER each page the model named. Covered 4 of those 53 while
//   roughly doubling render cost on the 18 of 46 documents with no heading.
//
//   ADDING ANY PAGE WHOSE TEXT ANNOUNCES A LAND PATTERN. Cheaper, but measurably
//   tailored to one vendor: over 46 documents the heading pattern finds 20 of 21
//   Texas Instruments and 0 of 6 Analog Devices. Its wording names no vendor and
//   its behaviour does, which is the test RULES.md rule 4 actually applies.
//
// The heading pattern itself survives in `sections.ts`, where the focused local
// model uses it to pick the page for ONE narrow question. That is a different
// job: there it selects among pages already being sent, rather than adding cost
// to every part on a yield nobody has demonstrated.

/**
 * Runs extraction end to end and returns the merged record.
 *
 * Throws whatever the model throws. A model failure must never cost the caller
 * the deterministic record it already has, and every caller already handles that
 * by keeping the record it passed in.
 */
export async function runExtraction(
  part: PartRecord,
  doc: DatasheetText,
  pdfBytes: ArrayBuffer,
  model: ExtractionModel,
  fileName: string,
  partNumber?: string,
  /**
   * How long RENDERING may take, when the caller is working to a deadline.
   *
   * The page budget was raised from 8 to 16 on 2026-08-18, and the render
   * ceiling is sized from it, so the default is now about 24 seconds. A route
   * with `maxDuration = 30` that let rendering run to that default would have
   * about six seconds left for two model calls. `renderPages` does not throw
   * when it runs out of time, it returns FEWER PAGES, so the failure would have
   * been a quietly thinner second pass rather than an error anyone could see.
   *
   * Passed by the caller that HAS a deadline rather than hardcoded low, because
   * capping it here would make the benches render fewer pages than the product
   * is capable of, and a bench that measures a product that does not exist is
   * the exact mistake `shipOutcome` was making this morning.
   */
  renderBudgetMs?: number
): Promise<ExtractionRun | null> {
  const request = buildExtractionRequest(part, doc, fileName, partNumber);
  if (!request) return null;

  // Pass 1: the whole document, as text.
  const first = await model.extract(request);

  // Pass 2: the pages it asked to see.
  //
  // Skipped, rather than returned from, when it asks for none.
  //
  // A render failure is not an extraction failure. `renderPages` returns fewer
  // pages rather than throwing, and a host with no working renderer produces
  // exactly the first-pass answer, which is a supported deployment rather than
  // an error.
  const pages = requestedPages(first, doc);
  let second: ExtractionResult = { values: {} };
  let rendered: number[] = [];
  let images: RenderedPage[] = [];
  if (pages.length > 0) {
    // RENDERING and ASKING are separated, because their failures mean opposite
    // things and one `catch` treated them the same.
    //
    // A render failure is a deployment fact: `renderPages` returns fewer pages
    // rather than throwing, and a host with no working renderer produces the
    // first-pass answer, which is supported. A MODEL failure is a transient
    // network error on the pass that reads the drawings, and falling through
    // from it silently ships text-layer dimensions as though they were read off
    // a drawing. See `SecondPassFailedError`.
    let withImages: ExtractionRequest | null = null;
    try {
      // Pass 1's own package answer goes with it. See `withRenderedPages`: the
      // second pass sees only the drawing pages, and a pass asked to measure a
      // package nobody has named refuses the whole document and says so.
      const chosen = typeof first.values.packageType?.value === "string" ? first.values.packageType.value : null;
      withImages = await withRenderedPages(
        request,
        pdfBytes,
        pages,
        renderBudgetMs !== undefined ? { budgetMs: renderBudgetMs } : {},
        chosen
      );
      images = withImages.images;
      rendered = images.map((image) => image.page);
    } catch {
      // No renderer, or none of the pages could be rasterised. Pass 1 stands.
      withImages = null;
    }

    if (withImages !== null && rendered.length > 0) {
      second = await askTwice(model, withImages, pages.length);
    }
  }

  const combined = combine(first, second, partNumber ?? part.partNumber.value ?? undefined);

  // A THIRD, FOCUSED PINOUT PASS WAS MEASURED AND REVERTED, 2026-08-19.
  //
  // It targeted the parts that arrive with a pin COUNT and no pins, six of the
  // fifty-three tuned parts, by asking for TWO fields over the pages that
  // caption themselves as a pinout. The mechanism works: it read 100 pins off
  // STM32F407VG and 80 off MSP430F5529, both exactly matching the hand-read
  // oracle, and moved the tuned corpus from 45% to 55% fields and 19% to 23%
  // shipping.
  //
  // It also made STM32H743ZI SHIP A WRONG NETLIST. Its LQFP144 figure prints
  // VSS at 51 and VDD at 52; the model emitted one pin there instead of two,
  // ran one behind for twenty-one pins, and re-synchronised at 73 by inventing
  // a name for 72. Verified against a render of page 57 by hand.
  //
  // Nothing in this product can see that. The table numbers 1..144 with no
  // gaps, the count agrees with `pinCount`, the cited page is real, and the
  // pads come out exactly as `validateGeometry` expects. The name MULTISET is
  // even preserved, because a dropped row plus renumbering moves a name rather
  // than losing it, so comparing names against the page's text cannot catch it
  // either. Only the hand-read oracle did.
  //
  // One wrong netlist in the four parts it unlocked. A wrong netlist is worse
  // than a refusal by a wide margin, so the refusal stays.
  //
  // What would make it safe, and it is NOT a heuristic: these documents state
  // their pinout TWICE, as a figure and as a pin-definition table. Requiring the
  // two to agree is a check the document itself supplies. That is the thing to
  // build before this is tried again, and reading a denser figure more carefully
  // is not.
  return {
    ...mergeModelValues(part, doc, combined, model.name, rendered),
    renderedPages: rendered,
    renderedImages: images,
    lookedAtPages: rendered.length > 0
  };
}


export { type ExtractionRequest };
