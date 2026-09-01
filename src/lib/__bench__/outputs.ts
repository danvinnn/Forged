/**
 * CORRUPT EVERY VALUE THAT REACHES AN OUTPUT FILE. Does the export gate object?
 *
 * ## The gap this fills
 *
 * `bench:unchecked` corrupts the RECORD values that place copper, and asks
 * whether a confirmation still vouches for them. `bench:symbol` does the same
 * for the netlist. Between them they cover the values a MODEL read.
 *
 * Neither touches the geometry the generator BUILDS from those values, and that
 * is a separate population with its own failure modes. Derived on 2026-08-30 by
 * reading what the emitters actually dereference rather than from memory:
 *
 *     FootprintGeometry  name description partNumber pads body courtyard
 *                        pin1Marker thermalVias provenance
 *     Pad                number centre widthMm heightMm shape mounting drillMm
 *     SymbolGeometry     name partNumber body bodyCentreYMm pins description
 *     SymbolPin          number name anchor side lengthMm electricalType
 *
 * Of those, `bench:courtyard` watches the courtyard, `bench:copper` watches the
 * pad positions, `bench:joints` watches the pad sizes against the leads, and
 * `bench:emitters` watches KiCad against Altium. Nothing watched the pin-1
 * marker, the drill, the paste apertures, the silkscreen body or the symbol's
 * anchors - and a wrong pin-1 marker is a part soldered down rotated, which is a
 * board in the bin rather than a value to re-check.
 *
 * ## What it asks
 *
 * `validateGeometry` is the gate every export passes through. So: take a
 * footprint and symbol that pass it, break one emitted value, and see whether
 * the gate still lets it out. A corruption that passes is a file that can ship
 * wrong with nothing in the product looking at it.
 *
 * ## What is deliberately NOT mutated, and why
 *
 * Phase C's rule is that every field an emitter reads is either caught, flagged,
 * or listed here with a reason. The rest of the emitted surface:
 *
 *     name, description, partNumber   Labels. Wrong text is visible the moment
 *                                     the library is opened and costs a rename,
 *                                     not a board. `bench:emitters` already
 *                                     checks the two formats agree on them.
 *     provenance                      Never written to a CAD file. It is the
 *                                     record of where the copper came from, and
 *                                     `bench:copper` measures the copper itself.
 *     pad.shape, pad.mounting         Structural: a wrong value here does not
 *                                     produce a subtly wrong file, it produces
 *                                     one the emitter refuses or the reader
 *                                     rejects, and `bench:kicad` opens every
 *                                     emitted file with the real tool.
 *     symbol.side, bodyCentreYMm      Layout only. A pin on the wrong side of a
 *                                     symbol is wrong-looking, not wrong-wired;
 *                                     the netlist is carried by number and name,
 *                                     which `bench:symbol` mutates directly.
 *
 * REFUSED IS NOT THE SAME AS CAUGHT. A mutation that makes the build throw
 * before the gate runs proves nothing about the gate, so those are counted
 * separately rather than scored as successes.
 *
 * Free: cached answers off disk, no network, no spend.
 */

import { buildFootprintGeometry, buildSymbolGeometry } from "../exporters";
import { validateGeometry, validateSymbol } from "../confidence";
import { replayRecords } from "./replay";
import { BENCH_SETTINGS } from "./shipcheck";
import { densityOf } from "../settings";
import type { FootprintGeometry, SymbolGeometry } from "../geometry";

interface Mutation {
  name: string;
  /** What shipping this wrong would do on a real board. */
  costs: string;
  footprint?: (geometry: FootprintGeometry) => FootprintGeometry;
  symbol?: (symbol: SymbolGeometry) => SymbolGeometry;
}

const MUTATIONS: Mutation[] = [
  {
    name: "pin-1 marker onto the far corner",
    costs: "the part is soldered down rotated, and every net is on the wrong pin",
    footprint: (g) => ({ ...g, pin1Marker: { xMm: -g.pin1Marker.xMm, yMm: -g.pin1Marker.yMm } })
  },
  {
    name: "a land dropped",
    costs: "one pin has no copper, so that connection does not exist",
    footprint: (g) => ({ ...g, pads: g.pads.filter((_pad, index) => index !== 0) })
  },
  {
    name: "two lands on one point",
    costs: "two nets shorted under the part",
    footprint: (g) => ({
      ...g,
      pads: g.pads.map((pad, index) => (index === 1 ? { ...pad, centre: { ...g.pads[0].centre } } : pad))
    })
  },
  {
    name: "a land renumbered to a pin that does not exist",
    costs: "a net lands on nothing, and the pin it belonged to has no copper",
    footprint: (g) => ({ ...g, pads: g.pads.map((pad, index) => (index === 0 ? { ...pad, number: "9999" } : pad)) })
  },
  {
    name: "a plated hole with no drill",
    costs: "an unplated pad that looks correct on screen and carries no connection",
    footprint: (g) => ({
      ...g,
      pads: g.pads.map((pad) =>
        pad.mounting === "through-hole" ? { ...pad, drillMm: undefined } : pad
      )
    })
  },
  {
    name: "a land pushed outside the courtyard",
    costs: "the part fouls its neighbour and the board does not assemble",
    footprint: (g) => ({
      ...g,
      pads: g.pads.map((pad, index) =>
        index === 0
          ? { ...pad, centre: { xMm: g.courtyard.halfWidthMm * 3, yMm: pad.centre.yMm } }
          : pad
      )
    })
  },
  {
    name: "a land size of NaN",
    costs: "a file the CAD tool refuses, or silently reads as zero",
    footprint: (g) => ({ ...g, pads: g.pads.map((pad, index) => (index === 0 ? { ...pad, widthMm: Number.NaN } : pad)) })
  },
  {
    name: "the silkscreen body swollen past the courtyard",
    costs: "silkscreen printed over the neighbouring part's copper",
    footprint: (g) => ({ ...g, body: { halfWidthMm: g.courtyard.halfWidthMm * 4, halfHeightMm: g.courtyard.halfHeightMm * 4 } })
  },
  {
    name: "a thermal via off its own pad",
    costs: "a hole drilled where no copper is, or a via shorting the pad to a lead land",
    footprint: (g) => ({
      ...g,
      thermalVias: g.thermalVias.map((via, index) =>
        index === 0 ? { ...via, centre: { xMm: via.centre.xMm + 12, yMm: via.centre.yMm } } : via
      )
    })
  },
  {
    name: "two symbol pins on one anchor",
    costs: "two nets shorted in the schematic, which no board inspection finds",
    symbol: (s) => ({
      ...s,
      pins: s.pins.map((pin, index) => (index === 1 ? { ...pin, anchor: { ...s.pins[0].anchor } } : pin))
    })
  },
  {
    name: "a symbol pin renamed",
    costs: "the netlist carries a name the datasheet does not, and the wiring follows it",
    symbol: (s) => ({ ...s, pins: s.pins.map((pin, index) => (index === 0 ? { ...pin, name: "NOTAPIN" } : pin)) })
  },
  {
    name: "a symbol pin drawn twice",
    costs: "one connection split across two schematic pins",
    symbol: (s) => ({ ...s, pins: [...s.pins, { ...s.pins[0], anchor: { xMm: s.pins[0].anchor.xMm, yMm: s.pins[0].anchor.yMm - 2.54 } }] })
  },
  {
    name: "a symbol pin with no length",
    costs: "a pin with nothing to attach a wire to",
    symbol: (s) => ({ ...s, pins: s.pins.map((pin, index) => (index === 0 ? { ...pin, lengthMm: 0 } : pin)) })
  }
];

