import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { createExportZip, FootprintUnavailableError, GeneratorUnavailableError } from "../exporters";
import { type PinRecord, type ResolvedPart } from "../types";

// A footprint is a manufacturing instruction. These tests are about the two ways
// this exporter has produced one that looked authoritative and was wrong: pads
// numbered in the wrong order, and pads sized from an invented pitch.

function pins(count: number): PinRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    number: String(index + 1),
    name: `P${index + 1}`,
    electricalType: "unspecified" as const
  }));
}

/**
 * An eight-lead SOIC with its OWN drawing read.
 *
 * These dimensions used to be absent, and a hand-typed family table supplied
 * them from the string `"8-pin SOIC"`. The table was deleted on 2026-08-14
 * because asserting a lead span from a package name is what `RULES.md` rule 1
 * forbids, so the fixture now carries what a datasheet actually states: the TI
 * D0008A drawing in the UCC27524 datasheet, JEDEC MS-012.
 *
 * The tests below are unchanged in what they assert. What changed is where the
 * numbers come from, which is the point.
 */
function soicPart(overrides: Partial<ResolvedPart> = {}): ResolvedPart {
  return {
    id: "test",
    partNumber: "ACME27524",
    manufacturer: "ACME",
    packageType: "8-pin SOIC",
    packageOutlineCode: null,
    jedecOutline: null,
    vendorLandPattern: null,
    exposedPad: false,
    pinCount: 8,
    pins: pins(8),
    dimensions: {
      bodyLengthMm: 4.9,
      bodyWidthMm: 3.9,
      bodyHeightMm: 1.75,
      pitchMm: 1.27,
      leadLengthMm: null,
      leadCount: 8,
      leadSides: 2,
      leadForm: "gullwing",
      mounting: null,
      leadDiameterMm: null,
      leadWidthMm: { minMm: 0.31, maxMm: 0.51 },
      leadSpanMm: { minMm: 5.8, maxMm: 6.2 },
      leadSpanCrossMm: null,
      leadContactMm: { minMm: 0.4, maxMm: 0.625 },
      thermalPadLengthMm: null, thermalPadWidthMm: null,
      landPadLengthMm: null,
      landPadWidthMm: null,
      landSpanMm: null,
      landSpanCrossMm: null,
      vacantLeadSlot: null,
      leadsPerSide: null,
      solderMaskExpansionMm: null,
      solderMaskDefined: null,
      thermalViaDiameterMm: null,
      thermalViaPitchMm: null
    },
    radiation: { tid: null, see: null, sel: null, qmlClass: null },
    sourceFileName: "ACME27524.pdf",
    notes: [],
    ...overrides
  };
}

async function filesFrom(part: ResolvedPart): Promise<Map<string, string>> {
  const bundle = await createExportZip(part, "kicad");
  const zip = await JSZip.loadAsync(bundle.buffer);
  const out = new Map<string, string>();
  for (const name of Object.keys(zip.files)) out.set(name, await zip.files[name].async("string"));
  return out;
}

/** Pad number to (x, y), parsed back out of the generated footprint. */
function padPositions(footprint: string): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  for (const line of footprint.split("\n")) {
    const match = /\(pad "([^"]+)" smd roundrect \(at (-?[\d.]+) (-?[\d.]+)\)/.exec(line.trim());
    if (match) positions.set(match[1], { x: Number(match[2]), y: Number(match[3]) });
  }
  return positions;
}

test("dual-row pads are numbered counterclockwise, not down both sides", async () => {
  // The bug this locks out: the old exporter ran both columns downward, putting
  // pin 5 of an 8-pin SOIC at the top right where pin 8 belongs. A board built
  // from that footprint is miswired, and nothing about the file looks wrong.
  const files = await filesFrom(soicPart());
  const footprint = files.get("acme27524.pretty/acme27524-8-pin-soic.kicad_mod");
  assert.ok(footprint, "a footprint must be emitted");

  const pads = padPositions(footprint);
  assert.equal(pads.size, 8, "all eight pads are present");

  const one = pads.get("1");
  const four = pads.get("4");
  const five = pads.get("5");
  const eight = pads.get("8");
  assert.ok(one && four && five && eight);

  // Pin 1 and pin 8 face each other across the package; so do 4 and 5.
  assert.ok(one.x < 0 && eight.x > 0, "pin 1 is on the left, pin 8 on the right");
  assert.equal(one.y, eight.y, "pin 1 and pin 8 sit on the same row");
  assert.equal(four.y, five.y, "pin 4 and pin 5 sit on the same row");
  assert.ok(four.y > one.y, "numbering runs down the left side");
  assert.ok(five.y > eight.y, "and back UP the right side, which is the whole point");
});

test("the symbol places every pin on the side its number belongs to", async () => {
  // The old symbol builder sorted pins by electrical type and then indexed both
  // sides off one running counter, so the columns collided.
  const files = await filesFrom(soicPart());
  const symbol = files.get("acme27524.kicad_sym");
  assert.ok(symbol);

  const placements = new Map<string, { x: number; y: number }>();
  for (const line of symbol.split("\n")) {
    const match = /\(pin \S+ line \(at (-?[\d.]+) (-?[\d.]+) \d+\).*\(number "([^"]+)"/.exec(line.trim());
    if (match) placements.set(match[3], { x: Number(match[1]), y: Number(match[2]) });
  }

  assert.equal(placements.size, 8, "every pin is drawn exactly once");
  const ys = [...placements.values()].map((placement) => `${placement.x},${placement.y}`);
  assert.equal(new Set(ys).size, 8, "no two pins share a coordinate");
  assert.ok(placements.get("1")!.x < 0 && placements.get("8")!.x > 0);
  assert.equal(placements.get("1")!.y, placements.get("8")!.y);
});

