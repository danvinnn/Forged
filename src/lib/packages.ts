/**
 * Package definitions: the lead dimensions IPC-7351B needs, per package family.
 *
 * This table is deliberately short. Every entry names the drawing it came from,
 * and every entry is pinned by a test to the land pattern the standard publishes
 * for that package. A family that is not in here is REFUSED, not approximated,
 * because the alternative is emitting a footprint whose pad pitch nobody read
 * off a document.
 *
 * Adding a family is three steps and none of them are optional:
 *   1. Take span, contact length, lead width and pitch off the package drawing.
 *   2. Add the entry with `source` naming that drawing.
 *   3. Add a case to the land pattern test pinning the computed result to the
 *      published pattern for that package. If it disagrees, the inputs are wrong.
 */

import { type LeadDimensions } from "./ipc7351";
import { type LeadWidth } from "./types";

export interface PackageDefinition {
  /** Family name used in output and messages. */
  family: string;
  /**
   * How the leads are arranged around the body.
   *
   * `quad` is four rows on a SQUARE body, which is what lets one land pattern
   * describe both axes: `computeLandPattern` works on one opposing pair of rows,
   * and on a square package the other pair is the same pattern turned 90
   * degrees. A rectangular quad package would need two computations and is not
   * supported; no entry here is one, and the pin-count range is what keeps it
   * that way.
   */
  arrangement: "dual" | "quad";
  /** Lead pitch in mm. Definitional for the family, not a measurement. */
  pitchMm: number;
  lead: LeadDimensions;
  /** Inclusive pin-count range this entry is valid for. */
  pinCounts: { min: number; max: number };
  /**
   * True when the part ships with untrimmed leads, so the seated span is a
   * property of the assembler's lead form rather than of the package. Callers
   * must supply a formed span; there is no defensible default.
   */
  spanFromLeadForm?: boolean;
  /** Where the numbers came from. Required: an entry without a source is a guess. */
  source: string;
  /** Matches the extracted package designator text. */
  match: RegExp;
}

/**
 * Narrow-body SOIC, JEDEC MS-012.
 *
 * Span, pitch and lead width are family constants in MS-012 and apply to the
 * 8, 14 and 16 lead variants alike; only the body length varies with pin count,
 * and that is taken from the extracted dimensions rather than asserted here.
 *
 * The contact range is a CALIBRATION, not a drawing dimension: see the note on
 * LeadDimensions. It is fitted so the computed land reproduces the pattern TI
 * prints on page 47 of the UCC27524 datasheet (1.55 x 0.6 on a 5.4 mm span), and
 * the test pins it there so a wrong value cannot survive silently.
 */
const SOIC_NARROW: PackageDefinition = {
  family: "SOIC narrow",
  arrangement: "dual",
  pitchMm: 1.27,
  pinCounts: { min: 8, max: 16 },
  source:
    "JEDEC MS-012, read off the TI D0008A package drawing in the UCC27524 datasheet (span 5.80-6.19, body 4.81-5.00 x 3.81-3.98, pitch 1.27, lead width 0.31-0.51). The land pattern target is the one TI prints on page 47 of that datasheet: 8 lands of 1.55 x 0.6 on a 5.4 mm centre span.",
  lead: {
    form: "gullwing",
    span: { minMm: 5.8, maxMm: 6.2 },
    contact: { minMm: 0.4, maxMm: 0.625 },
    width: { minMm: 0.31, maxMm: 0.51 }
  },
  match: /\b(?:SOIC|SO-?IC|SMALL\s+OUTLINE\s+INTEGRATED\s+CIRCUIT)\b/i
};

/**
 * TSSOP, JEDEC MO-153 variation AA.
 *
 * Span, pitch and lead width are read straight off the TI PW0008A drawing in the
 * INA240 datasheet, which cites MO-153 AA in its own notes. The contact length is
 * calibrated the same way as SOIC: it reproduces the inner gap of the land
 * pattern TI prints in that datasheet (8 lands of 1.5 x 0.45 on a 5.8 mm centre
 * span), and DETAIL A on the same drawing gives 0.50 as the typical foot, which
 * agrees.
 *
 * Worth knowing: our IPC-7351B density B outer extent lands within 0.01 mm of
 * TI's printed pattern, but our lands come out about 0.08 mm narrower, because
 * IPC's density B side fillet is smaller than TI's house rule. Both are valid;
 * the exporter reports the comparison rather than silently picking one.
 */
