import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LAYER_COUNT, layerStackParameters } from "../altium/layers";

/**
 * The layer table is checked against bytes Altium wrote, not against itself.
 *
 * `altium-layer-stack.golden.txt` is the `LAYER1NAME` through
 * `LAYER82DIELMATERIAL` run lifted verbatim out of the `/Library/Data` header of
 * `PCB - LEADLESS - QFN - QORVO RFSW6024.PcbLib`, a manufacturer-authored
 * footprint library from AltiumSharp's corpus. It enables Mechanical 1, 13 and
 * 15, so the generator is asked for that same set and has to reproduce the file
 * exactly, marker positions and carriage returns included.
 *
 * This was run against all 89 `.PcbLib` files in that corpus while the generator
 * was being written: 84 came back byte-identical and the other 5 differed only
 * in the copper `PREV`/`NEXT` chain, because they are 3- and 4-layer boards and
 * this emits the 2-layer chain every manufacturer footprint library carries.
 * Nothing else varied, which is what makes the table a constant rather than
 * somebody's stackup.
 */

const GOLDEN = fileURLToPath(new URL("./altium-layer-stack.golden.txt", import.meta.url));

function serialise(parameters: Array<[string, string]>): string {
  return parameters.map(([key, value]) => `${key}=${value}`).join("|");
}

test("the layer table reproduces the one Altium wrote, byte for byte", () => {
  const golden = readFileSync(GOLDEN, "latin1");
  const built = serialise(layerStackParameters([57, 69, 71]));

  assert.equal(built.length, golden.length, "same length");
  assert.equal(built, golden);
});

test("every layer byte is named, and named the way Altium names it", () => {
  const parameters = new Map(layerStackParameters([]));

  for (let layer = 1; layer <= LAYER_COUNT; layer += 1) {
    assert.ok(parameters.has(`LAYER${layer}NAME`), `layer ${layer} is named`);
  }

  // The three the emitter draws on. If any of these ever disagrees with the
  // number in `pcblib.ts`, primitives are landing somewhere other than where
  // this file says they are.
  assert.equal(parameters.get("LAYER1NAME"), "Top Layer");
  assert.equal(parameters.get("LAYER33NAME"), "Top Overlay");
  assert.equal(parameters.get("LAYER71NAME"), "Mechanical 15");
  assert.equal(parameters.get("LAYER57NAME"), "Mechanical 1");
});

test("only the mechanical layers asked for are enabled", () => {
  const parameters = new Map(layerStackParameters([57, 71]));

  // A layer drawn on and not enabled is invisible in Altium; a layer enabled and
  // never drawn on is clutter in the layer tabs. Both directions are asserted.
  assert.equal(parameters.get("LAYER57MECHENABLED"), "TRUE", "the component body layer");
  assert.equal(parameters.get("LAYER71MECHENABLED"), "TRUE", "the courtyard layer");
  assert.equal(parameters.get("LAYER69MECHENABLED"), "FALSE", "nothing is drawn on Mechanical 13");
  assert.equal(parameters.get("LAYER58MECHENABLED"), "FALSE");
  assert.equal(parameters.get("LAYER72MECHENABLED"), "FALSE");
});

test("a non-mechanical layer cannot be enabled", () => {
  // MECHENABLED exists only for 57 to 72. Passing anything else means the caller
  // has confused the layer table with the layer byte, and quietly ignoring it
  // would leave them believing a layer was turned on.
  assert.throws(() => layerStackParameters([33]), /not a mechanical layer/);
  assert.throws(() => layerStackParameters([1]), /not a mechanical layer/);
});
