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
 *
 * `TSOT` is here because it is the SAME OUTLINE, thinned: a TSOT-23 is a
 * SOT-23 body at a lower profile, and its 23 is the identical JEDEC outline
 * number carried over. `SOT` was on this list and `TSOT` was not, so the two
 * spellings of one outline disagreed. Seen live in the package chooser on an
 * AD8628, which offers both: `SOT-23` claimed no lead count, correctly, and
 * `TSOT-23` sat beside it reading "TSOT, 23 leads" on a five-lead part.
 */
const OUTLINE_NUMBERED = new Set(["TO", "SOT", "TSOT", "SC", "DO", "SOD", "DPAK"]);

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

/**
 * The family vocabulary as a bare alternation, for callers that need to REMOVE
 * family words from a label rather than detect them. Exported as a pattern
 * string so there is one vocabulary and not a second copy that drifts.
 */
export const PACKAGE_FAMILY_PATTERN = `\\b(?:${FAMILY_ALTERNATION})\\b`;

const NAMES_A_FAMILY = new RegExp(PACKAGE_FAMILY_PATTERN, "i");

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
 * WHICH family a name states, upper case, or null.
 *
 * `namesPackageFamily` answers whether, and `findPackageVariants` answers which
 * but only for a name that also declares a LEAD COUNT, which is the right rule
 * for harvesting designators out of prose and the wrong one for comparing two
 * names that are already known to be designators. `HTSSOP (PWP)` names a family
 * and declares no count, so the variant reader correctly yields nothing for it
 * and a caller asking "what family is this" got null.
 *
 * Longest-first ordering is inherited from the vocabulary, so `TSSOP` is never
 * read out of `HTSSOP`.
 */