const TSSOP: PackageDefinition = {
  family: "TSSOP",
  arrangement: "dual",
  pitchMm: 0.65,
  pinCounts: { min: 8, max: 16 },
  source:
    "JEDEC MO-153 variation AA, read off the TI PW0008A package drawing in the INA240 datasheet (span 6.2-6.6, body 2.9-3.1 x 4.3-4.5, pitch 0.65, lead width 0.19-0.30)",
  lead: {
    form: "gullwing",
    span: { minMm: 6.2, maxMm: 6.6 },
    contact: { minMm: 0.5, maxMm: 0.6 },
    width: { minMm: 0.19, maxMm: 0.3 }
  },
  match: /\bTSSOP\b/i
};

/**
 * Ceramic flat pack, 1.27 mm pitch, as used by nearly every rad-hard part.
 *
 * CFP is not like the plastic families and the difference matters. Read the
 * TI HKU0010A and U0010A drawings: the part ships with STRAIGHT, UNTRIMMED
 * leads, 22.7 mm tip to tip on a 7 mm body, and the assembler trims and forms
 * them. A SOIC arrives with its gull-wing already formed, so its span is fixed
 * at 6.00 +/- 0.20 and a land pattern follows from it. A CFP has no seated span
 * until someone chooses the trim.
 *
 * That is why TI prints no land pattern for these packages and why IPC-7351B
 * has no CFP family: the land pattern is a function of the customer's lead form,
 * not of the part. So the span here is supplied by the caller, and without it
 * the export refuses. Everything else is read off the drawing.
 */
const CERAMIC_FLATPACK: PackageDefinition = {
  family: "CFP",
  arrangement: "dual",
  pitchMm: 1.27,
  pinCounts: { min: 8, max: 48 },
  spanFromLeadForm: true,
  source:
    "TI HKU0010A and U0010A ceramic flat pack drawings in the TPS7A4501-SP datasheet (pitch 1.27, lead width 0.38-0.48, lead thickness 0.10-0.16, untrimmed tip-to-tip 22.7 max, body 6.66-7.06 x 6.77-7.27). ST's FLAT-16P is the same family, checked against Table 5 and Figure 6 of the RHFL4913 datasheet: pitch 1.27 typ, lead width b 0.38-0.48, lead thickness c 0.10-0.18, and two L dimensions of 6.35-7.36 either side of a 6.71-7.11 body, so tip to tip is about 19 to 22 mm of STRAIGHT lead.",
  lead: {
    form: "gullwing",
    // Filled in from the caller's formed lead span; see spanFromLeadForm.
    span: { minMm: Number.NaN, maxMm: Number.NaN },
    // Formed feet on a trimmed flat pack. Conventional trim leaves roughly this
    // much seated contact; it is applied only once a span has been supplied.
    contact: { minMm: 0.5, maxMm: 0.75 },
    width: { minMm: 0.38, maxMm: 0.48 }
  },
  /**
   * `FLAT-16P` and `Flat-8` are ST's spelling of this family, and they are
   * admitted on the strength of the drawing rather than the name: the RHFL4913's
   * Table 5 gives the same pitch, the same lead width and the same straight
   * untrimmed leads as the TI drawings this entry was read from.
   *
   * The digit is REQUIRED. A bare `FLAT` would swallow the plastic quad flat
   * packs, whose own drawings are titled `PLASTIC QUAD FLATPACK`, and handing a
   * VQFN ceramic flat pack geometry is the worst answer this table could give.
   * No quad package is ever designated `FLAT-16P`; they are LQFP, TQFP, CQFP.
   */
  match: /\b(?:CFP|CERAMIC\s+(?:DUAL\s+)?FLAT\s?PACK|FLATPACK|CDFP|FLAT-?\d{1,3}[A-Za-z]?)\b/i
};

