/**
 * Every package a datasheet offers the part in, not just the first one found.
 *
 * ## Why this exists
 *
 * Two measured facts about the corpus, and one product decision that follows
 * from both.
 *
 * `packageType` was NULL on 15 of the 23 parts that could not export, which made
 * it the largest single upstream cause: variant selection, drawing confirmation
 * and land-pattern lookup all key off the designator, so one missing string
 * starves three readers at once. The cause was never that the documents are
 * silent. It was that the designator was only recognised in five printed forms,
 * and the ones that matter here are written differently: ST prints `SO48` and
 * `Flat-16P` glued together, Renesas prints `64 Ld EP-TQFP`, VORAGO prints
 * `176 CQFP` in an ordering table.
 *
 * The second fact is that most datasheets describe SEVERAL packages, and this is
 * now the largest remaining blocker: LD1117 covers four, PCF8574 two, AD8628
 * three, ADG5412 two, TSV911 six. Reporting one of them as "the" package is a
 * guess, and reporting none leaves the caller with nothing to choose from. So
 * this returns the LIST, and the caller decides: the product's own input model
 * budgets one click per part for exactly this, and `/api/export` already accepts
 * a `packageType` override.
 *
 * ## What makes a candidate
 *
 * A lead count must be attached. That is not a formality, it is the whole safety
 * argument: a bare family token is worthless evidence in these documents.
 * Measured over the corpus, `TO` appears 16 times in an AD590 and 14 in an
 * AD8232 (from `TOP VIEW` and prose), `SC` 262 times in an RTAX2000S, and `SO`
 * 24 times in an STM32H743ZI. A count is what turns a token into a designator,
 * and it is also the thing that can be CHECKED, against the pin count read off
 * the part's own pin table.
 *
 * Two families are deliberately absent from the vocabulary and each was a real
 * misread waiting to happen:
 *
 * - `SMD` is not a package in a rad-hard datasheet. It is the DLA Standard
 *   Microcircuit Drawing number, and ST prints it on every page of RHFL4913.
 * - `PGA` is a Programmable Gain Amplifier far more often than a Pin Grid Array.
 *   ADS1115 says it 19 times and is a VSSOP.
 */

/**
 * Package families, longest first so `TSSOP` is never read as `SSOP` and
 * `FLATPACK` never as `FLAT`.
 *
 * Not a complete list of packages in the world and it does not need to be: a
 * family that is not here yields no designator, which is the same honest silence
 * the reader already produces. It needs to cover what the corpus prints.
 */
const PACKAGE_FAMILIES = [
  // `HTSSOP` is TI's thermally enhanced TSSOP, the PowerPAD part of their power
  // catalogue, and it was the ONE family the corpus prints that this list did not
  // have. Found by auditing every package-declaring context in both caches for
  // tokens the vocabulary does not recognise; it is the only real hit, in DRV8825
  // and LM5117, both of which named no package at all as a result.
  //
  // It cannot be reached by `TSSOP`: that entry is `\bTSSOP\b` and the `H` in
  // front of it is a word character, so there is no boundary to match at. That is
  // the behaviour to WANT, not a limitation to route around. An HTSSOP-28 has a
  // 9.70 x 6.40 body and MO-153 AA is a 4.4 mm one, so handing it the TSSOP land
  // pattern would be this table's worst answer; a test pins that refusal.
  "HVSSOP", "HTSSOP", "FLATPACK", "MINISO", "DSBGA", "SBDIP", "VSSOP", "LFCSP", "X2SON",
  "TSSOP", "HTQFP", "CQFP", "PQFP", "TQFP", "LQFP", "VQFN", "WQFN", "UQFN",
  "CDIP", "PDIP", "GDIP", "LCCC", "CLCC", "PLCC", "FBGA", "CBGA", "TBGA",
  "WCSP", "MSOP", "SSOP", "TSOT", "USON", "VSON", "WSON", "SOIC", "FLAT",
  // `LGA` is the land grid array, and it was the second family the corpus prints
  // that this list did not have. Every MEMS sensor ships in one: a LIS3DH is an
  // LGA-16, an LSM6DSO an LGA-14, an ADXL345 an LGA-14. Missing it, those parts
  // named NO package at all, so nothing declared a lead count, so a pin table
  // that read perfectly had no second signal to corroborate it and the pin count
  // was refused. The list already carries BGA, CBGA, FBGA and TBGA; the land grid
  // array is the one array package it did not.
  //
  // Same rule as `HTSSOP` above, and it matters as much here: recognising a
  // family and CHARACTERISING it are separate acts. This entry lets a part say it
  // is an LGA-16. It hands LGA no land pattern, and it must not, because no LGA
  // drawing in this corpus has been read.
  "QFN", "QFP", "DFN", "BGA", "LGA", "SON", "SOP", "DIP", "CFP", "GFP", "LCC",
  "SOT", "SOD", "DPAK", "SO", "TO", "SC", "DO"
];

