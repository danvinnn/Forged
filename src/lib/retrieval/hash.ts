// Local content hashing. The sha256 of the PDF bytes is the audit anchor: it identifies this
// exact datasheet, which the Class 3 / QML traceability story and Layer 2 citations both build on.
//
// Air-gap safety: node:crypto is a local computation, no network.

import { createHash } from "node:crypto";

export function sha256Hex(bytes: ArrayBuffer): string {
  return createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
}
