/**
 * Known-correct package DIMENSIONS, read by a human off the drawing.
 *
 * ## Why this exists
 *
 * Until 2026-08-17 there was no oracle on any dimension. Pin names had one and
 * package family had one; every number that places copper had nothing. So every
 * coverage figure this project has ever produced counted how many dimensions came
 * back NON-NULL, and none of them asked whether a single one was right.
 *
 * That gap bit immediately and in both directions on the day it was noticed:
 *
 *   I reported `leadForm: straight` and `leadSpanMm {21,25}` on an LMP7704-SP as
 *   proof a prompt fix had worked. I had checked the SHAPE of the answer and not
 *   the number.
 *
 *   I then declared {21,25} wrong, because in the PDF's text layer those two
 *   digits sit beside the document number, `25 21 4225069/E 09/2024`, and read
 *   as a footer. I proposed tightening the citation check to reject them.
 *
 *   Rendering the page settled it. `25` over `21` is a real dimension line
 *   spanning lead tip to lead tip on the bottom view. The model was right both
 *   times, and the "fix" would have broken a correct reading.
 *
 * The rule that falls out: a value's correctness cannot be judged from the text
 * layer, and it cannot be judged from whether the field is populated. It has to
 * be read off the rendered drawing by a person, once, and written down.
 *
 * ## The rules for adding an entry
 *
 * Every number here was read off the rendered page by a person looking at the
 * drawing. NOT copied from extractor output, NOT inferred from the text layer,
 * and NOT looked up from a JEDEC table. If you have not looked at the drawing,
 * do not add the entry.
 *
 * Entries are PARTIAL by design. A drawing that does not print a value gets no
 * key for it, which is different from a key with a null: the absence records that
 * a person looked and the drawing is silent. `leadContactMm` on a ceramic flat
 * pack is the worked example, and it is absent for a real reason: the leads leave
 * the body straight, so there is no seated foot until the assembler forms them.
 *
 * Keyed by the vendor's package OUTLINE CODE, because the code identifies the
 * drawing: one drawing serves many parts, and two parts sharing a package name
 * can have different drawings.
 *
 * `parts` then lists the corpus parts a person has confirmed use this drawing.
 * It is needed because the outline code is itself read by the model and often
 * comes back null, so keying on it alone would leave most of the corpus
 * uncheckable. A part is listed only where its datasheet offers ONE package, or
 * where the package it settles on has been checked by hand; anything ambiguous
 * is left out rather than guessed, since matching the wrong drawing would make
 * this file assert nonsense.
 */

/** A dimension a drawing prints as a min/max pair. */
export interface OracleRange {
  minMm: number;
  maxMm: number;
}

export interface DimensionOracleEntry {
  /** The package as the drawing titles it. Documentation, not an assertion. */
  packageType: string;
  /**
   * Corpus parts confirmed by hand to use this drawing. Empty where the
   * datasheet offers several packages and which one applies has not been
   * checked.
   */
  parts: string[];
  /** Which document and page a person read this from. */
  source: string;
  /**
   * How the leads leave the body, as DRAWN.
   *
   * `straight` exists here because it exists on the drawings: a ceramic flat
   * pack's leads extend in line with the body for the assembler to form. The
   * prompt offered only `gullwing` and `nolead` until 2026-08-17, so every CFP
   * answered null and it read as a failure to read.
   */
  leadForm?: "gullwing" | "nolead" | "straight";
  /** Tip to tip across the package, including the leads. */
  leadSpanMm?: OracleRange;
  /** Width of one lead, as printed on the drawing. */
  leadWidthMm?: OracleRange;
  /**
   * The seated foot, drawing dimension L. ABSENT where the drawing prints none,
   * which is the honest state for an unformed lead rather than a gap.
   */
  leadContactMm?: OracleRange;
  /** Lead pitch. */
  pitchMm?: number;
  /** Body, along the axis the pin rows run. */
  bodyLengthMm?: OracleRange;
  /** Body, across that axis. */
  bodyWidthMm?: OracleRange;
  /** Maximum seated height. */
  bodyHeightMaxMm?: number;
  /** Sides carrying leads. */
  leadSides?: 2 | 4;
  /** The JEDEC registration the drawing cites, exactly as printed. */
  jedecOutline?: string;
  /** The datasheet's OWN printed footprint, where it prints one. */
  land?: {
    source: string;
    /** One land, measured outward from the package centre. */
    padLengthMm: number;
    /** One land, measured across the row. */
    padWidthMm: number;
    /** Centre to centre between opposing rows. */
    spanMm: number;
    solderMaskExpansionMm?: number;
  };
}

/**
 * Hand-read entries.
 *
 * Small on purpose. Three drawings read properly are worth more than thirty
 * copied from the thing being tested, and this file is only useful for as long
 * as every line of it was read by a person.
 */
