import { test } from "node:test";
import assert from "node:assert/strict";
import {
  declaredLeadCount,
  pinTableFor,
  findOrderablePackages,
  findPackageVariants,
  namesPackageFamily,
  selectSinglePackage,
  soleDeclaredLeadCount
} from "../packagevariants";

/**
 * `packageType` was null on 15 of the 23 parts that could not export, which made
 * it the largest single upstream cause. The documents were never silent; the
 * designator was only recognised in five printed forms and these are written
 * differently.
 *
 * Every string below is quoted from a datasheet in the benchmark corpus.
 */

const all = (text: string) => findPackageVariants(text, text.length);
const designators = (text: string) => all(text).map((variant) => variant.designator);

test("the glued form is a designator", () => {
  // ST prints `Ceramic SO48 package` on RHF1201 page 1 and `Flat-16P` on
  // RHFL4913A. Neither has a separator, so neither was recognised at all.
  //
  // The material qualifier is KEPT. `packages.ts` refuses a hermetic part the
  // plastic JEDEC families by testing this string for the word `ceramic`, so a
  // designator that drops it drops the guard with it: an `SO48` is one
  // characterised family away from taking plastic geometry on a ceramic part,
  // where a `Ceramic SO48` is refused outright.
  assert.deepEqual(all("Ceramic SO48 package")[0], {
    designator: "Ceramic SO48",
    family: "SO",
    leadCount: 48,
    index: 8,
    inFrontMatter: true
  });
  assert.equal(all("Flat-16P")[0].leadCount, 16);
  assert.equal(all("available in LQFP100 and LQFP144").length, 2);
});

test("a short hyphenated prefix is kept with the family", () => {
  // Renesas writes `64 Ld EP-TQFP Package` in the ISL71001M thermal table.
  const variant = all("Thermal Resistance 64 Ld EP-TQFP Package")[0];
  assert.equal(variant.family, "TQFP");
  assert.equal(variant.leadCount, 64);
});

test("one adjective may sit between the count and the family", () => {
  // `16-Lead Ceramic SOIC` (ADC128S102QML-SP) and `128 Pin Ceramic LQFP`.
  assert.equal(all("Packaged in 16-Lead Ceramic SOIC")[0].family, "SOIC");
  assert.equal(all("128 Pin Ceramic LQFP")[0].leadCount, 128);
});

test("but not a whole phrase, because the nearest family is not the loosest", () => {
  // `64 Ld Thin Quad Flatpack (EP-TQFP)`. A window wide enough to reach the
  // TQFP reaches FLATPACK first, and FLATPACK is a CERAMIC family: a plastic
  // part would be handed ceramic flat pack geometry, which is a confidently
  // wrong footprint rather than an absent one.
  assert.deepEqual(designators("available in a plastic 64 Ld Thin Quad Flatpack"), []);
});

test("a number that is an outline code is not a lead count", () => {
  // SOT-23 is sold with 3, 5, 6 and 8 leads and TO-220 is a three-lead part.
  // Reading these as counts is how an LD1117 once declared 220 pins.
  for (const text of ["SOT-23", "TO-220", "SC70", "SOT23"]) {
    const variant = all(text)[0];
    assert.ok(variant, `${text} still names a family`);
    assert.equal(variant.leadCount, null, `${text} declares no count`);
  }
});

test("a bare family token is not a designator", () => {
  // Measured over the corpus: `TO` appears 16 times in an AD590 and 14 in an
  // AD8232 from `TOP VIEW` and prose, `SC` 262 times in an RTAX2000S. Without a
  // count these are noise, and they were the reason the search had to be so
  // narrow in the first place.
  assert.deepEqual(designators("SOIC TSSOP QFN packages are available"), []);
});

test("SMD is a drawing number, not a package", () => {
  // ST prints `DLA SMD are 5962F02534` on every rad-hard part. Treating SMD as
  // a family would give RHFL4913 a package it does not have.
  assert.deepEqual(designators("QML-V qualified, DLA SMD are 5962F02534"), []);
});

test("PGA is a gain amplifier more often than a pin grid array", () => {
  // ADS1115 says it 19 times and is a VSSOP.
  assert.deepEqual(designators("the PGA is set to 16"), []);
});

