import { loadBenchEnv } from "../../src/lib/__bench__/env";
loadBenchEnv();
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCachedParts } from "../../src/lib/__bench__/oracle-match";
import { DIMENSION_ORACLE } from "../../src/lib/__bench__/dimension-oracle";
import { PINOUT_ORACLE } from "../../src/lib/__bench__/pinout-oracle";
import { BENCH_SETTINGS, shipOutcome } from "../../src/lib/__bench__/shipcheck";
import { extractPartRecord } from "../../src/lib/datasheet";
import { findUnreadableFootprint } from "../../src/lib/vendorland";

// For every part the product SHIPS, can each of the three things it emits be
// contradicted by something a person has read?
//
//   the body and lead geometry  -> a hand-read outline drawing
//   the pin assignment          -> a hand-read pin table
//   the land pattern            -> the vendor's own printed footprint, hand-read
async function main() {
  const built = await buildCachedParts();
  const rows: string[] = [];
  let ships = 0;
  let all3 = 0;
  let noDrawing = 0;
  let noPins = 0;
  let noLand = 0;

  for (const e of built ?? []) {
    const outcome = await shipOutcome(e.record, BENCH_SETTINGS);
    if (!outcome.shipsAnswered) continue;
    ships += 1;

    const entry = e.oracleCode ? DIMENSION_ORACLE[e.oracleCode] : null;
    const hasDrawing = entry !== null;
    const hasPins = Object.prototype.hasOwnProperty.call(PINOUT_ORACLE, e.part);

    // Does the datasheet print a footprint at all? Only then is a missing
    // hand-read land a gap rather than a correct absence.
    let printsOne = false;
    for (const dir of [".bench-cache", ".holdout-cache"]) {
      const path = join(process.cwd(), dir, `${e.part}.pdf`);
      if (!existsSync(path)) continue;
      const bytes = readFileSync(path);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const { doc } = await extractPartRecord(`${e.part}.pdf`, buffer);
      printsOne = findUnreadableFootprint(doc) !== null;
      break;
    }
    const landSettled =
      entry !== null && (entry.land !== undefined || (entry.printsNothingFor ?? []).includes("land") || !printsOne);

    if (!hasDrawing) noDrawing += 1;
    if (!hasPins) noPins += 1;
    if (!landSettled) noLand += 1;
    if (hasDrawing && hasPins && landSettled) all3 += 1;
    else
      rows.push(
        `  ${e.part.padEnd(18)} ${hasDrawing ? "drawing " : "NO-DRAW  "} ${hasPins ? "pins    " : "NO-PINS "} ${landSettled ? "land" : "NO-LAND"}`
      );
  }

  for (const r of rows) console.log(r);
  console.log(`\nSHIPPING PARTS ${ships}`);
  console.log(`  fully judgeable (drawing + pin table + land settled)  ${all3}/${ships}`);
  console.log(`  no hand-read outline drawing                          ${noDrawing}`);
  console.log(`  no hand-read pin table                                ${noPins}`);
  console.log(`  datasheet prints a footprint nobody has read          ${noLand}`);
}
void main();
