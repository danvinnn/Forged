/**
 * ONE definition of "does this part ship", shared by every bench that claims it.
 *
 * ## Why this had to move
 *
 * `bench:holdout` and `bench:extraction` both printed a SHIPS figure labelled
 * "the product", and they were answering different questions. The hold-out
 * applied the customer's settings, ran the package chooser, and counted a part
 * that exports once the user answers. The tuned bench made ONE bare
 * `createExportZip` call on the record: no settings, no chooser, no answers.
 *
 * So 98% and 18% sat side by side as though comparable. They were not measures
 * of the same product, and the stricter one was the one carrying the label.
 *
 * It also broke a standing instruction on this project - always account for user
 * answers and user settings when calculating a ships percentage - which the
 * hold-out honoured and the tuned bench never had.
 *
 * A second implementation of a rule is a second answer to the same question, and
 * a bench is the place that can least afford one. Same reasoning as
 * `oneClickCheck` calling the product's own `packageOptions`, and the same
 * failure shape as the two cache readers that had drifted apart.
 *
 * Air-gap safe and free: pure generation over a record already read. No model
 * call, no network.
 */

import {
  asPackage,
  createExportZip,
  packageOptions,
  recordForPackage,
  FootprintUnavailableError,
  type OptionAnswers,
  type RequiredInput,
  type SuppliedDimensions
} from "../exporters";
import { pinTableFor } from "../packagevariants";
import { answersFromSettings, densityOf, type ForgeSettings } from "../settings";
import { resolveForExport, type PartRecord, type ResolvedPart } from "../types";

/**
 * One stand-in answer, in the units the field is asked in.
 *
 * Every branch prefers a number the document DID supply over one it did not:
 * the questions overlap, and a body width the record carries is a better basis
 * for a land span than any constant. The constants that remain are the ordinary
 * proportions of a small surface-mount package, chosen so that the resulting
 * pads sit inside their own courtyard and clear of each other.
 */
function answerFor(need: RequiredInput, record: PartRecord, designator?: string): number | string {
  // THE CHOSEN PACKAGE'S OWN MEASUREMENTS, not the record's empty flat block.
  //
  // On a document whose part number does not name a package, every dimension
  // lives in `packagesInThisDocument` and `record.dimensions` is entirely null -
  // correctly, because there is no such thing as "the body size" of a part sold
  // in seven packages. Reading the flat block there gave every stand-in its
  // fallback constant, and a 3 mm span invented for a 4 mm VQFN puts the pads
  // inside the body.
  //
  // Measured 2026-08-20: that is the whole of MSP430FR2433's "ANSWERED AND
  // STILL REFUSED". The product asks two answerable questions and SHIPS when
  // they are answered with the package's real numbers. The bench was reporting
  // its own arithmetic as a product defect, which is the one thing this line
  // must never do.
  const perPackage = designator ? pinTableFor(record.packagesInThisDocument, designator)?.dimensions : undefined;
  const dims = { ...record.dimensions, ...(perPackage ?? {}) } as PartRecord["dimensions"];
  const num = (value: unknown): number | null => (typeof value === "number" && value > 0 ? value : null);
  const span = (value: unknown): number | null =>
    value !== null && typeof value === "object" && value !== null
      ? num((value as { nominal?: unknown }).nominal ?? (value as { max?: unknown }).max)
      : num(value);

  const body = num(dims.bodyLengthMm.value) ?? num(dims.bodyWidthMm.value) ?? 3;
  const pitch = num(dims.pitchMm.value) ?? 0.5;
  const pins = num(record.pinCount.value) ?? 8;
  const sides = dims.leadSides.value ?? (pins % 4 === 0 && pins >= 16 ? 4 : 2);

  switch (need.field) {
    case "bodyLengthMm":
      return num(dims.bodyLengthMm.value) ?? span(dims.leadSpanMm.value) ?? body;
    case "bodyWidthMm":
      return num(dims.bodyWidthMm.value) ?? span(dims.leadSpanCrossMm.value) ?? body;
    case "bodyHeightMm":
      return num(dims.bodyHeightMm.value) ?? 1;
    // The pad's radial length and tangential width. A no-lead package's pad is
    // about the lead's own contact length and a little over half the pitch
    // wide, which is what keeps neighbours clear at any pitch.
    case "landPadLengthMm":
      return span(dims.leadContactMm.value) ?? Math.max(0.4, Math.min(1, pitch * 1.2));
    case "landPadWidthMm":
      return Math.max(0.2, pitch * 0.55);
    // The centre-to-centre span across the package. Derived from the body so the
    // pads land under the leads rather than beyond the courtyard.
    case "landSpanMm":
      return span(dims.leadSpanMm.value) ?? body;
    case "landSpanCrossMm":
      return span(dims.leadSpanCrossMm.value) ?? span(dims.leadSpanMm.value) ?? body;
    case "leadDiameterMm":
      return 0.5;
    case "pitchMm":
      return pitch;
    case "thermalPadLengthMm":
      return num(dims.thermalPadLengthMm.value) ?? body * 0.6;
    case "thermalPadWidthMm":
      return num(dims.thermalPadWidthMm.value) ?? body * 0.6;
    case "leadSides":
      return sides;
    case "leadsPerSide": {
      const per = Math.floor(pins / sides);
      return Array.from({ length: sides }, (_, i) => (i === 0 ? pins - per * (sides - 1) : per)).join(",");
    }
    // Which grid position on the short row carries no lead. A package that asks
    // this has one more position than it has leads on that row, so the last one
    // is the answer that is always in range.
    case "vacantLeadSlot":
      return Math.max(1, Math.floor(pins / 2) + 1);
    case "formedLeadSpanMm":
      return span(dims.leadSpanMm.value) ?? body + 1;
    case "formedLeadContactMm":
      return span(dims.leadContactMm.value) ?? 0.6;
  }
}