/**
 * A QUAD flat pack, which is not this family whatever its name suggests.
 *
 * `FLATPACK` on its own is how a ceramic dual flat pack is written, and it is
 * ALSO the middle of `PLASTIC QUAD FLATPACK`, which is the title of every TI
 * LQFP and VQFN drawing. Those are four rows of leads on a plastic body and this
 * entry is two rows of straight ceramic ones; handing a VQFN a CFP land pattern
 * would be the worst answer in this table.
 *
 * It was refused today only by luck: the pin counts that reach it happen to sit
 * above CFP's 48 lead ceiling. A 44 lead one would have gone straight through.
 */
const QUAD_FLAT_PACK = /\bQUAD\s+FLAT|\b[LTCPVWU]?QF[PN]\b|\bQFP\b|\bQFN\b/i;

/**
 * Wide-body SOIC, JEDEC MS-013.
 *
 * Read off the TI DW0016B drawing in the ISO7741 datasheet, whose own note 5
 * cites MS-013. It shares a NAME with the narrow body and differs by 4.3 mm of
 * lead span, which is why the two are separate entries and why a designator that
 * does not say which one it is gets refused.
 *
 * Its land pattern target is the one TI prints on the facing page and labels
 * "IPC-7351 NOMINAL": 16 lands of 2.0 x 0.6 on a 9.3 mm centre span. Note the
 * contact calibration differs from narrow body (0.40-1.00 against 0.40-0.625)
 * even though both drawings quote the same 0.40-1.27 lead range. That gap is the
 * clearest evidence the model is missing a term; see LeadDimensions.
 */
const SOIC_WIDE: PackageDefinition = {
  family: "SOIC wide",
  arrangement: "dual",
  pitchMm: 1.27,
  pinCounts: { min: 8, max: 28 },
  source:
    "JEDEC MS-013, read off the TI DW0016B package drawing in the ISO7741 datasheet (span 9.97-10.63, body 10.1-10.5 x 7.4-7.6, pitch 1.27, lead width 0.31-0.51), calibrated to the IPC-7351 nominal land pattern TI prints on the facing page",
  lead: {
    form: "gullwing",
    span: { minMm: 9.97, maxMm: 10.63 },
    contact: { minMm: 0.4, maxMm: 1.0 },
    width: { minMm: 0.31, maxMm: 0.51 }
  },
  match: /\b(?:SOIC|SO)-?W|\bWIDE\b|\bDW\b/i
};

/**
 * VSSOP, 0.5 mm pitch, ten leads. JEDEC MO-187 variation BA.
 *
 * Read off the TI DGS0010A drawing in the ADS1115 datasheet, with the page
 * RENDERED rather than taken from the text layer, because every drawing defect
 * found in this project so far was invisible in the text: span 4.75-5.05, body
 * 2.9-3.1 square, pitch 0.5, lead width 0.17-0.27, foot 0.40-0.70 in DETAIL A.
 *
 * TEN LEADS ONLY, and the narrowness is the point. A VSSOP-8 is TI's DGK, which
 * is the same body at 0.65 mm pitch, and pitch is definitional here. One entry
 * covering both would place every pad on an eight-lead part 0.15 mm per step out,
 * which compounds down the row: that is the ISO7741 failure in a different
 * family, and this table's whole reason for existing is not to repeat it.
 *
 * On the land pattern this is the first family where IPC-7351B and TI's printed
 * example genuinely disagree on LENGTH rather than width. Both are documented in
 * the test, and TI's own note 6 on that page says so outright: "Publication
 * IPC-7351 may have alternate designs." The centre-to-centre span agrees exactly.
 */
