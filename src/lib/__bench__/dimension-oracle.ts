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
  // VSSOP-10 (MSOP-10), hand-read off the rendered ADS1115 page 51 on
  // 2026-08-20. Chosen because two cached parts read this same drawing and
  // neither was checked by anything: ADS1115 and INA226.
  //
  // Note 1: all linear dimensions are in millimetres, anything in parentheses
  // is reference only. Notes 3 and 4 exclude mould flash and interlead flash
  // from the body dimensions, so these are the body proper.
  DGS0010A: {
    packageType: "VSSOP (10)",
    // NOT plain "ADS1115". That datasheet prints this drawing AND a 2.0 x 1.5 x
    // 0.4mm one, and the unhinted reading takes the other; listing it here
    // reported six correct values as wrong. `parts` is a hand-CONFIRMED list,
    // and the honest content of it is the readings actually confirmed to come
    // off this drawing. The height veto in `outlineFor` cannot save it because
    // the page that reading cites states no height in its title block.
    parts: ["ADS1115_VSSOP__DGS_", "INA226"],
    source: "ADS1115 datasheet, page 51, PACKAGE OUTLINE DGS0010A, rev 4221984/A 05/2015",
    leadForm: "gullwing",
    // 10X 0.27 / 0.17.
    leadWidthMm: { minMm: 0.17, maxMm: 0.27 },
    // DETAIL A, the seated foot: 0.7 / 0.4.
    leadContactMm: { minMm: 0.4, maxMm: 0.7 },
    // 8X 0.5, eight gaps across ten leads, five a side.
    pitchMm: 0.5,
    // 5.05 / 4.75 TYP, toe to toe.
    leadSpanMm: { minMm: 4.75, maxMm: 5.05 },
    // 3.1 / 2.9 on both axes: this body is square, which is why the two are
    // transcribed identically rather than one of them being a copy of a
    // misread.
    bodyLengthMm: { minMm: 2.9, maxMm: 3.1 },
    bodyWidthMm: { minMm: 2.9, maxMm: 3.1 },
    // Title block "VSSOP - 1.1 mm max height", and the side view agrees at
    // "1.1 MAX". Reference JEDEC MO-187 variation BA.
    bodyHeightMaxMm: 1.1,
    leadSides: 2
  },
  // THE SECOND CERAMIC FLATPACK IN THE SAME DATASHEET, hand-read off the
  // rendered page 29 on 2026-08-20. TPS7A4501-SP is offered in both this and
  // `U0010A`, and they are different packages: 2.63mm max height against 2.03,
  // a metal lid and a back-side thermal pad against neither.
  //
  // Added because the bench was scoring a CORRECT reading of THIS drawing as a
  // wrong reading of the other one. `parts` alone cannot separate two outlines
  // in one document; see `outlineFor` in `dimensions.ts`, which now picks
  // between them by the height the cited page prints.
  //
  // Note 1: all linear dimensions are in millimetres, and anything in
  // parentheses is REFERENCE ONLY - so (6.248), (4.3), (4.7), (6.62) and (7.02)
  // are deliberately not transcribed.
  HKU0010A: {
    packageType: "CFP (10)",
    parts: ["TPS7A4501-SP"],
    source: "TPS7A4501-SP datasheet, page 29, PACKAGE OUTLINE HKU0010A, rev 4226200/A 09/2020",
    // Leads leave the body flat and unformed, as on U0010A.
    leadForm: "straight",
    // 10X 0.48 / 0.38.
    leadWidthMm: { minMm: 0.38, maxMm: 0.48 },
    // 8X 1.27, eight gaps across ten leads, five a side.
    pitchMm: 1.27,
    // The title block reads "CFP - 2.63mm max height". The side view dimensions
    // the same envelope as "2.62 MAX"; both are transcribed as printed and the
    // title block is the one taken, because that is the figure the field asks
    // for and the one the reader is pointed at.
    bodyHeightMaxMm: 2.63,
    leadSides: 2
  },
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
  },

  // ON Semiconductor's SOIC-8, and the one non-TI, non-ADI vendor drawing in
  // this file. Dimensioned as a LETTERED TABLE (A, B, C, D, G, ...) rather than
  // with the callouts laid on the views, which is the shape most of this corpus
  // does not have. Read off the rendered page 2026-08-20.
  "751-07": {
    packageType: "SOIC-8 NB",
    parts: ["NCP1200"],
    source: "NCP1200 datasheet, page 16, PACKAGE DIMENSIONS SOIC-8 NB CASE 751-07 ISSUE AK",
    leadForm: "gullwing",
    // Table row S, 5.80 to 6.20.
    leadSpanMm: { minMm: 5.8, maxMm: 6.2 },
    // Table row D, 0.33 to 0.51.
    leadWidthMm: { minMm: 0.33, maxMm: 0.51 },
    // Table row K, 0.40 to 1.27.
    leadContactMm: { minMm: 0.4, maxMm: 1.27 },
    // Table row G, 1.27 BSC.
    pitchMm: 1.27,
    // Table row A, 4.80 to 5.00.
    bodyLengthMm: { minMm: 4.8, maxMm: 5.0 },
    // Table row B, 3.80 to 4.00.
    bodyWidthMm: { minMm: 3.8, maxMm: 4.0 },
    // Table row C, 1.35 to 1.75. The seated envelope is the maximum.
    bodyHeightMaxMm: 1.75,
    leadSides: 2,
    land: {
      // The drawing prints SOLDERING FOOTPRINT as an OUTER and an INNER span
      // (7.0 and 4.0) rather than a centre distance, so both the pad length and
      // the centre span are derived from that pair: length (7.0 - 4.0) / 2, and
      // centre (7.0 + 4.0) / 2. The printed 1.52 confirms the length
      // independently, which is why this entry is safe to assert.
      source: "NCP1200 datasheet, page 16, SOLDERING FOOTPRINT, SCALE 6:1",
      padLengthMm: 1.52,
      padWidthMm: 0.6,
      spanMm: 5.5
    }
  },

  // A ceramic dual flatpack with STRAIGHT leads, and the smallest one here.
  //
  // Carries no `leadContactMm` for the documented reason: the leads leave the
  // body straight and the drawing prints no seated foot, because the assembler
  // forms them. That absence is an assertion that a person looked, not a gap.
  HKJ: {
    packageType: "CFP (8)",
    parts: ["REF5025"],
    source: "REF5025 datasheet, page 27, MECHANICAL DATA HKJ (R-CDFP-F8), rev 4209892/A 10/08",
    leadForm: "straight",
    // 0.370 (9,40) / 0.250 (6,35), lead tip to lead tip across the top view.
    leadSpanMm: { minMm: 6.35, maxMm: 9.4 },
    // 0.021 (0,53) / 0.015 (0,38).
    leadWidthMm: { minMm: 0.38, maxMm: 0.53 },
    // i0.050 (1,27)a.
    pitchMm: 1.27,
    // 0.289 (7,34) / 0.265 (6,73), along the axis the two lead rows run.
    bodyLengthMm: { minMm: 6.73, maxMm: 7.34 },
    // 0.232 (5,89) / 0.212 (5,61), across that axis.
    bodyWidthMm: { minMm: 5.61, maxMm: 5.89 },
    // 0.078 (1,98) / 0.052 (1,32) on the side view, lid included.
    bodyHeightMaxMm: 1.98,
    leadSides: 2
  },

  // Renesas, and the only QFP in this file. Added 2026-08-20 specifically
  // because ISL71001M SHIPS a bundle today and its drawing had never been
  // checked by hand.
  //
  // IT CAUGHT ONE. Every other value below matches what the reader returned; the
  // body height does not. The drawing's side view prints `1.20 Max` and the
  // reader returned 1.00, which is the `1.00 +/- 0.05` printed in Detail A as
  // the lead's height above the seating plane. Two heights on one page, and the
  // wrong one was taken. It is not copper, but it is the height the exported
  // STEP solid is built to, so a mechanical clearance check against the bundle
  // is 0.2 mm short.
  //
  // `statedMaxHeightMm` does not catch it: this title block says
  // "10.0 x 10.0 x 1.2 mm Body", not "1.2mm max height", and that phrasing
  // appears in exactly ONE of the 55 cached datasheets, so it is a one-off
  // rather than a rule worth keying on.
  "Q64.10x10J": {
    packageType: "64-QFP",
    parts: ["ISL71001M"],
    source: "ISL71001M datasheet, page 36, Package Outline Drawing Q64.10x10J / PT0064AA, Rev01 Apr 1 2025",
    leadForm: "gullwing",
    // 12.00 +/- 0.10, both axes: this quad is square, so there is no cross span.
    leadSpanMm: { minMm: 11.9, maxMm: 12.1 },
    // 0.22 +/- 0.05 on the top view.
    leadWidthMm: { minMm: 0.17, maxMm: 0.27 },
    // Detail A, 0.60 +/- 0.15, measured at the gauge plane per note 4.
    leadContactMm: { minMm: 0.45, maxMm: 0.75 },
    pitchMm: 0.5,
    // 10.00 +/- 0.10, both axes.
    bodyLengthMm: { minMm: 9.9, maxMm: 10.1 },
    bodyWidthMm: { minMm: 9.9, maxMm: 10.1 },
    // Side view, `1.20 Max`, and confirmed by the title block's
    // "10.0 x 10.0 x 1.2 mm Body".
    bodyHeightMaxMm: 1.2,
    leadSides: 4,
    land: {
      // Recommended Land Pattern prints 12.60 outer and 10.20 inner, so the pad
      // length is (12.60 - 10.20) / 2 = 1.20, which the drawing also labels
      // directly, and the centre span is (12.60 + 10.20) / 2 = 11.40.
      source: "ISL71001M datasheet, page 36, Recommended Land Pattern (PCB Top View, SMD Design)",
      padLengthMm: 1.2,
      padWidthMm: 0.3,
      spanMm: 11.4
    }
  },

  // Analog Devices' 14-terminal LGA, and the entry that caught the worst defect
  // found on 2026-08-20. ADXL345 SHIPS four files today and its land is wrong.
  //
  // Figure 59 dimensions the pattern as an OUTER extent and an INNER gap, the
  // same shape NCP1200's SOLDERING FOOTPRINT uses: 3.3400 across the whole
  // pattern and 1.0500 between the two columns, so each pad is
  // (3.3400 - 1.0500) / 2 = 1.1450 long and the centre span is
  // (3.3400 + 1.0500) / 2 = 2.1950. The drawing labels 1.1450 directly, which
  // confirms both independently.
  //
  // The reader returned `1.05` for the pad and `2.29` for the span: it took the
  // INNER GAP as the pad length, then doubled the real pad length to get a span.
  // Both wrong numbers reproduce the correct 3.34 outer envelope, which is why
  // no plausibility guard catches this and why only a hand read could.
  //
  // `bench:copper` reports no disagreement here and is right to: the copper
  // faithfully reproduces the record. The record is what is wrong.
  //
  // These same values are already written down in `ipc7351.ts`, in the comment
  // recording why no-lead has no computed route ("ADI CC-14-1 1.145 x 0.550
  // @2.195"). A person read this drawing correctly months ago and the live
  // record disagreed with that comment the whole time, unmeasured.
  "CC-14-1": {
    packageType: "14-Terminal LGA",
    parts: ["ADXL345"],
    source: "ADXL345 datasheet, page 37, Figure 61, 14-Terminal Land Grid Array [LGA] (CC-14-1)",
    leadForm: "nolead",
    // 0.813 x 0.50 on the bottom view. The 0.50 is the terminal across the axis
    // the two columns run, which is what the land is widened from.
    leadWidthMm: { minMm: 0.5, maxMm: 0.5 },
    // 0.80 BSC.
    pitchMm: 0.8,
    // 5.00 BSC, along the axis the two terminal columns run.
    bodyLengthMm: { minMm: 5.0, maxMm: 5.0 },
    // 3.00 BSC, across that axis.
    bodyWidthMm: { minMm: 3.0, maxMm: 3.0 },
    // END VIEW prints 1.00 / 0.95 / 0.85 as max / nom / min.
    bodyHeightMaxMm: 1.0,
    // `leadSides` IS DELIBERATELY ABSENT, and this is the interesting part.
    //
    // The obvious read is 2: Figure 59 draws a column of six pads on the left
    // and six on the right. But terminals 7 and 14 sit alone at the centre of
    // the bottom and top edges, on the other two sides, and the land pattern
    // draws a pad for each. So six-per-side-times-two is 12, not 14, and the
    // package is neither a two-row part nor a uniform quad.
    //
    // The record answers 4. Asserting 2 here would have marked that WRONG on
    // the strength of my glance at two columns, which is exactly the guess this
    // file's header forbids. Where a hand read does not settle a value, the key
    // is left out: absence means a person looked and the drawing does not say,
    // which is worth more than a confident wrong expectation.
    land: {
      source: "ADXL345 datasheet, page 36, Figure 59, Recommended Printed Wiring Board Land Pattern",
      padLengthMm: 1.145,
      padWidthMm: 0.55,
      spanMm: 2.195
    }
  },

  // ST's LQFP100, and the first LQFP in this file. Read off two rendered pages
  // on 2026-08-21: Table 93 for the package, Figure 78 for the footprint.
  //
  // Worth having because LQFP is the largest family in the corpus by part count
  // and had no hand-read entry at all, and because this drawing dimensions its
  // footprint the way NCP1200 and ISL71001M do - an OUTER extent and an INNER
  // one, with the centre span implied rather than printed:
  //
  //     outer 16.7, pad length 1.2  ->  inner 16.7 - 2(1.2) = 14.3, which the
  //     drawing also prints, confirming both
  //     centre span 16.7 - 1.2 = 15.5
  //
  // The third figure on that page, 12.3, is the pad ROW: twenty-five lands at
  // 0.5 pitch is 12.0 between centres, plus one 0.3 land. It is not a span and
  // is recorded here only so the next person does not read it as one.
  "1L": {
    packageType: "LQFP100",
    parts: ["STM32F407VG"],
    source: "STM32F407VG datasheet, page 173, Table 93 LQFP100 mechanical data, and page 174, Figure 78 footprint example",
    leadForm: "gullwing",
    // D and E, 16.00 BSC. Square, so there is no cross span to record.
    leadSpanMm: { minMm: 16.0, maxMm: 16.0 },
    // b, 0.17 / 0.22 / 0.27.
    leadWidthMm: { minMm: 0.17, maxMm: 0.27 },
    // L, 0.45 / 0.60 / 0.75.
    leadContactMm: { minMm: 0.45, maxMm: 0.75 },
    // e, 0.50 BSC.
    pitchMm: 0.5,
    // D1 and E1, 14.00 BSC.
    bodyLengthMm: { minMm: 14.0, maxMm: 14.0 },
    bodyWidthMm: { minMm: 14.0, maxMm: 14.0 },
    // A, 1.50 typ / 1.60 max. The seated envelope is the maximum; A2 (1.35 to
    // 1.45) is the plastic body alone and is NOT what the 3D solid stands on.
    bodyHeightMaxMm: 1.6,
    leadSides: 4,
    land: {
      source: "STM32F407VG datasheet, page 174, Figure 78, LQFP100 footprint example (1L_LQFP100_FP_V1)",
      padLengthMm: 1.2,
      padWidthMm: 0.3,
      spanMm: 15.5
    }
  },

  // ST's LQFP144, the second LQFP and the largest package in this file.
  //
  // Kept alongside `1L` rather than folded into it, because the two are the same
  // FAMILY and different DRAWINGS: 22.00 against 16.00 across the leads, 144
  // leads against 100. That is exactly the distinction `sameOutlineCode` refuses
  // to blur, and having both here is what proves the reader is reading each
  // drawing rather than recognising "an ST LQFP".
  //
  // Same outer/inner footprint convention as `1L`, confirmed the same way:
  // 22.60 outer, 1.35 land, so 22.60 - 2(1.35) = 19.90 inner, which the drawing
  // also prints, and a centre span of 22.60 - 1.35 = 21.25.
  //
  // The 17.85 on that figure is the pad ROW, not a span: thirty-six lands at
  // 0.5 pitch is 17.5 between centres plus one 0.35 land.
  "1A": {
    packageType: "LQFP144",
    parts: ["STM32H743ZI"],
    source: "STM32H743ZI datasheet, page 325, Table 211 LQFP144 mechanical data, and page 327, Figure 121 footprint example",
    leadForm: "gullwing",
    // D and E, 22.00 BSC. Square.
    leadSpanMm: { minMm: 22.0, maxMm: 22.0 },
    // b, 0.17 / 0.22 / 0.27.
    leadWidthMm: { minMm: 0.17, maxMm: 0.27 },
    // L, 0.45 / 0.60 / 0.75.
    leadContactMm: { minMm: 0.45, maxMm: 0.75 },
    pitchMm: 0.5,
    // D1 and E1, 20.00 BSC.
    bodyLengthMm: { minMm: 20.0, maxMm: 20.0 },
    bodyWidthMm: { minMm: 20.0, maxMm: 20.0 },
    // A, max 1.60. This table prints no typ for A at all, only the maximum,
    // which is the seated envelope. A2 is the plastic body and is not it.
    bodyHeightMaxMm: 1.6,
    leadSides: 4,
    land: {
      source: "STM32H743ZI datasheet, page 327, Figure 121, LQFP144 footprint example (1A_LQFP144_FP)",
      padLengthMm: 1.35,
      padWidthMm: 0.35,
      spanMm: 21.25
    }
  }
};