/**
 * WHICH DRAWING THE COPPER CAME FROM.
 *
 * `DIMENSION_ORACLE` is keyed by the vendor's outline code, so "has a human
 * read this part's drawing" is only answerable once the bench can say which
 * drawing built the bundle. It could not, and the consequence was not cosmetic:
 * `bench:extraction` printed `record.packageOutlineCode` beside every shipping
 * part, which is the code the RECORD resolved to. A part that ships through the
 * package chooser ships as a DIFFERENT package - `asPackage` nulls the outline
 * code precisely because the record's belongs to another drawing - so those
 * rows named a drawing the copper did not come from, or "(no outline code
 * read)" for a package whose code the document prints in its own table.
 *
 * Reported, never inferred: `outlineCode` is null when the document named none
 * for the package that shipped, which is a different statement from "we did not
 * look".
 */
export interface ShippedPackage {
  /** The designator the bundle was built under. */
  designator: string;
  /** The vendor's own code for that package's outline drawing, where it printed one. */
  outlineCode: string | null;
}

/**
 * The drawing identity of one offered package, taken from the document's own
 * per-package table rather than from the record's flat field.
 */
function identityOf(record: PartRecord, designator: string): ShippedPackage {
  return { designator, outlineCode: pinTableFor(record.packagesInThisDocument, designator)?.outlineCode ?? null };
}

/**
 * THE RECORD THE EXPORT ACTUALLY BUILDS FROM, once a package has been chosen.
 *
 * Built the way `/api/export` builds it and in the same order: name the package,
 * resolve, then relabel. Any other order gets a different record - `asPackage`
 * blanks dimensions that `recordForPackage` had just supplied - and a bench
 * holding a different record from the one the copper came off is the failure
 * `bench:dimensions` spent a whole sitting on.
 *
 * Returns null only when the named package leaves a record `resolveForExport`
 * declines, which is a part that does not ship at all.
 */
function shippedRecordFor(record: PartRecord, designator: string): ResolvedPart | null {
  const resolved = resolveForExport(recordForPackage(record, designator));
  return resolved.ok ? asPackage(resolved.part, designator) : null;
}

export const BENCH_SETTINGS: ForgeSettings = {
  formedLeadSpanMm: 7.62,
  formedLeadContactMm: 1.4
};