const VSSOP_10: PackageDefinition = {
  family: "VSSOP-10",
  arrangement: "dual",
  pitchMm: 0.5,
  pinCounts: { min: 10, max: 10 },
  source:
    "JEDEC MO-187 variation BA, read off the TI DGS0010A package drawing in the ADS1115 datasheet (span 4.75-5.05, body 2.9-3.1 x 2.9-3.1, pitch 0.5, lead width 0.17-0.27, foot 0.40-0.70). The land pattern target is the one TI prints on the facing page: 10 lands of 1.45 x 0.3 on a 4.4 mm centre span.",
  lead: {
    form: "gullwing",
    span: { minMm: 4.75, maxMm: 5.05 },
    // Fitted, as every entry's contact is; see LeadDimensions. This range puts
    // the centre-to-centre span on TI's printed 4.4 exactly.
    contact: { minMm: 0.4, maxMm: 0.5 },
    width: { minMm: 0.17, maxMm: 0.27 }
  },
  match: /\bVSSOP\b/i
};

/**
 * VSSOP, 0.65 mm pitch, eight leads. JEDEC MO-187, TI outline DGK0008A.
 *
 * The sibling the VSSOP-10 entry above warned about, and it is a separate entry
 * for the reason that note gives: MO-187 keeps one body outline across its
 * variations and changes the PITCH, which is definitional here. One entry
 * covering both would place every pad on an eight-lead part 0.15 mm per step out.
 *
 * Read off the DGK0008A drawing in the LM358 datasheet, which cites MO-187 in
 * its own note 5: span 4.75-5.05, body 2.9-3.1 square, pitch 0.65, lead width
 * 0.25-0.38, foot 0.4-0.7 in DETAIL A.
 *
 * Two things are worth knowing about how well this one lands.
 *
 * The land WIDTH falls straight out of the drawing with nothing fitted: 0.25 +
 * 2(0.03) + rss(0.13) gives 0.4515 against the 0.45 TI prints. That is the model
 * working as the standard intends, and it is the first family here where the
 * width needed no help.
 *
 * The contact range is 0.40-0.50, the SAME calibration the ten-lead entry
 * needed, and it puts the centre-to-centre span on TI's printed 4.4 exactly
 * (4.401). Two variations of one JEDEC outline wanting the same fitted contact
 * is the first evidence in this table that the constant tracks the OUTLINE
 * rather than the individual drawing; see the note on LeadDimensions for why
 * that matters.
 */
const VSSOP_8: PackageDefinition = {
  family: "VSSOP-8",
  arrangement: "dual",
  pitchMm: 0.65,
  pinCounts: { min: 8, max: 8 },
  source:
    "JEDEC MO-187, read off the TI DGK0008A package drawing in the LM358 datasheet (span 4.75-5.05, body 2.9-3.1 x 2.9-3.1, pitch 0.65, lead width 0.25-0.38, foot 0.4-0.7). The land pattern target is the one TI prints on the facing page: 8 lands of 1.4 x 0.45 on a 4.4 mm centre span.",
  lead: {
    form: "gullwing",
    span: { minMm: 4.75, maxMm: 5.05 },
    // Fitted, as every entry's contact is; see LeadDimensions.
    contact: { minMm: 0.4, maxMm: 0.5 },
    width: { minMm: 0.25, maxMm: 0.38 }
  },
  // Deliberately NOT matching `MSOP`, which is what TI called this same DGK
  // outline before the rename and what ADI still calls a package of its own.
  // The two vendors' drawings have not both been read, and a family name shared
  // across vendors is not evidence they share a lead span. An ADI `10-lead MSOP`
  // stays refused rather than taking TI geometry.
  match: /\bVSSOP\b/i
};

