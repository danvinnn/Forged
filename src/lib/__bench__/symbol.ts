/**
 * THE SYMBOL, PUT THROUGH WHAT THE FOOTPRINT WAS PUT THROUGH.
 *
 * ## Why this exists
 *
 * `bench:unchecked` corrupts every value that places copper and asks whether
 * anything in the product objects. It found two holes on its first run. The
 * SYMBOL has never had an equivalent, and it carries the one output whose
 * failure a board cannot survive: the netlist. A wrong land is a joint that does
 * not form and is visible under a microscope; a wrong pin name is a wire
 * connected to the wrong net, and it is invisible in every view a reviewer
 * opens.
 *
 * ## Two halves, because there are two different lies to catch
 *
 * HALF 1 asks whether the symbol's own check works at all. `symbolViolations`
 * compares the emitted symbol to the record it came from, so it can only ever
 * catch an EMITTER bug - a dropped pin, a renamed one, two stubs on one point.
 * That is a real class (`buildSymbolGeometry` silently drops a pin whose lookup
 * misses) and the check is the only thing standing in front of it. So each
 * violation is forced to happen, on real symbols, and has to be reported. A
 * check nobody has ever seen fail is a check nobody has evidence works: this
 * project shipped one for weeks that matched a pad number the emitter never
 * emits.
 *
 * HALF 2 asks the `bench:unchecked` question. Take a value on the RECORD that
 * reaches the symbol, make it wrong, and see whether the product objects. The
 * emitter's check cannot help here by construction - it compares the symbol to
 * the record, and the record is what is wrong - so the answer has to come from a
 * confirmation, and where no confirmation covers a value at all, that is the
 * finding and no mutation is needed to state it.
 *
 * Free: cached model answers and cached PDFs off disk, no network, no spend.
 */

import { loadBenchEnv } from "./env";
import { buildCachedParts, documentFor } from "./oracle-match";
import { BENCH_SETTINGS, shipOutcome } from "./shipcheck";
import { buildFootprintGeometry, buildSymbolGeometry } from "../exporters";
import { confidenceChecks, symbolViolations } from "../confidence";
import { confirmations } from "../confirm";
import { densityOf } from "../settings";
import type { SymbolGeometry } from "../geometry";
import type { PinElectricalType, ResolvedPart } from "../types";

loadBenchEnv();

/**
 * HALF 1: a defect an emitter could plausibly introduce, injected into a symbol
 * that is otherwise correct.
 *
 * Every one of these is a shape this generator has actually produced or come one
 * lookup away from producing, which is why they are the ones worth forcing.
 */
const EMITTER_DEFECTS: Array<{
  name: string;
  /** Null where this part cannot carry the defect - too few pins, say. */
  apply: (symbol: SymbolGeometry) => SymbolGeometry | null;
}> = [
  {
    // `buildSymbolGeometry` skips a pin whose number is not in the record's
    // lookup. That is the failure that made the grid-array symbol come out
    // empty, and it is silent.
    name: "drop a pin",
    apply: (s) => (s.pins.length < 2 ? null : { ...s, pins: s.pins.slice(1) })
  },
  {
    name: "draw a pin twice",
    apply: (s) => (s.pins.length < 2 ? null : { ...s, pins: [...s.pins, { ...s.pins[0], anchor: { ...s.pins[0].anchor, yMm: s.pins[0].anchor.yMm - 2.54 } }] })
  },
  {
    name: "rename a pin",
    apply: (s) =>
      s.pins.length < 1 ? null : { ...s, pins: s.pins.map((pin, index) => (index === 0 ? { ...pin, name: `${pin.name}_X` } : pin)) }
  },
  {
    name: "two pins on one point",
    apply: (s) =>
      s.pins.length < 2 ? null : { ...s, pins: s.pins.map((pin, index) => (index === 1 ? { ...pin, anchor: { ...s.pins[0].anchor } } : pin)) }
  },
  {
    name: "invent a pin number",
    apply: (s) => (s.pins.length < 1 ? null : { ...s, pins: [...s.pins, { ...s.pins[0], number: "9999" }] })
  },
  {
    // The one that motivated the grid-array branch: a symbol that draws nothing
    // at all, while the footprint builds fine.
    name: "empty symbol",
    apply: (s) => (s.pins.length < 1 ? null : { ...s, pins: [] })
  }
];

/**
 * HALF 2: a value on the record that changes the symbol.
 *
 * `vouchedBy` names the confirmation that is supposed to stand behind it, or
 * null where the honest answer is that nothing does. A null is not a
 * placeholder: it is the claim this bench is making about that value, and the
 * run proves it by showing the objection set does not move.
 */