test("the lone-count form rejects what is not a lead count", () => {
  // Every one of these is from the corpus: a reel quantity, two body sizes in
  // millimetres, and the tail of `SOT-223 SO-8` read as `223 SO`.
  for (const text of ["Reel 500 SOIC", "55 BGA", "25 BGA", "SOT-223 SO-8"]) {
    assert.ok(
      !all(text).some((variant) => variant.designator.match(/^\d/)),
      `${text} yields no lone-count designator`
    );
  }
  // And accepts the real ones: VA41630's ordering table and VA10820's.
  assert.equal(all("VA41630-CQ176F0EBA 176 CQFP")[0].leadCount, 176);
});

test("one family at one count is a single package", () => {
  // The qualified reading wins over the bare one printed later in the same
  // document, because it carries strictly more of what the vendor wrote.
  const variants = all("Ceramic SO48 package. The SO48 outline is shown in Figure 26.");
  assert.equal(selectSinglePackage(variants)?.designator, "Ceramic SO48");
});

test("one family at several counts is not", () => {
  // An RTAX2000S is sold as a 208, a 256 and a 352 pin CQFP. Answering with any
  // one of them picks a package for a caller who never said which they had.
  const variants = all("208-Pin CQFP 256-Pin CQFP 352-Pin CQFP");
  assert.equal(variants.length, 3);
  assert.equal(selectSinglePackage(variants), null);
});

test("two families at the same count is not either", () => {
  // ADG5412 is both a 16-Lead TSSOP and a 16-Lead LFCSP. The count cannot
  // choose, and this is the case the caller is asked to resolve with one click.
  const variants = all("16-Lead TSSOP (4-Layer Board) 16-Lead LFCSP (4-Layer Board)");
  assert.equal(selectSinglePackage(variants), null);
  assert.deepEqual(new Set(variants.map((variant) => variant.family)), new Set(["TSSOP", "LFCSP"]));
});

test("a designator has to name a family", () => {
  // `80-pin target development board` became an MSP430F5529's package and
  // `MIL-STD-883B` an RTAX2000S's. Both are shaped like designators.
  assert.equal(namesPackageFamily("80-pin target"), false);
  assert.equal(namesPackageFamily("STD-883"), false);
  assert.equal(namesPackageFamily("16-Lead Ceramic"), false);
  assert.equal(namesPackageFamily("8-Pin SOIC"), true);
  assert.equal(namesPackageFamily("LQFP (80)"), true);
});

test("the lead count a designator declares can be checked against the pins", () => {
  assert.equal(declaredLeadCount("14-pin CFP"), 14);
  assert.equal(declaredLeadCount("LQFP (80)"), 80);
  assert.equal(declaredLeadCount("12-Pin BGA"), 12);
  // No count to check, so nothing to contradict.
  assert.equal(declaredLeadCount("SOT-23"), null);
});

test("one lead count across every package named is a corroboration", () => {
  // The front-matter pattern that reads a declared pin count requires a word
  // boundary after the count, so `FLAT-16P` declares nothing to it and an
  // RHFL4913 read a complete sixteen-pin table beside a package called FLAT-16P
  // and still reported an unknown pin count.
  assert.equal(soleDeclaredLeadCount(all("FLAT-16P and TO-257 packages")), 16);
  // Two packages, one count: ADG5412 is a 16-lead TSSOP and a 16-lead LFCSP.
  assert.equal(soleDeclaredLeadCount(all("16-Lead TSSOP 16-Lead LFCSP")), 16);
});

test("several lead counts corroborate nothing", () => {
  // RTAX2000S names 208, 256 and 352; TSV911 names 8 and 14.
  assert.equal(soleDeclaredLeadCount(all("208-Pin CQFP 256-Pin CQFP 352-Pin CQFP")), null);
  assert.equal(soleDeclaredLeadCount(all("SO-8 and TSSOP-14 packages")), null);
});

test("and a package that declares no count is no obstacle", () => {
  // An LD1117's TO-220 is an outline code, not a count, so it rules nothing out.
  assert.equal(soleDeclaredLeadCount(all("TO-220 and SO-8 packages")), 8);
  assert.equal(soleDeclaredLeadCount([]), null);
});

test("a material qualifier printed ahead of a glued designator is kept", () => {
  // Not cosmetic. `packages.ts` refuses a hermetic part the plastic JEDEC
  // families by testing the designator STRING for the word `ceramic`, so a
  // designator that drops it drops the guard: `SO48` resolves against a plastic
  // family the moment one is characterised, where `Ceramic SO48` is refused.
  assert.equal(all("Ceramic SO48 package")[0].designator, "Ceramic SO48");
  assert.equal(all("the ceramic Flat-8 outline")[0].designator, "ceramic Flat-8");

  // The qualifier belongs to the designator it precedes, not to any family that
  // happens to appear nearby.
  assert.equal(all("a plastic TSSOP14 part")[0].designator, "TSSOP14");
});