/**
 * LQFP, 0.5 mm pitch, eighty leads on a 12 mm square body. JEDEC MS-026, TI
 * outline PN0080A.
 *
 * The first QUAD entry, and the first package here whose leads are not two
 * opposing rows. It works with the existing land-pattern model unchanged because
 * the body is SQUARE: the standard's calculation is about one opposing PAIR of
 * rows, and on a square package the other pair is that same pattern turned 90
 * degrees. The exporter places it on four sides; nothing about the arithmetic
 * changes.
 *
 * Read off the PN0080A drawing in the MSP430F5529 datasheet, which cites MS-026
 * in its note 3: span 13.8-14.2 toe to toe, body 11.8-12.2 square, pitch 0.5,
 * lead width 0.17-0.27, foot 0.45-0.75 in DETAIL A.
 *
 * Calibration lands almost exactly: contact 0.45-0.60, a SUBSET of the drawing's
 * own foot range, puts the centre-to-centre span on TI's printed 13.4 (13.401)
 * and the land length on its printed 1.5 (1.503).
 *
 * The known divergence is the land WIDTH, and it runs the other way from TSSOP's:
 * IPC-7351B density B gives 0.345 against the 0.3 TI prints, so our lands are
 * 0.045 mm WIDER here where they are narrower there. Both are inside the pitch
 * with clearance to spare (0.5 pitch, 0.155 gap between neighbouring lands), and
 * the exporter reports the comparison rather than silently choosing.
 *
 * EIGHTY LEADS ONLY, for the reason every entry here is narrow: MS-026 keeps one
 * lead form across a family of bodies that grow with the pin count, so an
 * LQFP-100 is 14 mm square and an LQFP-144 is 20 mm. Their spans are different
 * numbers off different drawings, not something to interpolate.
 */
const LQFP_80: PackageDefinition = {
  family: "LQFP-80",
  arrangement: "quad",
  pitchMm: 0.5,
  pinCounts: { min: 80, max: 80 },
  source:
    "JEDEC MS-026, read off the TI PN0080A package drawing in the MSP430F5529 datasheet (span 13.8-14.2, body 11.8-12.2 square, pitch 0.5, lead width 0.17-0.27, foot 0.45-0.75). The land pattern target is the one TI prints on the facing page: 80 lands of 1.5 x 0.3 on a 13.4 mm centre span, both axes.",
  lead: {
    form: "gullwing",
    span: { minMm: 13.8, maxMm: 14.2 },
    // Fitted, as every entry's contact is; see LeadDimensions. Reproduces TI's
    // printed 13.4 centre span to within 0.001 mm.
    contact: { minMm: 0.45, maxMm: 0.6 },
    width: { minMm: 0.17, maxMm: 0.27 }
  },
  match: /\bLQFP\b/i
};

const PACKAGE_DEFINITIONS: PackageDefinition[] = [
  SOIC_NARROW,
  SOIC_WIDE,
  TSSOP,
  VSSOP_8,
  VSSOP_10,
  CERAMIC_FLATPACK,
  LQFP_80
];

/**
 * TI outline-code prefixes, mapped to the family they identify.
 *
 * A package drawing is titled with the outline it draws (`D0008A`, `DW0016B`,
 * `PW0008A`). That code is a better package identity than the prose designator
 * for the one distinction this table cannot otherwise make: **`D` and `DW` are
 * both written "SOIC" in prose and differ by 4.3 mm of lead span.** An ISO7741
 * calls itself a "16-pin SOIC" in its own front matter and is a DW0016B, so the
 * prose alone put every pad 1.96 mm inboard of where the leads actually land.
 *
 * Only prefixes whose family is characterised here are listed. An unrecognised
 * prefix contributes nothing rather than being guessed at, and the prose
 * designator is left to stand on its own.
 *
 * This refines a family; it never chooses one on its own. See the `confirmed`
 * gate in `findPackageDefinition` for why that restriction is load-bearing.
 */
const OUTLINE_CODE_FAMILIES: Record<string, string> = {
  // Read off the TI D0008A drawing (UCC27524) and DW0016B drawing (ISO7741),
  // which are the two drawings the SOIC entries above were themselves read from.
  D: "SOIC narrow",
  DW: "SOIC wide",
  // PW0008A, the INA240 drawing the TSSOP entry was read from.
  PW: "TSSOP",
  // HKU0010A and U0010A, the two ceramic flat pack drawings in TPS7A4501-SP.
  HKU: "CFP",
  U: "CFP"
};