const RECORD_MUTATIONS: Array<{
  name: string;
  vouchedBy: string | null;
  reaches: string;
  apply: (part: ResolvedPart) => ResolvedPart | null;
}> = [
  {
    name: "swap two pin names",
    vouchedBy: "pinout",
    reaches: "every net on the schematic",
    apply: (p) => {
      if (p.pins.length < 2) return null;
      const pins = p.pins.map((pin) => ({ ...pin }));
      const first = pins[0].name;
      pins[0].name = pins[1].name;
      pins[1].name = first;
      if (pins[0].name === pins[1].name) return null;
      return { ...p, pins };
    }
  },
  {
    name: "rotate pin numbering by 1",
    vouchedBy: "pinout",
    reaches: "which pad each net lands on",
    apply: (p) => {
      if (p.pins.length < 2) return null;
      const names = p.pins.map((pin) => pin.name);
      if (new Set(names).size < 2) return null;
      return { ...p, pins: p.pins.map((pin, index) => ({ ...pin, name: names[(index + 1) % names.length] })) };
    }
  },
  {
    // DELIBERATE, and recorded here rather than left to be rediscovered.
    //
    // Nothing vouches for the electrical type and nothing is going to. RULES.md:
    // "a pairing that cannot name two different means is not a confirmation, say
    // so rather than inventing one". The only candidate second source is the pin
    // NAME, and reading a type out of a name is the invention this project
    // exists not to do: `EN` is an input on one part and an open-drain output on
    // the next.
    //
    // What makes that acceptable, and what would stop making it acceptable:
    //
    //   - it is a READ value with a citation, taken from the pin table's own
    //     type column, or it is `unspecified` because the document has no such
    //     column. `bench:pintypes` measures which: 21 of 107 parts state any
    //     type at all, because most datasheets print "Pin No. | Mnemonic |
    //     Description" and nothing else.
    //   - a wrong type produces no wrong copper and no wrong net. It weakens the
    //     schematic tool's own advisory check and nothing else.
    //   - the budget is five GLANCES per part, and RULES.md is explicit that a
    //     flag which fires on correct readings and gets clicked past is worse
    //     than saying nothing checked it.
    //
    // If the type ever starts driving something that reaches a board, this stops
    // being defensible and it needs a second source or a flag.
    name: "every pin becomes power",
    vouchedBy: null,
    reaches: "the schematic tool's electrical rule check, and nothing that reaches a board",
    apply: (p) => {
      const power: PinElectricalType = "power";
      if (p.pins.every((pin) => pin.electricalType === power)) return null;
      return { ...p, pins: p.pins.map((pin) => ({ ...pin, electricalType: power })) };
    }
  },
  {
    name: "drop the last pin row",
    vouchedBy: "pin-count",
    reaches: "a connection that exists on the board and not on the sheet",
    apply: (p) => (p.pins.length < 2 ? null : { ...p, pins: p.pins.slice(0, -1) })
  }
];

/**
 * Everything the product would say about this record, as a comparable set.
 *
 * Deliberately the whole objection surface rather than one verdict: a mutation
 * that trades one complaint for another has still been noticed, and a mutation
 * that changes nothing at all is the one that ships.
 */
function objections(part: ResolvedPart, doc: Awaited<ReturnType<typeof documentFor>>): Set<string> | null {
  let geometry;
  try {
    geometry = buildFootprintGeometry(
      part,
      densityOf(BENCH_SETTINGS),
      BENCH_SETTINGS.formedLeadSpanMm,
      undefined,
      BENCH_SETTINGS.formedLeadContactMm
    );
  } catch {
    return null;
  }
  const out = new Set<string>();
  try {
    for (const violation of symbolViolations(buildSymbolGeometry(part), part)) out.add(`symbol: ${violation}`);
  } catch (error) {
    out.add(`symbol threw: ${String(error).slice(0, 60)}`);
  }
  for (const check of confidenceChecks(part)) {
    if (check.state !== "pass") out.add(`check ${check.id}: ${check.state}`);
  }
  for (const item of confirmations(part, geometry, doc, BENCH_SETTINGS.formedLeadSpanMm, BENCH_SETTINGS.formedLeadContactMm).items) {
    out.add(`confirm ${item.id}: ${item.state}`);
  }
  return out;
}