/**
 * Families whose trailing number is an OUTLINE code rather than a lead count.
 *
 * `SOT-23` is a body outline sold with 3, 5, 6 and 8 leads; `TO-220` is a
 * three-lead part; `SC70` counts nothing at all. Reading those numbers as lead
 * counts is how an LD1117 declared 220 pins and an RTAX2000S 883, so for these
 * the number is kept as part of the NAME and no count is claimed.
 */
const OUTLINE_NUMBERED = new Set(["TO", "SOT", "SC", "DO", "SOD", "DPAK"]);

/**
 * Families that are also ordinary English words or common abbreviations, and so
 * only count when printed in capitals as a designator is.
 *
 * `TO` is the worst of them: matched case-insensitively it turns `8 PINS To` into
 * a REF5025's package, `16-lead TSSOP to` into an ADC128S102QML-SP's, and `to
 * (5)` into an STM32H743ZI's. A vendor writing a package designator capitalises
 * it; a vendor writing the word "to" does not.
 */
const CAPITALS_ONLY = new Set(["TO", "SO", "SC", "DO"]);

/** Shortest lead count a glued designator may claim; see `MIN_GLUED_COUNT`. */
const MIN_GLUED_COUNT = 4;

/** Widest plausible lead count, matching the pin-table reader's own ceiling. */
const MAX_LEAD_COUNT = 600;

/** A package this document offers the part in. */
export interface PackageVariant {
  /** As printed, e.g. `16-Lead TSSOP`, `SO48`, `64 Ld EP-TQFP`. */
  designator: string;
  /** The recognised family token, uppercased. */
  family: string;
  /** Leads the designator declares, or null where the number is an outline. */
  leadCount: number | null;
  /** Offset into the document text, for the citation. */
  index: number;
  /** Found in the front matter, where a datasheet names its own package. */
  inFrontMatter: boolean;
}

const FAMILY_ALTERNATION = PACKAGE_FAMILIES.join("|");

const NAMES_A_FAMILY = new RegExp(`\\b(?:${FAMILY_ALTERNATION})\\b`, "i");

/**
 * Whether a designator names a package family at all.
 *
 * The check that separates a designator from a string merely SHAPED like one.
 * Without it an MSP430F5529 reported its package as `80-pin target`, off "80-pin
 * target development board", and an RTAX2000S as `STD-883`, off `MIL-STD-883B`.
 * Both are confidently wrong answers of exactly the kind a null is better than.
 */
export function namesPackageFamily(designator: string): boolean {
  return NAMES_A_FAMILY.test(designator);
}

/**
 * The printed forms, most constraining first.
 *
 * Each captures the count and the family in a fixed order, given per pattern
 * below, because the forms disagree about which comes first.
 */