/**
 * Designators whose NAME does not settle which characterised body they are.
 *
 * `SOIC` is the whole list, and it earns its place: narrow body (MS-012) and
 * wide body (MS-013) are both written that way in prose and differ by 4.3 mm of
 * lead span. Every other family here is chosen outright by its name plus the pin
 * count, so an outline code adds nothing to them and its absence costs nothing.
 *
 * Used only to decide whether an UNREADABLE outline code is fatal; see
 * `findPackageDefinition`.
 */
const SHARED_BODY_NAME = /\bSO-?IC\b|\bSMALL\s+OUTLINE\s+INTEGRATED\s+CIRCUIT\b/i;

/**
 * Reasons a package could not be resolved, phrased for a person deciding what to
 * do next rather than for a log.
 */
export interface PackageLookupFailure {
  reason: string;
  /** Families that are supported, so the message can say what would work. */
  supported: string[];
}

export type PackageLookup =
  | { ok: true; definition: PackageDefinition }
  | { ok: false; failure: PackageLookupFailure };

/**
 * Resolves an extracted package designator and pin count to a definition.
 *
 * Wide-body SOIC is deliberately NOT matched by the narrow entry: the two share
 * a name and differ by 4.3 mm of span, so treating them as one family would put
 * every pad on a wide-body part in the wrong place.
 *
 * `outlineCode` is the code printed on the part's own package drawing
 * (`DW0016B`), and it settles exactly that distinction. It is only ever recorded
 * for a drawing confirmed to be this part's package, which is what makes it safe
 * to believe here; see the gate in `readDrawingDimensions`.
 */
