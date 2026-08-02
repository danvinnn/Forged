/**
 * Record templates captured from Altium-written files.
 *
 * Every PCB primitive record has runs of bytes whose meaning is not documented
 * anywhere public. They are not padding: they carry pad-stack cache state, mask
 * modes, tolerances and identity values, and the fields after them shift if
 * their length is wrong. Zero-filling them produces a file that pyaltiumlib
 * parses happily and that Altium may refuse without saying why.
 *
 * So each template below is the exact byte string Altium itself wrote for a
 * primitive of that kind, and the emitter overlays only the fields it
 * understands at the offsets the readers agree on. The offsets are cross-checked
 * two ways: against pyaltiumlib's parser (the oracle, `pcblib/records/*.py`) and
 * against AltiumSharp's writer, which documents the same layout field by field.
 *
 * Provenance, all from AltiumSharp's `TestData/Generated/Individual/PCB`, which
 * are files Altium saved:
 *
 * - PAD_MAIN, PAD_SIZE_SHAPE: `PAD_SMD_ROUNDED.PcbLib`, a single 50 x 30 mil
 *   rounded-rectangle SMD pad on the top layer.
 * - TRACK: `MULTIPIN_SOIC.PcbLib`, a top-overlay silkscreen segment.
 * - ARC: `MULTIPIN_SOIC.PcbLib`, a full-circle top-overlay arc.
 * - TEXT: `TEXT_ALL_STROKE_FONTS.PcbLib`, a top-overlay stroke-font string.
 *
 * Do not "tidy" these. A byte here that looks like slack is a field somebody
 * has not decoded yet.
 */

function template(hex: string): Buffer {
  return Buffer.from(hex.replace(/\s+/g, ""), "hex");
}

/**
 * Pad record, first block: 202 bytes.
 *
 * Overlaid by the emitter: layer (0), flags (1-2), location (13-20), the three
 * pad sizes (21-44), hole size (45-48), the three base shapes (49-51), rotation
 * (52-59), the v7 layer id (114-117) and the two identity GUIDs (126-157).
 *
 * Note the base shapes in the template are 1 (Round), not 9. That is how Altium
 * encodes a rounded rectangle: the base shape stays round and the real per-layer
 * shape and corner radius live in the size/shape block below.
 */
export const PAD_MAIN_TEMPLATE = template(
  "010c00ffffffffffffffffffff000000" + // 0
    "000000000020a10700e093040020a107" + // 16
    "00e093040020a10700e0930400000000" + // 32
    "00010101000000000000000000000000" + // 48
    "00000000a08601000400a0860100400d" + // 64
    "0300400d030000000000409c00000000" + // 80
    "00000000000101000000000000000000" + // 96
    "000001000001000000409c000000d1ef" + // 112
    "a2e6ae033f4fb63a86d8703036b47a1d" + // 128
    "3573362e434b9c273f5e154623d00000" + // 144
    "0000ffffff7fffffff7f00011a000000" + // 160
    "00000000000000000103000000000000" + // 176
    "00000000000000000000" // 192
);

/**
 * Pad record, second block: 651 bytes, the per-layer size and shape stack.
 *
 * Overlaid by the emitter: the 29 mid-layer X sizes (0-115) and Y sizes
 * (116-231), and the pad size inside the single full-stack entry at the tail.
 * The per-layer shapes (532-563) are already 9 (rounded rectangle) and the
 * corner radii (564-595) are already 50 percent, which is Altium's default and
 * matches the 0.25 round-rect ratio the KiCad emitter uses for the same land.
 */
export const PAD_SIZE_SHAPE_TEMPLATE = template(
  "20a1070020a1070020a1070020a1070020a1070020a1070020a1070020a10700" + // 0
    "20a1070020a1070020a1070020a1070020a1070020a1070020a1070020a10700" + // 32
    "20a1070020a1070020a1070020a1070020a1070020a1070020a1070020a10700" + // 64
    "20a1070020a1070020a1070020a1070020a10700e0930400e0930400e0930400" + // 96
    "e0930400e0930400e0930400e0930400e0930400e0930400e0930400e0930400" + // 128
    "e0930400e0930400e0930400e0930400e0930400e0930400e0930400e0930400" + // 160
    "e0930400e0930400e0930400e0930400e0930400e0930400e0930400e0930400" + // 192
    "e0930400e0930400010101010101010101010101010101010101010101010101" + // 224
    "0101010101000000000000000000000000000000000000000000000000000000" + // 256
    "0000000000000000000000000000000000000000000000000000000000000000" + // 288
    "0000000000000000000000000000000000000000000000000000000000000000" + // 320
    "0000000000000000000000000000000000000000000000000000000000000000" + // 352
    "0000000000000000000000000000000000000000000000000000000000000000" + // 384
    "0000000000000000000000000000000000000000000000000000000000000000" + // 416
    "0000000000000000000000000000000000000000000000000000000000000000" + // 448
    "0000000000000000000000000000000000000000000000000000000000000000" + // 480
    "0000000000000000000000000000000000000001090909090909090909090909" + // 512
    "0909090909090909090909090909090909090909323232323232323232323232" + // 544
    "3232323232323232323232323232323232323232000000000000000000000000" + // 576
    "0000000000000000000000000000000000000000010000000f00000004008001" + // 608
    "0920a10700e09304003200" // 640
);

/**
 * Track record: 49 bytes.
 *
 * Overlaid: layer (0), start (13-20), end (21-28), width (29-32), v7 layer id
 * (41-44).
 */
export const TRACK_TEMPLATE = template(
  "210c00ffffffffffffffffffff807be1" + // 0
    "ffa01ce9ff807be1ff60e31600803801" + // 16
    "00000000000000000006000301000000" + // 32
    "00" // 48
);

/**
 * Arc record: 60 bytes.
 *
 * Overlaid: layer (0), centre (13-20), radius (21-24), start and end angle
 * (25-40), width (41-44), v7 layer id (52-55).
 */
export const ARC_TEMPLATE = template(
  "210c00ffffffffffffffffffff104ce5" + // 0
    "ff80b0edfff049020000000000000000" + // 16
    "00000000000080764030750000000000" + // 32
    "000000000600030100000000" // 48
);

/**
 * Text record, first block: 252 bytes. The string itself follows in a second
 * block.
 *
 * Overlaid: layer (0), location (13-20), height (21-24), stroke font (25-26),
 * rotation (27-34), stroke width (36-39), designator flag (41), the wide-string
 * index (115-118), the text-frame size (124-131) and the v7 layer id (226-229).
 */
export const TEXT_TEMPLATE = template(
  "210c00ffffffffffffffffffffc0bdf0" + // 0
    "ffa01ce9ff801a060007000000000000" + // 16
    "00000000409c00000000000000004100" + // 32
    "7200690061006c000000000000000000" + // 48
    "00000000000000000000000000000000" + // 64
    "00000000000000000000000000000000" + // 80
    "00000000000000000000000000000000" + // 96
    "000000000000000000000000f1701f00" + // 112
    "aa5207000300000000a037a000200b20" + // 128
    "00400d0300400d030000000000000101" + // 144
    "0041007200690061006c000000000000" + // 160
    "00000000000000000000000000000000" + // 176
    "00000000000000000000000000000000" + // 192
    "00000000000000000000000000000000" + // 208
    "00010600030100000000008000000080" + // 224
    "00000000c0bdf0ffa01ce9ff" // 240
);