interface DesignatorForm {
  pattern: RegExp;
  countGroup: number | null;
  familyGroup: number;
  /**
   * The qualifier this form allows between the count and the family, where it
   * allows one. Checked so it cannot BE a family: `16-lead TSSOP to` would
   * otherwise read as a TO package qualified "TSSOP", which is two designators
   * glued into one wrong one.
   */
  adjectiveGroup?: number;
  /** Glued forms claim a count with no keyword, so a small one is a footnote. */
  minCount?: number;
}

/**
 * A material qualifier a vendor prints ahead of the package designator.
 *
 * Kept because it is what the vendor PRINTED, and the designator travels into
 * the model's prompt, the package chooser and the footprint's own name. A
 * `Ceramic SO48` reduced to `SO48` reads as an ordinary plastic SO everywhere
 * downstream.
 *
 * It used to be justified by a guard in `packages.ts` that "refuses a ceramic
 * part the plastic JEDEC families by testing the designator string for this
 * word". That module was the hand-typed family table, deleted on 2026-08-14, and
 * nothing tests a designator for this word any more; lead form is read off the
 * drawing instead. The qualifier still earns its place, the guard it named does
 * not exist, and a comment that keeps naming it tells a reader they are
 * protected.
 */
const MATERIAL_QUALIFIER = /\b(ceramic|hermetic)\s+$/i;

/** The same words, tested anywhere in a designator already recorded. */
const MATERIAL_WORD = /\b(?:ceramic|hermetic)\b/i;

const FORMS: DesignatorForm[] = [
  // `16-Lead TSSOP`, `8-Pin SOIC`, `64 Ld EP-TQFP`, `16-Lead Ceramic SOIC`.
  //
  // One adjective is allowed between the count and the family and no more,
  // because the vendors that qualify a package qualify it with exactly one
  // (`Ceramic SOIC`, `Thin TQFP`). A wider window is how `64 Ld Thin Quad
  // Flatpack (EP-TQFP)` would come back as a FLATPACK, which is a ceramic
  // family, on a plastic part: the reach would find the loosest match rather
  // than the nearest, and the resulting land pattern would be confidently wrong
  // rather than absent. A short hyphenated prefix is allowed and kept, which is
  // what makes `EP-TQFP` read as a TQFP.
  {
    pattern: new RegExp(
      `\\b(\\d{1,3})[-\\s](?:lead|pin|ld)s?\\.?\\s+(?:([A-Za-z]{3,9})\\s+)?(?:[A-Za-z]{1,3}-)?(${FAMILY_ALTERNATION})\\b`,
      "gi"
    ),
    countGroup: 1,
    familyGroup: 3,
    adjectiveGroup: 2
  },
  // `SOIC (8)`, `SON (6)`, `LQFP (80)`. The space before the bracket is
  // required and it is doing real work: across the corpus a designator is a
  // separate token and a footnote marker is glued to the word it annotates, so
  // `CMTI(1)` and `NUMBER(3)` are excluded by the space alone.
  {
    pattern: new RegExp(`\\b(${FAMILY_ALTERNATION})\\s\\((\\d{1,3})\\)`, "gi"),
    countGroup: 2,
    familyGroup: 1
  },
  // `SOIC-8`, `GDIP-14`, `Flat-16P`, `HVSSOP-8`, and also `SOT-23`, whose
  // number is an outline rather than a count.
  {
    pattern: new RegExp(`\\b(${FAMILY_ALTERNATION})-(\\d{1,3})[A-Za-z]?\\b`, "gi"),
    countGroup: 2,
    familyGroup: 1
  },
  // `SO48`, `LQFP100`, `TSSOP14`, `DFN8`, and `SOT23`, `SC70`, `TO220`.
  //
  // Nothing but adjacency marks this form, so a small count is far more likely a
  // footnote marker than a package: ADR4525 prints `SOIC2` for footnote 2 on a
  // table heading, and no dual or quad package has two or three leads anyway.
  {
    pattern: new RegExp(`\\b(${FAMILY_ALTERNATION})(\\d{1,3})\\b`, "g"),
    countGroup: 2,
    familyGroup: 1,
    minCount: MIN_GLUED_COUNT
  },
  // `176 CQFP`, `128 LQFP`, `20 VQFN`, which is how an ordering table lays out
  // its package column. The noisiest form by far, so it is the most guarded:
  // see `plausibleLoneCount`.
  {
    pattern: new RegExp(`(^|[^-\\w.])(\\d{2,3})\\s+(${FAMILY_ALTERNATION})\\b`, "g"),
    countGroup: 2,
    familyGroup: 3
  }
];

