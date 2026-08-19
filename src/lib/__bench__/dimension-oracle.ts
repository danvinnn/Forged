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
  /**
   * The same span across the OTHER axis, for a four-sided package that is not
   * square. Absent on a two-sided or one-sided package, which has one, and on a
   * square quad, where `leadSpanMm` already says it.
   */
  leadSpanCrossMm?: OracleRange;
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
  /**
   * Seated height where the drawing prints ONLY a maximum, which is common on a
   * package whose standoff varies: "CFP - 2.33mm max height" and nothing else.
   * The reading should be that number, because the drawing states no other value
   * for the envelope.
   */
  bodyHeightMaxMm?: number;
  /**
   * Seated height where the drawing prints a max/nom/min, e.g. 0.80 / 0.75 /
   * 0.70. Any value inside is a correct reading.
   *
   * Both forms exist because the drawings do. Checking a max-only drawing
   * against a range would accept anything below it, and checking a
   * three-value drawing against its maximum alone marks the NOMINAL wrong, which
   * is the value the prompt asks for. AD8232 was marked WRONG at 0.75 against a
   * 0.80 max on the first run that checked it, and 0.75 is what its drawing
   * prints as nominal.
   */
  bodyHeightMm?: OracleRange;
  /**
   * The exposed thermal pad on the underside, along the SAME axis as
   * `bodyLengthMm`. Absent on a package that has none.
   *
   * Here because the pad is copper and a wrong one is a wrong footprint: it
   * shipped rotated ninety degrees from its own body on 2026-08-16, which fits
   * between the lead rows and so passes every invariant. Nothing checked the
   * number until this, so the axis has to be asserted and not just the size.
   */
  thermalPadLengthMm?: OracleRange;
  /** The same pad, across that axis. */
  thermalPadWidthMm?: OracleRange;
  /** Sides carrying leads. 1 for a single line, as on a TO-220 or a SIP. */
  leadSides?: 1 | 2 | 4;
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
    /**
     * Centre to centre across the OTHER axis, for a four-sided footprint that is
     * not square. The drawing prints both and nothing here could record the
     * second, so a rectangular quad's cross span had no correctness check at all.
     */
    spanCrossMm?: number;
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
  // Ceramic flat pack, 10 lead, dimensioned in INCHES with no millimetre
  // equivalents. Read 2026-08-18 off the rendered page.
  //
  // THIN ON PURPOSE, and the absences are the point. This drawing prints:
  //
  //   no tip-to-tip span   the leads are dimensioned from the body edge outward
  //                        (5X .32 +/- .01 each side) and the body separately, so
  //                        a span exists only as arithmetic over three toleranced
  //                        numbers. RULES.md 2: a derivation needs a reason from
  //                        practice, not from arithmetic being available. Absent.
  //   no seated foot       unformed leads, as on every CFP here. Absent, and that
  //                        absence is what `bench:dimensions` checks: a reader
  //                        returning a contact length for this package invented it.
  //   two body numbers     ".27 MAX GLASS" on both axes and ".241 +.019/-.003"
  //                        across the middle. Which of them `bodyLengthMm` means
  //                        is not decidable from the page, so neither is claimed.
  //
  // This is the rad-hard ceramic segment, which is the customer, so a thin honest
  // entry here is worth more than a full guessed one.
  //
  // NOTE, unresolved: the record read this code as `HKU0010A` and the drawing
  // titles itself `U0010A`. Keyed on the drawing's own spelling and matched via
  // `parts`, so the discrepancy cannot silently attach this to the wrong drawing.
  U0010A: {
    packageType: "CFP (10)",
    parts: ["TPS7A4501-SP"],
    source: "TPS7A4501-SP datasheet, page 28, PACKAGE OUTLINE U0010A, rev 4225582/A 01/2020",
    leadForm: "straight",
    // 10X .017 +/- .002 inch.
    leadWidthMm: { minMm: 0.381, maxMm: 0.4826 },
    // 8X .050 +/- .005 inch. Eight gaps across ten leads, five a side.
    pitchMm: 1.27,
    // From the drawing's own title block, "CFP - 2.03 mm max height".
    bodyHeightMaxMm: 2.03,
    leadSides: 2
  },
  // LFCSP-20, 4 x 4 mm. Read 2026-08-18 off the rendered page. The first
  // NO-LEAD package in this file, and the first square quad WITH an exposed pad.
  //
  // Two absences here are statements rather than gaps, which is the whole point
  // of partial entries:
  //
  //   leadSpanMm       a no-lead package has no leads to measure tip to tip. Its
  //                    terminals are on the underside, so the drawing prints no
  //                    such dimension and a reader returning one has invented it.
  //   leadSpanCrossMm  the body is square (4.00 SQ), so one span governs both
  //                    axes and a second entry would assert nothing.
  //
  // `leadContactMm` IS present: on a no-lead package the terminal length is what
  // sits on the pad, which is the same thing dimension L means on a gull-wing
  // drawing.
  "CP-20-8": {
    packageType: "LFCSP (20)",
    // The ordering guide on this page lists CP-20-8 and nothing else.
    parts: ["AD8232"],
    source: "AD8232 datasheet, page 27, Figure 69, 20-Lead LFCSP (CP-20-8), rev 10-12-2017-C",
    leadForm: "nolead",
    leadWidthMm: { minMm: 0.18, maxMm: 0.3 },
    leadContactMm: { minMm: 0.3, maxMm: 0.5 },
    pitchMm: 0.5,
    bodyLengthMm: { minMm: 3.9, maxMm: 4.1 },
    bodyWidthMm: { minMm: 3.9, maxMm: 4.1 },
    // 0.80 / 0.75 / 0.70 on the side view: an overall height with a nominal, so
    // it is a RANGE and not a bare maximum.
    bodyHeightMm: { minMm: 0.7, maxMm: 0.8 },
    // 2.75 / 2.60 SQ / 2.35, square, so both axes carry the same pair.
    thermalPadLengthMm: { minMm: 2.35, maxMm: 2.75 },
    thermalPadWidthMm: { minMm: 2.35, maxMm: 2.75 },
    leadSides: 4,
    jedecOutline: "MO-220-WGGD-11"
  },
  // TSSOP-38. Read 2026-08-18 off the rendered pages, BOTH of them: the outline
  // on page 65 and the printed land pattern on page 66.
  //
  // Entries carrying a `land` are the most valuable kind, because they are the
  // only ones that close the loop from a vendor's printed footprint all the way
  // to emitted copper (`bench:copper` compares the pads against this). Two of
  // the seven entries had one before this.
  DBT0038A: {
    packageType: "TSSOP (38)",
    // EMPTY: whether this datasheet offers only the DBT has not been checked by
    // hand, and the outline code was read for this part so the match does not
    // need the part name.
    parts: [],
    source: "ADS8688 datasheet, page 65, PACKAGE OUTLINE DBT0038A, rev 4220221/A 05/2020",
    leadForm: "gullwing",
    leadSpanMm: { minMm: 6.25, maxMm: 6.55 },
    leadWidthMm: { minMm: 0.17, maxMm: 0.23 },
    leadContactMm: { minMm: 0.5, maxMm: 0.75 },
    pitchMm: 0.5,
    // D. Nineteen leads a side at 0.5 is eighteen gaps, which is the "2X 9" the
    // drawing prints, so the row axis is fixed by the drawing and not by
    // convention.
    bodyLengthMm: { minMm: 9.65, maxMm: 9.75 },
    bodyWidthMm: { minMm: 4.35, maxMm: 4.45 },
    bodyHeightMaxMm: 1.2,
    leadSides: 2,
    jedecOutline: "MO-153",
    land: {
      source: "ADS8688 datasheet, page 66, LAND PATTERN EXAMPLE DBT0038A",
      padLengthMm: 1.5,
      padWidthMm: 0.3,
      spanMm: 5.8,
      // 0.05 MAX all around on the non-solder-mask-defined detail, which this
      // drawing marks PREFERRED.
      solderMaskExpansionMm: 0.05
    }
  },
  // LQFP-80. Read 2026-08-18 off the rendered page, and the FIRST four-sided
  // package in this file.
  //
  // That gap mattered: every defect the cross-axis work chased lives on a quad,
  // and until now nothing hand-read could contradict a quad reading at all. This
  // one is SQUARE, so `leadSpanCrossMm` is deliberately absent per the note on
  // the field: the drawing prints one span and it governs both axes. A
  // rectangular quad is still unrepresented and is the next entry worth reading.
  //
  // The row extent corroborates the arrangement without relying on convention:
  // the drawing prints "4X 9.5", and twenty leads a side at 0.5 pitch is
  // nineteen gaps of 0.5, which is 9.5.
  PN0080A: {
    packageType: "LQFP (80)",
    // EMPTY on purpose. This datasheet offers more than the LQFP and which
    // package the record settles on has not been checked by hand, so claiming
    // the part here could make the file assert nonsense. `bench:dimensions`
    // matches on the outline code, which is what identifies the drawing.
    parts: [],
    source: "MSP430F5529 datasheet, page 141, PACKAGE OUTLINE PN0080A, rev 4215166/A 08/2022",
    leadForm: "gullwing",
    // Tip to tip, 14.2/13.8 TYP. The 12.2/11.8 pair on the other two edges is the
    // BODY, and confusing the two is a 2 mm error in the land pattern.
    leadSpanMm: { minMm: 13.8, maxMm: 14.2 },
    leadWidthMm: { minMm: 0.17, maxMm: 0.27 },
    leadContactMm: { minMm: 0.45, maxMm: 0.75 },
    pitchMm: 0.5,
    bodyLengthMm: { minMm: 11.8, maxMm: 12.2 },
    bodyWidthMm: { minMm: 11.8, maxMm: 12.2 },
    bodyHeightMaxMm: 1.6,
    leadSides: 4,
    jedecOutline: "MS-026"
  },
  // PowerPAD SOIC-8. Read 2026-08-18 off the rendered page. The second entry
  // with an exposed pad, and deliberately a SOIC rather than another TSSOP: the
  // pad's long axis runs along the body's long axis on both, which is the thing
  // that shipped ninety degrees out on 2026-08-16, and one drawing cannot show
  // that it generalises.
  //
  // TPS54360 was promoted into the tuned corpus on 2026-08-17 for producing an
  // invalid footprint, so it is exactly the part that should have a hand-read
  // entry.
  DDA0008B: {
    packageType: "PowerPAD SOIC (8)",
    // The only package this datasheet offers.
    parts: ["TPS54360"],
    source: "TPS54360 datasheet, page 47, PACKAGE OUTLINE DDA0008B, rev 4214849/B 09/2025",
    leadForm: "gullwing",
    leadSpanMm: { minMm: 5.8, maxMm: 6.2 },
    leadWidthMm: { minMm: 0.31, maxMm: 0.51 },
    leadContactMm: { minMm: 0.4, maxMm: 1.27 },
    pitchMm: 1.27,
    // D, the axis the two rows of four run along: 3 gaps of 1.27 is the 3.81 the
    // drawing prints, which fixes the orientation without relying on convention.
    bodyLengthMm: { minMm: 4.8, maxMm: 5.0 },
    bodyWidthMm: { minMm: 3.8, maxMm: 4.0 },
    bodyHeightMaxMm: 1.7,
    thermalPadLengthMm: { minMm: 2.8, maxMm: 3.4 },
    thermalPadWidthMm: { minMm: 2.11, maxMm: 2.71 },
    leadSides: 2,
    jedecOutline: "MS-012"
    // No `land`: the recommended footprint is on another page and has not been
    // read, and an entry claiming one nobody looked at is worse than none.
  },
  // PowerPAD TSSOP-28. Read 2026-08-18 off the rendered page. Chosen because it
  // is the first entry with an EXPOSED PAD, which nothing here could check
  // before, and because 28 leads at 0.65 make the row axis unmistakable: the
  // drawing prints "2X 8.45" for the 14 spaces of one row, which fixes 9.6/9.8
  // as the body length and 4.3/4.5 as the width rather than leaving it to a
  // convention.
  PWP0028C: {
    packageType: "PowerPAD TSSOP (28)",
    // The only package this datasheet offers.
    parts: ["DRV8825"],
    source: "DRV8825 datasheet, page 30, PACKAGE OUTLINE PWP0028C, rev 4223582/A 03/2017",
    leadForm: "gullwing",
    leadSpanMm: { minMm: 6.2, maxMm: 6.6 },
    leadWidthMm: { minMm: 0.19, maxMm: 0.3 },
    leadContactMm: { minMm: 0.5, maxMm: 0.75 },
    pitchMm: 0.65,
    bodyLengthMm: { minMm: 9.6, maxMm: 9.8 },
    bodyWidthMm: { minMm: 4.3, maxMm: 4.5 },
    bodyHeightMaxMm: 1.2,
    // Along the body's LENGTH, which is the axis the drawing dimensions it on:
    // 5.18/4.48 runs parallel to the 9.6/9.8 body dimension on the bottom view.
    thermalPadLengthMm: { minMm: 4.48, maxMm: 5.18 },
    thermalPadWidthMm: { minMm: 2.4, maxMm: 3.1 },
    leadSides: 2,
    jedecOutline: "MO-153"
    // No `land`: the recommended footprint is on a later page and has not been
    // read, and an entry claiming one that was not looked at is worse than none.
  },

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
    // From the drawing's own title block, "CFP - 2.33mm max height", which is
    // the seated envelope.
    //
    // This drawing prints TWO heights and they are not the same measurement: the
    // side view dimensions the ceramic at `.070 +.010 -.020 [1.778]`. The reader
    // returned 1.778 and was marked WRONG on the first run that checked body
    // height at all, which was the right verdict for the wrong reason: the model
    // read the page correctly and the FIELD GUIDE asked for "body height". The
    // guide now asks for the seated envelope, because that is what the 3D solid
    // is stood on the board and clearance-checked as.
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
