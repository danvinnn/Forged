/**
 * Altium generator.
 *
 * One of three peers (KiCad, Altium, Cadence). It reads the format-neutral
 * geometry and knows nothing about the other formats, and none of them are
 * derived from it. Altium output used to be the KiCad emitter's text with a
 * header glued on, which is not support for Altium, it is a rename.
 *
 * The work is in `altium/`: `units.ts` for the coordinate conversion,
 * `binary.ts` for the block grammar, `templates.ts` for the record bytes Altium
 * itself wrote, and `pcblib.ts` for the library.
 */

export { emitAltiumPcbLib } from "./altium/pcblib";
export { emitAltiumSchLib } from "./altium/schlib";
export { AltiumEmitError } from "./altium/units";