/**
 * What the USER would actually be able to get, which is not what this measured
 * before.
 *
 * The bench used to call `createExportZip` on the record and count a success.
 * The product does not do that. It calls `packageOptions`, which runs the real
 * footprint build once per package the document offers, and shows the user a
 * chooser saying which of them work. On a family datasheet those are different
 * questions with different answers: a part whose record resolved to the SOIC can
 * still offer a working QFN, and the old measure could not see it.
 *
 * So SHIPS here is: can the user obtain at least one library without answering a
 * question. Two routes count, and they are the two the product actually offers:
 *
 *   1. the record exports as it stands, which is what happens when the document
 *      names one package and there is no choice to make
 *   2. some offered package exports
 *
 * No model calls. `packageOptions` is pure generation over a record already
 * read, so this costs nothing to re-measure from cache.
 *
 * ## Two numbers, and the second one is the product
 *
 * `ships` is the zero-friction figure: a bundle with nothing asked. It is the
 * one to watch for regressions, because it is the only one that cannot be moved
 * by asking the user more.
 *
 * `shipsAnswered` is what a customer actually experiences, and is the headline.
 * The product's whole input model says that a number no datasheet carries is
 * ASKED rather than invented; a part blocked only on such a question is a part
 * that ships, after a few seconds of typing. Reporting it as a failure measures
 * a product that refuses where this one asks.
 *
 * It is not a free pass. It counts a part only when EVERY remaining blocker is
 * a question the product knows how to ask AND the export really completes when
 * the answers arrive, which is checked here by supplying them. A part blocked by
 * "no land pattern for this package" or by an uncitable dimension is not
 * answerable and does not count, however small the gap looks.
 */
