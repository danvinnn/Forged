/**
 * Is every cached datasheet actually the datasheet it is filed under?
 *
 * ## The failure this exists for
 *
 * On 2026-08-21, hand-reading a package drawing turned up a mechanical section
 * that did not match the part it was stored as. Three of the 123 cached PDFs
 * were complete, well-formed, correct datasheets FOR A DIFFERENT DEVICE:
 *
 *     .bench-cache/TPS7A4700.pdf     is TPS7A20
 *     .holdout-cache/TPS7A4700.pdf   is TPS7A84
 *     .holdout-cache/TPS7A4901.pdf   is TPS7A20
 *
 * Two of those are in the hold-out, so the number this project quotes as its
 * honest one had been scoring reads of the wrong chip as wins.
 *
 * Nothing caught it. Not seven guards, not 719 tests, not `validateGeometry`,
 * not `bench:copper`. They could not have: every one of them asks whether the
 * output is consistent with the document, and it was. The document was wrong.
 * It took a human opening a page and looking at it.
 *
 * ## Why a bench and not a test
 *
 * The corpora are not in the repository - no vendor datasheet is ever committed,
 * so `.bench-cache/` and `.holdout-cache/` are gitignored. A unit test therefore
 * cannot see them, and a check that cannot see the thing it checks is worse than
 * none. This runs against whatever is on the machine that has the caches.
 *
 * ## What it asserts
 *
 *   WRONG PART   the document does not name the part it is filed under,
 *                by the same `namesThePart` rule the product applies to a
 *                user's fetch
 *   NOT A DOC    the document is too small to be a datasheet at all, by the
 *                same `looksLikeWrongDocument` rule
 *   UNREADABLE   the PDF is on disk but no text comes out of it
 *   ORPHAN       a cached file that belongs to no corpus entry, so nothing
 *                scores it and nothing would ever notice it rotting
 *
 * Sharing the product's two predicates is the whole point. A bench with its own
 * private notion of "wrong document" measures a rule nobody ships; when these
 * two were duplicated between `holdout.ts` and the route they had already
 * drifted once.
 *
 * Air-gap safe and free: reads local files, no network, no model, no spend.
 *
 * Usage:
 *   npm run bench:corpus
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { defect } from "./inject";
import { extractDatasheetText, looksLikeWrongDocument, namesThePart } from "../pdftext";
import { BENCH_CORPUS } from "../retrieval/__bench__/corpus";
import { HOLDOUT_CACHE_DIR, HOLDOUT_CORPUS, holdoutCachePath } from "./holdout-corpus";

const BENCH_CACHE_DIR = join(process.cwd(), ".bench-cache");

function benchCachePath(partNumber: string): string {
  return join(BENCH_CACHE_DIR, `${partNumber.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`);
}

interface Finding {
  corpus: string;
  part: string;
  check: "WRONG PART" | "NOT A DOC" | "UNREADABLE" | "ORPHAN";
  detail: string;
}

/**
 * The first line of a document, which is what a human would look at to settle
 * "what is this actually?". Printed alongside a WRONG PART finding so the reader
 * can judge the call rather than take the predicate's word for it.
 */
function heading(text: string): string {
  const line = text
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length >= 4);
  return (line ?? "").replace(/\s+/g, " ").slice(0, 72);
}

interface CorpusSpec {
  name: string;
  dir: string;
  parts: { partNumber: string }[];
  pathFor: (partNumber: string) => string;
}

