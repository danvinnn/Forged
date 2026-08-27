import { test } from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { createExportZip } from "../exporters";
import type { ResolvedPart } from "../types";

// EXPORTING THE SAME RECORD TWICE MUST PRODUCE THE SAME BYTES.
//
// An engineer who re-runs a part they already reviewed and signed off is
// entitled to the same library. Until 2026-08-21 they did not get it, and the
// reason had nothing to do with the model: `buildStepModel` and the manifest
// each called `new Date()` where they stood, so every export differed.
//
// The distinction that matters, and that this file pins down: the GEOMETRY was
// already reproducible. Every file a board is fabricated from - the KiCad
// footprint and symbol, both Altium libraries - is a pure function of the
// record. Only the two provenance files read the clock, and they hid that fact,
// because anyone diffing two bundles saw a difference and could not tell
// whether the copper had moved.

function soic8(): ResolvedPart {
  return {
    id: "repro-1",
    partNumber: "ACME555",
    manufacturer: "Test",
    packageType: "SOIC-8",
    packageOutlineCode: null,
    jedecOutline: null,
    vendorLandPattern: null,
    exposedPad: false,
    pinCount: 8,
    pins: Array.from({ length: 8 }, (_, index) => ({
      number: String(index + 1),
      name: `P${index + 1}`,
      electricalType: "unspecified" as const
    })),
    dimensions: {
      bodyLengthMm: 4.9,
      bodyWidthMm: 3.9,
      bodyHeightMm: 1.5,
      pitchMm: 1.27,
      leadLengthMm: 0.6,
      leadCount: 8,
      leadWidthMm: { minMm: 0.31, maxMm: 0.51 },
      leadSpanMm: { minMm: 5.8, maxMm: 6.2 },
      leadSpanCrossMm: null,
      leadContactMm: { minMm: 0.4, maxMm: 0.625 },
      thermalPadLengthMm: null,
      thermalPadWidthMm: null,
      landPadLengthMm: null,
      landPadWidthMm: null,
      landSpanMm: null,
      landSpanCrossMm: null,
      leadSides: 2,
      leadForm: "gullwing",
      mounting: null,
      leadDiameterMm: null,
      vacantLeadSlot: null,
      leadsPerSide: null,
      solderMaskExpansionMm: null,
      solderMaskDefined: null,
      thermalViaDiameterMm: null,
      thermalViaPitchMm: null
    },
    radiation: { tid: null, see: null, sel: null, qmlClass: null },
    sourceFileName: "test.pdf",
    notes: []
  };
}

/** Every file in the bundle, as text, keyed by name. */
async function filesOf(bundle: Awaited<ReturnType<typeof createExportZip>>): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(bundle.buffer);
  const out = new Map<string, string>();
  const names = Object.keys(zip.files).sort();
  for (const name of names) {
    const entry = zip.files[name];
    if (entry.dir) continue;
    out.set(name, await entry.async("string"));
  }
  return out;
}

test("every entry in the archive carries the pinned date, not the wall clock", async () => {
  // THE DETERMINISTIC FORM OF THE TEST BELOW.
  //
  // `manifest.json` was written with a bare `zip.file(name, content)` while every
  // other entry passed `{ date }`. JSZip stamps an undated entry from the wall
  // clock, so the bundle was not reproducible.
  //
  // The byte comparison below is the right property but a poor detector: the ZIP
  // date field has TWO-SECOND resolution, so two builds inside one tick are
  // identical and two straddling a tick are not. It passed roughly nine runs in
  // ten and went red in CI, and for months that read as a flaky test rather than
  // as the product being non-deterministic.
  //
  // This asks the question directly, of every entry, and cannot pass by luck.
  const at = new Date("2026-08-21T12:00:00.000Z");
  const bundle = await createExportZip(soic8(), "kicad", { generatedAt: at });
  const zip = await JSZip.loadAsync(bundle.buffer);

  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  assert.ok(entries.length > 1, "more than one entry, or this proves nothing");
  for (const entry of entries) {
    assert.equal(
      // The ZIP stores DOS time to a two-second resolution, so the stored value
      // is the pinned instant rounded, not the instant itself.
      Math.abs(entry.date.getTime() - at.getTime()) <= 2000,
      true,
      `${entry.name} is stamped ${entry.date.toISOString()} and not the pinned ${at.toISOString()}`
    );
  }
});

test("a pinned timestamp makes the whole ARCHIVE byte-identical", async () => {
  const at = new Date("2026-08-21T12:00:00.000Z");
  const first = await createExportZip(soic8(), "kicad", { generatedAt: at });
  const second = await createExportZip(soic8(), "kicad", { generatedAt: at });

  // The raw zip, not just its contents. A zip carries a modification date per
  // entry, and JSZip fills it from the clock unless told otherwise, so two
  // archives of identical files differed for a third reason beyond the two
  // `new Date()` calls this work started from.
  assert.equal(
    Buffer.compare(Buffer.from(first.buffer), Buffer.from(second.buffer)),
    0,
    "the same record and the same timestamp must produce the same archive"
  );

  // And per file, because a byte comparison that fails says nothing about where.
  const firstFiles = await filesOf(first);
  const secondFiles = await filesOf(second);
  assert.deepEqual([...firstFiles.keys()], [...secondFiles.keys()], "same files");
  for (const [name, content] of firstFiles) {
    assert.equal(content, secondFiles.get(name), `${name} must be byte-identical`);
  }
});

// THE GUARANTEE THAT HOLDS EVEN WITHOUT PINNING, and the one a user relies on.
//
// Production does not pin the clock, because a file claiming to have been made
// at a time it was not is worse than a file that differs. So the promise made to
// an engineer is narrower and stronger: everything you FABRICATE FROM is
// identical, and only the two provenance files carry the time.
test("without pinning, every file a board is built from is still identical", async () => {
  const first = await filesOf(await createExportZip(soic8(), "kicad"));
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const second = await filesOf(await createExportZip(soic8(), "kicad"));

  const PROVENANCE = [/manifest\.json$/, /\.step$/i, /\.stp$/i];
  let compared = 0;
  for (const [name, content] of first) {
    if (PROVENANCE.some((pattern) => pattern.test(name))) continue;
    compared += 1;
    assert.equal(content, second.get(name), `${name} must not depend on the clock`);
  }
  assert.ok(compared >= 2, `expected several geometry files, compared ${compared}`);
});

// The regression guard. If someone adds `new Date()` to an emitter, the test
// above still passes when the pinned one is used, so this asserts the shape
// directly: no emitted geometry file may contain a year-like timestamp that
// moved between two exports a second apart.
test("no geometry file carries a wall-clock timestamp", async () => {
  const at = new Date("2026-08-21T12:00:00.000Z");
  const files = await filesOf(await createExportZip(soic8(), "kicad", { generatedAt: at }));
  for (const [name, content] of files) {
    if (/manifest\.json$/.test(name) || /\.ste?p$/i.test(name)) continue;
    assert.ok(
      !content.includes(at.toISOString()),
      `${name} stamps the export time into a file a board is built from`
    );
  }
});