/**
 * Whether a bare `<number> <FAMILY>` is a designator rather than a coincidence.
 *
 * This form has no keyword to anchor it, so it matches things that are not
 * packages at all, and the corpus supplies every one of them: `500 SOIC` is a
 * reel quantity (ISO7741, PCF8574), `55 BGA` and `25 BGA` are millimetres,
 * `223 SO` is the tail of `SOT-223 SO-8` on an LD1117.
 *
 * Two rules clear all of them. Lead counts on real dual and quad packages are
 * even, which removes the odd numbers; and they fall in a range no reel quantity
 * does. The preceding character is checked in the pattern itself so a count
 * cannot be borrowed from the outline code next to it.
 */
function plausibleLoneCount(count: number): boolean {
  return count % 2 === 0 && count >= 4 && count <= 400;
}

/**
 * Every package designator the document prints, in document order.
 *
 * Duplicates are collapsed on family and count, keeping the earliest occurrence,
 * so a datasheet that repeats `SOIC` eighty times yields one entry.
 */
export function findPackageVariants(text: string, frontMatterEnd: number): PackageVariant[] {
  const found = new Map<string, PackageVariant>();

  for (const form of FORMS) {
    for (const match of text.matchAll(form.pattern)) {
      const printed = match[form.familyGroup] ?? "";
      const family = printed.toUpperCase();
      if (!family) continue;
      // A family that is also an English word only counts in capitals.
      if (CAPITALS_ONLY.has(family) && printed !== family) continue;
      const adjective = form.adjectiveGroup ? match[form.adjectiveGroup] : undefined;
      if (adjective && namesPackageFamily(adjective)) continue;

      const raw = form.countGroup === null ? null : Number(match[form.countGroup]);
      const outlineNumbered = OUTLINE_NUMBERED.has(family);
      const count = raw !== null && Number.isFinite(raw) && !outlineNumbered ? raw : null;

      if (count !== null && (count < (form.minCount ?? 2) || count > MAX_LEAD_COUNT)) continue;
      // The lone-count form is the only one whose count is unanchored, and it is
      // also the only one that has to carry its own weight: a variant with no
      // count from it would be a bare family token, which is what this whole
      // reader refuses to treat as evidence.
      if (form === FORMS[FORMS.length - 1] && (count === null || !plausibleLoneCount(count))) continue;
      // Every other form still has to declare a count somewhere, EXCEPT where
      // the family is outline-numbered, whose whole point is that the number is
      // a name rather than a count.
      if (count === null && !outlineNumbered) continue;

      // The designator as printed, trimmed of the separator the lone-count form
      // captures ahead of it.
      const printedDesignator = match[0].replace(/^[^-\w.]/, "").replace(/\s+/g, " ").trim();

      // A MATERIAL qualifier printed ahead of the designator is part of it, and
      // dropping it is not cosmetic: the designator is what reaches the model's
      // prompt, the package chooser and the footprint name, and `Ceramic SO48`
      // reduced to `SO48` reads as an ordinary plastic SO in all three.
      //
      // Only the forms that capture an adjective of their own keep it today, and
      // the glued form is not one of them. RHF1201 is sold as a `Ceramic SO48`
      // and came back as `SO48`. See `MATERIAL_QUALIFIER` for what this no
      // longer protects.
      const start = (match.index ?? 0) + (match[0].length - match[0].replace(/^[^-\w.]/, "").length);
      const qualifier = MATERIAL_QUALIFIER.exec(text.slice(Math.max(0, start - 16), start))?.[1];
      const designator = qualifier ? `${qualifier} ${printedDesignator}` : printedDesignator;

      const key = `${family}:${count ?? printedDesignator.toUpperCase()}`;
      const existing = found.get(key);
      // A qualified reading of the same package supersedes an unqualified one,
      // whichever came first in the document, because it carries strictly more of
      // what the vendor wrote. The existing entry is checked for the word ANYWHERE
      // rather than at its end: a VA10820's `128 Pin Ceramic LQFP` already carries
      // it in the middle, and a rule that missed that replaced a fully printed
      // designator with a worse one assembled from a sparser match.
      if (existing && !(qualifier && !MATERIAL_WORD.test(existing.designator))) continue;

      found.set(key, {
        designator,
        family,
        leadCount: count,
        index: match.index ?? 0,
        inFrontMatter: (match.index ?? 0) < frontMatterEnd
      });
    }
  }

  return [...found.values()].sort((left, right) => left.index - right.index);
}