export function findPackageDefinition(
  packageType: string,
  pinCount: number,
  outlineCode?: string
): PackageLookup {
  const supported = PACKAGE_DEFINITIONS.map((definition) => definition.family);
  const outlinePrefix = outlineCode ? /^([A-Z]{1,4})\d{4}[A-Z]$/i.exec(outlineCode)?.[1] : undefined;

  // A CERAMIC part is not one of the plastic families, whatever the designator
  // calls it. Every entry below except CFP is a plastic JEDEC outline read off a
  // plastic drawing, and a hermetic package sharing the name does not share the
  // dimensions: an ADC128S102QML-SP is sold as a `16-Lead Ceramic SOIC` and a
  // `16-lead ceramic flatpack`, and matching the first on the word SOIC would
  // hand a hermetic part MS-012 geometry.
  //
  // This was reachable in one click the moment the datasheet's own package list
  // was offered to the user, which is how it was found. The ceramic families are
  // the rad-hard half of the corpus and characterising them is real work; naming
  // one is not the same as having read its drawing.
  // A quad flat pack is not a ceramic DUAL flat pack; see QUAD_FLAT_PACK.
  //
  // This used to refuse every quad package outright. It now refuses every quad
  // package that no QUAD entry matches, which is the same protection stated
  // properly: what must never happen is a four-row package taking a two-row
  // entry's geometry, and `FLATPACK` matching inside `PLASTIC QUAD FLATPACK`
  // is exactly how a VQFN would otherwise be handed CFP lead dimensions.
  //
  // Restricting the candidate set rather than testing the winner afterwards is
  // deliberate: it means a quad designator can only ever be resolved by an entry
  // that was written as a quad, whatever else its name happens to match.
  if (QUAD_FLAT_PACK.test(packageType)) {
    const quad = PACKAGE_DEFINITIONS.filter(
      (definition) => definition.arrangement === "quad" && definition.match.test(packageType)
    );
    const fitted = quad.find(
      (definition) => pinCount >= definition.pinCounts.min && pinCount <= definition.pinCounts.max
    );
    if (fitted) return { ok: true, definition: fitted };

    return {
      ok: false,
      failure: {
        reason:
          quad.length > 0
            ? `"${packageType}" is a quad flat pack whose family is characterised for ${quad
                .map((definition) => `${definition.pinCounts.min} to ${definition.pinCounts.max}`)
                .join(", ")} leads, not ${pinCount}. Body size and lead span change with the lead count on these families, so no land pattern is generated.`
            : `"${packageType}" is a quad flat pack, which has four rows of leads. No quad land pattern is characterised for that family, so none is generated.`,
        supported
      }
    };
  }

  if (/\bCERAMIC\b/i.test(packageType) && !CERAMIC_FLATPACK.match.test(packageType)) {
    return {
      ok: false,
      failure: {
        reason: `"${packageType}" is a ceramic package. The characterised land patterns other than CFP are plastic JEDEC outlines, and a hermetic package that shares their name does not share their lead span, so no land pattern is generated.`,
        supported
      }
    };
  }

  // Wide body is checked FIRST. It shares the name "SOIC" with the narrow body
  // and differs by 4.3 mm of lead span, so a plain substring match on "SOIC"
  // would hand a wide-body part the narrow-body geometry and put every pad in
  // the wrong place.
  //
  // The prose designator usually does not say which one it is: an ISO7741 reads
  // "16-pin SOIC" and is a wide body. The outline code on its drawing does say.
  const codedFamily = outlinePrefix ? OUTLINE_CODE_FAMILIES[outlinePrefix.toUpperCase()] : undefined;
  const saysWide = /\bWIDE\b|\bSOIC-?W\b|\bDW\b/i.test(packageType);

  // An outline code we cannot READ is not the same as no outline code, and
  // treating it as one shipped wrong copper.
  //
  // Measured on ISO7841, which ships today: its drawing is titled `DWW0016A`, a
  // prefix this map does not carry, so the coded family came back undefined and
  // the decision fell through to the prose test on `16-pin SOIC`, which says
  // nothing about the body and therefore selected NARROW. The part went out with
  // a 5.376 mm centre-to-centre pad span. Its sibling ISO7741, whose `DW0016B` IS
  // in the map, ships at 9.301 mm, and a 16-lead SOIC body is 7.5 mm wide, so
  // those pads sat under the package.
  //
  // The code is positive evidence about which body this is, and an unreadable
  // one leaves the question open rather than answering it. Refusing is also the
  // only honest answer for this part specifically: its own ordering table lists
  // BOTH `SOIC (DW)` and `SOIC (DWW)`, which are different outlines with
  // different spans, so even knowing "wide" would not say which.
  //
  // Scoped to the designators where the NAME does not settle the geometry, which
  // is what makes this safe to add: an `8-Pin VSSOP` with an unrecognised
  // `DGK0008A` is unambiguous, because pin count and pitch choose that family
  // outright, and two parts that ship on exactly that path are unaffected.
  if (outlinePrefix && !codedFamily && !saysWide && SHARED_BODY_NAME.test(packageType)) {
    return {
      ok: false,
      failure: {
        reason: `"${packageType}" does not say which body it is, and the package drawing is titled ${outlineCode}, an outline code this table cannot interpret. Narrow and wide bodies of this family share a name and differ by more than 4 mm of lead span, so no land pattern is generated. Name the package explicitly to override.`,
        supported
      }
    };
  }

  const wideBody = codedFamily ? codedFamily === "SOIC wide" : saysWide;
  const matched = PACKAGE_DEFINITIONS.filter((definition) =>
    wideBody ? definition.family === "SOIC wide" : definition.match.test(packageType) && definition.family !== "SOIC wide"
  );

  // The code is trusted to say WHICH SOIC, not to overrule the designator about
  // what kind of package this is. If the two name different families then one of
  // them is a misread and there is no basis for choosing, which is the same rule
  // the pin count follows when its two signals disagree.
  if (codedFamily && matched.length > 0 && !matched.some((definition) => definition.family === codedFamily)) {
    return {
      ok: false,
      failure: {
        reason: `Conflicting package evidence: the designator reads "${packageType}" but the package drawing is titled ${outlineCode}, which is a ${codedFamily}. One of them is a misread, so no land pattern is generated. Name the package explicitly to override.`,
        supported
      }
    };
  }

  if (matched.length === 0) {
    return {
      ok: false,
      failure: {
        reason: `No IPC-7351B land pattern is characterised for package "${packageType}".`,
        supported
      }
    };
  }

  const fitted = matched.find(
    (definition) => pinCount >= definition.pinCounts.min && pinCount <= definition.pinCounts.max
  );
  if (!fitted) {
    const definition = matched[0];
    return {
      ok: false,
      failure: {
        reason: `Package "${packageType}" matches ${definition.family}, which is characterised for ${definition.pinCounts.min} to ${definition.pinCounts.max} pins, not ${pinCount}.`,
        supported
      }
    };
  }

  return { ok: true, definition: fitted };
}

