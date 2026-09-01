/**
 * Does the courtyard contain the part?
 *
 * IPC-7351B defines the courtyard as the maximum extent of the land pattern AND
 * the component body, plus an excess chosen by density level. `assemble` takes
 * the land extent on both axes of a quad and never compares it to the body, so a
 * package whose body reaches further than its lands - any no-lead part with
 * pull-back terminals - would get a courtyard inside its own outline.
 *
 * That is a hypothesis from reading the code. This measures whether it happens.
 *
 * Free: cached answers off disk, no network, no spend.
 */

import { buildFootprintGeometry, FootprintUnavailableError } from "../exporters";
import { defect } from "./inject";
import { replayRecords } from "./replay";
import { COURTYARD_EXCESS } from "../ipc7351";
import { BENCH_SETTINGS } from "./shipcheck";
import { densityOf } from "../settings";

function main(): void {
  const excess = COURTYARD_EXCESS[densityOf(BENCH_SETTINGS)];
  const short: string[] = [];
  const insideLands: string[] = [];
  let built = 0;

  for (const part of replayRecords()) {
    let geometry;
    try {
      geometry = buildFootprintGeometry(
        part,
        densityOf(BENCH_SETTINGS),
        BENCH_SETTINGS.formedLeadSpanMm,
        undefined,
        BENCH_SETTINGS.formedLeadContactMm
      );
    } catch (error) {
      if (!(error instanceof FootprintUnavailableError)) short.push(`${part.partNumber}: build threw`);
      continue;
    }
    built += 1;
    // A COURTYARD THAT DOES NOT CLEAR WHAT IT CONTAINS - the whole subject of
    // this bench. Shrunk after the build, so the lands and body are untouched
    // and only the outline is wrong.
    geometry = defect("courtyard.geometry", geometry, (g) => ({
      ...g,
      courtyard: { halfWidthMm: g.courtyard.halfWidthMm * 0.5, halfHeightMm: g.courtyard.halfHeightMm * 0.5 }
    }));

    // THE LANDS, which the courtyard must clear by the excess.
    const landHalfX = Math.max(...geometry.pads.map((pad) => Math.abs(pad.centre.xMm) + pad.widthMm / 2), 0);
    const landHalfY = Math.max(...geometry.pads.map((pad) => Math.abs(pad.centre.yMm) + pad.heightMm / 2), 0);
    if (
      geometry.courtyard.halfWidthMm + 1e-6 < landHalfX + excess ||
      geometry.courtyard.halfHeightMm + 1e-6 < landHalfY + excess
    ) {
      insideLands.push(
        `${part.partNumber.padEnd(20)} courtyard ${geometry.courtyard.halfWidthMm.toFixed(3)} x ` +
          `${geometry.courtyard.halfHeightMm.toFixed(3)}  lands need ${(landHalfX + excess).toFixed(3)} x ${(landHalfY + excess).toFixed(3)}`
      );
    }

    // AND THE BODY, which is the half nothing compares against on a quad.
    const bodyHalfX = geometry.body.halfWidthMm;
    const bodyHalfY = geometry.body.halfHeightMm;
    if (
      geometry.courtyard.halfWidthMm + 1e-6 < bodyHalfX + excess ||
      geometry.courtyard.halfHeightMm + 1e-6 < bodyHalfY + excess
    ) {
      short.push(
        `${part.partNumber.padEnd(20)} ${part.packageType.slice(0, 22).padEnd(22)} ` +
          `courtyard ${geometry.courtyard.halfWidthMm.toFixed(3)} x ${geometry.courtyard.halfHeightMm.toFixed(3)}   ` +
          `body needs ${(bodyHalfX + excess).toFixed(3)} x ${(bodyHalfY + excess).toFixed(3)}`
      );
    }
  }

  console.log(`\nChecked the courtyard of ${built} footprints at density ${densityOf(BENCH_SETTINGS)} (excess ${excess} mm). No spend.\n`);
  console.log(`  ${insideLands.length} courtyard(s) do not clear their own LANDS by the excess:`);
  for (const line of insideLands) console.log(`    ${line}`);
  if (insideLands.length === 0) console.log("    none");
  console.log(`\n  ${short.length} courtyard(s) do not clear the package BODY by the excess:`);
  for (const line of short) console.log(`    ${line}`);
  if (short.length === 0) console.log("    none");
  console.log("");
}

if (process.argv[1]?.endsWith("courtyard.ts")) {
  main();
}