/**
 * The lead count a single designator declares, or null where it declares none.
 *
 * Used to check a designator against the pin count read off the part's own pin
 * table. Two independent signals that contradict each other mean one of them is
 * a misread, which is the same rule the pin count itself already follows.
 */
export function declaredLeadCount(designator: string): number | null {
  const variants = findPackageVariants(designator, designator.length);
  const counted = variants.filter((variant) => variant.leadCount !== null);
  return counted.length === 1 ? counted[0].leadCount : null;
}

/**
 * The vendor's short package code inside a printed package name, or null.
 *
 *     "SOIC (DW)"   -> "DW"
 *     "VSSOP (DGS)" -> "DGS"
 *     "SOIC"        -> null, the name states a family and no code
 *
 * The parenthesised token only, never the family word. A family is shared by
 * packages of different sizes, so it cannot settle which drawing a set of
 * dimensions came from, and treating `SOIC` as a code would call `SOIC (D)` and
 * `SOIC (DW)` the same package, which is precisely the confusion this exists to
 * catch.
 */
export function designatorToken(packageName: string): string | null {
  const match = /\(([A-Za-z][A-Za-z0-9-]{0,7})\)/.exec(packageName);
  return match ? match[1].toUpperCase() : null;
}

/**
 * A package name reduced to letters and digits, upper case.
 *
 * For comparing a drawing's self-applied label against a caller's package name,
 * which are two different strings for the same thing: `SOIC (DW)` against
 * `SOICDW`, `SO-8` against `SO8`. Matching on the raw strings refuses correct
 * parts, and refusing correct parts is how the two earlier attempts at this
 * check failed.
 */
