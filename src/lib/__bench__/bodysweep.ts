/** Is there a bound on the OTHER side of the body, and what would it cost?
 *
 * `confirmBody` pairs the body against the lead span that has to reach past it.
 * That is a one-sided bound: `bench:unchecked` shrinks a body to 40% of its real
 * size and the span still reaches past it, so 56 bodies stay CONFIRMED while
 * wrong. The question is whether the span bounds the body from BELOW too, and
 * RULES.md says to measure a bound before shipping it rather than argue for it.
 */
import { loadBenchEnv } from "./env";
import { buildCachedParts } from "./oracle-match";
import { BENCH_SETTINGS, shipOutcome } from "./shipcheck";

loadBenchEnv();

async function main() {
  const built = await buildCachedParts();
  if (!built) return;
  const rows: Array<{ part: string; pkg: string; ratio: number }> = [];
  for (const entry of built) {
    const outcome = await shipOutcome(entry.record, BENCH_SETTINGS);
    const part = outcome.shippedPart;
    if (!part) continue;
    const { leadSpanMm, bodyWidthMm, bodyLengthMm } = part.dimensions;
    if (!leadSpanMm || bodyWidthMm === null || bodyLengthMm === null) continue;
    const across = Math.min(bodyWidthMm, bodyLengthMm);
    if (across <= 0) continue;
    rows.push({ part: part.partNumber, pkg: part.packageType, ratio: leadSpanMm.maxMm / across });
  }
  rows.sort((a, b) => b.ratio - a.ratio);
  console.log(`\nspan / body across, on ${rows.length} parts that state both.\n`);
  for (const row of rows.slice(0, 8)) console.log(`  widest   ${row.part.padEnd(18)} ${row.pkg.slice(0, 26).padEnd(28)} ${row.ratio.toFixed(2)}`);
  console.log("");
  for (const row of rows.slice(-8)) console.log(`  tightest ${row.part.padEnd(18)} ${row.pkg.slice(0, 26).padEnd(28)} ${row.ratio.toFixed(2)}`);
  console.log("");
  // The mutation shrinks the body to 0.4, which multiplies this ratio by 2.5.
  for (const bound of [1.5, 1.8, 2.0, 2.5, 3.0, 4.0]) {
    const flagged = rows.filter((row) => row.ratio > bound).length;
    const caught = rows.filter((row) => row.ratio / 0.4 > bound).length;
    console.log(`  bound ${bound.toFixed(1)}:  ${flagged} correct parts FLAGGED,  ${caught} of ${rows.length} shrunken bodies caught`);
  }
  console.log("");

  // A SECOND CANDIDATE, and a properly independent one: the land pattern the
  // datasheet PRINTS on its own page, against the body on the outline drawing.
  // Two drawings rather than two callouts on one.
  const land: Array<{ part: string; pkg: string; ratio: number }> = [];
  for (const entry of built) {
    const outcome = await shipOutcome(entry.record, BENCH_SETTINGS);
    const part = outcome.shippedPart;
    if (!part) continue;
    const { landSpanMm, landPadLengthMm, bodyWidthMm, bodyLengthMm } = part.dimensions;
    if (landSpanMm === null || landPadLengthMm === null || bodyWidthMm === null || bodyLengthMm === null) continue;
    const across = Math.min(bodyWidthMm, bodyLengthMm);
    if (across <= 0) continue;
    // The OUTER extent across the two land rows. A body wider than that has the
    // package hanging off its own footprint; a body far narrower has the lands
    // out in space.
    land.push({ part: part.partNumber, pkg: part.packageType, ratio: (landSpanMm + landPadLengthMm) / across });
  }
  land.sort((a, b) => b.ratio - a.ratio);
  console.log(`\nouter land extent / body across, on ${land.length} parts that state both.\n`);
  for (const row of land.slice(0, 6)) console.log(`  widest   ${row.part.padEnd(18)} ${row.pkg.slice(0, 26).padEnd(28)} ${row.ratio.toFixed(2)}`);
  for (const row of land.slice(-6)) console.log(`  tightest ${row.part.padEnd(18)} ${row.pkg.slice(0, 26).padEnd(28)} ${row.ratio.toFixed(2)}`);
  console.log("");
  for (const bound of [3.0, 3.2, 3.5, 4.0, 4.5, 5.0]) {
    const flagged = land.filter((row) => row.ratio > bound).length;
    const caught = land.filter((row) => row.ratio / 0.4 > bound).length;
    console.log(`  bound ${bound.toFixed(1)}:  ${flagged} correct parts FLAGGED,  ${caught} of ${land.length} shrunken bodies caught`);
  }
  console.log("");
}
void main();