export const DIMENSION_ORACLE: Record<string, DimensionOracleEntry> = {
  // Ceramic flat pack, straight untrimmed leads. The part that exposed both the
  // `leadForm` prompt gap and my own misreading of the text layer.
  HBH0014A: {
    packageType: "CFP (14)",
    // The only package this datasheet offers, so the match is unambiguous.
    parts: ["LMP7704-SP"],
    source: "LMP7704-SP datasheet, page 29, PACKAGE OUTLINE HBH0014A, rev 4225069/E 09/2024",
    leadForm: "straight",
    // The dimension line across the bottom view, lead tip to lead tip. Printed
    // without decimals, which is why it reads as a document number in the text
    // layer and is unmistakable on the rendered page.
    leadSpanMm: { minMm: 21, maxMm: 25 },
    leadWidthMm: { minMm: 0.382, maxMm: 0.482 },
    // leadContactMm deliberately ABSENT: the drawing prints no seated foot,
    // because the leads are unformed. See the interface note.
    pitchMm: 1.27,
    bodyLengthMm: { minMm: 9.55, maxMm: 9.91 },
    bodyWidthMm: { minMm: 6.3, maxMm: 6.65 },
    bodyHeightMaxMm: 2.861,
    leadSides: 2
    // No `land`: this datasheet prints no recommended footprint, which is why a
    // CFP needs the formed span from the assembler instead.
  },

  // TSSOP-8. Formed gull-wing leads, so it DOES print a contact length, which is
  // the contrast that makes the CFP's absence meaningful rather than a gap.
  PW0008A: {
    packageType: "TSSOP (8)",
    // LM358 and INA240 both offer several packages. Which one each record
    // settles on has not been checked by hand, so neither is claimed here.
    parts: [],
    source: "LM358 datasheet, page 51, PACKAGE OUTLINE PW0008A, rev 4221848/A 02/2015",
    leadForm: "gullwing",
    leadSpanMm: { minMm: 6.2, maxMm: 6.6 },
    leadWidthMm: { minMm: 0.19, maxMm: 0.3 },
    leadContactMm: { minMm: 0.5, maxMm: 0.75 },
    pitchMm: 0.65,
    bodyLengthMm: { minMm: 2.9, maxMm: 3.1 },
    bodyWidthMm: { minMm: 4.3, maxMm: 4.5 },
    bodyHeightMaxMm: 1.2,
    leadSides: 2,
    jedecOutline: "MO-153 AA",
    land: {
      source: "INA240 datasheet, page 34, EXAMPLE BOARD LAYOUT PW0008A",
      padLengthMm: 1.5,
      padWidthMm: 0.45,
      spanMm: 5.8,
      // Printed as 0.05 MAX for the non-solder-mask-defined detail and 0.05 MIN
      // for the solder-mask-defined one. Neither is marked preferred on this
      // drawing, and both figures are the same number.
      solderMaskExpansionMm: 0.05
    }
  },

  // SOIC-8, dimensioned in INCHES with millimetres in brackets. Kept
  // specifically because it is the unit-conversion case: every number below is
  // the bracketed millimetre figure the drawing prints.
  D0008A: {
    packageType: "SOIC (8)",
    parts: [],
    source: "INA240 datasheet, page 36, PACKAGE OUTLINE D0008A, rev 4214825/C 02/2019",
    leadForm: "gullwing",
    leadSpanMm: { minMm: 5.8, maxMm: 6.19 },
    leadWidthMm: { minMm: 0.31, maxMm: 0.51 },
    leadContactMm: { minMm: 0.41, maxMm: 1.27 },
    pitchMm: 1.27,
    bodyLengthMm: { minMm: 4.81, maxMm: 5.0 },
    bodyWidthMm: { minMm: 3.81, maxMm: 3.98 },
    bodyHeightMaxMm: 1.75,
    leadSides: 2,
    jedecOutline: "MS-012 AA"
  },

  // A ceramic flat pack that IS formed, which is the contrast that makes
  // HBH0014A above mean something.
  //
  // Both are 14-lead ceramic flat packs at 1.27 pitch and they are not the same
  // part to build: HBH0014A prints no seated foot, because its leads leave the
  // body straight and the assembler forms them. This one prints a bend radius of
  // R.015 [0.38], a 0 to 4 degree exit angle, and a .040 [1.02] foot in DETAIL A,
  // and its side view carries the leads down to the seating plane. So `CFP` in a
  // package name settles nothing about lead form, and a rule keyed on the family
  // word would get one of these two wrong.
  //
  // Read off the RENDERED pages, not the text layer, as the interface requires.
  NAC0014A: {
    packageType: "CERPACK (14)",
    // Left empty deliberately. This datasheet also offers a CDIP (J / R-GDIP-14)
    // and which package a record should settle on has not been hand-checked, so
    // no part is claimed here. The entry is keyed by the drawing and matches on
    // that alone.
    parts: [],
    source: "LM139AQML-SP datasheet, page 30, PACKAGE OUTLINE NAC0014A, rev 4215197/C 08/2022",
    leadForm: "gullwing",
    // .410 +/- .010 across the top view, lead tip to lead tip.
    leadSpanMm: { minMm: 10.16, maxMm: 10.66 },
    // 14X .017 +/- .002.
    leadWidthMm: { minMm: 0.38, maxMm: 0.48 },
    // DETAIL A, .040 +/- .003. Present precisely because these leads are formed.
    leadContactMm: { minMm: 0.95, maxMm: 1.09 },
    // 12X .050 +/- .002, twelve gaps across fourteen leads.
    pitchMm: 1.27,
    // .3870 +/- .0030, the dimension the leads are distributed along.
    bodyLengthMm: { minMm: 9.754, maxMm: 9.906 },
    // .250 +.020 -.005, an asymmetric tolerance printed as a stacked fraction.
    bodyWidthMm: { minMm: 6.23, maxMm: 6.85 },
    // bodyHeightMaxMm deliberately ABSENT. The end view prints .044MAX TYP [1.1]
    // and .070 +.010 -.020 [1.78], and which of the two is the seated height is
    // not unambiguous from the drawing. An oracle is only worth having while
    // every line in it was actually read, so an uncertain number is left out
    // rather than guessed: a wrong entry here would mark a correct reading as a
    // defect and cost more than the missing check.
    leadSides: 2,
    // Note 4 on the drawing: "No JEDEC registration as of December 2021", so
    // there is no `jedecOutline` to record rather than one we failed to find.
    land: {
      source: "LM139AQML-SP datasheet, page 31, EXAMPLE BOARD LAYOUT NAC0014A",
      // 14X .090 [2.29], the pad's long axis, measured outward from centre.
      padLengthMm: 2.29,
      // 14X .027 [0.69], across the row.
      padWidthMm: 0.69,
      // (.37) [9.4], centre to centre between the opposing columns.
      spanMm: 9.4,
      // .003 [0.07], printed MAX for the non-solder-mask-defined detail and MIN
      // for the solder-mask-defined one. Same number either way.
      solderMaskExpansionMm: 0.07
    }
  },

  // The 16-lead sibling of NAC0014A, and read separately rather than assumed
  // from it. Nearly every number does match, which is the point: assuming it
  // would have been right here and is exactly the habit that produced the MAX232
  // defect, where one drawing's numbers were taken for another's.
  //
  // The two differ where it matters least and would matter most if guessed: this
  // drawing states its height in the TITLE ("CFP - 2.33mm max height") and
  // NAC0014A's title states none at all, which is why that entry omits the
  // field rather than borrowing this one.
  NAC0016A: {
    packageType: "CFP (16)",
    // Empty for the same reason as NAC0014A: this datasheet also offers a
    // ceramic SOIC, and which one the record settles on is not hand-checked.
    parts: [],
    source: "ADC128S102QML-SP datasheet, page 31, PACKAGE OUTLINE NAC0016A, rev 4215198/C 08/2022",
    leadForm: "gullwing",
    // .410 +/- .010 [10.414 +/- 0.254].
    leadSpanMm: { minMm: 10.16, maxMm: 10.668 },
    // 16X .017 +/- .002 [0.4318 +/- 0.0508]. Printed to four decimal places
    // here and two on the 14-lead drawing; both are transcribed as printed.
    leadWidthMm: { minMm: 0.381, maxMm: 0.4826 },
    // DETAIL A, .040 +/- .003 [1.016 +/- 0.0762].
    leadContactMm: { minMm: 0.9398, maxMm: 1.0922 },
    // 14X .050 +/- .002, fourteen gaps across sixteen leads.
    pitchMm: 1.27,
    bodyLengthMm: { minMm: 9.754, maxMm: 9.906 },
    // .250 +.020 -.005 [6.35 +0.508 -0.127].
    bodyWidthMm: { minMm: 6.223, maxMm: 6.858 },
    // From the drawing's own title block.
    bodyHeightMaxMm: 2.33,
    leadSides: 2,
    // Note 4: "No JEDEC registration as of December 2021".
    land: {
      source: "ADC128S102QML-SP datasheet, page 32, EXAMPLE BOARD LAYOUT NAC0016A",
      padLengthMm: 2.29,
      padWidthMm: 0.69,
      spanMm: 9.4,
      solderMaskExpansionMm: 0.07
    }
  }
};
