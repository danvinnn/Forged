/**
 * IS THE PRODUCT ASKING FOR SOMETHING THE DATASHEET ALREADY PRINTS?
 *
 * ## The complaint this exists to answer
 *
 * A user handed the product an LTC6563 datasheet and was asked to type in four
 * numbers. Their question was the right one: "is this truly accurate? does the
 * datasheet truly not have this info?" It did have it. Answering that took an
 * afternoon of reading the PDF by hand, and the answer was only ever going to
 * cover one part.
 *
 * The input model says a question is legitimate only when the document
 * genuinely does not carry the value. Nothing measured whether that held.
 *
 * ## Why the oracles can decide it
 *
 * `DIMENSION_ORACLE` is a person reading rendered drawings and writing down what
 * is printed on them. **A value in it is a value the datasheet demonstrably
 * prints.** So a question about a field the oracle holds for that part's drawing
 * is provably wrong: the number is on the page, a human found it, and the
 * product is asking anyway.
 *
 * That makes the whole question falsifiable without any judgement, any sampling
 * or any spend. It is the same trick `bench:dimensions` plays for correctness,
 * pointed at friction instead.
 *
 * ## What a hit means, and the three kinds
 *
 * Every false question is one of three defects, and the classification is the
 * work list:
 *
 *   HELD    the value is ON the record and we asked regardless. A discard
 *           between the reader and the generator - the `asPackage` capital
 *           letter was exactly this, blanking eight read dimensions.
 *   DROPPED the model returned it and the merge did not keep it. The numberless
 *           pad row was this.
 *   UNREAD  nowhere on the record and nowhere in the model's answer, while a
 *           person read it off the drawing. The reading is at fault and the
 *           oracle names the page to go and look at.
 *
 * A question the oracle does NOT hold a value for is reported as legitimate,
 * because a person looked at that drawing and it prints nothing: an absent key
 * in the oracle is a positive statement, not a gap. See `dimension-oracle.ts`.
 *
 * Free and offline: the model here is a cache reader that throws on a miss.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RequiredInput } from "../exporters";
import { loadBenchEnv } from "./env";
import { DIMENSION_ORACLE, type DimensionOracleEntry } from "./dimension-oracle";
import { promptFingerprint } from "./modelcache";
import { buildCachedParts, type OracleValues } from "./oracle-match";
import { BENCH_SETTINGS, shipOutcome } from "./shipcheck";

loadBenchEnv();

/**
 * The hand-read value for one asked field, or null when the drawing prints none.
 *
 * `null` is a CLAIM here, not a gap: the oracle's entries are partial by design
 * and an absent key records that a person looked and the drawing is silent. That
 * is what makes "this question is legitimate" a finding rather than a shrug.
 *
 * The land pattern is matched across every complete pattern the drawing prints,
 * because a drawing can print more than one and both are the document's own.
 */
function oracleHolds(entry: DimensionOracleEntry, field: RequiredInput["field"]): string | null {
  const range = (value: { minMm: number; maxMm: number } | undefined) =>
    value ? `${value.minMm}-${value.maxMm}` : null;
  const lands = [entry.land, ...(entry.landAlternatives ?? [])].filter((value) => value !== undefined);
  const fromLand = (pick: (land: NonNullable<DimensionOracleEntry["land"]>) => number | undefined) => {
    for (const land of lands) {
      const value = pick(land);
      if (typeof value === "number") return String(value);
    }
    return null;
  };

  switch (field) {
    case "bodyLengthMm":
      return range(entry.bodyLengthMm);
    case "bodyWidthMm":
      return range(entry.bodyWidthMm);
    case "bodyHeightMm":
      return range(entry.bodyHeightMm) ?? (entry.bodyHeightMaxMm !== undefined ? `${entry.bodyHeightMaxMm} max` : null);
    case "pitchMm":
      return entry.pitchMm !== undefined ? String(entry.pitchMm) : null;
    case "leadSides":
      return entry.leadSides !== undefined ? String(entry.leadSides) : null;
    case "thermalPadLengthMm":
      return range(entry.thermalPadLengthMm);
    case "thermalPadWidthMm":
      return range(entry.thermalPadWidthMm);
    case "landPadLengthMm":
      return fromLand((land) => land.padLengthMm);
    case "landPadWidthMm":
      return fromLand((land) => land.padWidthMm);
    case "landSpanMm":
      return fromLand((land) => land.spanMm);
    case "landSpanCrossMm":
      return fromLand((land) => land.spanCrossMm);
    // NOT JUDGEABLE, and deliberately not silently passed. See `UNHOLDABLE`.
    case "leadDiameterMm":
    case "leadsPerSide":
    case "vacantLeadSlot":
    case "formedLeadSpanMm":
    case "formedLeadContactMm":
      return null;
  }
}

/**
 * Fields no drawing can settle, or that this oracle's schema cannot hold.
 *
 * Split in two because the two have different futures.
 *
 * The forming dies are the settings the product makes mandatory precisely
 * because no datasheet states them: a ceramic flat pack arrives with straight
 * leads and the assembler's own tooling decides the formed span. Asking is the
 * only correct behaviour and it is asked ONCE per account, not per part.
 *
 * The other three are real features of a drawing that this schema has no key
 * for. Reporting them as legitimate would be a claim nobody checked, so they are
 * reported as UNJUDGED and they are a schema gap to close.
 */
const SETTING_FIELDS = new Set<string>(["formedLeadSpanMm", "formedLeadContactMm"]);
const UNHOLDABLE = new Set<string>(["leadDiameterMm", "leadsPerSide", "vacantLeadSlot"]);

