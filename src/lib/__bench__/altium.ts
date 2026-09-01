/**
 * DOES A SECOND, INDEPENDENT READER OPEN EVERY ALTIUM FILE WE EMIT?
 *
 * ## Why this is not `bench:kicad` for Altium
 *
 * It cannot be. Altium Designer is Windows-only, licensed, and has no headless
 * equivalent of `kicad-cli`: its scripting runs inside the running application.
 * "Altium opens the file" is a question for a person with Altium, and it stays on
 * that list.
 *
 * What CAN be closed is an asymmetry. Altium has two independent readers in this
 * repository and only one of them ever saw the whole corpus:
 *
 *     AltiumSharp (C#)     `bench:emitters`, every part, every PcbLib and SchLib
 *     pyaltiumlib (Python)  the unit tests only, on hand-built fixtures
 *
 * KiCad had exactly that shape until 2026-08-30 - one permissive reader over the
 * corpus - and it hid a symbol library KiCad itself refuses to open, over a
 * single pin typed `nc`. A permissive reader accepting a file is not evidence
 * the tool will.
 *
 * So this runs the OTHER implementation across every emitted file. Two readers
 * that have never seen each other's code, over the whole corpus, is the closest
 * thing to the real tool that exists on this machine.
 *
 * ## Diagnostics are findings, not noise
 *
 * `altium-oracle.py` says it in its own header: pyaltiumlib does not raise on a
 * malformed record, it logs and carries on. A file that parses to plausible
 * values while logging "common parameters array spacer is not as expected" is a
 * broken file, and only the log says so. That is precisely the failure mode
 * Altium has - it refuses a malformed library without explaining - so a
 * diagnostic here is reported as a finding rather than counted and forgotten.
 *
 * SKIPS RATHER THAN FAILS when pyaltiumlib is absent, and says so. A bench that
 * goes red for a missing dependency is one people learn to ignore.
 *
 * Free: no network, no model, no spend.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { createExportZip } from "../exporters";
import { defect } from "./inject";
import { replayRecords } from "./replay";

const ORACLE = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "emitters",
  "__tests__",
  "altium-oracle.py"
);

interface OracleResult {
  error?: string;
  componentCount?: number;
  parts?: Array<{ name: string; records: unknown[] }>;
  diagnostics?: string[];
  unsupportedRecords?: string[];
}

function read(path: string): OracleResult {
  try {
    return JSON.parse(execFileSync("python3", [ORACLE, path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })) as OracleResult;
  } catch (error) {
    // The oracle exits non-zero on a file it could not read AND prints its JSON,
    // so the stdout is the answer rather than the failure.
    const out = (error as { stdout?: string }).stdout;
    if (out) {
      try {
        return JSON.parse(out) as OracleResult;
      } catch {
        // fall through
      }
    }
    return { error: `the oracle did not complete: ${String(error).slice(0, 160)}` };
  }
}

async function main(): Promise<void> {
  const probe = read(join(tmpdir(), "definitely-not-a-library.PcbLib"));
  if (probe.error?.includes("pyaltiumlib is not installed")) {
    console.log("\npyaltiumlib is not installed, so the second Altium reader has not been asked anything.");
    console.log("  pip install pyaltiumlib\n");
    return;
  }

  const root = join(tmpdir(), "forge-altium-bench");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const refused: string[] = [];
  const noisy: string[] = [];
  /** Record types pyaltiumlib does not implement. A fact about the reader. */
  const unsupported = new Set<string>();
  let files = 0;
  let parts = 0;
  let refusedToBuild = 0;

  for (const part of replayRecords()) {
    let bundle;
    try {
      bundle = await createExportZip(part, "altium", { generatedAt: new Date(0) });
    } catch {
      // A part that does not build is `bench:replay`'s subject, not this one.
      refusedToBuild += 1;
      continue;
    }
    parts += 1;
    const zip = await JSZip.loadAsync(bundle.buffer);
    for (const name of Object.keys(zip.files)) {
      if (!name.endsWith(".PcbLib") && !name.endsWith(".SchLib")) continue;
      const base = `${part.partNumber.replace(/[^A-Za-z0-9._-]+/g, "_")}-${name.split("/").pop()}`;
      const path = join(root, base);
      // A LIBRARY THAT IS NOT ONE. Altium's format is an OLE compound file, so
      // truncating it is what a half-written or half-copied library looks like -
      // and the failure this bench exists for is a file that LOOKS fine and does
      // not open.
      const bytes = defect("altium.file", await zip.files[name].async("nodebuffer"), (buffer) =>
        buffer.subarray(0, Math.floor(buffer.length / 3))
      );
      writeFileSync(path, bytes);
      files += 1;

      const result = read(path);
      if (result.error) {
        refused.push(`${part.partNumber} ${name.endsWith(".PcbLib") ? "PcbLib" : "SchLib"}: ${result.error.slice(0, 150)}`);
        continue;
      }
      // A LIBRARY THAT OPENS AND CONTAINS NOTHING is a refusal wearing a success.
      if ((result.parts?.length ?? 0) === 0) {
        refused.push(`${part.partNumber} ${name.endsWith(".PcbLib") ? "PcbLib" : "SchLib"}: opened, and holds no component`);
        continue;
      }
      // DIAGNOSTICS AND UNSUPPORTED RECORDS ARE NOT THE SAME THING, and this
      // bench's first run treated them as one and produced 77 false findings.
      //
      // A DIAGNOSTIC is pyaltiumlib complaining about what it read - "common
      // parameters array spacer is not as expected" - and its own header says a
      // file that parses to plausible values while logging one is broken. That
      // is a finding.
      //
      // An UNSUPPORTED RECORD is the reader saying it does not implement that
      // record type. It is a fact about pyaltiumlib, not about our file. Every
      // SchLib we emit reports 45, 46 and 48, which are the footprint-link
      // records: written deliberately, modelled on a real Altium library where
      // all 23 components name a model and no file, and read without complaint
      // by AltiumSharp. Calling them defects would have sent somebody after a
      // correct emitter.
      if ((result.diagnostics ?? []).length > 0) {
        noisy.push(
          `${part.partNumber} ${name.endsWith(".PcbLib") ? "PcbLib" : "SchLib"}: ` +
            `${(result.diagnostics ?? []).slice(0, 2).join(" | ").slice(0, 170)}`
        );
      }
      for (const record of result.unsupportedRecords ?? []) unsupported.add(String(record));
    }
  }

  console.log(`\nAsked pyaltiumlib to open every Altium file this product emits. No network, no spend.\n`);
  console.log(`  ${files} file(s) across ${parts} part(s). ${refusedToBuild} part(s) did not build at all.`);
  console.log(`  This is a SECOND independent reader, not Altium. See this file's header.\n`);

  if (refused.length > 0) {
    console.log(`  ${refused.length} file(s) the reader would not open:`);
    for (const line of refused) console.log(`    ${line}`);
    console.log("");
  }
  if (noisy.length > 0) {
    console.log(`  ${noisy.length} file(s) opened while logging a complaint, which is how a malformed`);
    console.log(`  Altium library presents itself:`);
    for (const line of noisy) console.log(`    ${line}`);
    console.log("");
  }
  if (unsupported.size > 0) {
    console.log(`  Record types this reader does not implement, so it cannot speak for them:`);
    console.log(`    ${[...unsupported].sort((a, b) => Number(a) - Number(b)).join(", ")}`);
    console.log(`    45, 46 and 48 are the footprint link. AltiumSharp reads them; see schlib.ts.\n`);
  }
  if (refused.length === 0 && noisy.length === 0) {
    console.log("  Every file opened, held a component, and logged no complaint.\n");
    return;
  }
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith("altium.ts")) {
  void main();
}
