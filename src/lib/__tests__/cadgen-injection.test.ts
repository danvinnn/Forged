import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { createExportZip } from "../exporters";
import type { ResolvedPart } from "../types";

// ENFORCED deferred obligation CADGEN_INPUT_SANITIZATION.
//
// This is not a documented caveat, it is a FAILING test that stays red until the injection is
// fixed. It exists because the malicious value arrives through a Layer 1 lookup (a crafted part
// number resolved from a datasheet), even though the vulnerable sink is Layer 3 generation code.
//
// STEP Part 21 and KiCad s-expressions both use quoted string literals. A part number containing
// the quote character breaks out of the literal, exactly like SQL/format injection, and corrupts
// or hijacks the generated file. The fix is to escape or whitelist every extracted value before
// interpolating it into generated output. When that is done, this test passes, and the matching
// ledger sentinel CADGEN_INPUT_SANITIZATION_DONE can be added.

function partWith(partNumber: string): ResolvedPart {
  return {
    id: "inj-1",
    partNumber,
    manufacturer: "Test",
    packageType: "SOIC-8",
    packageOutlineCode: null,
    pinCount: 8,
    pins: [],
    dimensions: {
      bodyLengthMm: 4.9,
      bodyWidthMm: 3.9,
      bodyHeightMm: 1.5,
      pitchMm: 1.27,
      leadLengthMm: 0.6,
      leadCount: 8,
      leadWidthMm: null, leadSpanMm: null, leadContactMm: null
    },
    radiation: { tid: null, see: null, sel: null, qmlClass: null },
    sourceFileName: "test.pdf",
    notes: []
  } as ResolvedPart;
}

async function fileContents(zipBytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(zipBytes);
  const parts: string[] = [];
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    parts.push(await zip.files[name].async("string"));
  }
  return parts.join("\n---\n");
}

test("STEP export: a single quote cannot break out of a Part 21 string literal", async () => {
  // In STEP, string literals are single-quoted and a literal quote is escaped by DOUBLING it.
  // Raw, PRODUCT('LMP7704','INJECTED') would parse as two arguments; escaped, it stays one.
  const malicious = "LMP7704','INJECTED";
  const bundle = await createExportZip(partWith(malicious), "kicad");
  const zip = await JSZip.loadAsync(new Uint8Array(bundle.buffer));
  const stepName = Object.keys(zip.files).find((n) => n.endsWith(".step"));
  assert.ok(stepName, "expected a .step file");
  const step = await zip.files[stepName!].async("string");

  // The unescaped break-out (a lone quote-comma-quote) must not appear; the escaped form (doubled
  // quotes) is what a correct implementation produces.
  assert.doesNotMatch(step, /'LMP7704','INJECTED'/, "single quote broke out of the STEP literal (CADGEN_INPUT_SANITIZATION)");
  assert.match(step, /LMP7704'',''INJECTED/, "expected doubled-quote escaping in STEP output");
});

test("KiCad export: a quote+newline cannot inject an s-expression token", async () => {
  // KiCad s-expression strings are double-quoted. A raw double quote plus newline would close the
  // string and let the following text parse as new tokens. Correct handling escapes the quote and
  // neutralizes the newline, so no bare (evil_token appears at line start.
  const malicious = 'LMP7704"\n  (evil_token 1)';
  const bundle = await createExportZip(partWith(malicious), "kicad");
  const zip = await JSZip.loadAsync(new Uint8Array(bundle.buffer));
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir || !/\.(kicad_sym|kicad_mod)$/.test(name)) continue;
    const text = await zip.files[name].async("string");
    assert.doesNotMatch(text, /^\s*\(evil_token/m, `${name}: quote/newline injected a KiCad token (CADGEN_INPUT_SANITIZATION)`);
  }
});