export function familyToken(name: string): string | null {
  const match = NAMES_A_FAMILY.exec(name ?? "");
  return match ? match[0].toUpperCase() : null;
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
  /**
   * Whether this form's number is anchored by the vendor's own word for a lead.
   *
   * ## Why an outline-numbered family still gets a count from this form
   *
   * `OUTLINE_NUMBERED` exists because a trailing number on those families is a
   * NAME: the 23 in `SOT-23` is a body outline sold with 3, 5, 6 and 8 leads.
   * That was applied to every form at once, which threw away counts the
   * document states in words. Measured on an AD8628, which prints `5-Lead SOT`
   * and `5-Lead TSOT`: both came back declaring no lead count at all, on a
   * datasheet that says "5-Lead" in front of the family name.
   *
   * That is the failure shape this repo keeps finding: the evidence was on the
   * page, was matched, and was discarded by a rule written for a different
   * form. `5-Lead SOT` is not ambiguous. The count is a count because the
   * vendor wrote "Lead" next to it, and no outline number can be confused for
   * one when the digits are on the other side of that word.
   */
  countIsAnchored?: boolean;
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

/**
 * `SO48`, `LQFP100`, `TSSOP14`, `DFN8`, and `SOT23`, `SC70`, `TO220`.
 *
 * Named rather than left anonymous inside `FORMS` because it is the only form
 * marked by nothing but adjacency, and two rules refer to it: the minimum count
 * below, and the enumeration filter at the end of `findPackageVariants` that
 * covers the families for which that minimum cannot apply.
 *
 * Nothing but adjacency marks this form, so a small count is far more likely a
 * footnote marker than a package: ADR4525 prints `SOIC2` for footnote 2 on a
 * table heading, and no dual or quad package has two or three leads anyway.
 */
const GLUED_FORM: DesignatorForm = {
  pattern: new RegExp(`\\b(${FAMILY_ALTERNATION})(\\d{1,3})\\b`, "g"),
  countGroup: 2,
  familyGroup: 1,
  minCount: MIN_GLUED_COUNT
};

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
    adjectiveGroup: 2,
    countIsAnchored: true
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
  GLUED_FORM,
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
  /** Keys produced by the glued form on an outline-numbered family, to family. */
  const unanchored = new Map<string, string>();

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
      // An outline number is a name, EXCEPT where the vendor anchored it to the
      // word "lead" or "pin" themselves. See `countIsAnchored`.
      const outlineNumbered = OUTLINE_NUMBERED.has(family) && form.countIsAnchored !== true;
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
      // Adjacency alone, and a number that is a NAME rather than a count. See
      // `unanchoredOutlines`.
      if (form === GLUED_FORM && outlineNumbered) unanchored.set(key, family);
    }
  }

  // AN ENUMERATION IS NOT A PACKAGE.
  //
  // The glued form is the only one marked by nothing but adjacency, which is why
  // it demands a plausible lead count. For an OUTLINE-NUMBERED family that guard
  // is silently skipped, because the number there is a name and not a count, so
  // `count` is null and the minimum never applies. That left the weakest form in
  // this module running with no check at all on the families where the number
  // cannot be checked against anything: `SOT23` and `DO15` are equally good
  // evidence to it, and one of them is a package.
  //
  // Measured 2026-08-19: an accelerometer's register map prints DO0 through
  // DO15, and every one became a package the chooser offered the user. Sixteen
  // options, fifteen of them fiction, on a part whose real package was read
  // correctly beside them.
  //
  // The rule, stated without naming a vendor or a family: an outline number
  // identifies one package, so a document that glues SEVERAL different numbers
  // to the same outline-numbered family is enumerating something else. Nothing
  // in the token can say which one is the package, and this module's standing
  // answer to "cannot tell" is to say nothing rather than to pick.
  //
  // Costs nothing where the form is doing its job: measured over the tuned
  // corpus, every glued outline designator in it (three, all `SOT23`) is the
  // only number its family appears glued to.
  const gluedPerFamily = new Map<string, number>();
  for (const family of unanchored.values()) gluedPerFamily.set(family, (gluedPerFamily.get(family) ?? 0) + 1);
  for (const [key, family] of unanchored) {
    if ((gluedPerFamily.get(family) ?? 0) > 1) found.delete(key);
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
 * The vendor package CODE a name states, or null.
 *
 * Which token is the code depends on which side of the brackets the FAMILY is
 * on, and reading the brackets unconditionally gets it backwards:
 *
 *     "SOIC (D)"        family outside, code inside      -> D
 *     "HTSSOP (PWP)"    family outside, code inside      -> PWP
 *     "D (OPA1612)"     code outside, DEVICE inside      -> D, not OPA1612
 *     "RGT (VQFN, 16)"  code outside, family inside      -> RGT
 *
 * Getting `D (OPA1612)` wrong is not cosmetic: the join reads `OPA1612` as this
 * package's code, compares it against `SOIC (D)`'s `D`, and refuses the two
 * halves of one package on a CONTRADICTION it invented itself.
 */
export function packageCodeOf(rawName: string): string | null {
  const name = spellOut(rawName);
  const beforeBracket = name.split("(")[0];
  // When the family is stated first, the brackets hold the code. When it is not,
  // the leading token IS the code and the brackets hold something else.
  const token = namesPackageFamily(beforeBracket)
    ? designatorToken(name)
    : (leadingCode(name) ?? designatorToken(name));
  // A VENDOR OUTLINE NUMBER REDUCED TO THE CODE IT BEGINS WITH.
  //
  // Pass 2 reads the code off the drawing's own title block, where it is printed
  // as a full outline number: `SOIC (DW0016A)`, `TSSOP (PW0016A)`. Every other
  // place in a document writes the bare code, so `DW0016A` and `DW` are the same
  // package written twice and comparing them as strings says they are not.
  //
  // Reducing is safe HERE and would not be everywhere: the outline number
  // distinguishes `PW0016A` from `PW0020A`, and dropping it elsewhere has cost a
  // regression in this repo before. This comparison also requires the two lead
  // counts to agree, which is exactly the distinction the number was carrying.
  return token === null ? null : (outlineCodeDesignator(token) ?? token);
}

/**
 * A label with its underscores spelled out as spaces.
 *
 * `SOIC_W` hides `SOIC` from every reader in this file, because they all match
 * on a word boundary and `_` is a word character. Analog Devices writes every
 * narrow and wide body that way, so without this an `8-Lead SOIC_N` reports no
 * family at all and can never be recognised as the SOIC a caption names.
 */
export function spellOut(name: string): string {
  return (name ?? "").replace(/_/g, " ");
}

/**
 * A vendor code written BEFORE the family rather than inside brackets after it.
 *
 * `RGT (VQFN, 16)` and `D (OPA1612)` are both this shape, and `designatorToken`
 * cannot see them: it reads the parenthesised token, which here is a family or a
 * device rather than the code. Restricted to a short all-capitals run at the
 * very start so an ordinary family word never becomes a code.
 */
function leadingCode(name: string): string | null {
  const match = /^([A-Z]{1,4})\b/.exec(name.trim());
  if (match === null) return null;
  // A family word is not a code, whichever end of the string it sits at.
  return namesPackageFamily(match[1]) ? null : match[1];
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
/**
 * One vendor drawing code, with the decoration a model adds around it removed.
 *
 * Kept separate from `outlineCodeDesignator`, which reduces a TI code to its
 * letter designator (`D0008A` to `D`). That is the right reduction for matching
 * a code against a package NAME and the wrong one for asking whether two entries
 * describe the same DRAWING: `D0008A` and `D0014A` both designate `D`, and they
 * are a SOIC-8 and a SOIC-14.
 */
export function normalizeOutlineCode(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (value.length === 0) return null;
  // "CASE 751-07" is ON Semiconductor's own heading for the code "751-07", and
  // the model returns it both ways on the same document.
  value = value.replace(/^(?:CASE|PACKAGE\s+OUTLINE|OUTLINE)\s+/i, "");
  // "DSJ (R-PVSON-N14)" is the code with the JEDEC style spelled out beside it.
  value = value.replace(/\s*\([^)]*\)\s*/g, " ");
  value = value.trim().replace(/\s+/g, " ").toUpperCase();
  return value.length > 0 && value.length <= 32 ? value : null;
}

/**
 * Do two drawing codes name the same drawing?
 *
 * MEASURED over the cached corpus on 2026-08-20: the code came back identical on
 * 44 of 52 parts. Of the eight that differed, six were one code wearing
 * decoration and two were genuinely different drawings:
 *
 *     751-07   vs  CASE 751-07              same, a heading
 *     DSJ      vs  DSJ (R-PVSON-N14)        same, a style spelled out
 *     1L       vs  1L_LQFP100_ME_V3         same, ST's descriptive suffix
 *     DDA0008B vs  RGT0016C                 DIFFERENT drawings
 *     DCK0006A vs  DBV0006A                 DIFFERENT: SC-70 against SOT-23
 *
 * The suffix case is handled as a PREFIX AT A SEPARATOR rather than by stripping
 * everything after the first underscore, because stripping would collapse ST's
 * own codes into each other: `7983231_13` and `7983231_14` are two drawings, and
 * neither is a prefix of the other at a boundary, so they stay apart.
 *
 * Two codes that merely start with the same letters do NOT match: `DDA0008B` and
 * `DDA0008C` are a revision apart, and `D0008A` against `D0014A` differs by six
 * leads. Only a separator counts as the end of a code.
 */
export function sameOutlineCode(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalizeOutlineCode(a);
  const right = normalizeOutlineCode(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return longer.startsWith(shorter) && /^[\s_\-.]/.test(longer.slice(shorter.length));
}

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
/**
 * Whether two printed designators name the SAME package.
 *
 * Letters and digits only, upper case, which is the comparison `pinTableFor`
 * has always used so that `VQFN (RGE)` and `VQFNRGE` are one string. Exported
 * so `asPackage` can use the same rule instead of `===`.
 *
 * ## What `===` cost
 *
 * `asPackage` blanks every dimension when the designator it is given differs
 * from the record's, which is right: those values were read off ONE package's
 * drawings. It compared with `===`.
 *
 * On an LTC6563 the model returned `24-lead QFN` and the chooser offered
 * `24-Lead QFN`. One capital letter, the same package, and the record's land
 * length, land width, centre span, lead sides, pitch and all three body
 * dimensions were discarded, every one of them read and cited to page 33. The
 * user was then asked for eight numbers the product had already read. Reported
 * 2026-08-25.
 *
 * Deliberately NOT looser than this. `SOIC (D)` and `SOIC (DW)` still differ,
 * because the drawing code disagreeing is a real disagreement; only the
 * spelling of one name is being normalised.
 */
/** The one package family a name states, or null when it states none or several. */
function soleFamily(name: string): string | null {
  const found = new Set(
    [...name.matchAll(new RegExp(PACKAGE_FAMILY_PATTERN, "gi"))].map((match) => match[0].toUpperCase())
  );
  return found.size === 1 ? [...found][0]! : null;
}

/**
 * The lead count a name states in words, wherever it sits.
 *
 * Exported since 2026-08-27 for the per-package join in `merge.ts`. A lead count
 * is not an IDENTITY - `forge-lead-count-is-not-an-identity` - but two names that
 * state DIFFERENT counts are certainly not the same package, and that is all the
 * join asks of it.
 */
export function statedLeadCount(name: string): number | null {
  const found = new Set<number>();
  // The unit word is what makes a number a COUNT rather than an outline number:
  // `SOT23` is a three-lead package and `DO15` is a diode body, and reading
  // either as a lead count would invent a second source that then confirms a
  // wrong pin count. Widened past `lead|pin|ld` on 2026-09-02: `14-Terminal
  // LGA`, `4-position Terminal Block` and `400-ball` state their count as
  // plainly as `24-Lead` does, and the parts that word it this way were exactly
  // the ones with nothing else to check against.
  for (const match of name.matchAll(
    /(\d{1,3})\s*[-\s]?\s*(?:lead|pin|ld|terminal|position|contact|circuit|ball|bump|way|pole)s?\b/gi
  )) {
    const count = Number(match[1]);
    if (count >= 2) found.add(count);
  }
  // `FCBGA (400)`, `VQFN (24)`, `SOIC (8)`: the family outside the bracket, its
  // size inside. Bare digits ONLY, so `QFN (3mm x 5mm)` and `RGT (VQFN, 16)`
  // are not read as counts.
  for (const match of name.matchAll(/\((\d{1,3})\)/g)) {
    const count = Number(match[1]);
    if (count >= 2) found.add(count);
  }
  // Two different counts in one name is `16-lead PDIP/SOIC_N/TSSOP` territory:
  // a statement about a shared pinout rather than the name of one package. This
  // module's standing answer to "cannot tell" is to say nothing.
  return found.size === 1 ? [...found][0]! : null;
}

export function sameDesignatorName(left: string, right: string): boolean {
  const key = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (key(left) === key(right)) return true;

  // A FULLER DESCRIPTION OF THE SAME PACKAGE.
  //
  // The model names the package from whatever the page gave it, and the length
  // of that varies between reads of one document. The same LTC6563 came back as
  // `24-lead QFN` on one pass and `24-Lead Plastic Side Solderable QFN
  // (3mm x 5mm)` on the next, while the designator harvested from the text
  // stayed `24-Lead QFN`. Spelling alone does not reconcile those, and the
  // second read discarded the same eight values the first one did.
  //
  // Three things have to agree, and each is a statement the names actually
  // make rather than a similarity score:
  //
  //   the FAMILY          QFN is not SOIC
  //   the LEAD COUNT      24-Lead is not 20-Lead
  //   the DRAWING CODE    `SOIC (D)` is not `SOIC (DW)`
  //
  // The code only disqualifies when BOTH names carry one and they disagree. A
  // name that states no code is not contradicting anything, which is what lets
  // the long form above match: its bracket holds `3mm x 5mm`, not a code.
  //
  // The lead count must be present on both. Two names that state no count are
  // not distinguishable this way, so they are left alone rather than merged on
  // family agreement, which would put `SOT-23` and a different `SOT-23` variant
  // together on the strength of three letters.
  // The family must be the ONLY one each name states. A pin table's caption
  // routinely lists every package sharing an assignment, `16-lead
  // PDIP/SOIC_N/TSSOP`, and that is a statement about the PINOUT rather than
  // the name of one package. Matching it against a specific package would keep
  // one package's measured dimensions under another's name, which is the exact
  // thing `asPackage` exists to prevent.
  const family = soleFamily(left);
  if (family === null || family !== soleFamily(right)) return false;

  // Read straight off the words, not via `declaredLeadCount`. That function
  // requires the count to sit within one adjective of the family, deliberately,
  // so that `64 Ld Thin Quad Flatpack (EP-TQFP)` cannot reach across to the
  // wrong family. Here the family is already agreed, so the only question left
  // is what count each name states, and `24-Lead Plastic Side Solderable QFN`
  // puts three words in between.
  const leads = statedLeadCount(left);
  if (leads === null || leads !== statedLeadCount(right)) return false;

  const leftCode = designatorToken(left);
  const rightCode = designatorToken(right);
  if (leftCode !== null && rightCode !== null && leftCode !== rightCode) return false;

  return true;
}

export function pinTableFor<
  T extends { packageType: string; alsoKnownAs?: string[]; outlineCode?: string; pins?: unknown[] }
>(tables: readonly T[] | undefined, designator: string): T | null {
  if (!tables || tables.length === 0) return null;

  /** Letters and digits only, so `VQFN (RGE)` and `VQFNRGE` are one string. */
  const key = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");

  // A DRAWING CODE IN THE DESIGNATOR SETTLES IT BEFORE ANY NAME IS COMPARED.
  //
  // A document can print two drawings under one caption, and after 2026-08-20
  // those stay two entries rather than being merged on the strength of the
  // caption. Measured on the tuned corpus that day:
  //
  //     UCC27524   "HVSSOP (DGN)"  ->  DGN0008G  and  DGN0008H
  //     TLV9061    "X2SON (DPW)"   ->  DPW0005A  and  DPW0005B
  //     OPA2189    "SOIC"          ->  D0008A    and  D0014A
  //
  // Every name-based rule below then finds two tables, picks neither, and the
  // user is told no pinout matches a package whose pinout we are holding twice.
  // So `packageOptions` offers the code alongside the caption, and an answer
  // carrying one is resolved here, by the one thing that tells the two apart.
  const bracketed = /\[([^\]]+)\]\s*$/.exec(designator.trim());
  if (bracketed) {
    const wantedCode = bracketed[1];
    const matched = tables.filter((table) => sameOutlineCode(table.outlineCode, wantedCode));
    if (matched.length === 1) return matched[0];
    // A code that names no table, or two, is not an answer. Falling through to
    // the name rules would then match on the caption the two SHARE, which is
    // the ambiguity this branch exists to resolve; better to refuse.
    if (matched.length > 1) return null;
    designator = designator.slice(0, bracketed.index).trim();
  }
  // EVERY NAME THE DOCUMENT PRINTS FOR THIS PACKAGE, not only the one the entry
  // happens to be filed under. An entry assembled from two passes carries both,
  // and the designator arriving here comes from a third place again: the
  // ordering table. See `alsoKnownAs` on the record type.
  const namesOf = (table: T) => [table.packageType, ...(table.alsoKnownAs ?? [])].map(key).filter((n) => n.length > 0);
  const wantedKey = key(designator);
  if (wantedKey.length > 0) {
    const exact = tables.filter((table) => namesOf(table).includes(wantedKey));
    if (exact.length === 1) return exact[0];

    // One name inside the other, which is how `16-lead TSSOP` meets `TSSOP` and
    // how `SOIC (D)` meets `SOICD`. Only when it picks out exactly one table.
    const containing = tables.filter((table) =>
      namesOf(table).some((other) => other.includes(wantedKey) || wantedKey.includes(other))
    );
    if (containing.length === 1) return containing[0];

    // THE SAME FACTS IN A DIFFERENT ORDER.
    //
    // `VQFN (RGT)` and `RGT (VQFN, 16)` are one package written by two readers,
    // and no amount of punctuation-stripping makes one contain the other: the
    // family and the code have swapped places. Comparing what the two names
    // SAY, rather than how they read, settles it, and it is the same proof the
    // two-pass join is built on.
    //
    // Both halves must be known and both must agree, so a family alone never
    // matches: a document with a 3x3 and a 2x2 DFN6 is genuinely ambiguous and
    // stays refused.
    const wantedFamily = familyToken(designator);
    const wantedCode = packageCodeOf(designator);
    if (wantedFamily !== null && wantedCode !== null) {
      const proven = tables.filter((table) =>
        [table.packageType, ...(table.alsoKnownAs ?? [])].some(
          (name) => familyToken(name) === wantedFamily && packageCodeOf(name) === wantedCode
        )
      );
      if (proven.length === 1) return proven[0];
    }
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

/**
 * HOW MANY SIDES THE PACKAGE FAMILY NAME SAYS THE LEADS COME OUT OF.
 *
 * A second, independent reading of `dimensions.leadSides`, which until now had
 * none: `bench:unchecked` swapped 2 for 4 on 86 footprints that the product
 * vouched for and 59 of them stayed CONFIRMED. Swapping the side count turns a
 * quad flat pack into a very long two-row part and back, which is a footprint
 * that does not fit at all, and nothing was looking.
 *
 * The side count is IN THE NAME, and this is a reading rather than a convention.
 * The Q in QFP, QFN and PLCC is quad; SOIC, SSOP, TSSOP, SOT, DFN, SON and a
 * ceramic flat pack are two rows; a TO can and a SIP are one; a BGA and an LGA
 * have no sides at all and this answers null for them rather than guessing.
 * `declaredLeadCount` above already reads a lead COUNT out of the same string
 * for the same purpose, so this is the same liberty and no new one.
 *
 * Measured over the cached corpus 2026-08-29: 97 of 103 designators state a side
 * count, 96 agree with the drawing and 1 disagrees (`VQFN-HR (7)`, a seven-pin
 * half-etched QFN, where the flag is the right outcome). The six silent ones are
 * all LGA, where the answer is correctly "no sides".
 *
 * BOUNDED BY LETTERS RATHER THAN WORD BOUNDARIES, because a datasheet writes the
 * family and the lead count as one token as often as not - `TSSOP8`, `LQFP48`,
 * `DFN6`, `Flat-16P`. A `\b` ends at the digit, and with one it recognised 78
 * designators rather than 97.
 */
export function declaredLeadSides(designator: string): 1 | 2 | 4 | null {
  const name = designator.toUpperCase();
  const has = (...families: string[]) => new RegExp(`(?<![A-Z])(?:${families.join("|")})(?![A-Z])`).test(name);
  // Checked FIRST. A grid array's designator often carries a token that would
  // otherwise read as a two-row family, and "no sides" has to win over a
  // substring match.
  if (has("BGA", "[HWTUV]?LGA", "CSP", "WLCSP", "DSBGA", "PGA")) return null;
  if (has("TO", "SIP", "SIL")) return 1;
  if (has("[CLTMPHVU]?QFP", "[VHWUML]?QFN", "LFCSP", "MLPQ", "MLF", "PLCC", "QFJ", "LCC")) return 4;
  if (
    has(
      "[HW]?SOIC", "SOP", "[TQV]?SSOP", "[HE]?TSSOP", "MSOP", "VSSOP", "TSOP", "TSOT", "SOT",
      "[VHWU]?SON", "[VHWU]?DFN", "[PC]?DIP", "SO", "SC", "SOD", "CFP", "FLAT", "FLATPACK"
    )
  ) {
    return 2;
  }
  return null;
}