export function normaliseForMatch(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/**
 * The package code a vendor outline-drawing number begins with, or null.
 *
 *     "DW0016A"   -> "DW"
 *     "D0008A"    -> "D"
 *     "DGS0010A"  -> "DGS"
 *     "MS-012 AA" -> null, a JEDEC registration and not a vendor outline
 *
 * Null wherever the code is not letters-then-digits, which is what keeps this
 * from judging vendors whose outline numbers carry no designator: it can then
 * prove nothing and says so, rather than refusing a part it cannot read. The
 * digits must follow immediately, so a JEDEC number like `MS-012` is rejected by
 * the hyphen rather than being mistaken for a package called `MS`.
 */
export function outlineCodeDesignator(outlineCode: string | null): string | null {
  if (!outlineCode) return null;
  const match = /^([A-Za-z]{1,5})\d{2,}[A-Za-z]?$/.exec(outlineCode.trim());
  return match ? match[1].toUpperCase() : null;
}




/**
 * A row of TI's PACKAGE OPTION ADDENDUM, which is the strongest statement about
 * packaging any datasheet in this corpus makes.
 *
 *     LM5117PMH/NOPB    Active Production   HTSSOP (PWP) | 20   73 | TUBE  ...
 *     OPA2333AIDGKR     Active Production   VSSOP (DGK) | 8     2500 | ...
 *
 * Everything the rest of this file does is inference from prose: a designator is
 * recognised by its shape and then checked for plausibility, because a datasheet
 * mentions packages in passing constantly. This table is not prose. It is
 * generated from TI's own ordering database, one row per ORDERABLE part number,
 * and it states the package and the pin count as separate fields.
 *
 * Two things follow that nothing else here can offer:
 *
 * The row is keyed to a part number, so a family datasheet's packages can be
 * split between the part in hand and its siblings. An OPA333 document describes
 * both the OPA333 and the OPA2333 and the prose reader can only pool them.
 *
 * The package CODE is printed beside the family, and that code is the outline
 * (`D`, `DW`, `PWP`) which `packages.ts` already uses to tell narrow-body SOIC
 * from wide. Those two differ by 4.3 mm of lead span and share a name, so a
 * source that carries the code is worth more than one that does not.
 *
 * The `/NOPB` and `.A` suffixes on National-heritage and revision-marked part
 * numbers are why the orderable token allows `/` and `.`; without them an LM5117
 * matched nothing at all.
 */
const ORDERABLE_ROW = new RegExp(
  // Orderable part number, then the status word TI's generator always prints.
  String.raw`\b([A-Z][A-Z0-9]{2,}[A-Z0-9./-]*)\s+` +
    String.raw`(?:ACTIVE|Active|NRND|OBSOLETE|Obsolete|PREVIEW|Preview)\b` +
    // Material type sits between, and is never a pipe or a bracket.
    String.raw`[^|()]{0,60}?` +
    // `HTSSOP (PWP) | 20`
    String.raw`\b([A-Z][A-Za-z0-9-]{1,10})\s*\(\s*([A-Z0-9]{1,5})\s*\)\s*\|\s*(\d{1,3})\b`,
  "g"
);

/**
 * Whether an orderable part number is a variant of the part being read.
 *
 * A prefix test, with the one guard that matters: the character after the base
 * must not be a DIGIT. `OPA333` prefixes `OPA333AID`, which is the same device
 * in a package, and it also prefixes nothing else here; but a bare prefix test
 * would let `LM358` claim an `LM3580` and hand one part another's package.
 */
function isOrderableOf(orderable: string, base: string): boolean {
  if (!orderable.startsWith(base)) return false;
  const next = orderable.charAt(base.length);
  return next === "" || !/\d/.test(next);
}

/**
 * The packages TI's ordering table lists for THIS part number.
 *
 * Empty for a document without the table, which is every non-TI datasheet and
 * some older TI ones, so callers must treat it as an additional source rather
 * than a replacement. It is deliberately not merged with the prose reader here:
 * a caller that wants the union can concatenate, and one that wants only the
 * authoritative answer can use this alone.
 */
export function findOrderablePackages(text: string, partNumber: string): PackageVariant[] {
  const base = partNumber.trim().toUpperCase();
  if (base.length < 3) return [];

  const found: PackageVariant[] = [];
  const seen = new Set<string>();
  ORDERABLE_ROW.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = ORDERABLE_ROW.exec(text)) !== null) {
    const [, orderable, family, code, pins] = match;
    if (!isOrderableOf(orderable.toUpperCase(), base)) continue;

    // `DIESALE`, `WAFERSALE` and `XCEPT` are shipping forms rather than
    // packages, and they come through this table as though they were one. The
    // family vocabulary rejects them without needing to know their names.
    if (!namesPackageFamily(family)) continue;

    const leadCount = Number(pins);
    if (!Number.isInteger(leadCount) || leadCount < MIN_GLUED_COUNT || leadCount > MAX_LEAD_COUNT) continue;

    // As printed, including the outline code, which is the part downstream
    // cares about most; see the note above.
    const designator = `${family} (${code})`;
    const key = `${family.toUpperCase()}:${leadCount}`;
    if (seen.has(key)) continue;
    seen.add(key);

    found.push({
      designator,
      family: family.toUpperCase(),
      leadCount,
      index: match.index,
      // The addendum is appended after the datasheet body, never in the front
      // matter, whatever the page count.
      inFrontMatter: false
    });
  }

  return found;
}

