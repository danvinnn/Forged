/**
 * WAS THE DATASHEET READ? One definition, for every bench that asks.
 *
 * Lifted out of `holdout.ts` on 2026-08-28, when a second blind corpus needed
 * the same question answered. Two benches each with their own idea of "read" is
 * how `SHIPS` came to have two definitions and how one of them quietly measured
 * something the product does not do. A definition that two instruments disagree
 * about is worse than either instrument.
 *
 * Nothing here is specific to the hold-out corpus, and nothing here may become
 * so: the hold-out is never tuned against, and a classifier shared with a bench
 * that IS tuned against would be a way round that by the back door.
 */

import type { DatasheetText } from "../pdftext";
import { looksLikeWrongDocument } from "../pdftext";
import type { PartRecord } from "../types";

/**
 * Why one part produced no bundle, in a form that GROUPS.
 *
 * The point of the hold-out is not a list of parts to go and fix, it is a
 * histogram of causes. A cause with one part behind it is a document; a cause
 * with nine is a hole in the reader.
 */
export function classify(record: PartRecord, doc?: DatasheetText): string {
  const pins = record.pins.value ?? [];
  const count = record.pinCount.value;

  // WHAT WE FETCHED IS NOT ALWAYS A DATASHEET, and that is a different failure.
  //
  // AD8495 resolved to a three-page Soldered Electronics breakout-board product
  // page: 2,318 characters, no pinout, no mechanical section, a shipping weight
  // and an order code. The model correctly refused all 36 fields, including the
  // manufacturer, because none of them is in the document.
  //
  // Counting that as "we could not read the datasheet" is wrong in both
  // directions: it makes extraction look worse than it is, and it hides a
  // retrieval failure that a user would hit exactly as hard. Retrieval is out of
  // scope for this bench, so it is named and set aside rather than scored.
  //
  // The test is deliberately about SIZE and not about content: a document with
  // no pinout section might still be a datasheet whose pinout is a figure, and
  // that is a reading problem. A component datasheet that is three pages long
  // with two thousand characters is not a component datasheet.
  // The rule lives in `pdftext.ts` so the PRODUCT applies the same one. It was
  // duplicated here, which meant the bench could classify a case the product had
  // no way to detect.
  if (doc && looksLikeWrongDocument(doc)) {
    return "NOT A DATASHEET (retrieval fetched the wrong document)";
  }

  // A PINOUT PER PACKAGE IS A PINOUT.
  //
  // A family datasheet whose part number does not name a package gets `pins`
  // null, correctly: the model is told not to pick among several pinouts. It
  // returns them all, labelled, and each is located on a page before it is
  // stored. Counting that as "no pins, no count" is what made twelve of the
  // fifty-one parts with a reading look unreadable when the document had been
  // read fine and the answer was on the record. The package chooser offers
  // exactly these, one option per table.
  //
  // Only tables that were LOCATED count. An entry that matched no page in the
  // document is not evidence, and `resolveForExport` refuses it downstream.
  //
  // AND A PIN COUNT DOES NOT STOP IT BEING ONE. This asked additionally for
  // `count === null`, so a document that named its lead count AND tabulated a
  // pinout per package was filed as "count but no pins" and never offered to
  // the chooser at all: the run stopped one step before the product, for the
  // third time in this file's history. TCA9548A, LD39050 and ADG1211 each carry
  // two or three located per-package tables and were counted as unread.
  const located = (record.packagesInThisDocument ?? []).filter((table) => table.citation).length;
  if (pins.length === 0 && located > 0) {
    return "read (one pinout per package, user picks)";
  }

  if (pins.length === 0 && count === null) return "no pins, no count";
  if (pins.length === 0) return "count but no pins";
  if (count === null) return "pins but no count (nothing corroborates them)";
  return "read";
}
