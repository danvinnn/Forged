/**
 * WHAT HAPPENS WHEN SOMEONE UPLOADS THE WRONG THING.
 *
 * ## Why this exists
 *
 * Every instrument in this repo feeds the product a real datasheet. A person
 * will not. They will pick the scanned photocopy, the file that finished
 * downloading halfway, the errata sheet instead of the datasheet, the .docx they
 * renamed, and the 900-page family reference manual.
 *
 * The failure that matters here is not a crash. A crash is honest. The failure
 * that matters is **HTTP 200 with a near-empty record**: the product says it
 * worked, hands over a page of blanks, and the person has to work out for
 * themselves that nothing was read. That has happened once already, when a model
 * timeout returned a parser-only record with a 200 beside it.
 *
 * So every case below is judged on two things:
 *
 *   1. did it fail SAFELY - a 4xx or 5xx, not a 200 carrying nothing
 *   2. does the message tell a person what to do about it
 *
 * A message is judged by reading it. This bench prints every one, because a
 * string that only a test has ever seen is a string nobody has read.
 *
 * Free: no model call, no network. Every input is built here or read from the
 * repo's own caches.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadBenchEnv } from "./env";

loadBenchEnv();

/**
 * REAL DOCUMENTS, not synthesised ones.
 *
 * The first version of this built its own PDFs and two of the three problems it
 * reported were its own generator: pdf.js rejected both files outright, so what
 * they measured was a broken builder rather than the product. Every awkward case
 * below is now a document that actually exists.
 *
 * The one case this cannot reach is a SCANNED page with no text layer, which is
 * most old mil-spec paper. There is no PDF writer on this machine and no scanned
 * datasheet in the caches, so it is named here as untested rather than faked.
 */
function cached(part: string): Buffer | null {
  for (const directory of [".holdout-cache", ".bench-cache"]) {
    const path = join(process.cwd(), directory, `${part}.pdf`);
    if (existsSync(path)) return readFileSync(path);
  }
  return null;
}

/** One real datasheet from the repo's caches, for the truncation case. */
function aRealDatasheet(): Buffer | null {
  for (const directory of [".bench-cache", ".holdout-cache"]) {
    const path = join(process.cwd(), directory);
    if (!existsSync(path)) continue;
    const name = readdirSync(path).find((entry) => entry.endsWith(".pdf"));
    if (name) return readFileSync(join(path, name));
  }
  return null;
}

interface Case {
  name: string;
  what: string;
  body: Buffer | null;
  fileName?: string;
}

function cases(): Case[] {
  const real = aRealDatasheet();
  return [
    { name: "an empty file", what: "the download never started", body: Buffer.alloc(0) },
    {
      name: "a web page saved as .pdf",
      what: "they saved the product page instead of the datasheet",
      // Big enough to clear the size floor, so this reaches the check that
      // actually applies: it is not a PDF.
      body: Buffer.from(`<!doctype html><title>LM358</title>${"<p>Buy now</p>".repeat(400)}`, "utf8")
    },
    {
      name: "a real datasheet that stops halfway",
      what: "the download was interrupted",
      body: real ? real.subarray(0, Math.floor(real.length / 3)) : null
    },
    {
      // A REAL one. Retrieval fetched this instead of the AD8495 datasheet, and
      // `bench:holdout` has been reporting it as NOT A DATASHEET ever since.
      name: "a real PDF that is not a datasheet",
      what: "they picked the errata, or the search found the wrong document",
      body: cached("AD8495")
    },
    {
      // Also real, and also from the hold-out: read fine, states no pin table.
      name: "a real datasheet with no pin table",
      what: "a part whose document simply does not print one",
      body: cached("CD4017B")
    },
    {
      name: "a file larger than the limit",
      what: "a 900-page family reference manual",
      body: Buffer.concat([Buffer.from("%PDF-1.4\n", "latin1"), Buffer.alloc(51 * 1024 * 1024, 0x20)])
    },
    {
      // A REAL SCANNED DOCUMENT: three pages of a datasheet rendered to JPEG and
      // wrapped in a PDF, with no text layer at all (0 characters over 3 pages).
      //
      // Named as NOT COVERED here until 2026-08-30, on the grounds that there
      // was no PDF writer on the machine and no scanned datasheet in the caches.
      // Both were true and neither made the case go away: an older mil-spec part
      // is frequently a photocopy, and this product's market is older mil-spec
      // parts. Built from a page this repository already renders for the model,
      // so it is a genuine image-only PDF rather than a mock of one.
      name: "a scanned datasheet with no text layer",
      what: "an older part whose only document is a photocopy",
      body: scanned()
    },
    { name: "no file at all", what: "the form posted with nothing attached", body: null, fileName: "" }
  ];
}