test("a designator that already carries the qualifier is not rebuilt from a sparser match", () => {
  // A VA10820 prints `128 Pin Ceramic LQFP`, which the keyword form captures
  // whole. A later, sparser match that merely sits after the word `ceramic` must
  // not replace it with something the vendor never wrote.
  const variants = all("128 Pin Ceramic LQFP, ceramic 128 LQFP");
  assert.equal(variants.length, 1, "one package, however many ways it is printed");
  assert.equal(variants[0].designator, "128 Pin Ceramic LQFP");
});

test("a thermally enhanced TSSOP is its own family, not a TSSOP", () => {
  // `HTSSOP` is TI's PowerPAD TSSOP and it was the one family the corpus prints
  // that the vocabulary did not have, found by auditing every package-declaring
  // context in both caches for unrecognised tokens. DRV8825 states its own
  // package as `HTSSOP (28)` in its Device Information table and LM5117 as
  // `20-Pin HTSSOP`; both reported NO package at all before this.
  assert.equal(namesPackageFamily("HTSSOP (28)"), true);
  assert.equal(all("DRV8825 HTSSOP (28) 9.70 mm x 6.40 mm")[0].family, "HTSSOP");
  assert.equal(all("the 20-Pin HTSSOP option")[0].designator, "20-Pin HTSSOP");
  assert.equal(declaredLeadCount("HTSSOP (28)"), 28);

  // And it is NOT read as the plain family whose name it contains. An HTSSOP-28
  // has a 9.70 x 6.40 body; MO-153 AA, which is what `TSSOP` is characterised
  // from, is 4.4 mm wide and stops at 16 leads. The land-pattern refusal is
  // pinned separately in the packages test; this pins the reading that feeds it.
  assert.equal(all("HTSSOP (28)")[0].family, "HTSSOP", "not TSSOP");
});

// ---------------------------------------------------------------------------
// TI's PACKAGE OPTION ADDENDUM, the one source in these documents that is not
// prose. Quoted from the DRV8825, LM5117 and OPA333 datasheets.
//
// Measured over both caches: 42 documents carry it, and it takes the reported
// variant list from 184 entries to 113, every one of which the vendor lists as
// orderable for that exact part number.
// ---------------------------------------------------------------------------

const orderable = (text: string, part: string) =>
  findOrderablePackages(text, part).map((variant) => `${variant.designator}/${variant.leadCount}`);

test("the ordering table is read, with the outline code kept", () => {
  // The code is the point: `D` and `DW` are both written SOIC and differ by
  // 4.3 mm of lead span, and `packages.ts` tells them apart by exactly this.
  assert.deepEqual(
    orderable("DRV8825PWPR Active Production HTSSOP (PWP) | 28 2000 | LARGE T&R Yes", "DRV8825"),
    ["HTSSOP (PWP)/28"]
  );
  assert.deepEqual(
    orderable("ISO7741DWR Active Production SOIC (DW) | 16 2000 | LARGE T&R", "ISO7741"),
    ["SOIC (DW)/16"]
  );
});

test("a National-heritage suffix does not hide the row", () => {
  // `/NOPB` and `.A` are why the orderable token allows `/` and `.`. Without
  // them an LM5117 matched nothing at all and reported no package.
  assert.deepEqual(
    orderable(
      "LM5117PMH/NOPB Active Production HTSSOP (PWP) | 20 73 | TUBE Yes SN " +
        "LM5117PSQ/NOPB.A Active Production WQFN (RTW) | 24 1000 | SMALL T&R Yes SN",
      "LM5117"
    ),
    ["HTSSOP (PWP)/20", "WQFN (RTW)/24"]
  );
});

test("a sibling device's packages are not claimed", () => {
  // The whole reason to prefer this table over the prose reader. An OPA333
  // document describes the OPA2333 as well, and prose pools the two: seven
  // families where the vendor lists two for the part actually being read.
  const addendum =
    "OPA2333AIDGKR Active Production VSSOP (DGK) | 8 2500 | LARGE T&R Yes " +
    "OPA2333AIDRBR Active Production SON (DRB) | 8 3000 | LARGE T&R Yes " +
    "OPA333AID Active Production SOIC (D) | 8 75 | TUBE Yes " +
    "OPA333AIDBVR Active Production SOT-23 (DBV) | 5 3000 | LARGE T&R Yes";

  assert.deepEqual(orderable(addendum, "OPA333"), ["SOIC (D)/8", "SOT-23 (DBV)/5"]);
  assert.deepEqual(orderable(addendum, "OPA2333"), ["VSSOP (DGK)/8", "SON (DRB)/8"]);
});