async function main(): Promise<void> {
  const built = await buildCachedParts();
  if (!built) {
    console.log("No extraction model configured, so no cached records can be rebuilt.");
    process.exitCode = 1;
    return;
  }

  const caught = new Map<string, number>();
  const missed = new Map<string, string[]>();
  const applicable = new Map<string, number>();
  const silent = new Map<string, string[]>();
  const noticed = new Map<string, number>();
  const eligible = new Map<string, number>();
  // THE INVARIANT counts a FLAGGED value as not silent: it has been put in front
  // of the user. So a mutation that changes nothing while the value was already
  // flagged is not a hole, and lumping the two together would have this bench
  // report 68 holes where the true number is much smaller. Split at the source.
  const silentWhileConfirmed = new Map<string, string[]>();
  const wasConfirmed = new Map<string, number>();
  let symbols = 0;

  for (const entry of built) {
    const outcome = await shipOutcome(entry.record, BENCH_SETTINGS);
    const part = outcome.shippedPart;
    if (!part) continue;

    // HALF 1. Only on symbols that are clean to start with, so a reported
    // violation is the injected one.
    let symbol: SymbolGeometry;
    try {
      symbol = buildSymbolGeometry(part);
    } catch {
      continue;
    }
    if (symbolViolations(symbol, part).length > 0) continue;
    symbols += 1;
    for (const defect of EMITTER_DEFECTS) {
      const broken = defect.apply(symbol);
      if (!broken) continue;
      applicable.set(defect.name, (applicable.get(defect.name) ?? 0) + 1);
      if (symbolViolations(broken, part).length > 0) caught.set(defect.name, (caught.get(defect.name) ?? 0) + 1);
      else missed.set(defect.name, [...(missed.get(defect.name) ?? []), part.partNumber]);
    }

    // HALF 2.
    const doc = await documentFor(entry.part);
    const base = objections(part, doc);
    if (!base) continue;
    for (const mutation of RECORD_MUTATIONS) {
      const mutated = mutation.apply(part);
      if (!mutated) continue;
      eligible.set(mutation.name, (eligible.get(mutation.name) ?? 0) + 1);
      const after = objections(mutated, doc);
      // A footprint that no longer builds is itself an objection.
      const changed = after === null || after.size !== base.size || [...after].some((item) => !base.has(item));
      const vouched = mutation.vouchedBy !== null && base.has(`confirm ${mutation.vouchedBy}: confirmed`);
      if (vouched) wasConfirmed.set(mutation.name, (wasConfirmed.get(mutation.name) ?? 0) + 1);
      if (changed) {
        noticed.set(mutation.name, (noticed.get(mutation.name) ?? 0) + 1);
      } else {
        silent.set(mutation.name, [...(silent.get(mutation.name) ?? []), part.partNumber]);
        if (vouched || mutation.vouchedBy === null) {
          silentWhileConfirmed.set(mutation.name, [...(silentWhileConfirmed.get(mutation.name) ?? []), part.partNumber]);
        }
      }
    }
  }

  console.log(`\nHALF 1: forced each emitter defect on ${symbols} clean symbols. Does the symbol's own check report it?\n`);
  console.log(`  ${"defect".padEnd(24)} ${"tried".padStart(7)} ${"reported".padStart(9)} ${"MISSED".padStart(8)}`);
  for (const defect of EMITTER_DEFECTS) {
    const tried = applicable.get(defect.name) ?? 0;
    const gone = missed.get(defect.name)?.length ?? 0;
    console.log(
      `  ${defect.name.padEnd(24)} ${String(tried).padStart(7)} ${String(caught.get(defect.name) ?? 0).padStart(9)} ${String(gone).padStart(8)}${gone > 0 ? "  <-- NOT CHECKED" : ""}`
    );
  }
  const untried = EMITTER_DEFECTS.filter((defect) => (applicable.get(defect.name) ?? 0) === 0);
  if (untried.length > 0) console.log(`\n  Never exercised, so unproven: ${untried.map((d) => d.name).join(", ")}`);
  for (const defect of EMITTER_DEFECTS) {
    const parts = missed.get(defect.name);
    if (!parts) continue;
    console.log(`\n  "${defect.name}" goes unreported on: ${parts.slice(0, 10).join(", ")}${parts.length > 10 ? " ..." : ""}`);
  }

  console.log(`\nHALF 2: corrupted each record value the symbol is built from. Does ANYTHING object?\n`);
  console.log("  A value already FLAGGED is not silent - the user has been told to check it - so the");
  console.log("  column that matters is the last one: corrupted while the product still vouched for it.\n");
  console.log(
    `  ${"mutation".padEnd(26)} ${"vouched by".padEnd(12)} ${"tried".padStart(6)} ${"vouched".padStart(8)} ${"noticed".padStart(8)} ${"SILENT+VOUCHED".padStart(15)}`
  );
  // A mutation this file declares `vouchedBy: null` is a POSITION, not an
  // oversight: the comment on it says why nothing checks that value and what
  // would change the answer. Flagging it as a hole every run would train the
  // next reader to skip the whole table.
  for (const mutation of RECORD_MUTATIONS) {
    const tried = eligible.get(mutation.name) ?? 0;
    const hole = silentWhileConfirmed.get(mutation.name)?.length ?? 0;
    const vouched = mutation.vouchedBy === null ? tried : (wasConfirmed.get(mutation.name) ?? 0);
    console.log(
      `  ${mutation.name.padEnd(26)} ${(mutation.vouchedBy ?? "NOTHING").padEnd(12)} ${String(tried).padStart(6)} ${String(vouched).padStart(8)} ${String(noticed.get(mutation.name) ?? 0).padStart(8)} ${String(hole).padStart(15)}${hole > 0 ? (mutation.vouchedBy === null ? "  <-- by decision" : "  <-- HOLE") : ""}`
    );
  }
  console.log("");
  for (const mutation of RECORD_MUTATIONS) {
    const parts = silentWhileConfirmed.get(mutation.name);
    if (!parts) continue;
    console.log(`  "${mutation.name}" changes nothing the product says, on ${parts.length} parts.`);
    console.log(`      It reaches: ${mutation.reaches}`);
    console.log(`      ${parts.slice(0, 8).join(", ")}${parts.length > 8 ? " ..." : ""}`);
  }
  console.log("");
}

void main();