/**
 * Did the MODEL return this field, under the prompt in force today?
 *
 * Answers the HELD/DROPPED split: a value the model produced and the record does
 * not carry was discarded somewhere between them. Filtered to the current
 * fingerprint because an answer stored under an older question is an answer to a
 * different question, and scoring it reports a product nobody can run.
 */
function modelAnswered(part: string, field: string): boolean {
  const dir = join(process.cwd(), ".model-cache");
  if (!existsSync(dir)) return false;
  const current = promptFingerprint();
  const key = `dimensions.${field}`;
  for (const file of readdirSync(dir)) {
    if (!file.startsWith(`${part}-`) || !file.endsWith(".json")) continue;
    let entry: { prompt?: string; result?: { values?: Record<string, { value?: unknown }> } };
    try {
      entry = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      continue;
    }
    if (entry.prompt !== current) continue;
    const values = entry.result?.values ?? {};
    if (values[key]?.value !== undefined && values[key]?.value !== null) return true;
    // The per-package table, where a family datasheet states every measurement.
    const packages = values["packagesInThisDocument"]?.value;
    if (Array.isArray(packages)) {
      for (const offered of packages) {
        const dims = (offered as { dimensions?: Record<string, { value?: unknown } | unknown> })?.dimensions;
        if (!dims || typeof dims !== "object") continue;
        const held = (dims as Record<string, unknown>)[field];
        const value = held !== null && typeof held === "object" ? (held as { value?: unknown }).value : held;
        if (value !== undefined && value !== null) return true;
      }
    }
  }
  return false;
}

/** Is the value already sitting on the record the generator was handed? */
function recordHolds(values: OracleValues, field: string): boolean {
  const held = values[`dimensions.${field}`]?.value;
  return held !== undefined && held !== null;
}

type Kind = "HELD" | "DROPPED" | "UNREAD";

interface Finding {
  part: string;
  outline: string;
  field: string;
  kind: Kind;
  printed: string;
}

async function main(): Promise<void> {
  const built = await buildCachedParts();
  if (!built) {
    console.log("No model configured, so no records can be rebuilt.");
    return;
  }

  const findings: Finding[] = [];
  const legitimate: string[] = [];
  const unjudged: string[] = [];
  const settings: string[] = [];
  let asking = 0;
  let asked = 0;

  for (const entry of built) {
    const outcome = await shipOutcome(entry.record, BENCH_SETTINGS);
    if (outcome.asks.length === 0) continue;
    asking += 1;
    asked += outcome.asks.length;

    const oracle = entry.oracleCode ? DIMENSION_ORACLE[entry.oracleCode] : null;
    for (const need of outcome.asks) {
      const where = `${entry.part}.${need.field}`;
      if (SETTING_FIELDS.has(need.field)) {
        settings.push(where);
        continue;
      }
      if (UNHOLDABLE.has(need.field)) {
        unjudged.push(`${where} (no oracle key for this feature)`);
        continue;
      }
      if (!oracle) {
        unjudged.push(`${where} (no hand-read drawing for this part)`);
        continue;
      }
      const printed = oracleHolds(oracle, need.field);
      if (printed === null) {
        legitimate.push(`${where} [${entry.oracleCode}]`);
        continue;
      }
      const kind: Kind = recordHolds(entry.values, need.field)
        ? "HELD"
        : modelAnswered(entry.part, need.field)
          ? "DROPPED"
          : "UNREAD";
      findings.push({ part: entry.part, outline: entry.oracleCode!, field: need.field, kind, printed });
    }
  }

  console.log(`\n${asking} of ${built.length} cached parts are asked a question. ${asked} questions in total.\n`);

  for (const finding of findings) {
    console.log(
      `  FALSE ${finding.kind.padEnd(8)} ${finding.part.padEnd(14)} ${finding.field.padEnd(19)} ` +
        `the drawing prints ${finding.printed} (${finding.outline})`
    );
  }

  // EVERY QUESTION, not just the wrong ones. A run reporting "0 false" has to
  // be readable as a run that looked, or it is indistinguishable from a run that
  // matched nothing - which is the shape of every instrument on this project
  // that reported a clean sheet while being unable to see.
  if (legitimate.length > 0) {
    console.log("  Asked, and the hand-read drawing prints nothing for it:");
    for (const where of legitimate) console.log(`    ok     ${where}`);
    console.log("");
  }

  console.log(`  FALSE QUESTIONS ${findings.length}`);
  console.log(`    HELD    ${findings.filter((f) => f.kind === "HELD").length}  on the record, asked anyway`);
  console.log(`    DROPPED ${findings.filter((f) => f.kind === "DROPPED").length}  the model returned it, the merge did not keep it`);
  console.log(`    UNREAD  ${findings.filter((f) => f.kind === "UNREAD").length}  printed on the drawing, never read`);
  console.log(`  LEGITIMATE ${legitimate.length}  a person read the drawing and it prints nothing`);
  console.log(`  SETTINGS   ${settings.length}  no datasheet states these, asked once per account`);
  console.log(`  UNJUDGED   ${unjudged.length}  nothing hand-read can decide these`);

  if (unjudged.length > 0) {
    console.log("");
    for (let i = 0; i < unjudged.length; i += 3) console.log(`    ${unjudged.slice(i, i + 3).join(", ")}`);
  }

  if (findings.length > 0) {
    console.log(`\n  Every FALSE above is the product asking a user for a number that is on the page in front of them.`);
    process.exitCode = 1;
  }
}

main();
