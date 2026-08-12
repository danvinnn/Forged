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

function soicPart(overrides: Partial<ResolvedPart> = {}): ResolvedPart {
  return {
    id: "test",
    partNumber: "ACME27524",
    manufacturer: "ACME",
    packageType: "8-pin SOIC",
    packageOutlineCode: null,
    vendorLandPattern: null,
    exposedPad: false,
    pinCount: 8,
    pins: pins(8),
    dimensions: {
      bodyLengthMm: 4.9,
      bodyWidthMm: 3.9,
      bodyHeightMm: 1.75,
      pitchMm: null,
      leadLengthMm: null,
      leadCount: 8,
      leadWidthMm: null, leadSpanMm: null, leadContactMm: null,
      thermalPadLengthMm: null, thermalPadWidthMm: null
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
  const footprint = files.get("acme27524.pretty/acme27524-soic-narrow.kicad_mod");
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
  const footprint = files.get("acme27524.pretty/acme27524-soic-narrow.kicad_mod");
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
    /\(property "Footprint" "acme27524:acme27524-soic-narrow"/,
    "the symbol carries a resolvable footprint reference"
  );
  assert.ok(
    [...files.keys()].some((name) => name.startsWith("acme27524.pretty/")),
    "and the footprint really is in the folder that produces that nickname"
  );
});

test("the KiCad footprint references the 3D body that ships beside it", async () => {
  const files = await filesFrom(soicPart());
  const footprint = files.get("acme27524.pretty/acme27524-soic-narrow.kicad_mod");
  assert.ok(footprint);

  assert.match(footprint, /\(model "\$\{KIPRJMOD\}\/acme27524\.step"/, "the body is referenced");
  assert.ok(files.has("acme27524.step"), "and the file it points at is in the bundle");
});

test("an uncharacterised package refuses the whole export", async () => {
  // Not a degraded bundle. Shipping a symbol and a 3D body while quietly
  // omitting the footprint reads as success to anyone who does not check.
  await assert.rejects(
    () => createExportZip(soicPart({ packageType: "12-Pin BGA", pinCount: 12, pins: pins(12) }), "kicad"),
    (error: unknown) => {
      assert.ok(error instanceof FootprintUnavailableError);
      assert.match(error.reason, /12-Pin BGA/);
      assert.ok(error.supportedFamilies.length > 0, "the refusal says what would work");
      return true;
    }
  );
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

test("an unknown package refuses rather than defaulting the pitch to 1.27", async () => {
  // The precise old behaviour: packageType "Unknown package" fell through to a
  // 1.27 mm default and produced a footprint for a part whose pitch nobody read.
  await assert.rejects(
    () => createExportZip(soicPart({ packageType: "Unknown package" }), "kicad"),
    FootprintUnavailableError
  );
});

test("the manifest records what the footprint was built from", async () => {
  const files = await filesFrom(soicPart());
  const manifest = JSON.parse(files.get("manifest.json") ?? "{}");

  assert.equal(manifest.footprint.family, "SOIC narrow");
  assert.equal(manifest.footprint.densityLevel, "B");
  assert.equal(manifest.footprint.pitchMm, 1.27);
  assert.match(manifest.footprint.source, /MS-012/, "the lead data cites its drawing");
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
  const footprint = files.get("acme27524.pretty/acme27524-soic-narrow.kicad_mod");
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

test("a refusal that the user can answer says exactly what it needs", async () => {
  await assert.rejects(
    () => createExportZip(soicPart({ packageType: "14-lead CFP", pinCount: 14, pins: pins(14) }), "kicad"),
    (error: unknown) => {
      assert.ok(error instanceof FootprintUnavailableError);
      assert.equal(error.needs.length, 1);
      const need = error.needs[0];
      assert.equal(need.field, "formedLeadSpanMm", "names the request field that answers it");
      assert.equal(need.unit, "mm");
      assert.equal(need.scope, "install", "an assembler forms to one convention, not one per part");
      assert.match(need.why, /trims and forms|never bends/, "says why no datasheet has it");
      return true;
    }
  );
});

test("a refusal the user cannot answer offers nothing to fill in", async () => {
  await assert.rejects(
    () => createExportZip(soicPart({ packageType: "12-Pin BGA", pinCount: 12, pins: pins(12) }), "kicad"),
    (error: unknown) => {
      assert.ok(error instanceof FootprintUnavailableError);
      assert.deepEqual(error.needs, [], "no characterised land pattern is our gap, not their input");
      return true;
    }
  );
});

test("answering the need produces the bundle", async () => {
  const bundle = await createExportZip(
    soicPart({ packageType: "14-lead CFP", pinCount: 14, pins: pins(14) }),
    "kicad",
    { formedLeadSpanMm: 10.16 }
  );
  assert.ok(bundle.buffer.byteLength > 0);
});

/**
 * The part's own mechanical drawing, used to check the hand-entered families.
 *
 * Every entry in packages.ts was read off ONE vendor drawing and then applied to
 * a family. The part in front of us carries the evidence to test that, and the
 * case that made this urgent was real: an ISO7741 calls itself a "16-pin SOIC"
 * in its own front matter and is a DW0016B wide body. Resolved from the prose
 * alone it exported 16 pads at 5.376 mm centre to centre, against the 9.3 mm
 * pattern TI prints in that same datasheet. Every pad was 1.96 mm inboard of its
 * lead, on a part that passes every other check the exporter makes.
 */
test("the outline code tells a wide-body SOIC from a narrow one", async () => {
  const wide = await createExportZip(
    soicPart({
      packageType: "16-pin SOIC",
      packageOutlineCode: "DW0016B",
      pinCount: 16,
      pins: pins(16)
    }),
    "kicad"
  );

  assert.equal(wide.footprint.family, "SOIC wide");
  assert.equal(wide.footprint.centreToCentreMm, 9.301, "the pattern TI prints for this outline");

  // Same designator, no drawing to confirm it, so the prose stands on its own.
  const narrow = await createExportZip(
    soicPart({ packageType: "16-pin SOIC", pinCount: 16, pins: pins(16) }),
    "kicad"
  );
  assert.equal(narrow.footprint.family, "SOIC narrow");
});

test("a drawn pitch that contradicts the family refuses rather than placing pads", async () => {
  // 0.65 is a real TSSOP pitch and this part resolves to SOIC narrow at 1.27.
  // One of the two is about a different package. Placing pads on either would
  // produce a file nothing downstream can tell is wrong.
  await assert.rejects(
    () => createExportZip(soicPart({ dimensions: { ...soicPart().dimensions, pitchMm: 0.65 } }), "kicad"),
    (error: unknown) => {
      assert.ok(error instanceof FootprintUnavailableError);
      assert.match(error.message, /0\.65/);
      assert.match(error.message, /different package/);
      return true;
    }
  );
});

test("a drawn lead width is used in place of the family's", async () => {
  const narrower = await createExportZip(
    soicPart({ dimensions: { ...soicPart().dimensions, leadWidthMm: { minMm: 0.2, maxMm: 0.3 }, leadSpanMm: null, leadContactMm: null } }),
    "kicad"
  );
  const family = await createExportZip(soicPart(), "kicad");

  assert.ok(
    narrower.footprint.padWidthMm < family.footprint.padWidthMm,
    "a narrower lead gets a narrower land, through IPC-7351B Xmax"
  );
  assert.match(
    narrower.footprint.source,
    /own package drawing/,
    "and the manifest says the width came from this part rather than the family"
  );
});

test("a drawn pitch that agrees with the family changes nothing", async () => {
  const drawn = await createExportZip(
    soicPart({ dimensions: { ...soicPart().dimensions, pitchMm: 1.27 } }),
    "kicad"
  );
  assert.equal(drawn.footprint.family, "SOIC narrow");
  assert.equal(drawn.footprint.centreToCentreMm, 5.376);
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
  const part = soicPart({ pinCount: 9, pins: pins(9) });

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
    dimensions: {
      bodyLengthMm: 12,
      bodyWidthMm: 12,
      bodyHeightMm: 1.6,
      pitchMm: null,
      leadLengthMm: null,
      leadCount: 80,
      leadWidthMm: null, leadSpanMm: null, leadContactMm: null,
      thermalPadLengthMm: null, thermalPadWidthMm: null
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

test("a quad lead count the entry does not cover refuses rather than being placed", async () => {
  // Body size and lead span move with the lead count on these families: an
  // LQFP-100 is 14 mm square where the 80 is 12, so there is nothing to
  // interpolate. The count is refused before any pad is placed.
  //
  // This lands on the pin-count range rather than on the divide-by-four guard in
  // `buildFootprintGeometry`, because the only quad entry today is exactly 80
  // leads. That guard is unreachable for the same reason the dual case's
  // odd-count guard is: it exists so that adding a family with a RANGE cannot
  // silently produce a short side.
  await assert.rejects(
    () => createExportZip(lqfpPart({ pinCount: 78, pins: pins(78) }), "kicad"),
    (error: unknown) => {
      assert.ok(error instanceof FootprintUnavailableError);
      assert.match(error.message, /not 78/);
      return true;
    }
  );
});

test("a quad package can never take a dual-row entry's geometry", async () => {
  // The trap this guard was written for: `FLATPACK` is how a ceramic DUAL flat
  // pack is written and it is also the middle of `PLASTIC QUAD FLATPACK`, the
  // title of every TI LQFP and VQFN drawing. Handing a quad package the CFP lead
  // dimensions would be the worst answer this table could give, so a quad
  // designator is only ever matched against entries written as quads.
  await assert.rejects(
    () =>
      createExportZip(
        lqfpPart({ packageType: "48-lead PLASTIC QUAD FLATPACK", pinCount: 48, pins: pins(48) }),
        "kicad"
      ),
    (error: unknown) => {
      assert.ok(error instanceof FootprintUnavailableError);
      assert.match(error.message, /quad flat pack/);
      return true;
    }
  );
});

// --- exposed thermal pads ------------------------------------------------------
//
// A thermal pad is a mandatory soldered feature, so a footprint that omits it is
// wrong and a footprint that pastes it solid is also wrong. Both failures look
// fine in CAD; the second one fails at reflow.

function vqfnPart(overrides: Partial<ResolvedPart> = {}): ResolvedPart {
  return soicPart({
    partNumber: "ACME8420",
    packageType: "8-pin SOIC",
    exposedPad: true,
    dimensions: { ...soicPart().dimensions, thermalPadLengthMm: 2.1, thermalPadWidthMm: 1.8 },
    ...overrides
  });
}

test("an exposed pad whose size is unknown still refuses", async () => {
  await assert.rejects(
    () => createExportZip(soicPart({ exposedPad: true }), "kicad"),
    (error: unknown) => {
      assert.ok(error instanceof FootprintUnavailableError);
      assert.match(error.reason, /size was not read/);
      assert.match(error.reason, /D2 and E2/, "and says where to find it");
      return true;
    }
  );
});

test("a sized exposed pad becomes a real land, numbered after the leads", async () => {
  const files = await filesFrom(vqfnPart());
  const footprint = files.get("acme8420.pretty/acme8420-soic-narrow.kicad_mod");
  assert.ok(footprint, "the export succeeds once the pad can be built");

  // Pad 9 on an 8-pin part: the convention every CAD tool expects.
  const copper = /\(pad "9" smd roundrect \(at 0(?:\.0+)? 0(?:\.0+)?\) \(size ([\d.]+) ([\d.]+)\) \(layers "F\.Cu" "F\.Mask"\)/.exec(footprint);
  assert.ok(copper, `a thermal land must be emitted; got:\n${footprint}`);
  assert.equal(Number(copper[1]), 2.1, "the land is 1:1 with the exposed pad");
  assert.equal(Number(copper[2]), 1.8);
  assert.ok(!/\(pad "9" smd roundrect[^\n]*F\.Paste/.test(footprint), "the COPPER carries no paste");
});

test("the thermal land's paste is an array, covering well under 100%", async () => {
  // The defect this prevents: a land pasted 1:1 floats the package on a bubble
  // of solder, lifting the perimeter leads clean off their lands, and the excess
  // escapes as balls. IPC-7093 puts the target between 50% and 80%.
  const files = await filesFrom(vqfnPart());
  const footprint = files.get("acme8420.pretty/acme8420-soic-narrow.kicad_mod")!;

  const apertures = [...footprint.matchAll(/\(pad "9" smd rect \(at (-?[\d.]+) (-?[\d.]+)\) \(size ([\d.]+) ([\d.]+)\) \(layers "F\.Paste"\)/g)];
  assert.ok(apertures.length > 1, `paste must be subdivided, got ${apertures.length} aperture(s)`);

  const pasted = apertures.reduce((total, a) => total + Number(a[3]) * Number(a[4]), 0);
  const coverage = pasted / (2.1 * 1.8);
  assert.ok(coverage > 0.5 && coverage < 0.8, `coverage ${(coverage * 100).toFixed(0)}% must sit in the IPC-7093 band`);

  // Every aperture sits inside the land. Paste at the very edge bridges to the
  // perimeter lands.
  for (const a of apertures) {
    assert.ok(Math.abs(Number(a[1])) + Number(a[3]) / 2 <= 2.1 / 2 + 1e-9, "aperture within the land in x");
    assert.ok(Math.abs(Number(a[2])) + Number(a[4]) / 2 <= 1.8 / 2 + 1e-9, "aperture within the land in y");
  }
});

test("Altium refuses a windowed paste rather than pasting it solid", async () => {
  // The writer cannot express paste that differs from copper. Emitting the pad
  // anyway would produce a file that opens correctly and fails at reflow, so it
  // refuses and names the format that can.
  await assert.rejects(
    () => createExportZip(vqfnPart(), "altium"),
    (error: unknown) => {
      assert.match((error as Error).message, /thermal pad|paste/i);
      return true;
    }
  );
});