function main(): void {
  const passed = new Map<string, string[]>();
  const caught = new Map<string, number>();
  const refused = new Map<string, number>();
  /** Parts where the mutation had nothing to change, so nothing was measured. */
  const inert = new Map<string, number>();
  let base = 0;

  for (const part of replayRecords()) {
    let footprint: FootprintGeometry;
    let symbol: SymbolGeometry;
    try {
      footprint = buildFootprintGeometry(
        part,
        densityOf(BENCH_SETTINGS),
        BENCH_SETTINGS.formedLeadSpanMm,
        undefined,
        BENCH_SETTINGS.formedLeadContactMm
      );
      symbol = buildSymbolGeometry(part);
      // ONLY PARTS THAT PASS THE GATE AS BUILT. Corrupting a footprint the gate
      // already refuses measures nothing.
      validateGeometry(footprint, part);
      validateSymbol(symbol, part);
    } catch {
      continue;
    }
    base += 1;

    for (const mutation of MUTATIONS) {
      let broken: FootprintGeometry;
      let brokenSymbol: SymbolGeometry;
      try {
        broken = mutation.footprint ? mutation.footprint(footprint) : footprint;
        brokenSymbol = mutation.symbol ? mutation.symbol(symbol) : symbol;
      } catch {
        refused.set(mutation.name, (refused.get(mutation.name) ?? 0) + 1);
        continue;
      }
      // A MUTATION THAT CHANGED NOTHING IS NOT A HOLE.
      //
      // "a plated hole with no drill" strips `drillMm` from through-hole pads,
      // and 86 of 86 parts in this corpus are surface mount, so it handed back
      // the same footprint and the gate duly passed it. Reported as a hole on
      // the first run: an instrument measuring nothing and calling the result a
      // finding, which is the exact shape this whole pass exists to remove.
      if (
        JSON.stringify(broken) === JSON.stringify(footprint) &&
        JSON.stringify(brokenSymbol) === JSON.stringify(symbol)
      ) {
        inert.set(mutation.name, (inert.get(mutation.name) ?? 0) + 1);
        continue;
      }
      try {
        validateGeometry(broken, part);
        validateSymbol(brokenSymbol, part);
        passed.set(mutation.name, [...(passed.get(mutation.name) ?? []), part.partNumber]);
      } catch {
        caught.set(mutation.name, (caught.get(mutation.name) ?? 0) + 1);
      }
    }
  }

  console.log(`\nBroke each emitted value on ${base} footprints that pass the export gate as built. No spend.\n`);
  console.log(`  ${"mutation".padEnd(44)} ${"caught".padStart(7)} ${"SHIPPED ANYWAY".padStart(15)}`);
  const holes: Mutation[] = [];
  for (const mutation of MUTATIONS) {
    const quiet = passed.get(mutation.name)?.length ?? 0;
    const took = caught.get(mutation.name) ?? 0;
    if (quiet > 0) holes.push(mutation);
    console.log(
      `  ${mutation.name.padEnd(44)} ${String(took).padStart(7)} ${String(quiet).padStart(15)}` +
        (took + quiet === 0
          ? `  <-- NO DATA, nothing to change on ${inert.get(mutation.name) ?? 0} part(s)`
          : quiet > 0
            ? "  <-- HOLE"
            : "")
    );
  }

  console.log("");
  for (const mutation of holes) {
    const parts = passed.get(mutation.name) ?? [];
    console.log(`  "${mutation.name}" passes the gate on ${parts.length} part(s).`);
    console.log(`      What it costs: ${mutation.costs}`);
    console.log(`      ${parts.slice(0, 8).join(", ")}${parts.length > 8 ? " ..." : ""}`);
  }
  if (holes.length === 0) console.log("  Every corrupted output value was refused by the export gate.");
  console.log("");
  if (holes.length > 0) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("outputs.ts")) {
  main();
}
