/**
 * THE TWO CANDIDATE SECOND SOURCES FOR `leadSides`, SCORED BEFORE EITHER SHIPPED.
 *
 * `bench:unchecked` swapped 2 sides for 4 on 86 footprints the product vouched
 * for and 59 stayed CONFIRMED. Two rules could tell them apart and only one was
 * worth shipping, which is what this measured.
 *
 * GEOMETRY - the leads on one side, at their own pitch, have to fit along the
 * body edge they come out of. Measured over 98 parts: every correct reading sits
 * at 1.07 or below, so a bound of 1.1 flags none of them, and it catches 25 of
 * 98 swaps. Real, and partial: an 8-pin SOIC read as four-sided puts two leads
 * on each edge and fits perfectly well.
 *
 * THE NAME - the Q in QFP is quad. 97 of 103 designators state a family that
 * says how many sides its leads come out of, 96 agree with the drawing and one
 * disagrees. The six silent ones are LGA, which has no sides.
 *
 * The name won and the geometry rule was not built. One second source that
 * covers 94% of the corpus is worth more than a second one covering a quarter of
 * it, and RULES.md is explicit that a bound which rarely fires is not carrying a
 * check, it is decorating it.
 */
import { loadBenchEnv } from "./env";
import { buildCachedParts } from "./oracle-match";
import { BENCH_SETTINGS, shipOutcome } from "./shipcheck";
// The SHIPPED rule, not a copy of it. A sweep that scores its own private
// version of a constant is scoring nothing.
import { declaredLeadSides as declaredSides } from "../packagevariants";

loadBenchEnv();

async function main() {
  const built = await buildCachedParts();
  if (!built) return;
  const rows: Array<{ part: string; sides: number; ratio: number; other: number | null }> = [];
  for (const entry of built) {
    const outcome = await shipOutcome(entry.record, BENCH_SETTINGS);
    const part = outcome.shippedPart;
    if (!part) continue;
    const { pitchMm, leadSides, bodyWidthMm, bodyLengthMm } = part.dimensions;
    if (!pitchMm || !leadSides || bodyWidthMm === null || bodyLengthMm === null) continue;
    if (leadSides !== 2 && leadSides !== 4) continue;
    // Leads on ONE side, times the pitch, against the body edge they run along.
    // Two-sided: the rows run along the LENGTH. Four-sided: each edge carries a
    // quarter, and the shorter edge is the binding one.
    const need = (sides: number) => (part.pinCount / sides) * pitchMm;
    const along = (sides: number) => (sides === 2 ? bodyLengthMm : Math.min(bodyWidthMm, bodyLengthMm));
    const ratio = need(leadSides) / along(leadSides);
    const swapped = leadSides === 2 ? 4 : 2;
    rows.push({ part: part.partNumber, sides: leadSides, ratio, other: need(swapped) / along(swapped) });
  }
  rows.sort((a, b) => b.ratio - a.ratio);
  // AND THE OTHER CANDIDATE SECOND SOURCE: does the package NAME state the side
  // count? A quad flat pack is called quad. The product already reads a lead
  // COUNT out of a package name (`declaredLeadCount`), so this is the same kind
  // of reading rather than a new liberty.
  let named = 0;
  let agrees = 0;
  const disagrees: string[] = [];
  let unnamed = 0;
  const unnamedNames: string[] = [];
  for (const entry of built) {
    const outcome = await shipOutcome(entry.record, BENCH_SETTINGS);
    const part = outcome.shippedPart;
    if (!part || !part.dimensions.leadSides) continue;
    const said = declaredSides(part.packageType);
    if (said === null) {
      unnamed += 1;
      if (unnamedNames.length < 14) unnamedNames.push(part.packageType);
      continue;
    }
    named += 1;
    if (said === part.dimensions.leadSides) agrees += 1;
    else disagrees.push(`${part.partNumber} "${part.packageType}" name says ${said}, record says ${part.dimensions.leadSides}`);
  }
  console.log(`\n  package NAME states a side count on ${named} parts, silent on ${unnamed}`);
  console.log(`    agrees ${agrees}   DISAGREES ${disagrees.length}`);
  for (const line of disagrees.slice(0, 10)) console.log(`      ${line}`);
  console.log(`    names it does not recognise: ${unnamedNames.join(" | ")}`);

  console.log(`\n${rows.length} parts with a pitch, a body and a lead-side count.\n`);
  console.log(`  as read : ${rows.map((r) => r.ratio).reduce((a, b) => Math.max(a, b), 0).toFixed(2)} worst, ${rows.map((r) => r.ratio).reduce((a, b) => Math.min(a, b), 99).toFixed(2)} best`);
  console.log(`  worst ten as read (leads-on-a-side over the body edge they run along):`);
  for (const r of rows.slice(0, 10)) console.log(`    ${r.part.padEnd(20)} sides ${r.sides}  ${r.ratio.toFixed(2)}   swapped would be ${r.other?.toFixed(2)}`);
  for (const bound of [1.0, 1.1, 1.2, 1.3, 1.5, 2.0]) {
    const wrongly = rows.filter((r) => r.ratio > bound).length;
    const caught = rows.filter((r) => (r.other ?? 0) > bound).length;
    console.log(`  bound ${bound.toFixed(1)}:  ${wrongly} correct parts FLAGGED,  ${caught} of ${rows.length} swaps caught`);
  }
  console.log("");
}
void main();