/**
 * The pin table belonging to ONE package of a family datasheet.
 *
 * ## The defect this closes
 *
 * A document describing several packages returns one pin table per package, and
 * the record separately carries a single `pins` answer for whichever package the
 * reading settled on. Relabelling the part as a sibling kept that single answer:
 * the package chooser offered every package the document names, `asPackage`
 * blanked every dimension because they describe the wrong package, and then
 * handed the wrong package's PINS to the generator. The UI did the same thing
 * more directly, replying "the pinout was already read, so it was kept".
 *
 * The packages genuinely differ. Measured over the cached hold-out answers on
 * 2026-08-16, 21 of the 56 cached documents describe more than one package with
 * its own pin table, and on TEN of them the lead counts differ: an ADS1256 is an SSOP-20 or
 * an SSOP-28, an SN74HC595 a 16-pin SOIC or a 20-pin FK, an LT1013 an 8, 14 or
 * 16 lead part. A 20-pad footprint labelled SSOP-28 is a board nobody can build.
 *
 * ## Matched on the designator first, then on the lead count
 *
 * Both sides are rendering the SAME printed designator, and they differ only in
 * punctuation and case: a TCA9548A's variants read `VQFN (RGE)` where its tables
 * read `VQFNRGE`, and an ADG1211's read `16-lead TSSOP` on both sides. So the
 * first key is the designator with everything but letters and digits removed.
 * That is not a normaliser fitted to particular spellings; it is the comparison
 * you make when two renderings of one string differ in how they punctuate it.
 *
 * Matching on the LEAD COUNT alone was the first attempt and it was measured
 * failing: of twelve hold-out parts carrying per-package tables, it matched two.
 * `TSSOP (PW)` declares no count at all, and an ADG1211 offers a 16-lead TSSOP
 * beside a 16-lead LFCSP, so the count is ambiguous exactly where a family
 * datasheet is most likely to need it.
 *
 * The count survives as the FALLBACK, for a designator whose text does not line
 * up but whose count identifies exactly one table.
 *
 * Returns null when nothing identifies exactly one table, which is the honest
 * answer rather than a guess. `buildFootprintGeometry` refuses anything left
 * contradictory.
 */
export function pinTableFor<T extends { packageType: string; pins?: unknown[] }>(
  tables: readonly T[] | undefined,
  designator: string
): T | null {
  if (!tables || tables.length === 0) return null;

  /** Letters and digits only, so `VQFN (RGE)` and `VQFNRGE` are one string. */
  const key = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const wantedKey = key(designator);
  if (wantedKey.length > 0) {
    const exact = tables.filter((table) => key(table.packageType) === wantedKey);
    if (exact.length === 1) return exact[0];

    // One name inside the other, which is how `16-lead TSSOP` meets `TSSOP` and
    // how `SOIC (D)` meets `SOICD`. Only when it picks out exactly one table.
    const containing = tables.filter((table) => {
      const other = key(table.packageType);
      return other.length > 0 && (other.includes(wantedKey) || wantedKey.includes(other));
    });
    if (containing.length === 1) return containing[0];
  }

  // The lead count, for a designator whose text does not line up with any table.
  // The table's own row count is what it actually contains, which is a stronger
  // statement than the count its label happens to declare.
  const wanted = declaredLeadCount(designator);
  if (wanted === null) return null;
  // Only entries that HAVE rows can be matched on their row count. An entry
  // carrying measurements and no pinout states nothing about lead count, and
  // reading its absence as a count of zero would match a designator to a table
  // it says nothing about.
  const matching = tables.filter((table) => table.pins !== undefined && table.pins.length === wanted);
  return matching.length === 1 ? matching[0] : null;
}
