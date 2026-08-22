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
  // TI's WIDE-BODY SOIC-16. Read 2026-08-22 off MAX232 pages 23 and 24.
  //
  // Worth having next to D0008A and D0014A because it is the same family name
  // and a completely different size: 7.4-7.6 body against 3.81-3.98, a 10.63
  // span against 6.19, 2 mm lands on a 9.3 centre span. "SOIC" settles nothing
  // about geometry, which is why this file is keyed on the drawing code.
  DW0016A: {
    packageType: "SOIC (16), wide body",
    // MAX232 and PCF8574 both print this drawing and both offer several
    // packages, so no part is claimed. Matched on the outline code.
    parts: [],
    source: "MAX232 datasheet, page 23, PACKAGE OUTLINE DW0016A, rev 4220721/A 07/2016",
    leadForm: "gullwing",
    // 10.63 over 9.97, marked TYP.
    leadSpanMm: { minMm: 9.97, maxMm: 10.63 },
    // 16X 0.51 over 0.31.
    leadWidthMm: { minMm: 0.31, maxMm: 0.51 },
    // 1.27 over 0.40 on DETAIL A, the seated foot.
    leadContactMm: { minMm: 0.4, maxMm: 1.27 },
    pitchMm: 1.27,
    // 10.5 over 10.1, NOTE 3: excludes mold flash.
    bodyLengthMm: { minMm: 10.1, maxMm: 10.5 },
    // 7.6 over 7.4, NOTE 4: excludes interlead flash.
    bodyWidthMm: { minMm: 7.4, maxMm: 7.6 },
    bodyHeightMaxMm: 2.65,
    leadSides: 2,
    jedecOutline: "MS-013",
    land: {
      source: "MAX232 datasheet, page 24, LAND PATTERN EXAMPLE DW0016A",
      padLengthMm: 2.0,
      padWidthMm: 0.6,
      // (9.3) between the two pad-column centrelines.
      spanMm: 9.3,
      // 0.07 MAX all around non-solder-mask-defined, 0.07 MIN all around
      // solder-mask-defined. Neither marked preferred on this revision.
      solderMaskExpansionMm: 0.07
    }
  },

  // TI's PowerPAD HVSSOP-8. Read 2026-08-22 off UCC27524 pages 43 and 44.
  //
  // DGK0008A above with a thermal pad added, and the lead geometry is identical
  // to the millimetre: same 5.05/4.75 span, same 0.38/0.25 width, same 0.7/0.4
  // foot, same 1.4 x 0.45 lands on a 4.4 centre span. Two drawings read
  // independently on different days agreeing is worth more than either alone.
  DGN0008G: {
    packageType: "PowerPAD HVSSOP (8)",
    // UCC27524 offers this drawing AND its sibling DGN0008H under one caption
    // ("HVSSOP (DGN)"), which is the collision `packageOptions` disambiguates by
    // appending the outline code. Which one a record settles on is therefore not
    // decidable from here, so no part is claimed.
    parts: [],
    source: "UCC27524 datasheet, page 43, PACKAGE OUTLINE DGN0008G, rev 4225480/C 11/2024",
    leadForm: "gullwing",
    // 5.05 over 4.75, marked TYP.
    leadSpanMm: { minMm: 4.75, maxMm: 5.05 },
    leadWidthMm: { minMm: 0.25, maxMm: 0.38 },
    // 0.7 over 0.4 on DETAIL A.
    leadContactMm: { minMm: 0.4, maxMm: 0.7 },
    pitchMm: 0.65,
    // 3.1 over 2.9 on both axes, NOTE 3 along the rows and NOTE 4 across them.
    bodyLengthMm: { minMm: 2.9, maxMm: 3.1 },
    bodyWidthMm: { minMm: 2.9, maxMm: 3.1 },
    bodyHeightMaxMm: 1.1,
    // Bottom view: 2.15/1.95 along the row axis, 1.846/1.646 across it.
    thermalPadLengthMm: { minMm: 1.95, maxMm: 2.15 },
    thermalPadWidthMm: { minMm: 1.646, maxMm: 1.846 },
    leadSides: 2,
    jedecOutline: "MO-187",
    land: {
      source: "UCC27524 datasheet, page 44, LAND PATTERN EXAMPLE DGN0008G",
      padLengthMm: 1.4,
      padWidthMm: 0.45,
      // (4.4) between the two pad-column centrelines, the same span DGK0008A
      // prints: a thermal pad changes what sits BETWEEN the rows, not where the
      // rows sit.
      spanMm: 4.4,
      // 0.05 MAX all around non-solder-mask-defined, marked PREFERRED. The
      // THERMAL land is separately drawn as a solder-mask-defined pad with its
      // own opening, so this figure is the signal pads' and is recorded as such.
      solderMaskExpansionMm: 0.05
    }
  },

  // Analog Devices' 24-lead side-solderable QFN, 3 x 5 mm. Read 2026-08-22 off
  // LTC6563 page 33.
  //
  // HERE TO TEST A HYPOTHESIS, AND IT FAILED IT. Three parts misread their land
  // span on 2026-08-21 and all three carried an exposed thermal pad, so the
  // guess was that a crowded exposed-pad figure is what defeats the reader. This
  // is an exposed-pad QFN whose figure is MORE awkward than any of them - it
  // prints an OUTER extent and an INNER gap and never states the centre distance
  // at all, so the answer has to be derived:
  //
  //     5.50 outer, 4.10 inner  ->  centre 4.80
  //     3.50 outer, 2.10 inner  ->  centre 2.80
  //
  // The reader gets 4.80 right. So "exposed pad" is not the class, and neither is
  // "outer-and-inner figure" - ADXL345 is drawn the same way and also reads
  // correctly now. Recorded so nobody re-runs this guess.
  //
  // Not a JEDEC outline: note 1 on the drawing says so outright, so no
  // `jedecOutline` is claimed.
  "05-08-1795": {
    packageType: "UDDM QFN (24)",
    // The only package this datasheet offers.
    parts: ["LTC6563"],
    source: "LTC6563 datasheet, page 33, PACKAGE DESCRIPTION, LTC DWG 05-08-1795 Rev 0",
    leadForm: "nolead",
    // NO `leadSpanMm`. The terminals are flush with the body on a no-lead
    // package and this drawing prints no tip-to-tip dimension; the body is
    // recorded below instead.
    //
    // 0.25 +/- 0.05, the terminal across the row.
    leadWidthMm: { minMm: 0.2, maxMm: 0.3 },
    // DETAIL A prints TERMINAL LENGTH 0.40 +/- 0.10 outright.
    leadContactMm: { minMm: 0.3, maxMm: 0.5 },
    pitchMm: 0.5,
    // 5.00 +/- 0.10 is the axis the land's 4.80 centre span runs along, and
    // 3.00 +/- 0.10 is across it. Paired that way rather than by which number is
    // bigger, so the entry and the land block describe the same axis.
    bodyLengthMm: { minMm: 4.9, maxMm: 5.1 },
    bodyWidthMm: { minMm: 2.9, maxMm: 3.1 },
    // 0.75 +/- 0.05.
    bodyHeightMm: { minMm: 0.7, maxMm: 0.8 },
    // 3.65 +/- 0.10 along the 5 mm axis, 1.65 +/- 0.10 across it.
    thermalPadLengthMm: { minMm: 3.55, maxMm: 3.75 },
    thermalPadWidthMm: { minMm: 1.55, maxMm: 1.75 },
    leadSides: 4,
    land: {
      source: "LTC6563 datasheet, page 33, RECOMMENDED SOLDER PAD PITCH AND DIMENSIONS",
      padLengthMm: 0.7,
      padWidthMm: 0.25,
      // DERIVED, and the derivation is the point: this figure states 5.50 outer
      // and 4.10 inner and no centre distance, so the centre is their mean.
      // (5.50 + 4.10) / 2 = 4.80, which is also 5.50 - 0.70.
      spanMm: 4.8,
      // The other axis, by the same arithmetic: (3.50 + 2.10) / 2 = 2.80.
      spanCrossMm: 2.8,
      // NO `solderMaskExpansionMm`. The figure says only "APPLY SOLDER MASK TO
      // AREAS THAT ARE NOT SOLDERED" and prints no clearance. Absent because a
      // person looked and the drawing is silent.
    }
  },

  // TI's SC-70 5-lead. Read 2026-08-21 off OPA333 pages 37 and 38, rendered.
  //
  // The SMALLEST package in this file, and it is here for that reason: every
  // dimension is under a millimetre and a decimal point read wrongly is a
  // footprint nobody can hand-solder. Same axis convention as DBV0005A above -
  // the rows run vertically, so the horizontal 2.4/1.8 is the LEAD SPAN and the
  // horizontal 1.4/1.1 across the body alone is the body WIDTH.
  DCK0005A: {
    packageType: "SC-70 (5)",
    // OPA333, SN74LVC1G08 and TLV9061 all print this drawing and all offer
    // several packages, so no part is claimed. Matched on the outline code.
    parts: [],
    source: "OPA333 datasheet, page 37, PACKAGE OUTLINE DCK0005A, rev 4214834/G 11/2024",
    leadForm: "gullwing",
    leadSpanMm: { minMm: 1.8, maxMm: 2.4 },
    // 5X 0.33 over 0.15. NOTE 5 on the drawing says this width does not comply
    // with JEDEC, which is the vendor's own warning and is recorded as read.
    leadWidthMm: { minMm: 0.15, maxMm: 0.33 },
    // 0.46 over 0.26 TYP on the side view, the seated foot.
    leadContactMm: { minMm: 0.26, maxMm: 0.46 },
    // 2X 0.65. Five leads in a six-position grid, so one position is empty.
    pitchMm: 0.65,
    bodyLengthMm: { minMm: 1.85, maxMm: 2.15 },
    bodyWidthMm: { minMm: 1.1, maxMm: 1.4 },
    bodyHeightMaxMm: 1.1,
    leadSides: 2,
    jedecOutline: "MO-203",
    land: {
      source: "OPA333 datasheet, page 38, LAND PATTERN EXAMPLE DCK0005A",
      padLengthMm: 0.95,
      padWidthMm: 0.4,
      // (2.2) between the two pad-column centrelines.
      spanMm: 2.2,
      // 0.07 MAX all around non-solder-mask-defined, marked PREFERRED, and
      // 0.07 MIN all around solder-mask-defined.
      solderMaskExpansionMm: 0.07
    }
  },

  // TI's TSSOP-14. Read 2026-08-21 off OPA2189 pages 52 and 53, rendered.
  //
  // Its land is IDENTICAL to PW0008A's below - 1.5 x 0.45 lands on a 5.8 centre
  // span - which is right and worth stating: the two packages differ in lead
  // COUNT and body length, not in lead span or land geometry. Two entries read
  // independently off two drawings agreeing is the cheapest confirmation this
  // file can produce.
  //
  // The lead span is printed as the same stacked "6.6 over 6.2 TYP" pair that
  // PWP0028C carries, and PWP0028C is the entry the reader collapses to 6.6-6.6.
  // Reading this one is what makes that a class rather than a one-off.
  PW0014A: {
    packageType: "TSSOP (14)",
    // OPA2189, TLV9061 and TXB0104 all print this drawing and all offer several
    // packages, so no part is claimed. Matched on the outline code.
    parts: [],
    source: "OPA2189 datasheet, page 52, PACKAGE OUTLINE PW0014A, rev 4220202/B 12/2023",
    leadForm: "gullwing",
    leadSpanMm: { minMm: 6.2, maxMm: 6.6 },
    // 14X 0.30 over 0.17.
    leadWidthMm: { minMm: 0.17, maxMm: 0.3 },
    // 0.75 over 0.50 on DETAIL A, the seated foot.
    leadContactMm: { minMm: 0.5, maxMm: 0.75 },
    pitchMm: 0.65,
    // 5.1 over 4.9, NOTE 3: excludes mold flash.
    bodyLengthMm: { minMm: 4.9, maxMm: 5.1 },
    // 4.5 over 4.3, NOTE 4: excludes interlead flash.
    bodyWidthMm: { minMm: 4.3, maxMm: 4.5 },
    bodyHeightMaxMm: 1.2,
    leadSides: 2,
    jedecOutline: "MO-153",
    land: {
      source: "OPA2189 datasheet, page 53, LAND PATTERN EXAMPLE PW0014A",
      padLengthMm: 1.5,
      padWidthMm: 0.45,
      // (5.8) between the two pad-column centrelines.
      spanMm: 5.8,
      // 0.05 MAX all around non-solder-mask-defined, marked PREFERRED, and
      // 0.05 MIN all around solder-mask-defined.
      solderMaskExpansionMm: 0.05
    }
  },

  // TI's 20-terminal VQFN with an exposed pad. Read 2026-08-21 off TPS7A4700
  // pages 29 and 30, rendered, the day that datasheet was fetched correctly for
  // the first time.
  //
  // ADDED BECAUSE IT SHIPS AND WAS UNCHECKED, and the read is WRONG. The record
  // carries `landSpanMm: 3.9`, which is 4.65 less the 0.75 pad length: the reader
  // took the printed (4.65) as an OUTER extent and subtracted a pad. It is not an
  // outer extent. The (4.65) extension lines drop from the two pad-column
  // CENTRELINES, and the same drawing dimensions its 5-pad row as (2.6) - four
  // 0.65 pitches between outermost pad CENTRES - so the convention is
  // centre-to-centre throughout.
  //
  // The geometry settles it independently: at a 3.9 centre span a 0.75 land ends
  // 0.175 mm INSIDE the 5.0 mm body edge, so it would not reach the terminal it
  // is meant to solder. At 4.65 it overhangs the body edge by 0.2 mm, which is
  // the ordinary toe extension.
  //
  // SAME SHAPE AS ADXL345: a figure dimensioned as an extent misread as a span,
  // where both readings stay plausible on their own. Third instance of it.
  RGW0020A: {
    packageType: "VQFN (20)",
    // The only package this datasheet offers.
    parts: ["TPS7A4700"],
    source: "TPS7A4700 datasheet, page 29, PACKAGE OUTLINE RGW0020A, rev 4219039/A 06/2018",
    leadForm: "nolead",
    // NO `leadSpanMm`. A no-lead package's terminals are flush with the body, so
    // the drawing prints a body dimension and no tip-to-tip span. 5.1/4.9 is the
    // BODY, recorded below as such.
    //
    // 20X 0.36 over 0.26, the terminal across the row.
    leadWidthMm: { minMm: 0.26, maxMm: 0.36 },
    // 20X 0.65 over 0.45, the terminal along the outward axis. This is the
    // no-lead equivalent of dimension L and is what the land is built from.
    leadContactMm: { minMm: 0.45, maxMm: 0.65 },
    pitchMm: 0.65,
    // 5.1 over 4.9 on BOTH axes. A square package, so both keys carry it.
    bodyLengthMm: { minMm: 4.9, maxMm: 5.1 },
    bodyWidthMm: { minMm: 4.9, maxMm: 5.1 },
    bodyHeightMaxMm: 1.0,
    // Square 3.15 +/- 0.1, the exposed pad on the underside.
    thermalPadLengthMm: { minMm: 3.05, maxMm: 3.25 },
    thermalPadWidthMm: { minMm: 3.05, maxMm: 3.25 },
    leadSides: 4,
    land: {
      source: "TPS7A4700 datasheet, page 30, LAND PATTERN EXAMPLE RGW0020A",
      padLengthMm: 0.75,
      padWidthMm: 0.31,
      // (4.65), centre to centre. See the note above; the record says 3.9.
      spanMm: 4.65,
      // 0.07 MAX all around on the non-solder-mask-defined detail, marked
      // PREFERRED, and 0.07 MIN on the other.
      solderMaskExpansionMm: 0.07
    }
  },

  // TI's SOT-23-5. Read 2026-08-21 off OPA333 pages 43 and 44, rendered.
  //
  // The axes are the trap on this drawing and are worth stating. The pin rows run
  // VERTICALLY (1,2,3 left and 5,4 right), so the horizontal 3.0/2.6 across the
  // whole top view is the LEAD SPAN, the horizontal 1.75/1.45 across the body
  // alone is the body WIDTH, and the vertical 3.05/2.75 marked A is the body
  // LENGTH. Reading the 3.0/2.6 as a body dimension is the obvious mistake and
  // would put the lands 0.4 mm out.
  DBV0005A: {
    packageType: "SOT-23 (5)",
    // Every corpus datasheet printing this drawing (OPA333, OPA2189, TLV9061,
    // SN74LVC1G08) offers several packages, so no part is claimed. Matched on the
    // outline code.
    parts: [],
    source: "OPA333 datasheet, page 43, PACKAGE OUTLINE DBV0005A, rev 4214839/K 08/2024",
    leadForm: "gullwing",
    leadSpanMm: { minMm: 2.6, maxMm: 3.0 },
    // 5X 0.5 over 0.3.
    leadWidthMm: { minMm: 0.3, maxMm: 0.5 },
    // 0.6 over 0.3 TYP on the side view, the seated foot.
    leadContactMm: { minMm: 0.3, maxMm: 0.6 },
    // 2X 0.95 between lead centres. Five leads in a six-position grid, so one
    // position is empty; which one is on the drawing but is not an oracle field.
    pitchMm: 0.95,
    bodyLengthMm: { minMm: 2.75, maxMm: 3.05 },
    bodyWidthMm: { minMm: 1.45, maxMm: 1.75 },
    // 1.45 over 0.90 on the side view. A RANGE, not a max-only drawing, even
    // though the title block says "1.45 mm max height": the drawing prints both
    // ends, so any value inside is a correct reading.
    bodyHeightMm: { minMm: 0.9, maxMm: 1.45 },
    leadSides: 2,
    jedecOutline: "MO-178",
    land: {
      source: "OPA333 datasheet, page 44, LAND PATTERN EXAMPLE DBV0005A",
      padLengthMm: 1.1,
      padWidthMm: 0.6,
      // (2.6) between the two pad-column centrelines.
      spanMm: 2.6,
      // 0.07 MAX all around on the non-solder-mask-defined detail, which this
      // drawing marks PREFERRED, and 0.07 MIN on the other.
      solderMaskExpansionMm: 0.07
    }
  },

  // TI's SOIC-14. Read 2026-08-21 off OPA2189 pages 49 and 50, rendered.
  //
  // Dimensioned in MILLIMETRES with no inch equivalents, which is the contrast
  // with D0008A above: same vendor, same family, same year range, and the other
  // way round on units. Anything that assumed one convention would get one of
  // these two wrong.
  D0014A: {
    packageType: "SOIC (14)",
    // No part claimed: every corpus datasheet printing this drawing (OPA2189,
    // OPA2277, TLV9061, TXB0104) offers several packages, and which one a record
    // settles on has not been hand-checked. Matched on the outline code instead.
    parts: [],
    source: "OPA2189 datasheet, page 49, PACKAGE OUTLINE D0014A, rev 4220718/A 09/2016",
    leadForm: "gullwing",
    // 6.2 over 5.8, marked TYP, across the leads.
    leadSpanMm: { minMm: 5.8, maxMm: 6.2 },
    // 14X 0.51 over 0.31.
    leadWidthMm: { minMm: 0.31, maxMm: 0.51 },
    // 1.27 over 0.40 on DETAIL A, the seated foot.
    leadContactMm: { minMm: 0.4, maxMm: 1.27 },
    pitchMm: 1.27,
    // 8.75 over 8.55, NOTE 3: excludes mold flash.
    bodyLengthMm: { minMm: 8.55, maxMm: 8.75 },
    // 4.0 over 3.8, NOTE 4: excludes interlead flash.
    bodyWidthMm: { minMm: 3.8, maxMm: 4.0 },
    bodyHeightMaxMm: 1.75,
    leadSides: 2,
    jedecOutline: "MS-012 AB",
    land: {
      source: "OPA2189 datasheet, page 50, LAND PATTERN EXAMPLE D0014A",
      padLengthMm: 1.55,
      padWidthMm: 0.6,
      // (5.4) between the two pad-column centrelines. The same span as D0008A,
      // which is right: the two packages differ in lead COUNT, not in lead span.
      spanMm: 5.4,
      // 0.07 MAX all around non-solder-mask-defined, 0.07 MIN all around
      // solder-mask-defined. Neither marked preferred on this revision.
      solderMaskExpansionMm: 0.07
    }
  },

  // TI's VSSOP-8 at 0.65 pitch. Read 2026-08-21 off LM358 pages 56 and 57.
  DGK0008A: {
    packageType: "VSSOP (8)",
    // Shared by LM358, OPA2189, OPA333 and TLV9061, all of which offer several
    // packages, so no part is claimed. Matched on the outline code.
    parts: [],
    source: "LM358 datasheet, page 56, PACKAGE OUTLINE DGK0008A, rev 4214862/A 04/2023",
    leadForm: "gullwing",
    // 5.05 over 4.75, marked TYP.
    leadSpanMm: { minMm: 4.75, maxMm: 5.05 },
    // 8X 0.38 over 0.25.
    leadWidthMm: { minMm: 0.25, maxMm: 0.38 },
    // 0.7 over 0.4 on DETAIL A.
    leadContactMm: { minMm: 0.4, maxMm: 0.7 },
    pitchMm: 0.65,
    // 3.1 over 2.9 on BOTH axes, NOTE 3 along the rows and NOTE 4 across them.
    // Recorded on both keys because the drawing prints both, not because one was
    // copied to the other.
    bodyLengthMm: { minMm: 2.9, maxMm: 3.1 },
    bodyWidthMm: { minMm: 2.9, maxMm: 3.1 },
    bodyHeightMaxMm: 1.1,
    leadSides: 2,
    jedecOutline: "MO-187",
    land: {
      source: "LM358 datasheet, page 57, LAND PATTERN EXAMPLE DGK0008A",
      padLengthMm: 1.4,
      padWidthMm: 0.45,
      // (4.4) between the two pad-column centrelines.
      spanMm: 4.4,
      // 0.05 MAX all around on the non-solder-mask-defined detail, which this
      // drawing marks PREFERRED, and 0.05 MIN on the other.
      solderMaskExpansionMm: 0.05
    }
  },

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
    // BOTH figures this drawing prints for the envelope, as a range.
    //
    // The title block reads "CFP - 2.63mm max height" and the side view
    // dimensions the same envelope as "2.62 MAX". This entry asserted 2.63
    // alone, and on 2026-08-21 the record read 2.62 and was marked WRONG for it.
    //
    // That is a false accusation, and this file's worst failure mode: 2.62 is
    // printed on the drawing, describes the same envelope, and differs by a
    // hundredth of a millimetre. A reader taking either has read the page
    // correctly. `bodyHeightMm` is the field for exactly this - "any value
    // inside is a correct reading" - and asserting one endpoint of a
    // disagreement the DRAWING contains sends someone to fix working code.
    //
    // Narrow on purpose: this relaxes an expectation where the document itself
    // states two values. It does not relax anything where the document states
    // one and the reader produced another.
    bodyHeightMm: { minMm: 2.62, maxMm: 2.63 },
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
    jedecOutline: "MS-026",
    land: {
      // Read 2026-08-21 off the rendered page. MSP430F5529 SHIPS from this
      // pattern and nothing checked it until now.
      source: "MSP430F5529 datasheet, page 142, LAND PATTERN EXAMPLE PN0080A, rev 4215166/A 08/2022",
      padLengthMm: 1.5,
      padWidthMm: 0.3,
      // (13.4) on BOTH axes, dimensioned between the opposing rows' pad
      // CENTRELINES. Square, so no `spanCrossMm`: the drawing prints one number
      // twice rather than two different ones.
      spanMm: 13.4,
      // 0.05 MAX all around non-solder-mask-defined, 0.05 MIN all around
      // solder-mask-defined. Neither marked preferred on this revision.
      solderMaskExpansionMm: 0.05
    }
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
    jedecOutline: "MS-012",
    land: {
      // Read 2026-08-21 off the rendered page. TPS54360 SHIPS from this pattern.
      source: "TPS54360 datasheet, page 48, LAND PATTERN EXAMPLE DDA0008B, rev 4214849/B 09/2025",
      padLengthMm: 1.55,
      padWidthMm: 0.6,
      // (5.4) between the two pad-column centrelines. The SAME span D0008A
      // prints, which is right: a PowerPAD SOIC-8 and a plain SOIC-8 differ in
      // what sits between the rows, not in where the rows sit.
      spanMm: 5.4,
      // 0.07 MAX / 0.07 MIN, labelled "PADS 1-8". The thermal land is separately
      // drawn as a SOLDER MASK DEFINED PAD with its own opening, which is why
      // that detail is scoped to the signal pads and is recorded as read.
      solderMaskExpansionMm: 0.07
    }
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
    // THE STANDING WRONG. The model reads this as 6.6-6.6, taking the top line of
    // the stacked "6.6 / 6.2 TYP" pair and dropping the bottom. Re-verified by
    // hand from the rendered page on 2026-08-21: the range is right and the read
    // is wrong. Costs 0.2mm of span, so 0.1mm per pad centre, and only where the
    // printed land pattern is unavailable - here it is rejected by the vendor
    // land guard because the same page's land span is misread too.
    //
    // MEASURED NEGATIVE, do not retry: refusing a degenerate range would fix this
    // and break four parts. Across every current-prompt cached answer, 7 spans
    // come back with minMm === maxMm and 6 of them are CORRECT - ST prints the
    // LQFP span as a single basic value, and this oracle itself records
    // `leadSpanMm: { 16.0, 16.0 }` for STM32F407VG and `{ 22.0, 22.0 }` for
    // STM32H743ZI, both hand-read. A degenerate range is a legitimate answer.
    // The defect is in which line of a stacked pair gets read, and no guard
    // downstream can see the pair.
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
    jedecOutline: "MO-153",
    land: {
      // Read 2026-08-21 off the rendered page. This is the check that would have
      // caught the defect above: the model reads this drawing's span as 4.3, and
      // 4.3 is what you get by subtracting the 1.5 pad length from the printed
      // 5.8 as though 5.8 were an outer-edge dimension. It is not - the (5.8)
      // extension lines drop from the two pad-column CENTRELINES, and 5.8 is also
      // what the package geometry gives (a 6.4 mid lead span less a ~0.6 foot).
      // The vendor land guard rejects the 4.3 and falls back to IPC-7351B, so no
      // wrong copper shipped, but nothing until now asserted which value is right.
      source: "DRV8825 datasheet, page 31, LAND PATTERN EXAMPLE PWP0028C, rev 4223582/A 03/2017",
      padLengthMm: 1.5,
      padWidthMm: 0.45,
      spanMm: 5.8,
      // 0.05 MAX all around non-solder-mask-defined, which this drawing marks
      // PREFERRED, and 0.05 MIN all around solder-mask-defined.
      solderMaskExpansionMm: 0.05
    }
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
  //
  // INDEPENDENTLY RE-READ 2026-08-21 off SN65HVD230 pages 40 and 41 without
  // looking at this entry first, and again off MC33063A pages 28 and 29. All
  // three datasheets print revision 4214825/C 02/2019 and every number matches.
  // That is the strongest evidence in this file that keying on the outline code
  // is sound: one drawing, three documents, no drift. It is also the most reused
  // drawing in the corpus - LM358, OPA333, UCC27524, OPA2189 and INA240 print it
  // too - so this one entry covers seven datasheets.
  //
  // The `land` block was added by that re-read. Until then this drawing's
  // recommended footprint, which is what the generator actually builds from for
  // every SOIC-8 here, had no check on it at all.
  D0008A: {
    packageType: "SOIC (8)",
    // Listed only where the datasheet offers this package ALONE, per the rule at
    // the top of this file. The other five offer several packages each, so which
    // one a given record settles on is not decidable from here; they are covered
    // by the outline-code match instead.
    parts: ["SN65HVD230", "MC33063A"],
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
    jedecOutline: "MS-012 AA",
    land: {
      source: "SN65HVD230 datasheet, page 41, LAND PATTERN EXAMPLE D0008A, and MC33063A page 29, identical",
      padLengthMm: 1.55,
      padWidthMm: 0.6,
      // (.213) [5.4], dimensioned between the two pad-column CENTRELINES rather
      // than across the outer edges. Confirmed against the package geometry: a
      // 6.0 mid lead span less a foot of roughly 0.6 puts the foot centres 5.4
      // apart, where an outer-edge reading would put them at 3.85.
      spanMm: 5.4,
      // .0028 MAX all around on the non-solder-mask-defined detail and .0028 MIN
      // on the solder-mask-defined one. Both are labelled, both read [0.07], and
      // neither is marked preferred on this revision.
      solderMaskExpansionMm: 0.07
    }
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
  // FIXED, and this entry is what proves it. `bench:dimensions` reads 1.145 and
  // 2.195 off the LIVE pipeline, matching this hand read exactly.
  //
  // Do not be misled by an ORACLE SPAN finding for this part. On 2026-08-22
  // `bench:copper` reported ADXL345 emitting 2.290 against a printed 2.195, and
  // it was the BENCH, not the part: that check ran on a replay record STITCHED
  // from two prompt versions, where three cached answers read this part
  // correctly and one stale one read 2.29 and happened to be newest, so it won
  // the field. `bench:copper` now skips the oracle comparison on any stitched
  // record. It lied in the direction that supported a change I already wanted to
  // make, which is the reason that correction is written down here.
  //
  // The reasoning below is kept in full because the 2026-08-20 read really was
  // wrong, and because it is what a hand read has to look like when two answers
  // both reproduce the same outer envelope.
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
  },

  // ST's SOT23-5, and the first entry here keyed by a name this file INVENTS
  // rather than by a vendor code.
  //
  // TSV321 SHIPS a bundle and was the one part the VERIFIED count could not
  // cover, because its drawing prints no code at all: Figure 19 is headed
  // "SOT23-5 package outline" and nothing else. Keying on the code alone would
  // leave every such drawing permanently unverifiable, which is a gap in this
  // file rather than a fact about the part. `outlineFor` already falls back to
  // the `parts` list, so a descriptive key plus an honest `parts` entry works.
  //
  // The key is prefixed to make clear it is not a code anyone will find on the
  // page. If ST ever prints one, this entry should be re-keyed to it.
  "ST-SOT23-5-DS4381": {
    packageType: "SOT23-5",
    parts: ["TSV321"],
    source: "TSV321 datasheet, page 10, Figure 19 and Table 5, SOT23-5 package mechanical data",
    leadForm: "gullwing",
    // E, 2.60 to 3.00, lead tip to lead tip across the top view.
    leadSpanMm: { minMm: 2.6, maxMm: 3.0 },
    // b, 0.35 to 0.50.
    leadWidthMm: { minMm: 0.35, maxMm: 0.5 },
    // L, 0.35 to 0.55.
    leadContactMm: { minMm: 0.35, maxMm: 0.55 },
    // e, 0.95 typ. e1 (1.9) is the span across two pitches on the three-lead
    // side and is NOT the pitch; taking it would double every pad spacing.
    pitchMm: 0.95,
    // D, 2.80 to 3.00, along the axis the lead rows run.
    bodyLengthMm: { minMm: 2.8, maxMm: 3.0 },
    // E1, 1.50 to 1.75. NOT E, which is the lead span, and the two differ by
    // more than a millimetre on this package.
    bodyWidthMm: { minMm: 1.5, maxMm: 1.75 },
    // A, 0.90 MIN to 1.45 MAX, so a RANGE and not `bodyHeightMaxMm`.
    //
    // Recorded as a max on the first attempt, which marked the record's 1.175
    // WRONG. 1.175 is the midpoint of 0.90 and 1.45 and is a correct reading of
    // a drawing that prints both ends; `bodyHeightMaxMm` is for the drawings
    // that print ONLY a maximum. Getting this wrong produces a false accusation
    // against working code, which is the one thing this file must never do.
    //
    // A2 (0.90 to 1.30) is the moulded body without the standoff A1 and is not
    // the seated envelope.
    bodyHeightMm: { minMm: 0.9, maxMm: 1.45 },
    // Three leads on one side and two on the other, so the short row leaves its
    // MIDDLE position empty. That asymmetry is `vacantLeadSlot` on the record;
    // this file has no key for it, so it is described rather than asserted.
    leadSides: 2
  },

  // ST's ceramic SO48, a 48-lead rad-hard flat pack. The largest lead count in
  // this file and squarely in this product's market.
  //
  // Two things on this drawing are easy to get wrong and the reader got both:
  //
  // The span is L (12.28 to 12.88), not E1 (10.90 typ). The side view stacks
  // four horizontal dimensions - E over the lid, E1, E2 and E3 in the middle,
  // and L across the bottom - and only L reaches lead tip to lead tip. E1 sits
  // between the body and the tips and taking it would pull both pad rows more
  // than 1.6 mm too far in. That E2 + 2(E3) = 6.35 + 3.30 = 9.65 = E is the
  // arithmetic that identifies E as the BODY and leaves L as the span.
  //
  // `leadContactMm` is ABSENT, and that is an assertion. These leads leave the
  // body straight and the drawing prints no seated foot, because the assembler
  // forms them - the same convention as HBH0014A and HKJ. The table's L is the
  // overall span here, NOT a foot length, which is the trap on this page.
  "ST-CERAMIC-SO48-DocID012585": {
    packageType: "Ceramic SO48",
    parts: ["RHF1201"],
    source: "RHF1201 datasheet, page 33, Figure 26 and Table 14, Ceramic SO48 mechanical data",
    leadForm: "straight",
    // L, 12.28 / 12.58 / 12.88.
    leadSpanMm: { minMm: 12.28, maxMm: 12.88 },
    // b, 0.20 / 0.254 / 0.30.
    leadWidthMm: { minMm: 0.2, maxMm: 0.3 },
    // e, 0.635 typ. Twenty-four leads a side across a 15.75 mm body.
    pitchMm: 0.635,
    // D, 15.57 / 15.75 / 15.92, along the axis the two lead rows run.
    bodyLengthMm: { minMm: 15.57, maxMm: 15.92 },
    // E, 9.52 / 9.65 / 9.78, across that axis.
    bodyWidthMm: { minMm: 9.52, maxMm: 9.78 },
    // A, 2.18 / 2.47 / 2.72, lid included.
    bodyHeightMaxMm: 2.72,
    leadSides: 2
  }
};