async function checkCorpus(spec: CorpusSpec): Promise<{ findings: Finding[]; checked: number }> {
  const findings: Finding[] = [];
  let checked = 0;
  const accounted = new Set<string>();

  for (const part of spec.parts) {
    const path = spec.pathFor(part.partNumber);
    accounted.add(basename(path));
    // A part with no cached PDF is not a hygiene problem. `bench:extraction` and
    // `bench:holdout` both already report what they could not fetch, and saying
    // it a third time would bury the findings that matter under a list of gaps.
    if (!existsSync(path)) continue;
    checked += 1;

    const bytes = readFileSync(path);
    let doc;
    try {
      doc = await extractDatasheetText(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      );
    } catch (error) {
      findings.push({
        corpus: spec.name,
        part: part.partNumber,
        check: "UNREADABLE",
        detail: error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 120) : String(error)
      });
      continue;
    }

    if (looksLikeWrongDocument(doc)) {
      const chars = doc.pages.reduce((sum, page) => sum + page.text.length, 0);
      findings.push({
        corpus: spec.name,
        part: part.partNumber,
        check: "NOT A DOC",
        detail: `${doc.pages.length} page(s), ${chars} chars: "${heading(doc.pages[0]?.text ?? "")}"`
      });
      continue;
    }

    // A DOCUMENT FILED UNDER THE WRONG PART, which is the failure this bench was
    // written for and which has reported zero since the day it was fixed. The
    // part number is corrupted rather than the document, so `namesThePart` is
    // asked exactly the question it exists to answer.
    //
    // Asked about a DIFFERENT part rather than a mangled one. A suffix does not
    // work: `namesThePart` walks the stem back a character at a time, so
    // `LM358-NOTAREAL` still matches on `LM358` and only 1 of 116 was reported.
    const asked = defect("corpus.text", part.partNumber, () => "QX9987654B");
    if (!namesThePart(doc, asked)) {
      findings.push({
        corpus: spec.name,
        part: part.partNumber,
        check: "WRONG PART",
        detail: `front matter reads "${heading(doc.pages[0]?.text ?? "")}"`
      });
    }
  }

  if (existsSync(spec.dir)) {
    for (const file of readdirSync(spec.dir)) {
      if (!file.toLowerCase().endsWith(".pdf")) continue;
      if (accounted.has(file)) continue;
      findings.push({
        corpus: spec.name,
        part: file.replace(/\.pdf$/i, ""),
        check: "ORPHAN",
        detail: "cached but in no corpus list, so nothing scores it"
      });
    }
  }

  return { findings, checked };
}

async function main(): Promise<void> {
  const specs: CorpusSpec[] = [
    {
      name: "tuned",
      dir: BENCH_CACHE_DIR,
      parts: BENCH_CORPUS,
      pathFor: benchCachePath
    },
    {
      name: "hold-out",
      dir: HOLDOUT_CACHE_DIR,
      parts: HOLDOUT_CORPUS,
      pathFor: holdoutCachePath
    }
  ];

  const findings: Finding[] = [];
  let checked = 0;
  for (const spec of specs) {
    const result = await checkCorpus(spec);
    findings.push(...result.findings);
    checked += result.checked;
  }

  console.log(`\nChecked ${checked} cached datasheet(s) against the part they are filed under.`);
  console.log("  No network, no model, no spend.\n");

  if (findings.length === 0) {
    console.log("  Every cached document names its own part.\n");
    return;
  }

  for (const finding of findings) {
    console.log(
      `  ${finding.check.padEnd(11)} ${finding.corpus.padEnd(9)} ${finding.part.padEnd(18)} ${finding.detail}`
    );
  }

  // ONLY the dangerous class fails the run.
  //
  // A document for the WRONG DEVICE reads perfectly and scores as a WIN, so it
  // makes a measurement false in the flattering direction and every figure taken
  // from a corpus in that state has to be thrown away. An UNREADABLE file is the
  // same kind of problem seen from the other side: the corpus says a part is
  // covered and no measurement can use it.
  //
  // NOT A DOC is different and must NOT fail. The retrieval corpus deliberately
  // contains vendors that publish no public datasheet - VA41630 is
  // `expect: "miss"` precisely because VORAGO serves a web page - and both
  // scoring benches already name that case and set it aside rather than counting
  // it as a read failure. Failing here would leave this permanently red for a
  // reason nobody can fix, which is how a check stops being read.
  //
  // ORPHAN does not fail either: it is a housekeeping note, not a wrong number.
  const invalidating = findings.filter((f) => f.check === "WRONG PART" || f.check === "UNREADABLE");
  console.log(`\n  ${findings.length} finding(s).`);
  if (invalidating.length > 0) {
    console.log(`  ${invalidating.length} of them are documents that are not the part they claim to be.`);
    console.log("  Every figure measured over this corpus is invalid until they are replaced.\n");
    process.exitCode = 1;
  } else {
    const notADoc = findings.filter((f) => f.check === "NOT A DOC").length;
    const orphans = findings.filter((f) => f.check === "ORPHAN").length;
    const parts = [
      notADoc > 0 ? `${notADoc} retrieval miss(es): the vendor served no datasheet, which both scoring benches already set aside` : null,
      orphans > 0 ? `${orphans} orphan(s): cached files no corpus scores. Delete or adopt.` : null
    ].filter(Boolean);
    console.log(`  Every cached document is the part it claims to be. ${parts.join(" ")}\n`);
  }
}

main().catch((error) => {
  console.error("corpus hygiene run failed:", error);
  process.exitCode = 1;
});