export async function shipOutcome(
  record: PartRecord,
  settings: ForgeSettings
): Promise<{
  ships: boolean;
  shipsAnswered: boolean;
  why: string;
  asked: number;
  brokeWhenAnswered: string | null;
  /** The package whose drawing built the copper. Null when nothing shipped. */
  shippedAs: ShippedPackage | null;
  /**
   * The record the bundle was BUILT FROM, which is not the record that went in.
   *
   * A family datasheet leaves the flat block empty and states each package in
   * `packagesInThisDocument`; the copper, the pin names and the pad count all
   * come from that table through `asPackage`. Every instrument that wants to
   * judge what shipped needs this record and not the input one, and each that
   * re-derived it got a different answer. Null when nothing shipped.
   */
  shippedPart: ResolvedPart | null;
  /**
   * The questions the product would put to the user, and which package they are
   * about. Empty when nothing is asked.
   *
   * Exposed rather than re-derived because `bench:questions` has to judge these
   * exact questions against the hand-read drawings, and there is only one route
   * through the chooser that produces them - the CHEAPEST one, which is the path
   * a user actually takes. A second implementation of "what does the product
   * ask" would drift from this one, which is the failure this whole module was
   * created to end.
   */
  asks: RequiredInput[];
  /** The designator those questions belong to, where the chooser named one. */
  asksFor: string | null;
}> {
  const resolved = resolveForExport(record);

  // ROUTE ONE: the record as it stands, which is what the user gets when the
  // document names one package and there is no choice to make.
  let direct: FootprintUnavailableError | null = null;
  // What route one refused with, when it could not even be attempted.
  //
  // A record `resolveForExport` declines used to RETURN here, which put this
  // bench one step ahead of the product in exactly the way `/api/export` was:
  // the chooser has read per-package pin tables since 2026-08-16, and route two
  // below is where that happens, and neither was ever reached. Ten of the
  // fifty-six parts of the 2026-08-17 run were reported `held: missing
  // pinCount,pins` with their pinouts sitting on the record, labelled and
  // located. A bench that stops before the product does measures a product that
  // does not exist.
  //
  // Kept as the fallback reason rather than discarded: where route two offers
  // nothing either, "the reading is missing pins" is still the truest thing to
  // say about the part.
  let held: string | null = null;
  /** A route-one bundle that shipped WITHOUT its 3D solid, kept as the fallback. */
  let partial: Awaited<ReturnType<typeof shipOutcome>> | null = null;
  if (!resolved.ok) {
    held =
      resolved.untraceable && resolved.untraceable.length > 0
        ? `held: uncitable ${[...new Set(resolved.untraceable)].join(",")}`
        : `held: missing ${resolved.missing.join(",")}`;
  } else {
    try {
      // THE SETTINGS GO WITH IT, exactly as `/api/export` sends them.
      //
      // This passed the density level alone, so route one asked LMP7704-SP and
      // REF5025 for a formed lead span and foot that the user had ALREADY
      // answered on the settings screen, and the bench counted them as not
      // shipping. `/api/export` reads both off the parsed settings and always
      // has; the measurement was of a product that does not exist.
      //
      // Same failure as the ten parts reported "held: missing pins" while route
      // two held their pinouts, and the reason `shipOutcome` was written: one
      // definition, matching the route.
      const bundle = await createExportZip(resolved.part, "kicad", {
        densityLevel: densityOf(settings),
        ...(settings.formedLeadSpanMm !== undefined ? { formedLeadSpanMm: settings.formedLeadSpanMm } : {}),
        ...(settings.formedLeadContactMm !== undefined
          ? { formedLeadContactMm: settings.formedLeadContactMm }
          : {})
      });
      // ROUTE ONE built from the record itself, so the record's own code is the
      // drawing - the one case where `packageOutlineCode` is the right answer.
      const fromRecord = {
        ships: true,
        shipsAnswered: true,
        why: "",
        asked: 0,
        brokeWhenAnswered: null,
        shippedAs: { designator: resolved.part.packageType, outlineCode: resolved.part.packageOutlineCode },
        shippedPart: resolved.part,
        asks: [] as RequiredInput[],
        asksFor: null
      };
      // AND IT WINS OUTRIGHT ONLY WHEN IT IS COMPLETE.
      //
      // The record ships as it stands, and on a document that never named the
      // package that bundle is labelled "Unknown package" and carries no 3D
      // solid, because the body dimensions were not read. Route two may offer
      // the SAME part under its real designator with everything built. A user
      // looking at both would not choose the first, and this returned it the
      // moment it succeeded.
      //
      // Measured on MC33063A the moment the body stopped blocking the export:
      // its flat record has no body dimensions, so route one used to refuse and
      // route two shipped `SOIC (D)`. Once route one could ship without the
      // solid it won by arriving first, and PACKAGE FAMILY fell to 27/28.
      //
      // So an incomplete route one is HELD and route two is tried first. A
      // complete route one still returns immediately, which is every part whose
      // document names one package.
      // Read off the bundle rather than re-derived. `stepSupported` is the
      // export's own answer to "was everything built", so this cannot drift from
      // it the way a second copy of `askForBody` would.
      if (bundle.stepSupported) return fromRecord;
      partial = fromRecord;
    } catch (error) {
      // ONE PART MUST NEVER KILL THE RUN.
      //
      // This rethrew anything that was not a `FootprintUnavailableError`, and on
      // 2026-08-17 a `FootprintInvalidError` from the output invariant ("the pin
      // table lists pin 9 and no land was placed for it") ended a paid 56-part
      // run partway through. $0.57 of answers were bought and no figure was
      // produced. `shipCheck` in `extraction.ts` has recorded any error as a
      // non-ship for months; this is the same rule with only one of its two
      // copies hardened.
      //
      // An invalid footprint IS a non-ship, and saying so is strictly more
      // informative than a stack trace: it is the output invariant doing its job.
      if (!(error instanceof FootprintUnavailableError)) {
        const why = error instanceof Error ? error.message.split("\n")[0].slice(0, 60) : "unknown";
        if (process.env.FORGE_DEBUG_INVALID) { console.error("INVALID", error instanceof Error ? error.message : error); console.error("DIMS", JSON.stringify(resolved.part.dimensions), "pins", resolved.part.pins.length, "pinCount", resolved.part.pinCount, "ep", resolved.part.exposedPad); }
        return {
          ships: false,
          shipsAnswered: false,
          why: `invalid: ${why}`,
          asked: 0,
          brokeWhenAnswered: null,
          shippedAs: null,
          shippedPart: null,
          asks: [],
          asksFor: null
        };
      }
      direct = error;
    }
  }

  // ROUTE TWO: whatever the chooser offers. Empty when the document names no
  // alternatives, which is why route one's refusal is kept rather than replaced.
  const choice = packageOptions(record, installAnswers(settings));
  // A COMPLETE BUNDLE BEATS A PARTIAL ONE, where both ship.
  //
  // `ships` now covers two outcomes: everything built, or everything except the
  // 3D solid, whose three body dimensions were not read. Both give the user
  // files with no question answered, so both are `ships`; they are not equally
  // good, and this took the FIRST in document order.
  //
  // Measured the moment the body stopped blocking: STM32F103C8 switched from
  // shipping its UFQFPN48, whose drawing is hand-read and whose solid builds, to
  // a QFN36 that merely came earlier in the list - and PACKAGE FAMILY and
  // VERIFIED both fell as a result. A user choosing by hand would not make that
  // trade, and neither should this.
  //
  // `needs` on a `ships` option is exactly the outstanding-extras list, so
  // "nothing outstanding" is the whole rule; see `PackageOption.needs`.
  const shipping = choice.ok ? choice.options.filter((option) => option.status === "ships") : [];
  const offered = shipping.find((option) => option.needs.length === 0) ?? shipping[0];
  // A complete route one already returned. An incomplete one is still better
  // than an incomplete route two, so it only loses to a COMPLETE option.
  if (partial && !shipping.some((option) => option.needs.length === 0)) return partial;
  if (offered) {
    return {
      ships: true,
      shipsAnswered: true,
      why: "",
      asked: 0,
      brokeWhenAnswered: null,
      shippedAs: identityOf(record, offered.designator),
      shippedPart: shippedRecordFor(record, offered.designator),
      asks: [],
      asksFor: null
    };
  }

  // The SMALLEST question set across every route, because that is the friction
  // the product actually imposes: the user takes the cheapest path on offer.
  const asks: Array<{ needs: RequiredInput[]; designator?: string }> = choice.ok
    ? choice.options
        .filter((option) => option.status === "needs-input")
        .map((option) => ({ needs: option.needs, designator: option.designator }))
    : [];
  if (direct && direct.needs.length > 0) asks.push({ needs: direct.needs });

  if (asks.length === 0) {
    // Nothing anywhere is answerable. Prefer route one's own words: it is about
    // the package actually read, and an option's reason is about a sibling.
    const unsupported = choice.ok ? choice.options.find((option) => option.status === "unsupported") : undefined;
    const reason = direct?.reason ?? unsupported?.reason ?? null;
    // The traceability refusal is the truest answer only when nothing else has
    // one: a record with no pins and no offered package really is unread.
    if (reason === null && held !== null) {
      return {
        ships: false,
        shipsAnswered: false,
        why: held,
        asked: 0,
        brokeWhenAnswered: null,
        shippedAs: null,
        shippedPart: null,
        asks: [],
        asksFor: null
      };
    }
    return {
      ships: false,
      shipsAnswered: false,
      why: `unsupported: ${(reason ?? "no land pattern").slice(0, 60)}`,
      asked: 0,
      brokeWhenAnswered: null,
      shippedAs: null,
      shippedPart: null,
      asks: [],
      asksFor: null
    };
  }
  const cheapest = asks.reduce((best, ask) => (ask.needs.length < best.needs.length ? ask : best));
  const fewest = cheapest.needs;

  // NOW ANSWER THEM, because that is what the user does next.
  //
  // Every value here is one a real user reads off the drawing in front of them;
  // the bench derives a self-consistent stand-in so the question under test is
  // "does the pipeline complete once an answer arrives", not "can the bench
  // guess the number". A part that still refuses after being answered is a
  // defect, and is reported by name rather than folded into the total.
  const answered = await exportWithAnswers(record, fewest, settings, cheapest.designator);
  return {
    ships: false,
    shipsAnswered: answered.ok,
    why: `needs ${fewest.map((need) => need.field).join(",")}`,
    asked: answered.ok ? answered.asked : fewest.length,
    brokeWhenAnswered: answered.ok ? null : answered.why,
    shippedAs: answered.ok ? answered.shippedAs : null,
    shippedPart:
      answered.ok && answered.shippedAs ? shippedRecordFor(record, answered.shippedAs.designator) : null,
    asks: fewest,
    asksFor: cheapest.designator ?? null
  };
}

