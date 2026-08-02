/**
 * The v6 layer table that every Altium `.PcbLib` carries in `/Library/Data`.
 *
 * ## Why a footprint library needs one
 *
 * A primitive stores its layer as a byte. The byte alone does not enable the
 * layer: Altium keeps a per-document table saying which mechanical layers are
 * turned on, and a mechanical layer that is off is not drawn. Our courtyard sits
 * on Mechanical 15. Without this table, Altium falls back to its default, which
 * enables Mechanical 1 and nothing else, and the courtyard is in the file and
 * invisible on screen. That is the "opens and looks wrong" failure the emitter
 * documentation warns about, and it is the reason this table is not optional.
 *
 * All eleven manufacturer-authored footprint libraries in AltiumSharp's corpus
 * enable exactly Mechanical 1, 13 and 15, and put their courtyards on 15. We
 * enable the two we actually draw on and leave the rest alone.
 *
 * ## Where the values come from
 *
 * The block is a constant. Across all 89 Altium-written `.PcbLib` files in the
 * corpus, the 738 keys differ only in `MECHENABLED` (which layers are on) and in
 * the `PREV`/`NEXT` chain (how many copper layers the board has). Everything
 * else, including the layer names and the dielectric defaults, is byte-identical
 * everywhere. So this is Altium's own default layer table, not some project's
 * stackup, and `altium-layer-stack.test.ts` checks that what this file builds is
 * byte-for-byte what Altium wrote.
 *
 * The one piece of structure that had to be measured rather than guessed is the
 * sub-record boundary. Altium restarts the record every five layers, exactly,
 * regardless of byte length, and terminates the outgoing one with a carriage
 * return: `...FR-4\r|RECORD=Board|LAYER6NAME=...`. Both halves matter, and both
 * are checked against the golden capture rather than reasoned about.
 */

/**
 * Layer names indexed by the v7 layer byte, 1 to 82.
 *
 * This is also the ground truth for the layer numbers the emitter writes:
 * `LAYER71NAME=Mechanical 15` is Altium's own statement of which byte that
 * layer is, taken from files Altium wrote rather than derived from a formula.
 */
const LAYER_NAMES: readonly string[] = [
  "", // index 0 is unused: layer bytes start at 1
  "Top Layer",
  ...Array.from({ length: 30 }, (_, index) => `Mid-Layer ${index + 1}`),
  "Bottom Layer",
  "Top Overlay",
  "Bottom Overlay",
  "Top Paste",
  "Bottom Paste",
  "Top Solder",
  "Bottom Solder",
  ...Array.from({ length: 16 }, (_, index) => `Internal Plane ${index + 1}`),
  "Drill Guide",
  "Keep-Out Layer",
  ...Array.from({ length: 16 }, (_, index) => `Mechanical ${index + 1}`),
  "Drill Drawing",
  "Multi-Layer",
  "Connections",
  "Background",
  "DRC Error Markers",
  "Selections",
  "Visible Grid 1",
  "Visible Grid 2",
  "Pad Holes",
  "Via Holes"
];

/** The highest layer byte the table describes. */
export const LAYER_COUNT = 82;

/**
 * The copper chain, as a two-layer board: Top through to Bottom, with the
 * overlay, paste and solder layers pointing at the copper they belong to. A
 * footprint library has no board, and this is the plainest one there is. It is
 * what all eleven manufacturer footprint libraries in the corpus carry.
 */
const CHAIN: Record<number, { prev: number; next: number }> = {
  1: { prev: 0, next: 32 },
  32: { prev: 1, next: 0 },
  33: { prev: 0, next: 1 },
  34: { prev: 32, next: 0 },
  35: { prev: 0, next: 1 },
  36: { prev: 32, next: 0 },
  37: { prev: 0, next: 1 },
  38: { prev: 32, next: 0 }
};

/**
 * Dielectric and copper defaults. Identical on every one of the 82 layers in
 * every file in the corpus, which is what makes them defaults rather than
 * anyone's board.
 */
const DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ["COPTHICK", "1.4mil"],
  ["DIELTYPE", "0"],
  ["DIELCONST", "4.800"],
  ["DIELHEIGHT", "12.6mil"],
  ["DIELMATERIAL", "FR-4"]
];

/** Altium restarts the sub-record every five layers. Measured, not guessed. */
const LAYERS_PER_RECORD = 5;

/** Terminates a sub-record, immediately before the next `RECORD=Board`. */
const RECORD_TERMINATOR = "\r";

/**
 * Builds the layer table as an ordered parameter list.
 *
 * @param enabledMechanical - The mechanical layer bytes (57 to 72) to turn on.
 *   Pass the layers the emitter actually draws on; a layer enabled here and
 *   never drawn on is clutter, and one drawn on and not enabled is invisible.
 */
export function layerStackParameters(enabledMechanical: Iterable<number>): Array<[string, string]> {
  const enabled = new Set(enabledMechanical);
  for (const layer of enabled) {
    if (layer < 57 || layer > 72) {
      throw new Error(`Layer ${layer} is not a mechanical layer, so it has no MECHENABLED flag.`);
    }
  }

  const parameters: Array<[string, string]> = [];

  for (let layer = 1; layer <= LAYER_COUNT; layer += 1) {
    // The marker separates groups of five and does not lead the first group.
    if (layer > 1 && (layer - 1) % LAYERS_PER_RECORD === 0) {
      const previous = parameters[parameters.length - 1];
      previous[1] += RECORD_TERMINATOR;
      parameters.push(["RECORD", "Board"]);
    }

    const chain = CHAIN[layer] ?? { prev: 0, next: 0 };
    parameters.push([`LAYER${layer}NAME`, LAYER_NAMES[layer]]);
    parameters.push([`LAYER${layer}PREV`, String(chain.prev)]);
    parameters.push([`LAYER${layer}NEXT`, String(chain.next)]);
    parameters.push([`LAYER${layer}MECHENABLED`, enabled.has(layer) ? "TRUE" : "FALSE"]);
    for (const [suffix, value] of DEFAULTS) {
      parameters.push([`LAYER${layer}${suffix}`, value]);
    }
  }

  return parameters;
}
