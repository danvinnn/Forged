import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * NO SENTENCE MAY ASSERT WHAT A DOCUMENT CONTAINS UNLESS WE LOOKED AND CAN SAY
 * WHERE.
 *
 * ## The defect this exists to stop
 *
 * A user was told "no recommended footprint was found in this datasheet for
 * this package" while the page that printed it sat on the record. The claim was
 * not a wording slip: the code had checked one vendor's spelling of one heading,
 * found nothing, and reported the absence as a property of the document. When
 * the search was widened the same corpus went from 4 datasheets located to 36.
 *
 * That is the whole shape. A negative claim about a document is a claim about
 * every page of it, and this product reads a handful. What it actually knows is
 * what its own reading returned, and saying THAT is both true and more useful:
 * "this was not read" tells a user to look, where "the datasheet does not have
 * it" tells them to stop.
 *
 * ## Why a source scan rather than a behavioural test
 *
 * The sentences are the defect. Each one is produced on a different refusal path
 * with its own preconditions, and reaching all of them through the product would
 * take more scaffolding than the check is worth - while the property being
 * checked is visible in the text itself.
 *
 * So this reads the source and refuses the phrasings that assert absence. It is
 * a narrow instrument and it says so: it cannot catch a new sentence phrased a
 * new way, and it can catch every one of the six that were found on 2026-08-25
 * coming back.
 */

/** The repo root, so paths in a failure read the way a developer types them. */
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCE = join(ROOT, "src");

/**
 * THE PROMPT IS ADDRESSED TO THE MODEL, NOT TO A USER.
 *
 * "Null if the datasheet prints no such drawing" is the correct instruction to
 * give a reader: it tells the model what to answer when it looks and sees
 * nothing, which is the honest answer and the one this whole rule is about.
 * Nothing in it is shown to anybody.
 */
const NOT_ADDRESSED_TO_A_USER = ["src/lib/extraction/models/prompt.ts"];

/** Every .ts and .tsx under src, minus the tests and benches that discuss them. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "__tests__" || name === "__bench__" || name === "node_modules") continue;
      sources(path, out);
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    if (NOT_ADDRESSED_TO_A_USER.some((skip) => path.endsWith(skip.replace(/\//g, sep)))) continue;
    out.push(path);
  }
  return out;
}

/**
 * A CONDITIONAL IS NOT A CLAIM.
 *
 * "where the document prints no outline for it, its footprint cannot be built"
 * states a rule about documents in general and asserts nothing about the one in
 * front of the user. The rule this file enforces is about assertions.
 */
const CONDITIONAL = /\b(where|if|unless|when|whenever)\s*$/i;

/**
 * Phrasings that state an absence as a fact about the document.
 *
 * Every one of these was a live sentence in the product. They are listed as
 * patterns rather than exact strings so a reworded return of the same claim is
 * still caught.
 */
const ASSERTS_ABSENCE: Array<{ pattern: RegExp; instead: string }> = [
  {
    pattern: /(this |the )?(datasheet|document)('s)? (prints?|draws?|gives?|supplies|has|contains?|carries) no\b/i,
    instead: "say what the reading returned, e.g. \"no X was read from this datasheet\""
  },
  {
    pattern: /\bnothing (else )?in (this|the) (datasheet|document)\b/i,
    instead: "say what was read, not what the document holds"
  },
  {
    pattern: /\bno page of (this|the) (datasheet|document)\b/i,
    instead: "say the value was not located, which is a fact about the reading"
  },
  {
    pattern: /(this|the) (datasheet|document) (covers|describes|gives) (a pinout for each|several)\b/i,
    instead: "say how many were read, which is what is known"
  }
];

test("no user-facing sentence asserts what a document does not contain", () => {
  const offences: string[] = [];
  for (const path of sources(SOURCE)) {
    const text = readFileSync(path, "utf8");
    text.split("\n").forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
      // A COMMENT MAY QUOTE THE FORBIDDEN WORDING, and several do, precisely so
      // the reason survives beside the code that used to say it. Located by
      // position rather than by how the line starts: the explanations sit on the
      // same line as the code they replaced.
      const comment = line.indexOf("//");
      for (const { pattern, instead } of ASSERTS_ABSENCE) {
        const found = pattern.exec(line);
        if (!found) continue;
        if (comment !== -1 && found.index > comment) continue;
        if (CONDITIONAL.test(line.slice(0, found.index))) continue;
        offences.push(
          `${path.slice(ROOT.length + 1)}:${index + 1}  ${trimmed.slice(0, 110)}\n      instead: ${instead}`
        );
      }
    });
  }

  assert.deepEqual(
    offences,
    [],
    `A sentence claims what a document does not contain. We read a handful of pages; ` +
      `an absence in our reading is not an absence in the document.\n\n${offences.join("\n\n")}\n`
  );
});

/**
 * The positive direction, which is the other half of the same rule: a claim that
 * a document DOES contain something is fine, and has to name where.
 *
 * Only the land-pattern refusal is pinned here, because it is the one that was
 * actually wrong and the one whose page is available at the point of writing.
 */
test("the land-pattern refusal names the page when the datasheet prints one", async () => {
  const source = readFileSync(join(ROOT, "src/lib/exporters.ts"), "utf8");
  const match = /const why = landPage[\s\S]{0,400}?;/.exec(source);
  assert.ok(match, "the land-pattern refusal still chooses its wording on whether a page was found");
  assert.match(
    match[0],
    /page \$\{landPage\}/,
    "the branch that says a footprint IS printed must name the page it is printed on"
  );
  assert.match(
    match[0],
    /No recommended footprint was read/,
    "and the branch that found none must say it was not READ, not that none exists"
  );
});