export const SUPPORTED_PACKAGE_FAMILIES = PACKAGE_DEFINITIONS.map((definition) => definition.family);

/**
 * How far a drawn pitch may sit from the family's before the two are describing
 * different packages. Pitches are definitional and printed to two decimals, so
 * this is a float-comparison tolerance rather than an engineering allowance: the
 * real gaps between families are 0.15 mm and up.
 */
const PITCH_AGREEMENT_MM = 0.02;

/** What this part's own mechanical drawing contributed, where it was readable. */
export interface DrawnPackageEvidence {
  /** Code printed on the drawing, e.g. `DW0016B`. */
  outlineCode?: string | null;
  /** Pitch read off the drawing, used to check the family rather than to place pads. */
  pitchMm?: number | null;
  /** Lead width read off the drawing, used in place of the family's. */
  leadWidthMm?: LeadWidth | null;
}

/**
 * Resolves a package to a definition, checked against the part's own drawing.
 *
 * This is the single place both the parse route and the exporter ask "which
 * package is this, and what lead dimensions does it have". They used to answer
 * it separately, which is how the UI could report a land pattern check for a
 * SOIC narrow while the export generated a SOIC wide.
 *
 * Every entry in the table above was read off ONE vendor drawing and then
 * applied to a whole family. That is defensible for a JEDEC outline and it is
 * still an assumption, and the part in front of us carries the evidence to test
 * it, so it is tested.
 */
export function resolvePackageDefinition(
  packageType: string,
  pinCount: number,
  drawn: DrawnPackageEvidence = {}
): PackageLookup {
  const lookup = findPackageDefinition(packageType, pinCount, drawn.outlineCode ?? undefined);
  if (!lookup.ok) return lookup;

  let definition = lookup.definition;

  // A pitch that disagrees means the designator and the drawing are describing
  // different packages. Since the pads are placed on the FAMILY's pitch, the
  // footprint would come out confidently wrong rather than obviously wrong,
  // which is the failure the whole refusal posture exists to prevent.
  if (
    drawn.pitchMm !== null &&
    drawn.pitchMm !== undefined &&
    Math.abs(drawn.pitchMm - definition.pitchMm) > PITCH_AGREEMENT_MM
  ) {
    return {
      ok: false,
      failure: {
        // Worded by what is known, not by where it came from. This field is the
        // mechanical drawing's pitch on most parts and a model's on some, and
        // `ResolvedPart` has flattened the provenance away by the time the
        // exporter sees it. Naming a source we cannot confirm here would be the
        // same unfounded provenance claim the whole record format exists to
        // prevent.
        reason: `The lead pitch extracted from this datasheet is ${drawn.pitchMm} mm, but "${packageType}" resolves to ${definition.family}, whose pitch is ${definition.pitchMm} mm. One of the two is about a different package, so no land pattern is generated. Name the package explicitly to override.`,
        supported: SUPPORTED_PACKAGE_FAMILIES
      }
    };
  }

  // Where the drawing gives this part's own lead width, it is used in place of
  // the family constant: same family and a different vendor is a real source of
  // difference, and the width sets the land width directly through Xmax.
  const width = drawn.leadWidthMm;
  if (width && width.minMm > 0 && width.maxMm >= width.minMm) {
    definition = {
      ...definition,
      lead: { ...definition.lead, width: { minMm: width.minMm, maxMm: width.maxMm } },
      source: `${definition.source}. Lead width ${width.minMm}-${width.maxMm} mm read off this part's own package drawing${drawn.outlineCode ? ` (${drawn.outlineCode})` : ""}, in place of the family value.`
    };
  }

  return { ok: true, definition };
}