test("pad geometry comes from IPC-7351B, not from an invented pitch", async () => {
  const files = await filesFrom(soicPart());
  const footprint = files.get("acme27524.pretty/acme27524-8-pin-soic.kicad_mod");
  assert.ok(footprint);

  const pads = padPositions(footprint);
  // Published nominal SOIC-8 land: 0.60 x 1.55 lands on a 5.40 mm centre span.
  const size = /\(pad "1"[^\n]*\(size ([\d.]+) ([\d.]+)\)/.exec(footprint);
  assert.ok(size, "the pad must declare a size");
  assert.ok(Math.abs(Number(size[1]) - 1.55) < 0.05, `land length ${size[1]} should be about 1.55 mm`);
  assert.ok(Math.abs(Number(size[2]) - 0.6) < 0.05, `land width ${size[2]} should be about 0.60 mm`);
  assert.ok(
    Math.abs(Math.abs(pads.get("1")!.x) * 2 - 5.4) < 0.05,
    "centre-to-centre span should be about 5.40 mm"
  );

  // Adjacent pins on one side sit exactly one pitch apart.
  assert.ok(Math.abs(pads.get("2")!.y - pads.get("1")!.y - 1.27) < 0.001, "pitch is 1.27 mm");

  assert.match(footprint, /F\.CrtYd/, "a courtyard is drawn");
  assert.match(footprint, /IPC-7351B density level B/, "the file states what it was built to");
});

// --- The parts arrive attached to each other -----------------------------------
// A symbol and a footprint that the tool does not associate is two correct files
// and a manual step per part. These lock in that the bundle links itself up.

test("the KiCad symbol names the footprint, and the nickname is one the user gets by default", async () => {
  const files = await filesFrom(soicPart());
  const symbol = files.get("acme27524.kicad_sym");
  assert.ok(symbol);

  // The footprint ships in `acme27524.pretty/`, and KiCad nicknames a footprint
  // library after its folder, so `acme27524` is the nickname the user ends up
  // with by doing nothing. The reference has to match that or it dangles.
  assert.match(
    symbol,
    /\(property "Footprint" "acme27524:acme27524-8-pin-soic"/,
    "the symbol carries a resolvable footprint reference"
  );
  assert.ok(
    [...files.keys()].some((name) => name.startsWith("acme27524.pretty/")),
    "and the footprint really is in the folder that produces that nickname"
  );
});

test("the KiCad footprint references the 3D body that ships beside it", async () => {
  const files = await filesFrom(soicPart());
  const footprint = files.get("acme27524.pretty/acme27524-8-pin-soic.kicad_mod");
  assert.ok(footprint);

  assert.match(footprint, /\(model "\$\{KIPRJMOD\}\/acme27524\.step"/, "the body is referenced");
  assert.ok(files.has("acme27524.step"), "and the file it points at is in the bundle");
});


test("an exposed thermal pad refuses the footprint, on an otherwise buildable package", async () => {
  // The refusal that used to live in `normalizeModelPins`, where it also threw
  // away the pin table. Here the package is a plain characterised SOIC-8 and the
  // pinout is complete, so nothing but the pad is stopping it: the pad alone has
  // to be enough, because a footprint missing a mandatory soldered feature is a
  // board that does not work.
  await assert.rejects(
    () => createExportZip(soicPart({ exposedPad: true }), "kicad"),
    (error: unknown) => {
      assert.ok(error instanceof FootprintUnavailableError);
      assert.match(error.reason, /exposed thermal pad/);
      return true;
    }
  );

  // And the same part without the pad still builds, so the test above is really
  // testing the pad rather than some other gap in the fixture.
  const files = await filesFrom(soicPart());
  assert.ok(files.size > 0);
});


test("the manifest records what the footprint was built from", async () => {
  const files = await filesFrom(soicPart());
  const manifest = JSON.parse(files.get("manifest.json") ?? "{}");

    // The family is the datasheet's own designator now, not a table's name for it.
  assert.equal(manifest.footprint.family, "8-pin SOIC");
  assert.equal(manifest.footprint.densityLevel, "B");
  assert.equal(manifest.footprint.pitchMm, 1.27);
  // Where the numbers came from, which is now always one of two answers: this
  // datasheet's printed footprint, or this datasheet's package drawing plus the
  // standard's arithmetic. It used to be able to say "JEDEC MS-012", quoted from
  // a family table, about a document nobody had checked said so.
  assert.match(
    manifest.footprint.source,
    /this datasheet's own package drawing/,
    "the manifest says which of the two sources placed the copper"
  );
});

// --- Formats are peers, not conversions ---------------------------------------
// Altium and Cadence output used to be the KiCad text with a header glued on,
// which is a rename, not support. These lock in that a format either has its own
// generator reading the neutral geometry, or it refuses.

test("a format with no generator refuses instead of shipping a renamed file", async () => {
  // Cadence is the format still without a generator. Altium used to be here, and
  // the rule it was standing for has not moved: a format either has its own
  // generator reading the neutral geometry, or the export fails.
  await assert.rejects(
    () => createExportZip(soicPart(), "cadence"),
    (error: unknown) => {
      assert.ok(error instanceof GeneratorUnavailableError);
      assert.equal(error.format, "cadence");
      assert.ok(error.available.includes("kicad"), "the refusal says what does exist");
      assert.match(error.message, /does not emit a renamed file/i);
      return true;
    }
  );
});

test("the Altium bundle is native Altium, not the KiCad output under another name", async () => {
  // The precise old bug: `<part>.altium.symbol.txt` holding KiCad s-expressions.
  // Both Altium files are OLE compound documents, which is a thing the KiCad
  // emitter cannot accidentally produce.
  const bundle = await createExportZip(soicPart(), "altium");
  const zip = await JSZip.loadAsync(bundle.buffer);

  const names = Object.keys(zip.files);
  assert.ok(names.includes("acme27524.PcbLib"), "a footprint library");
  assert.ok(names.includes("acme27524.SchLib"), "and a symbol library, so the bundle is not half a part");

  const oleSignature = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  for (const name of ["acme27524.PcbLib", "acme27524.SchLib"]) {
    const content = await zip.files[name].async("nodebuffer");
    assert.ok(content.subarray(0, 8).equals(oleSignature), `${name} is not an OLE compound file`);
    assert.ok(!content.includes("kicad_symbol_lib"), `${name} carries KiCad text`);
    assert.ok(!content.includes("(footprint "), `${name} carries KiCad text`);
  }
});

test("no output file is ever produced by relabelling another format", async () => {
  // The exact shape of the old bug: a .txt carrying KiCad s-expressions under an
  // Altium-looking name.
  const files = await filesFrom(soicPart());
  for (const [name, content] of files) {
    if (/altium|cadence|allegro/i.test(name)) {
      assert.fail(`${name} looks like a foreign-format file emitted by the KiCad generator`);
    }
    if (name.endsWith(".txt")) {
      assert.ok(!/\(footprint |\(kicad_symbol_lib/.test(content), `${name} wraps KiCad syntax`);
    }
  }
});

test("the KiCad generator reads the neutral geometry, and the geometry is complete", async () => {
  // If the geometry is complete enough to drive KiCad, it is complete enough to
  // drive Altium and Cadence, which is the whole reason for the seam.
  const files = await filesFrom(soicPart());
  const footprint = files.get("acme27524.pretty/acme27524-8-pin-soic.kicad_mod");
  const symbol = files.get("acme27524.kicad_sym");
  assert.ok(footprint && symbol);

  // Everything a generator needs is present in the output: pads with positions
  // and sizes, a body, a courtyard, and a pin-1 marker.
  assert.equal((footprint.match(/\(pad /g) ?? []).length, 8);
  assert.match(footprint, /F\.Fab/, "body outline");
  assert.match(footprint, /F\.CrtYd/, "courtyard");
  assert.match(footprint, /fp_circle/, "pin 1 marker");
  assert.equal((symbol.match(/\(pin /g) ?? []).length, 8);
});

/**
 * The two refusals, and why the caller has to tell them apart.
 *
 * One is answerable and the other is not. A CFP needs a number nobody has
 * written down anywhere, so the user can supply it and get their footprint. An
 * uncharacterised package has no land pattern in our table, which is our gap to
 * close and not something anyone can type their way out of. Returning the same
 * error for both leaves the user with nothing to do in the case where there was
 * something to do.
 */

/** A ceramic flat pack: same drawing, plus the straight leads it actually has. */
function cfpPart(): ResolvedPart {
  return soicPart({
    packageType: "14-lead CFP",
    pinCount: 14,
    pins: pins(14),
    dimensions: { ...soicPart().dimensions, leadForm: "straight" }
  });
}

test("a refusal that the user can answer says exactly what it needs", async () => {
  await assert.rejects(
    // `leadForm: "straight"` is what makes this a flat pack, and it is READ off
    // the drawing: TI's HKU0010A shows leads 22.7 mm tip to tip on a 7 mm body,
    // straight, for the assembler to trim. A family table used to infer it from
    // the letters "CFP", which is a name rather than evidence.
    () => createExportZip(cfpPart(), "kicad"),
    (error: unknown) => {
      assert.ok(error instanceof FootprintUnavailableError);
      // TWO numbers since 2026-08-17, both made by the assembler's forming die:
      // the seated span and the seated FOOT. The drawing prints neither, and
      // demanding the foot off the drawing is what made every ceramic flat pack
      // fail the computed land path. Asked together rather than one per export
      // attempt.
      assert.deepEqual(
        error.needs.map((need) => need.field).sort(),
        ["formedLeadContactMm", "formedLeadSpanMm"]
      );
      for (const need of error.needs) {
        assert.equal(need.unit, "mm");
        assert.equal(need.scope, "install", "an assembler forms to one convention, not one per part");
        assert.match(need.why, /trims and forms|never bends/, "says why no datasheet has it");
      }
      return true;
    }
  );
});


test("answering the need produces the bundle", async () => {
  // Both formed numbers, because a flat pack's land is sized around a foot the
  // assembler makes. Supplying only the span used to be enough and produced a
  // land computed from a contact length read off a drawing that prints none.
  const bundle = await createExportZip(cfpPart(), "kicad", {
    formedLeadSpanMm: 10.16,
    formedLeadContactMm: 0.6
  });
  assert.ok(bundle.buffer.byteLength > 0);
});

test("a flat pack still refuses when only the span is answered", async () => {
  // The half-answered case. The foot is what the land is sized around, so a
  // pattern built without it would be invented geometry wearing a real number.
  await assert.rejects(
    () => createExportZip(cfpPart(), "kicad", { formedLeadSpanMm: 10.16 }),
    (error: unknown) => {
      assert.ok(error instanceof FootprintUnavailableError);
      assert.deepEqual(
        error.needs.map((need) => need.field),
        ["formedLeadContactMm"],
        "and asks only for what is still missing"
      );
      return true;
    }
  );
});






test("an odd lead count refuses rather than mis-placing the shorter row", async () => {
  // Two opposing rows of unequal length: where the shorter row's missing position
  // sits is a package convention, not something the pitch implies. On a five-lead
  // SOT-23 (JEDEC MO-178) the two-lead side takes the OUTER positions and the
  // middle one is empty; the pad loop indexes each row from its own top and would
  // put pin 4 in that empty middle. A pad where the part has no lead is a
  // miswired board, not a cosmetic defect.
  // Nine rather than five so the family's own 8-to-16 range check does not fire
  // first. Either way it is a refusal; this asserts it is refused for the RIGHT
  // reason, because the row placement is what would have been wrong.
  //
  // The designator has to declare nine too. It read "8-pin SOIC" while the
  // record carried nine pins, so the lead-count guard refused it first and this
  // test passed on a refusal about the wrong thing.
  const part = soicPart({ packageType: "9-pin SOIC", pinCount: 9, pins: pins(9) });

  await assert.rejects(
    () => createExportZip(part, "kicad"),
    (error: unknown) => {
      assert.ok(error instanceof FootprintUnavailableError);
      assert.match(error.reason, /odd number of leads/);
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// QUAD packages: four rows of leads on a square body.
//
// Laid out from the TI PN0080A drawing in the MSP430F5529 datasheet, which is
// where the LQFP-80 entry itself was read from. Its corner labels are the ground
// truth for the numbering: 1 and 20 at the top and bottom of the LEFT side, 21
// and 40 at the left and right of the BOTTOM, 41 and 60 at the bottom and top of
// the RIGHT, 61 and 80 at the right and left of the TOP.
// ---------------------------------------------------------------------------

function lqfpPart(overrides: Partial<ResolvedPart> = {}): ResolvedPart {
  return {
    ...soicPart(),
    partNumber: "ACME430F5529",
    packageType: "LQFP (80)",
    pinCount: 80,
    pins: pins(80),
    // The TI PN0080A drawing itself, rather than a family entry keyed on the
    // string "LQFP". JEDEC MS-026: 14.00 BSC span, 12 mm body, 0.5 pitch.
    dimensions: {
      bodyLengthMm: 12,
      bodyWidthMm: 12,
      bodyHeightMm: 1.6,
      pitchMm: 0.5,
      leadLengthMm: null,
      leadCount: 80,
      leadWidthMm: { minMm: 0.17, maxMm: 0.27 },
      leadSpanMm: { minMm: 13.8, maxMm: 14.2 },
      leadSpanCrossMm: null,
      leadContactMm: { minMm: 0.45, maxMm: 0.6 },
      thermalPadLengthMm: null, thermalPadWidthMm: null,
      landPadLengthMm: null,
      landPadWidthMm: null,
      landSpanMm: null,
      landSpanCrossMm: null,
      leadSides: 4,
      leadForm: "gullwing",
      mounting: null,
      leadDiameterMm: null,
      vacantLeadSlot: null,
      leadsPerSide: null,
      solderMaskExpansionMm: null,
      solderMaskDefined: null,
      thermalViaDiameterMm: null,
      thermalViaPitchMm: null
    },
    sourceFileName: "ACME430F5529.pdf",
    ...overrides
  };
}

test("a quad package puts its leads on four sides, counterclockwise from pin 1", async () => {
  const files = await filesFrom(lqfpPart());
  const footprint = files.get("acme430f5529.pretty/acme430f5529-lqfp-80.kicad_mod");
  assert.ok(footprint, "the footprint is named for the family it resolved to");

  const at = padPositions(footprint);
  assert.equal(at.size, 80, "every lead gets a land");

  // The drawing's own corner labels. Pin 1 is at the TOP of the left side, and
  // +y is DOWN, so it carries the most negative y of that side.
  const corner = (n: string) => `${at.get(n)!.x},${at.get(n)!.y}`;
  assert.equal(corner("1"), "-6.7,-4.75", "pin 1: top of the left side");
  assert.equal(corner("20"), "-6.7,4.75", "pin 20: bottom of the left side");
  assert.equal(corner("21"), "-4.75,6.7", "pin 21: left end of the bottom");
  assert.equal(corner("40"), "4.75,6.7", "pin 40: right end of the bottom");
  assert.equal(corner("41"), "6.7,4.75", "pin 41: bottom of the right side");
  assert.equal(corner("60"), "6.7,-4.75", "pin 60: top of the right side");
  assert.equal(corner("61"), "4.75,-6.7", "pin 61: right end of the top");
  assert.equal(corner("80"), "-4.75,-6.7", "pin 80: left end of the top");

  // 13.4 is the centre-to-centre span TI prints for this pattern, on both axes.
  assert.equal(at.get("1")!.x * -2, 13.4);
  assert.equal(at.get("21")!.y * 2, 13.4);
});

test("a quad package's top and bottom lands are turned 90 degrees", async () => {
  // A land is long in the direction its lead runs, which is outward from the
  // body. Emitting all four sides the same way round would put the top and
  // bottom lands across their leads instead of along them.
  const files = await filesFrom(lqfpPart());
  const footprint = files.get("acme430f5529.pretty/acme430f5529-lqfp-80.kicad_mod")!;

  const size = (pad: string) =>
    new RegExp(`\\(pad "${pad}" smd roundrect \\(at [^)]+\\) \\(size ([\\d.]+) ([\\d.]+)\\)`).exec(
      footprint
    )!;

  const left = size("1");
  const bottom = size("21");
  assert.ok(Number(left[1]) > Number(left[2]), "a left-side land is long across x");
  assert.ok(Number(bottom[2]) > Number(bottom[1]), "a bottom land is long across y");
  assert.equal(left[1], bottom[2], "and it is the same land, turned");
  assert.equal(left[2], bottom[1]);
});

test("a quad courtyard clears the lands on all four sides", async () => {
  // The dual case takes its height from the BODY, which on a quad would draw the
  // keep-out inside the top and bottom lands.
  const files = await filesFrom(lqfpPart());
  const footprint = files.get("acme430f5529.pretty/acme430f5529-lqfp-80.kicad_mod")!;
  const court = /\(fp_rect \(start (-?[\d.]+) (-?[\d.]+)\) \(end (-?[\d.]+) (-?[\d.]+)\) \(layer "F.CrtYd"/.exec(
    footprint
  )!;

  const half = Number(court[3]);
  assert.equal(Number(court[4]), half, "square, as the package is");
  const at = padPositions(footprint);
  const landOuterEdge = Math.abs(at.get("21")!.y) + 1.503 / 2;
  assert.ok(half > landOuterEdge, `courtyard ${half} must clear the outermost land at ${landOuterEdge}`);
});



// --- exposed thermal pads ------------------------------------------------------
//
// A thermal pad is a mandatory soldered feature, so a footprint that omits it is
// wrong and a footprint that pastes it solid is also wrong. Both failures look
// fine in CAD; the second one fails at reflow.

function vqfnPart(overrides: Partial<ResolvedPart> = {}): ResolvedPart {
  return soicPart({
    partNumber: "ACME8420",
    // EIGHT, matching `soicPart`'s pin table. This said `VQFN-16` while the
    // record carried eight pins, which is the contradiction the lead-count guard
    // in `buildFootprintGeometry` now refuses. The fixture was wrong, not the
    // guard: a footprint built from it would have been an eight-pad VQFN-16.
    packageType: "VQFN-8",
    exposedPad: true,
    dimensions: { ...soicPart().dimensions, thermalPadLengthMm: 2.1, thermalPadWidthMm: 1.8 },
    ...overrides
  });
}

test("an exposed pad whose size is unknown ASKS, because the drawing states it", async () => {
  // Was "still refuses". The pad size is dimensions D2 and E2 on the package
  // outline, so a part reaching here is one we failed to read, not one whose
  // datasheet withheld anything. Saying "no footprint is generated" reported our
  // gap as the document's. It still will not build a pad it cannot size; it just
  // asks for the two numbers instead of stopping.
  const padded = soicPart({ exposedPad: true });
  await assert.rejects(
    () => createExportZip(padded, "kicad"),
    (error: Error) => {
      const needs = (error as FootprintUnavailableError).needs.map((n) => n.field);
      assert.deepEqual(needs, ["thermalPadLengthMm", "thermalPadWidthMm"]);
      assert.match(error.message, /D2 and E2/);
      return true;
    }
  );
});

test("supplying the pad size builds the part, with no second read of the datasheet", async () => {
  const padded = soicPart({ exposedPad: true });
  const out = await createExportZip(padded, "kicad", {
    supplied: { thermalPadLengthMm: 2.15, thermalPadWidthMm: 1.2 }
  });
  assert.ok(out.files.length > 0);
});

test("a sized exposed pad becomes a real land, numbered after the leads", async () => {
  const files = await filesFrom(vqfnPart());
  const footprint = files.get("acme8420.pretty/acme8420-vqfn-8.kicad_mod");
  assert.ok(footprint, "the export succeeds once the pad can be built");

  // Pad 9 on an 8-pin part: the convention every CAD tool expects.
  const copper = /\(pad "9" smd roundrect \(at 0(?:\.0+)? 0(?:\.0+)?\) \(size ([\d.]+) ([\d.]+)\) \(property pad_prop_heatsink\) \(layers "F\.Cu" "F\.Mask"\)/.exec(footprint);
  assert.ok(copper, `a thermal land must be emitted; got:\n${footprint}`);
  // 1:1 with the pad, and on the pad's own axes. The fixture's D2 x E2 is
  // 2.1 x 1.8, and D2 is measured parallel to D, which this generator draws on
  // Y. So the emitted size is (E2, D2) and not (D2, E2).
  //
  // These two assertions read 2.1 then 1.8 until 2026-08-16, which is what the
  // generator did rather than what the drawing means: `bodyLengthMm` went to Y
  // and `thermalPadLengthMm` to X, so the pad sat ninety degrees from the body.
  // A square fixture cannot show that, and every thermal test before this one
  // used a square pad.
  assert.equal(Number(copper[1]), 1.8, "the land's X is the pad's WIDTH (E2)");
  assert.equal(Number(copper[2]), 2.1, "and its Y is the pad's LENGTH (D2), along the body's length");
  assert.ok(!/\(pad "9" smd roundrect[^\n]*F\.Paste/.test(footprint), "the COPPER carries no paste");
});

test("the thermal land's paste is an array, covering well under 100%", async () => {
  // The defect this prevents: a land pasted 1:1 floats the package on a bubble
  // of solder, lifting the perimeter leads clean off their lands, and the excess
  // escapes as balls. IPC-7093 puts the target between 50% and 80%.
  const files = await filesFrom(vqfnPart());
  const footprint = files.get("acme8420.pretty/acme8420-vqfn-8.kicad_mod")!;

  // An EMPTY pad number, which is how the reference library spells a paste-only
  // aperture: reusing the thermal pad's number declares each aperture a second
  // terminal with that number. See `emitKicadFootprint`.
  const apertures = [...footprint.matchAll(/\(pad "" smd rect \(at (-?[\d.]+) (-?[\d.]+)\) \(size ([\d.]+) ([\d.]+)\) \(layers "F\.Paste"\)/g)];
  assert.ok(apertures.length > 1, `paste must be subdivided, got ${apertures.length} aperture(s)`);

  const pasted = apertures.reduce((total, a) => total + Number(a[3]) * Number(a[4]), 0);
  const coverage = pasted / (2.1 * 1.8);
  assert.ok(coverage > 0.5 && coverage < 0.8, `coverage ${(coverage * 100).toFixed(0)}% must sit in the IPC-7093 band`);

  // Every aperture sits inside the land. Paste at the very edge bridges to the
  // perimeter lands.
  //
  // The land is 1.8 wide in X and 2.1 tall in Y: D2 runs along the body's
  // length, which this generator draws on Y. The apertures follow the land they
  // sit on, so they turn with it.
  for (const a of apertures) {
    assert.ok(Math.abs(Number(a[1])) + Number(a[3]) / 2 <= 1.8 / 2 + 1e-9, "aperture within the land in x");
    assert.ok(Math.abs(Number(a[2])) + Number(a[4]) / 2 <= 2.1 / 2 + 1e-9, "aperture within the land in y");
  }
});

test("Altium writes a windowed paste rather than refusing the part", async () => {
  // Inverted 2026-08-14. This asserted a refusal, on the reasoning that pasting
  // a thermal land solid floats the package off its leads and that refusing was
  // the honest option. The reasoning about reflow was right; the conclusion was
  // not. It failed EVERY QFN, DFN and SON part for Altium users, and a missing
  // feature reported as a principled stance is still a missing feature.
  //
  // The apertures now go on Top Paste and the copper pad has its own paste
  // suppressed, so the land is not pasted solid and the part builds.
  const padded = soicPart({
    exposedPad: true,
    dimensions: { ...soicPart().dimensions, thermalPadLengthMm: 2.15, thermalPadWidthMm: 1.2 }
  });
  const out = await createExportZip(padded, "altium");
  assert.ok(out.files.length > 0, "an exposed-pad part is exportable to Altium");
});

test("the exposed pad lies along the SAME axis as the body it is on the underside of", async () => {
  // ## The defect
  //
  // `bodyLengthMm` sets the fabrication outline's Y half-extent, and
  // `thermalPadLengthMm` set the thermal pad's X size. Two fields both called
  // "length", on opposite axes, so the pad came out turned ninety degrees from
  // the package it belongs to.
  //
  // It shipped silently. A rotated pad usually still fits between the lead rows,
  // so no invariant fires and nothing in CAD looks unusual. Every test that
  // touched a thermal pad before this used a SQUARE one (1.68 x 1.68), which is
  // the shape that cannot show the bug.
  //
  // ## Which one is right
  //
  // D2 is measured parallel to D on a package outline drawing, and `bodyLength`
  // is D. So the pad's length lies along the body's length. `thermalPadFitsBody`
  // in `confidence.ts` already compares length against length and width against
  // width, so the record check and the generator disagreed and the generator was
  // the wrong half.
  //
  // A dual package draws its lead rows down the left and right, so the body's
  // long axis is Y. The pad's long axis must be Y too.
  const part = soicPart({
    exposedPad: true,
    pins: [...pins(8), { number: "9", name: "GND", electricalType: "passive" as const }],
    dimensions: {
      ...soicPart().dimensions,
      // Body 4.9 long by 3.9 wide, pad 3.0 long by 1.6 wide. Both rectangular,
      // both on the same axis, which is what makes the orientation observable.
      bodyLengthMm: 4.9,
      bodyWidthMm: 3.9,
      thermalPadLengthMm: 3.0,
      thermalPadWidthMm: 1.6,
      landPadLengthMm: 1.4,
      landPadWidthMm: 0.6,
      landSpanMm: 5.0,
      landSpanCrossMm: null,
    }
  });

  const files = await filesFrom(part);
  const footprint = files.get("acme27524.pretty/acme27524-8-pin-soic.kicad_mod");
  assert.ok(footprint, "a footprint must be emitted");

  const pad = /\(pad "9" smd roundrect \(at [\d.-]+ [\d.-]+\) \(size ([\d.]+) ([\d.]+)\)/.exec(footprint);
  assert.ok(pad, "the thermal land must be emitted");
  const [, xMm, yMm] = pad.map(Number);

  assert.equal(yMm, 3.0, "the pad's LENGTH runs along the body's length, which is Y here");
  assert.equal(xMm, 1.6, "and its width across, which is X");
  assert.ok(
    yMm > xMm,
    "a pad longer than it is wide, on a body longer than it is wide, must agree about which way that is"
  );
});


/**
 * The land pattern the DATASHEET PRINTS wins over the one we would compute.
 *
 * This is the product's whole premise applied to the pads: every number comes
 * from the document the user uploaded. 36 of 39 hold-out datasheets print a
 * recommended footprint on a named page, and until 2026-08-12 none of it
 * reached the footprint. The pattern was computed from IPC-7351B plus a
 * hand-typed family table, and the vendor's own drawing was read only to VETO
 * that computation, which is the answer being used to check a substitute for
 * itself. It also let a TI house rule lay out an ST part while ST's own numbers
 * sat unread two pages away.
 *
 * The numbers below are the ones actually printed on page 34 of the INA240
 * datasheet, TI drawing PW0008A: `8X (1.5)`, `8X (0.45)`, `(5.8)`.
 */
function printedFixture(overrides: Partial<ResolvedPart["dimensions"]> = {}): ResolvedPart {
  const part = soicPart();
  return {
    ...part,
    dimensions: {
      ...part.dimensions,
      landPadLengthMm: 1.5,
      landPadWidthMm: 0.45,
      landSpanMm: 5.8,
      landSpanCrossMm: null,
      ...overrides
    }
  };
}

test("the datasheet's own printed footprint is used, not a computed one", async () => {
  const footprint = [...(await filesFrom(printedFixture())).entries()]
    .find(([name]) => name.endsWith(".kicad_mod"))![1];

  // Exactly what TI prints, to three decimals, with nothing derived.
  assert.match(footprint, /\(size 1\.500 0\.450\)/, "the vendor's land size, not ours");
  // Centre span 5.8 means each row sits 2.9 mm from the centre line.
  assert.match(footprint, /\(at -?2\.900 /, "each row at half the printed centre span");
});

test("the file says the pads are the vendor's, not the standard's", async () => {
  const footprint = [...(await filesFrom(printedFixture())).entries()]
    .find(([name]) => name.endsWith(".kicad_mod"))![1];

  // "The manufacturer recommends this" and "we derived this from IPC-7351B"
  // are different claims and a reviewer signing off a board must see which.
  assert.match(footprint, /RECOMMENDED FOOTPRINT PRINTED IN THIS DATASHEET/i);
});

test("a partial printed pattern is not used at all", async () => {
  // Filling the gaps from a computed pattern would emit a footprint that claims
  // to be the vendor's while being half ours. All three or none.
  const footprint = [...(await filesFrom(printedFixture({ landSpanMm: null }))).entries()]
    .find(([name]) => name.endsWith(".kicad_mod"))![1];

  assert.doesNotMatch(footprint, /RECOMMENDED FOOTPRINT PRINTED/i, "falls back to the computed path");
  assert.doesNotMatch(footprint, /\(size 1\.500 0\.450\)/, "and must not use the half it had");
});

test("printed lands that would overlap at the centre are refused", async () => {
  // A land longer than the whole centre span means the drawing was misread.
  // Emitting it would short every opposing pair together.
  const footprint = [...(await filesFrom(printedFixture({ landPadLengthMm: 9.0 }))).entries()]
    .find(([name]) => name.endsWith(".kicad_mod"))![1];

  assert.doesNotMatch(footprint, /RECOMMENDED FOOTPRINT PRINTED/i);
});


/**
 * A misread printed pattern must not reach a board.
 *
 * Before the printed pattern fed the footprint, it could only ever VETO a
 * computed one, so a misreading was harmless: the computation was what got
 * emitted. Now the printed numbers ARE the footprint, and nothing downstream
 * looks at them again. A decimal point read wrongly would be manufactured.
 *
 * Both checks below use the part's OWN mechanical dimensions, so they add no
 * outside assumption; they only ask whether the pattern is the size of the part.
 */
test("a land wider than the pitch is refused, because it would merge with its neighbour", async () => {
  const part = printedFixture({ landPadWidthMm: 1.4, pitchMm: 1.27 });
  const footprint = [...(await filesFrom(part)).entries()]
    .find(([name]) => name.endsWith(".kicad_mod"))![1];

  assert.doesNotMatch(footprint, /RECOMMENDED FOOTPRINT PRINTED/i);
});

test("a pattern out of proportion to the package is caught by the IPC band, not by a made-up factor", async () => {
  // Was "a pattern several times the size of the package is refused", against a
  // limit of 2x that I chose by reasoning rather than measuring. Deleted: the
  // band check does this job with the standard's own numbers, and a factor
  // nobody can source is exactly the kind of invented figure this codebase
  // otherwise refuses to carry.
  //
  // Same misread the old factor was aimed at, a centre span read as ten times
  // its real value, and the band still catches it.
  const out = await createExportZip(
    drawnPart({ landPadLengthMm: 1.1, landPadWidthMm: 0.4, landSpanMm: 24 }),
    "kicad"
  );
  assert.doesNotMatch(out.footprint.source, /printed in this datasheet/);
});

test("the real INA240 numbers pass both checks", async () => {
  // The guard must not refuse the case it was written around. Pitch is this
  // fixture's own 1.27 rather than the INA240's 0.65, because a SOIC declaring
  // a 0.65 pitch is refused earlier by the package resolver, which is a
  // different guard and correct.
  const part = printedFixture({ pitchMm: 1.27 });
  const footprint = [...(await filesFrom(part)).entries()]
    .find(([name]) => name.endsWith(".kicad_mod"))![1];

  assert.match(footprint, /RECOMMENDED FOOTPRINT PRINTED/i);
});

// ---------------------------------------------------------------------------
// The datasheet's own footprint, built WITHOUT the family table.
//
// The rule: every number describing a part comes from that part's datasheet,
// and where the document genuinely does not carry one, we ask.
//
// Measured 2026-08-13, before this existed: all 12 parts shipping from the
// tuned corpus were fed by the hand-typed family table, and that table refused
// SOT-23, SOT-10, TSOT and LFCSP outright. TLV9061 prints its whole footprint
// and was refused for having a package name the table had never heard of.
// ---------------------------------------------------------------------------

function printedPart(overrides: Partial<ResolvedPart["dimensions"]> = {}): ResolvedPart {
  return soicPart({
    packageType: "SOT-23",
    pinCount: 6,
    pins: pins(6),
    dimensions: {
      ...soicPart().dimensions,
      pitchMm: 0.95,
      // The package OUTLINE was not read for this part, only the recommended
      // footprint. Left null deliberately: inheriting the SOIC fixture's lead
      // span would put a 6 mm gull-wing's dimensions on a SOT-23, and the IPC
      // band check would then correctly refuse the very pattern under test.
      leadSpanMm: null,
      leadSpanCrossMm: null,
      leadContactMm: null,
      leadWidthMm: null,
      landPadLengthMm: 1.1,
      landPadWidthMm: 0.6,
      landSpanMm: 1.9,
      landSpanCrossMm: null,
      leadSides: 2,
      ...overrides
    }
  });
}

test("a package nothing has ever heard of still builds, from its own printed footprint", async () => {
  const out = await createExportZip(printedPart(), "kicad");
  assert.ok(out.files.length > 0, "no table is consulted, so an unfamiliar designator is not a problem");
  assert.match(
    out.footprint.source,
    /printed in this datasheet/,
    "and the provenance names the datasheet, not a standard or a table"
  );
});

test("the pads are the datasheet's numbers, not a computed substitute", async () => {
  const files = await filesFrom(printedPart());
  const name = [...files.keys()].find((f) => f.endsWith(".kicad_mod"));
  assert.ok(name, "a footprint must be emitted");
  const footprint = files.get(name)!;

  // 1.1 x 0.6 lands, exactly as the datasheet prints them.
  const size = /\(pad "1"[^\n]*\(size ([\d.]+) ([\d.]+)\)/.exec(footprint);
  assert.ok(size, "pad 1 has a size");
  assert.deepEqual([Number(size[1]), Number(size[2])].sort(), [0.6, 1.1]);

  // Centre span 1.9 means each row sits 0.95 from the centre line.
  const pads = padPositions(footprint);
  assert.equal(Math.abs(pads.get("1")!.x), 0.95);

  // And the record says where the numbers came from, so nobody has to guess.
  const kicad = [...files.keys()].find((f) => f.endsWith(".kicad_mod"))!;
  assert.match(files.get(kicad)!, /PRINTED IN THIS DATASHEET/);
});

test("without leadSides the printed footprint is not placed, because the rows are unknown", async () => {
  // Pad positions need to know whether this is two rows or four. That is on the
  // drawing; it is not something the pad sizes imply. Falls back rather than
  // guessing, and SOT-23 has no table entry, so it becomes a question.
  await assert.rejects(
    () => createExportZip(printedPart({ leadSides: null }), "kicad"),
    (error: Error) => error.name === "FootprintUnavailableError"
  );
});

test("a datasheet that prints no footprint ASKS, rather than refusing or inventing", async () => {
  const silent = printedPart({
    landPadLengthMm: null,
    landPadWidthMm: null,
    landSpanMm: null,
    landSpanCrossMm: null,
  });
  await assert.rejects(
    () => createExportZip(silent, "kicad"),
    (error: Error) => {
      const needs = (error as FootprintUnavailableError).needs.map((n) => n.field);
      assert.deepEqual(needs, ["landPadLengthMm", "landPadWidthMm", "landSpanMm"]);
      // Every ask says why the document cannot answer it.
      assert.ok((error as FootprintUnavailableError).needs.every((n) => n.why.length > 0));
      return true;
    }
  );
});

test("only the MISSING numbers are asked for", async () => {
  // Two of three read means one question, not four.
  const partial = printedPart({ landSpanMm: null });
  await assert.rejects(
    () => createExportZip(partial, "kicad"),
    (error: Error) => {
      assert.deepEqual((error as FootprintUnavailableError).needs.map((n) => n.field), ["landSpanMm"]);
      return true;
    }
  );
});

test("an odd lead count is refused on the datasheet path too, not just the table path", async () => {
  // SOT-23-5. Which position the short row leaves empty is drawn on the page and
  // is not implied by the pitch, so this refuses rather than misplacing a pad.
  const odd = soicPart({
    packageType: "SOT-23",
    pinCount: 5,
    pins: pins(5),
    dimensions: {
      ...soicPart().dimensions,
      pitchMm: 0.95,
      landPadLengthMm: 1.1,
      landPadWidthMm: 0.6,
      landSpanMm: 1.9,
      landSpanCrossMm: null,
      leadSides: 2
    }
  });
  await assert.rejects(
    () => createExportZip(odd, "kicad"),
    (error: Error) => /odd number of leads/.test(error.message)
  );
});

// ---------------------------------------------------------------------------
// Solder mask, read off the datasheet's own land pattern drawing.
//
// Found by an audit on 2026-08-13 that compared what 46 datasheets print
// against what the extractor asks for. 20 of 46 state a mask clearance beside
// the pad dimensions the generator was already reading, e.g. TI's
// "0.05 MIN ALL AROUND", and nothing carried it into the emitted footprint.
// ---------------------------------------------------------------------------

test("a mask clearance the datasheet states reaches the KiCad pad", async () => {
  const files = await filesFrom(printedPart({ solderMaskExpansionMm: 0.05 }));
  const name = [...files.keys()].find((f) => f.endsWith(".kicad_mod"))!;
  assert.match(files.get(name)!, /\(solder_mask_margin 0\.050\)/);
});

test("a datasheet that states no clearance emits none, rather than zero", async () => {
  // Not a nitpick. `solder_mask_margin 0` is an instruction to open the mask
  // exactly to the copper edge; absent means the board house's own default
  // applies. Writing zero for "not stated" would silently change the board.
  const files = await filesFrom(printedPart());
  const name = [...files.keys()].find((f) => f.endsWith(".kicad_mod"))!;
  assert.doesNotMatch(files.get(name)!, /solder_mask_margin/);
});

test("a stated clearance of zero is emitted, because that is a real instruction", async () => {
  const files = await filesFrom(printedPart({ solderMaskExpansionMm: 0 }));
  const name = [...files.keys()].find((f) => f.endsWith(".kicad_mod"))!;
  assert.match(files.get(name)!, /\(solder_mask_margin 0\.000\)/);
});

// ---------------------------------------------------------------------------
// Derived from the part's OWN package drawing, with no family table involved.
// ---------------------------------------------------------------------------

/** A drawing with lead dimensions but NO printed footprint. The common case. */
function drawnPart(overrides: Partial<ResolvedPart["dimensions"]> = {}): ResolvedPart {
  return soicPart({
    packageType: "SOT-23",
    pinCount: 6,
    pins: pins(6),
    dimensions: {
      ...soicPart().dimensions,
      pitchMm: 0.95,
      leadSides: 2,
      leadForm: "gullwing",
      mounting: null,
      leadDiameterMm: null,
      leadSpanMm: { minMm: 2.6, maxMm: 3.0 },
      leadSpanCrossMm: null,
      leadWidthMm: { minMm: 0.3, maxMm: 0.5 },
      leadContactMm: { minMm: 0.3, maxMm: 0.6 },
      ...overrides
    }
  });
}

test("a package with no printed footprint is derived from its own drawing", async () => {
  // 40 of 46 corpus datasheets print an outline; only 27 print a land pattern.
  // SOT-23 is in no table here, so this can only have come from the drawing.
  const out = await createExportZip(drawnPart(), "kicad");
  assert.ok(out.files.length > 0);
  assert.match(out.footprint.source, /computed from this datasheet's own package drawing/);
});

test("a no-lead package with no printed footprint asks, rather than being invented", async () => {
  // IPC-7351B publishes fillet goals per lead form and only the gull-wing table
  // is transcribed here, so a QFN has no model to be computed against. It used
  // to be laid out by a rule reverse-engineered from four TI drawings; that was
  // retired because nothing is invented. Now it asks.
  await assert.rejects(
    () => createExportZip(drawnPart({ leadForm: "nolead" }), "kicad"),
    (error: Error) => {
      assert.ok((error as FootprintUnavailableError).needs.length > 0, "and it is answerable");
      return true;
    }
  );
});

test("a no-lead package that DOES print its footprint still builds from it", async () => {
  // The common case, and the one that matters: retiring the invented rule must
  // not cost a part whose own datasheet states the answer.
  const out = await createExportZip(
    drawnPart({
      leadForm: "nolead",
      mounting: null,
      leadDiameterMm: null,
      landPadLengthMm: 0.8,
      landPadWidthMm: 0.3,
      landSpanMm: 2.6,
      landSpanCrossMm: null,
    }),
    "kicad"
  );
  assert.match(out.footprint.source, /printed in this datasheet/);
});


test("an unread lead form with no lead span refuses, rather than guessing a form", async () => {
  await assert.rejects(
    () => createExportZip(drawnPart({ leadForm: null, leadSpanMm: null }), "kicad"),
    (error: Error) => error.name === "FootprintUnavailableError"
  );
});

// ---------------------------------------------------------------------------
// The band check. A vendor pattern between IPC Least and Most is a design
// choice; one outside it is a misread.
// ---------------------------------------------------------------------------

test("a printed pattern inside the IPC band is accepted", async () => {
  const out = await createExportZip(
    drawnPart({ landPadLengthMm: 1.1, landPadWidthMm: 0.4, landSpanMm: 2.4 }),
    "kicad"
  );
  assert.match(out.footprint.source, /printed in this datasheet/);
});

test("a printed pattern outside the IPC band is not used, and the output says so", async () => {
  // A decimal point read wrongly: a 2.4 mm span becomes 24. The band catches it
  // where the invented guards did not. The part still builds, from the drawing,
  // because refusing a part whose outline we can read would be worse; what must
  // not happen is using the out-of-band pattern, or swapping silently.
  const out = await createExportZip(
    drawnPart({ landPadLengthMm: 1.1, landPadWidthMm: 0.4, landSpanMm: 24 }),
    "kicad"
  );
  assert.doesNotMatch(out.footprint.source, /printed in this datasheet/);
  assert.match(out.footprint.source, /computed from this datasheet's own package drawing/);
});

// ---------------------------------------------------------------------------
// Odd pin counts, placed from the vacant slot read off the pinout.
// ---------------------------------------------------------------------------

test("a five-lead package places its leads around the gap the pinout shows", async () => {
  const sot235 = drawnPart({});
  const odd = { ...sot235, pinCount: 5, pins: pins(5) };
  odd.dimensions = { ...odd.dimensions, vacantLeadSlot: 2 };

  const files = await filesFrom(odd);
  const name = [...files.keys()].find((f) => f.endsWith(".kicad_mod"))!;
  const pads = padPositions(files.get(name)!);

  assert.equal(pads.size, 5, "five leads, five pads");
  // Three slots per side. Pin 5 takes the first slot on the right, pin 4 the
  // third, and the middle is empty. Filling from the top instead would put pin
  // 4 where the package has nothing.
  assert.equal(pads.get("5")!.y, pads.get("1")!.y, "pin 5 sits opposite pin 1");
  assert.equal(pads.get("4")!.y, pads.get("3")!.y, "pin 4 sits opposite pin 3");
  assert.ok(!Object.is(pads.get("4")!.y, pads.get("2")!.y), "and nothing sits opposite pin 2");
});

test("an odd count with no vacant slot read still refuses, and asks", async () => {
  const odd = { ...drawnPart(), pinCount: 5, pins: pins(5) };
  await assert.rejects(
    () => createExportZip(odd, "kicad"),
    (error: Error) => {
      assert.match(error.message, /was not read/);
      assert.ok((error as FootprintUnavailableError).needs.length > 0, "and it asks");
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// Thermal vias.
// ---------------------------------------------------------------------------

test("thermal vias the datasheet dimensions are emitted, and carry no pin number", async () => {
  const padded = soicPart({
    exposedPad: true,
    dimensions: {
      ...soicPart().dimensions,
      pitchMm: 0.65,
      leadSides: 2,
      leadForm: "gullwing",
      mounting: null,
      leadDiameterMm: null,
      leadSpanMm: { minMm: 4.9, maxMm: 5.1 },
      leadSpanCrossMm: null,
      leadWidthMm: { minMm: 0.2, maxMm: 0.3 },
      leadContactMm: { minMm: 0.4, maxMm: 0.6 },
      thermalPadLengthMm: 2.15,
      thermalPadWidthMm: 1.2,
      thermalViaDiameterMm: 0.35,
      thermalViaPitchMm: 0.8
    }
  });
  const files = await filesFrom(padded);
  const name = [...files.keys()].find((f) => f.endsWith(".kicad_mod"))!;
  const text = files.get(name)!;

  const vias = text.split("\n").filter((line) => line.includes('(pad "" thru_hole'));
  assert.ok(vias.length > 0, "the datasheet stated vias, so vias are emitted");
  // An empty pad number is what keeps them out of the netlist. Numbering them
  // would make each via a phantom terminal.
  assert.ok(vias.every((line) => /\(pad "" /.test(line)));
  assert.ok(vias.every((line) => /\(drill 0\.350\)/.test(line)));
});

test("no via data means no vias, rather than a guessed grid", async () => {
  const padded = soicPart({
    exposedPad: true,
    dimensions: { ...soicPart().dimensions, thermalPadLengthMm: 2.15, thermalPadWidthMm: 1.2 }
  });
  const files = await filesFrom(padded);
  const name = [...files.keys()].find((f) => f.endsWith(".kicad_mod"));
  if (!name) return;
  assert.doesNotMatch(files.get(name)!, /thru_hole/);
});

// ---------------------------------------------------------------------------
// A quad package whose sides are NOT equal
// ---------------------------------------------------------------------------

/**
 * The 38-lead quad, laid out as KiCad's own library lays one out.
 *
 * `QFN-38-1EP_4x6mm_P0.4mm_EP2.65x4.65mm` in the official `Package_DFN_QFN`
 * library puts twelve leads on each long side at -2.2 to +2.2 and seven on each
 * short side at -1.2 to +1.2, every row symmetric about its own centre line and
 * the odd count putting a lead ON that line. That file is the source for both
 * the division and the placement asserted here.
 *
 * What this locks out is not a rounding difference. Until 2026-08-14 the pad
 * placer divided the pin count by four whatever `leadsPerSide` said, so a 38
 * lead part produced `Array.from({ length: 9.5 })`, nine pads a side, and pads
 * numbered `10.5` and `29.5` for pins that do not exist. It was emitted without
 * complaint.
 */
function unequalQuadPart(overrides: Partial<ResolvedPart> = {}): ResolvedPart {
  return {
    ...soicPart(),
    partNumber: "ACME38",
    packageType: "QFN-38",
    pinCount: 38,
    pins: pins(38),
    dimensions: {
      ...soicPart().dimensions,
      bodyLengthMm: 6,
      bodyWidthMm: 4,
      pitchMm: 0.4,
      leadCount: 38,
      leadSides: 4,
      leadsPerSide: "12,7,12,7",
      landPadLengthMm: 0.8,
      landPadWidthMm: 0.2,
      landSpanMm: 4.0,
      landSpanCrossMm: null,
    },
    sourceFileName: "ACME38.pdf",
    ...overrides
  };
}

test("an unequal quad uses the per-side counts it read, and every pad is a real pin", async () => {
  const files = await filesFrom(unequalQuadPart());
  const footprint = files.get("acme38.pretty/acme38-qfn-38.kicad_mod");
  assert.ok(footprint, "a footprint is emitted");

  const at = padPositions(footprint);
  assert.equal(at.size, 38, "every lead gets a land, and there are no extras");
  for (const number of at.keys()) {
    assert.match(number, /^\d+$/, `pad "${number}" is numbered for a pin that exists`);
  }

  // Twelve down the left, seven across the bottom, twelve up the right, seven
  // back across the top. Counterclockwise, as on every other package here.
  assert.deepEqual(at.get("1"), { x: -2, y: -2.2 }, "pin 1: top of the long left side");
  assert.deepEqual(at.get("12"), { x: -2, y: 2.2 }, "pin 12: bottom of the long left side");
  assert.deepEqual(at.get("13"), { x: -1.2, y: 2 }, "pin 13: left end of the short bottom side");
  assert.deepEqual(at.get("19"), { x: 1.2, y: 2 }, "pin 19: right end of the short bottom side");
  assert.deepEqual(at.get("38"), { x: -1.2, y: -2 }, "pin 38: back at the left end of the top");

  // Each side is centred on ITSELF, so the seven-lead row has a lead on the
  // centre line rather than being packed against one end.
  assert.deepEqual(at.get("16"), { x: 0, y: 2 }, "the middle lead of an odd row sits on the centre line");
});

test("a quad whose count does not divide by four, with nothing read, asks rather than approximating", async () => {
  const part = unequalQuadPart({
    dimensions: { ...unequalQuadPart().dimensions, leadsPerSide: null }
  });
  await assert.rejects(
    () => createExportZip(part, "kicad"),
    (error: unknown) => {
      assert.ok(error instanceof FootprintUnavailableError);
      assert.deepEqual(
        error.needs.map((need) => need.field),
        ["leadsPerSide"],
        "the question names the field the export route accepts"
      );
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// RECTANGULAR quads: two spans, not one.
//
// A four-sided package carried ONE centre span and both axes used it, which is
// correct only for a square. Most are not: ADXL345 is a 3 x 5 mm LGA-14 with
// sides of 6, 2, 4, 2. Placing its long axis at the short axis's span drove the
// corner lands into each other and the corner check refused the whole part.
//
// The refusal was right and the cause was not a misreading. The document states
// both numbers; the prompt asked for one and told the model to discard the
// other, so the record described a square package that does not exist.
//
// Worth stating what the guard could NOT do: it only fires when the error is
// large enough to short two lands. A mildly rectangular package was placed
// slightly wrong and shipped, which is why this is fixed rather than guarded.
// ---------------------------------------------------------------------------

test("a rectangular quad places each axis on its own span", async () => {
  const part = unequalQuadPart({
    dimensions: {
      ...unequalQuadPart().dimensions,
      // 12 lands down each long side, 7 across each short one.
      landSpanMm: 4.0,
      landSpanCrossMm: 6.0
    }
  });

  const files = await filesFrom(part);
  const footprint = files.get("acme38.pretty/acme38-qfn-38.kicad_mod");
  assert.ok(footprint, "a footprint is emitted");
  const at = padPositions(footprint);

  // Left and right sit on landSpanMm, the axis landPadLengthMm runs along.
  assert.equal(at.get("1")?.x, -2, "the left row sits at half the main span");
  assert.equal(at.get("20")?.x, 2, "and the right row opposite it");

  // Top and bottom sit on the OTHER span, which is what used to be lost.
  assert.equal(at.get("16")?.y, 3, "the bottom row sits at half the CROSS span, not the main one");
  assert.equal(at.get("35")?.y, -3, "and the top row opposite it");
});

test("a square quad still places both axes on the one span it has", async () => {
  // The control. `landSpanCrossMm` is null on every two-sided package and on a
  // square quad, and falling back to the single span is exactly right there.
  const files = await filesFrom(unequalQuadPart());
  const footprint = files.get("acme38.pretty/acme38-qfn-38.kicad_mod");
  assert.ok(footprint);
  const at = padPositions(footprint);
  assert.equal(at.get("1")?.x, -2);
  assert.equal(at.get("16")?.y, 2, "with no cross span, the second axis uses the first");
});