/** The image-only PDF in `test-data`, or null where it has not been built. */
function scanned(): Buffer | null {
  const path = join(process.cwd(), "test-data", "scanned-no-text-layer.pdf");
  return existsSync(path) ? readFileSync(path) : null;
}

function verdictOf(status: number, payload: Record<string, unknown>): { safe: boolean; note: string } {
  if (status >= 400) return { safe: true, note: `refused with ${status}` };
  if (status !== 200) return { safe: false, note: `unexpected status ${status}` };

  const record = payload.part as { pins?: { value?: unknown[] | null } } | undefined;
  const pins = record?.pins?.value?.length ?? 0;
  if (pins > 0) return { safe: true, note: `read ${pins} pins` };

  // A 200 THAT READ NOTHING IS ONLY SAFE IF IT SAYS SO.
  //
  // The first version of this called every empty 200 a defect, which is too
  // harsh: a document that genuinely has no pin table should come back read and
  // empty, not refused. What decides it is whether the answer TELLS the person.
  // `packageChoice.ok === false` with `blockedBy` naming the missing fields is
  // what the screen turns into "Not enough was read to build anything: pin table
  // and pin count", so that is the signal to look for rather than a guess about
  // what the UI does.
  const choice = payload.packageChoice as { ok?: boolean; blockedBy?: string[] } | undefined;
  if (choice && choice.ok === false && (choice.blockedBy?.length ?? 0) > 0) {
    return { safe: true, note: `read nothing, and says so: blocked by ${choice.blockedBy!.join(", ")}` };
  }
  return { safe: false, note: "200 OK with nothing read and nothing saying so: the product looks like it worked" };
}

async function main(): Promise<void> {
  const { POST } = await import("../../app/api/parse/route");
  let unsafe = 0;
  let caller = 0;

  console.log("\nSeven things a person could upload that are not the datasheet we hoped for.\n");

  for (const item of cases()) {
    caller += 1;
    const form = new FormData();
    if (item.body !== null) {
      form.set("file", new Blob([new Uint8Array(item.body)], { type: "application/pdf" }), item.fileName ?? "upload.pdf");
    }
    const request = new Request("http://localhost/api/parse", {
      method: "POST",
      headers: { "x-forwarded-for": `10.1.0.${caller}` },
      body: form
    });

    let status: number;
    let payload: Record<string, unknown>;
    try {
      const response = await POST(request);
      status = response.status;
      payload = (await response.json()) as Record<string, unknown>;
    } catch (error) {
      status = -1;
      payload = { error: `THREW: ${error instanceof Error ? error.message : String(error)}` };
    }

    const verdict = status === -1 ? { safe: false, note: "the route threw rather than answering" } : verdictOf(status, payload);
    if (!verdict.safe) unsafe += 1;
    console.log(`  ${verdict.safe ? "ok  " : "BAD "} ${item.name}`);
    console.log(`       (${item.what})`);
    console.log(`       ${verdict.note}`);
    // THE MESSAGE, PRINTED. A string only a test has read is a string nobody
    // has read, and this is the sentence the person is left holding.
    const message = typeof payload.error === "string" ? payload.error : typeof payload.note === "string" ? payload.note : "";
    if (message) console.log(`       says: "${message.slice(0, 220)}"`);
    if (process.env.FORGE_SHOW_PAYLOAD === "1" && status === 200) {
      console.log(`       payload keys: ${Object.keys(payload).join(", ")}`);
      const choice = payload.packageChoice as Record<string, unknown> | undefined;
      console.log(`       packageChoice: ${JSON.stringify(choice).slice(0, 500)}`);
      const record = payload.part as Record<string, { value?: unknown }> | undefined;
      console.log(`       packageType=${JSON.stringify(record?.packageType?.value)} pinCount=${JSON.stringify(record?.pinCount?.value)}`);
      console.log(`       checks=${JSON.stringify((payload.checks as unknown[])?.length)} toCheck=${JSON.stringify((payload.toCheck as unknown[])?.length)}`);
    }
    console.log("");
  }

  console.log(unsafe === 0 ? "  Every bad upload was refused, and said so." : `  ${unsafe} upload(s) failed in a way the person cannot see.`);
  if (unsafe > 0) process.exitCode = 1;
}

void main();