test("a longer part number is not a variant of a shorter one", () => {
  // The guard that makes the prefix test safe. `LM358` prefixes `LM3580`, which
  // is a different device, and claiming its package would be a wrong footprint
  // arrived at through a string operation.
  assert.deepEqual(orderable("LM3580XYZ Active Production SOIC (D) | 8 75 | TUBE", "LM358"), []);

  // A letter after the base is the ordinary case and must still be read.
  assert.deepEqual(orderable("LM358AD Active Production SOIC (D) | 8 75 | TUBE", "LM358"), [
    "SOIC (D)/8"
  ]);
});

test("a shipping form is not a package", () => {
  // `DIESALE`, `WAFERSALE` and `XCEPT` come through this table in the package
  // column as though they were packages. The family vocabulary rejects them
  // without this reader needing to know their names.
  assert.deepEqual(
    orderable(
      "REF5025AMDXCEPT Active Production XCEPT (0) | 0 1 | TUBE " +
        "LM139AWRQMLV Active Production DIESALE (0) | 0 1 | TUBE " +
        "REF5025HKJ Active Production CFP (HKJ) | 8 1 | TUBE",
      "REF5025"
    ),
    ["CFP (HKJ)/8"]
  );
});

// ---------------------------------------------------------------------------
// Selecting one package's pin table out of a family datasheet
// ---------------------------------------------------------------------------

/**
 * The defect these lock out shipped a wrong footprint by the shortest possible
 * route: the package chooser offered every package a document names, and both
 * the UI relabel and `asPackage` carried ONE package's pin table across to all
 * of them. An ADS1256 read as a 20-pin SSOP-20 became an "SSOP-28" holding
 * twenty pins, and the UI said the pinout had been kept as though that were a
 * service.
 */
test("a package's own pin table is selected by the lead count it declares", () => {
  const tables = [
    { packageType: "SSOP-20", pins: Array.from({ length: 20 }, () => ({})) },
    { packageType: "SSOP-28", pins: Array.from({ length: 28 }, () => ({})) }
  ];
  assert.equal(pinTableFor(tables, "28-Lead SSOP")?.packageType, "SSOP-28");
  assert.equal(pinTableFor(tables, "SSOP-20")?.packageType, "SSOP-20");
});

test("the table's own row count decides, not the label it carries", () => {
  // The model writes the designator the DOCUMENT prints, which is spelled every
  // way there is: "TSSOPPW", "HSOIC (DDA, 8)", "DB, DGV, DW, N, NS, PW, RGY".
  // Matching those to a variant designator would need a normaliser fitted to
  // whichever spellings happen to be in the cache.
  const tables = [
    { packageType: "TSSOPPW", pins: Array.from({ length: 16 }, () => ({})) },
    { packageType: "VQFNRVA", pins: Array.from({ length: 24 }, () => ({})) }
  ];
  assert.equal(pinTableFor(tables, "24-Lead VQFN")?.packageType, "VQFNRVA");
});

test("an ambiguous or absent count selects nothing, rather than guessing", () => {
  const sameCount = [
    { packageType: "TSSOP-16", pins: Array.from({ length: 16 }, () => ({})) },
    { packageType: "VQFN-16", pins: Array.from({ length: 16 }, () => ({})) }
  ];
  // Two tables of sixteen. Which one a "16-Lead TSSOP" means cannot be settled
  // on the count, and the names are not comparable, so this answers null and
  // lets the caller refuse rather than picking one.
  assert.equal(pinTableFor(sameCount, "16-Lead TSSOP"), null);
  // A designator that declares no count at all: SOT-23, TO-220, SOD-123.
  assert.equal(pinTableFor(sameCount, "SOT-23"), null);
  assert.equal(pinTableFor(undefined, "SSOP-28"), null);
  assert.equal(pinTableFor([], "SSOP-28"), null);
});

test("no table matches a count the document never printed", () => {
  const tables = [{ packageType: "SSOP-20", pins: Array.from({ length: 20 }, () => ({})) }];
  assert.equal(pinTableFor(tables, "28-Lead SSOP"), null);
});