/**
 * The settings a customer sets once, as the chooser and the exporter take them.
 *
 * The forming-die numbers are the two fields the settings screen makes
 * mandatory, precisely because no datasheet states them. A bench that leaves
 * them unset measures a product nobody uses: every straight-lead part would ask
 * for a span the customer has already given.
 */
/** See `answersFromSettings`. One definition, shared with the routes. */
const installAnswers = (settings: ForgeSettings): OptionAnswers => answersFromSettings(settings);

/**
 * Answer every question the product asked, then try again.
 *
 * ## What this measures, and what it deliberately does not
 *
 * It measures whether the PIPELINE completes once answers arrive: that the
 * route accepts the field, that the generator uses it, and that the output
 * invariants pass on the result. It does NOT measure whether the bench guessed
 * the right number, and it must not be read that way. A real user reads these
 * off the package drawing in front of them.
 *
 * So the stand-ins are derived from the part's own record wherever it carries
 * anything to derive from, and are geometrically self-consistent where it does
 * not. Deriving matters: a land span invented independently of the body size
 * produces pads outside their own courtyard, and the output invariant would
 * then refuse a part for the bench's arithmetic rather than for the product's.
 */
async function exportWithAnswers(
  record: PartRecord,
  needs: RequiredInput[],
  settings: ForgeSettings,
  /** The package whose questions these are, so the answers come from ITS drawings. */
  forPackage?: string
): Promise<{ ok: true; asked: number; shippedAs: ShippedPackage } | { ok: false; why: string }> {
  const supplied: Record<string, unknown> = {};
  let asked = 0;

  // A QUESTION SET ARRIVES IN ROUNDS, and so does the user's answer.
  //
  // The land pattern and the arrangement are answered by different parts of the
  // generator, so supplying the pad size can reveal that the pitch is missing
  // too. Measured 2026-08-19, three parts hit exactly that: they were reported
  // as "answered and still refused" by a single-round bench, and every one of
  // them ships on the second round. A bench that asks once measures a product
  // that gives up when the user answers.
  //
  // Bounded, and the bound is the finding: a set of questions that keeps
  // growing is a refusal wearing a form, and four rounds is already more
  // friction than the input model allows.
  const MAX_ROUNDS = 4;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const outstanding = round === 0 ? needs : null;
    if (outstanding) for (const need of outstanding) supplied[need.field] = answerFor(need, record, forPackage);
    asked = Object.keys(supplied).length;

    const answers: OptionAnswers = {
      ...installAnswers(settings),
      supplied: supplied as SuppliedDimensions
    };

    // Route one, the record as it stands.
    const resolved = resolveForExport(record);
    if (resolved.ok) {
      try {
        await createExportZip(resolved.part, "kicad", {
          densityLevel: densityOf(settings),
          formedLeadSpanMm: settings.formedLeadSpanMm,
          formedLeadContactMm: settings.formedLeadContactMm,
          supplied: supplied as SuppliedDimensions
        });
        return {
          ok: true,
          asked,
          shippedAs: { designator: resolved.part.packageType, outlineCode: resolved.part.packageOutlineCode }
        };
      } catch (error) {
        if (error instanceof FootprintUnavailableError && error.needs.length > 0) {
          for (const need of error.needs) supplied[need.field] = answerFor(need, record, forPackage);
        }
      }
    }

    // Route two, whatever the chooser offers once the answers are in hand.
    const choice = packageOptions(record, answers);
    const offered = choice.ok ? choice.options.find((option) => option.status === "ships") : undefined;
    if (offered) return { ok: true, asked, shippedAs: identityOf(record, offered.designator) };
    const stillAsking = choice.ok
      ? choice.options.find((option) => option.status === "needs-input")
      : undefined;
    if (stillAsking && stillAsking.status === "needs-input") {
      const fresh = stillAsking.needs.filter((need) => supplied[need.field] === undefined);
      if (fresh.length === 0) {
        return { ok: false, why: `asks for ${stillAsking.needs.map((n) => n.field).join(",")} and refuses the answers` };
      }
      for (const need of fresh) supplied[need.field] = answerFor(need, record, stillAsking.designator);
      continue;
    }
    if (Object.keys(supplied).length === asked) {
      const unsupported = choice.ok ? choice.options.find((option) => option.status === "unsupported") : undefined;
      return { ok: false, why: (unsupported?.reason ?? "refused with no reason given").slice(0, 90) };
    }
  }
  return { ok: false, why: `still asking after ${MAX_ROUNDS} rounds of answers` };
}
