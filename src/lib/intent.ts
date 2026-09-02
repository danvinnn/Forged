/**
 * WHAT THE USER CAME FOR, CHOSEN BEFORE THE READ.
 *
 * Its own module because both the shell and the progress model need it, and the
 * shell imports the progress model. A type living in the component that renders
 * it would make that a cycle.
 *
 * The reader is field-directed: it is handed the fields and the pages to go
 * after. A footprint wants the package outline drawing and one chosen package; a
 * SPICE model wants the specification table and no package at all, because a
 * macromodel describes the die. Asking afterwards means over-reading both or
 * re-reading, and a re-read is the most expensive action in the product.
 */
export type Intent = "cad" | "spice" | "both";
