/**
 * DOES KICAD ITSELF OPEN WHAT WE EMIT?
 *
 * ## Why an independent reader was not enough
 *
 * `bench:emitters` reads every emitted footprint and symbol back with `kiutils`
 * and compares it against Altium's, and that has caught real defects. But
 * kiutils is not KiCad. It is a permissive Python parser that takes an
 * s-expression at its word, and the customer opens the actual program.
 *
 * The gap was not theoretical. Run for the first time on 2026-08-30:
 *
 *     78 of 80 symbol libraries loaded, and 2 did not.
 *
 * Both carried a pin typed `nc`, and the emitter wrote `not_connected`. KiCad's
 * token is `no_connect`. KiCad does not skip the pin or warn - it refuses the
 * WHOLE LIBRARY with "Unable to load library", so every part in the file is lost
 * over one pin. kiutils parsed it happily, 890 unit tests passed, and the defect
 * had been shipping since the electrical type was first emitted two days
 * earlier.
 *
 * ## What it does
 *
 * Builds every corpus part, writes the footprints into one `.pretty` library and
 * each symbol into its own file, and asks `kicad-cli` to plot them all to SVG.
 * Plotting is the cheapest operation that forces a full parse and a full
 * geometry build, so anything KiCad cannot make sense of comes back as an error
 * rather than as a quiet default.
 *
 * ## Getting kicad-cli
 *
 * `brew install --cask kicad` needs an administrator password for a directory
 * this tool does not use. The binary runs perfectly from the disk image without
 * installing anything:
 *
 *     hdiutil attach -nobrowse -readonly -mountpoint /tmp/kicadmnt <the .dmg>
 *     FORGE_KICAD_CLI=/tmp/kicadmnt/KiCad/KiCad.app/Contents/MacOS/kicad-cli npm run bench:kicad
 *
 * SKIPS RATHER THAN FAILS when the binary is absent, and says so. A machine
 * without KiCad has not proved anything, and a bench that goes red for a missing
 * tool is one people learn to ignore.
 *
 * Free: no network, no model, no spend.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import JSZip from "jszip";
import { createExportZip } from "../exporters";
import { replayRecords } from "./replay";

/** The binary, from the environment or from the usual places. */
function kicadCli(): string | null {
  const candidates = [
    process.env.FORGE_KICAD_CLI,
    "/tmp/kicadmnt/KiCad/KiCad.app/Contents/MacOS/kicad-cli",
    "/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli",
    "/usr/bin/kicad-cli",
    "/usr/local/bin/kicad-cli",
    "/opt/homebrew/bin/kicad-cli"
  ].filter((path): path is string => Boolean(path));
  return candidates.find((path) => existsSync(path)) ?? null;
}

async function main(): Promise<void> {
  const cli = kicadCli();
  if (!cli) {
    console.log("\nNo kicad-cli found, so KiCad has not been asked anything. See this file's header.\n");
    return;
  }
  const version = spawnSync(cli, ["version"], { encoding: "utf8" }).stdout?.trim() ?? "unknown";

  const root = join(tmpdir(), "forge-kicad-bench");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "forge.pretty"), { recursive: true });
  mkdirSync(join(root, "syms"), { recursive: true });

  /** Which file came from which part, so a refusal can be named. */
  const symbolOwner = new Map<string, string>();
  let footprints = 0;
  let refusedToBuild = 0;

  for (const part of replayRecords()) {
    let bundle;
    try {
      bundle = await createExportZip(part, "kicad", {});
    } catch {
      // A part that does not build is `bench:replay`'s subject, not this one.
      refusedToBuild += 1;
      continue;
    }
    const zip = await JSZip.loadAsync(bundle.buffer);
    for (const name of Object.keys(zip.files)) {
      const base = name.split("/").pop() ?? name;
      if (name.endsWith(".kicad_mod")) {
        writeFileSync(join(root, "forge.pretty", base), await zip.files[name].async("string"));
        footprints += 1;
      }
      if (name.endsWith(".kicad_sym")) {
        // Named after the PART, so a failure points at something actionable.
        const file = `${part.partNumber.replace(/[^A-Za-z0-9._-]+/g, "_")}.kicad_sym`;
        writeFileSync(join(root, "syms", file), await zip.files[name].async("string"));
        symbolOwner.set(file, part.partNumber);
      }
    }
  }

  console.log(`\nAsked KiCad ${version} to open everything this product emits. No network, no spend.\n`);
  console.log(`  ${footprints} footprint(s) and ${symbolOwner.size} symbol librar(ies) built.`);
  if (refusedToBuild > 0) console.log(`  ${refusedToBuild} part(s) did not build at all; that is bench:replay's subject.`);

  const problems: string[] = [];

  // THE FOOTPRINTS, as one library, which is how a user adds them.
  const fp = spawnSync(cli, ["fp", "export", "svg", "--output", join(root, "svg"), join(root, "forge.pretty")], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (fp.status !== 0) {
    problems.push(`KiCad refused the footprint library: ${(fp.stderr || fp.stdout || "").trim().split("\n").slice(-3).join(" | ")}`);
  }

  // THE SYMBOLS, one library at a time. Together, a single bad file would take
  // the whole run down and name nothing.
  let symbolsOk = 0;
  for (const [file, part] of symbolOwner) {
    const result = spawnSync(cli, ["sym", "export", "svg", "--output", join(root, "symsvg"), join(root, "syms", file)], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024
    });
    if (result.status === 0) symbolsOk += 1;
    else {
      problems.push(
        `KiCad will not open ${part}'s symbol library: ${(result.stderr || result.stdout || "").trim().split("\n").slice(-1)[0]}`
      );
    }
  }

  console.log(`  ${fp.status === 0 ? "every" : "NOT every"} footprint plotted, ${symbolsOk} of ${symbolOwner.size} symbol librar(ies) opened.\n`);
  if (problems.length === 0) {
    console.log("  KiCad opens everything this product emits.\n");
    return;
  }
  for (const line of problems) console.log(`  ${line}`);
  console.log(`\n  ${problems.length} file(s) the customer's own tool will not read.\n`);
  process.exitCode = 1;
}

if (process.argv[1]?.endsWith("kicad.ts")) {
  void main();
}
