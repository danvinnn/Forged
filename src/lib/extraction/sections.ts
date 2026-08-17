/**
 * Finding a SECTION by the heading printed above it.
 *
 * Not a parser. This locates a section; it never reads a value off one. That is
 * why it can be deterministic while the values themselves come from a model
 * reading the rendered page.
 *
 * ## Scope, and a measurement that narrowed it
 *
 * One consumer: the focused local model, which asks several narrow questions and
 * needs to pick the ONE page each question is about.
 *
 * It was briefly also used to add the land-pattern page to the render set for
 * every part. That was removed on 2026-08-17 for being tailored. Over 46
 * datasheets the pattern below finds:
 *
 *     Texas Instruments   20 of 21
 *     STMicroelectronics   6 of 11
 *     Analog Devices       0 of 6
 *     other                2 of 8
 *
 * The wording names no vendor and the behaviour does, which is the test rule 4
 * actually applies. Widening it was measured too: allowing any short gap after
 * "recommended" gains LTC6563's real `RECOMMENDED SOLDER PAD` and also matches
 * the prose `recommended that the pad` and `recommended to layout`. One real
 * page for two wrong ones.
 *
 * Selecting among pages ALREADY being sent, which is what the focused model does
 * here, is a different trade from adding a rendered page to every part: a miss
 * costs that one question its best page rather than costing every part money.
 */

/**
 * How a datasheet titles a printed footprint, as far as this pattern reaches.
 *
 * `LAND PATTERN EXAMPLE` and `FOOTPRINT EXAMPLE` are confirmed against the
 * corpus. `layout` was added on the unchecked claim that ST and ADI print
 * `RECOMMENDED PCB LAYOUT`; measured afterwards it gains exactly one document in
 * 46, and ADI is 0 of 6 either way. The claim was invented before it was
 * checked, which is rule 1, so it is corrected here rather than left standing.
 *
 * Do NOT read this as a general statement about how vendors write headings. It
 * is not, and the split above says so. It is good enough for its one job:
 * picking a page from among pages already being sent.
 *
 * Shared rather than written twice. The same pattern in two files is the defect
 * shape LEARNINGS.md names first.
 */
export const LAND_PATTERN_HEADING =
  /land\s+pattern|recommended\s+(?:pcb\s+)?(?:land|footprint|pad|layout)|footprint\s+example/i;
