// Does naming a package actually unblock a family datasheet?
//
// The extraction bench says 6 parts read no geometry at all: the model correctly
// declines to pick a package when the base part number does not name one, and so
// declines every dimension with it. `oneClickCheck` then reports them as not
// one-click, because it calls `packageOptions` on the record AS IT STANDS and
// nothing on that record changes when a package is named.
//
// But the product does something the bench does not: naming a package re-posts
// to /api/parse, which sets `packageType` with method `user` and puts it in the
// model's prompt. So the bench's figure is a floor, and the question of whether
// the product is actually blocked was never measured.
//
// This measures it, one part at a time, because the answer decides whether
// there is a defect to fix or only a bench that cannot see the fix.
//
// Usage:  npx tsx src/lib/__bench__/packagehint.ts ISO7741 "SOIC (DW)"

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractDatasheetText } from "../pdftext";
import { buildPartRecord } from "../datasheet";
import { runExtraction } from "../extraction/run";
import { packageOptions, FootprintUnavailableError } from "../exporters";
import { resolveForExport } from "../types";
import { makeExtractionModel } from "../extraction/factory";
import { getDeploymentMode } from "../retrieval/deployment";
import { cachingModel, chargedSpend } from "./modelcache";
import { loadBenchEnv } from "./env";

loadBenchEnv();
if (!process.env.FORGE_LOG_LEVEL) process.env.FORGE_LOG_LEVEL = "warn";

async function main() {
  const [partNumber, hint] = process.argv.slice(2);
  if (!partNumber) throw new Error("usage: packagehint.ts <PART> [package]");

  const bytes = readFileSync(join(".bench-cache", `${partNumber}.pdf`));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const doc = await extractDatasheetText(buffer);

  const inner = await makeExtractionModel(getDeploymentMode());
  if (!inner) throw new Error("no model configured");
  const model = cachingModel(inner, "use", () => `${partNumber}#${hint ?? "none"}`);

  const before = chargedSpend().usd;

  // Exactly what the route builds when the caller names a package.
  // No source URL: the third parameter is `sourceUrl`, and this passed the PART
  // NUMBER into it, so the probe was not building "exactly what the route
  // builds" as the note above claims.
  const record = buildPartRecord(doc, `${partNumber}.pdf`, undefined, hint ? { packageType: hint } : undefined);
  const run = await runExtraction(record, doc, buffer, model, `${partNumber}.pdf`, partNumber);
  const part = run?.part ?? record;

  const dims = part.dimensions;
  const show = (name: string, field: { value: unknown }) =>
    `${name}=${field.value === null ? "-" : JSON.stringify(field.value)}`;

  console.log(`\n${partNumber}  package hint: ${hint ?? "(none)"}`);
  console.log(
    "  ",
    [
      show("packageType", part.packageType),
      show("leadSides", dims.leadSides),
      show("body", dims.bodyLengthMm),
      show("landSpan", dims.landSpanMm),
      show("landPadL", dims.landPadLengthMm),
      show("pitch", dims.pitchMm),
      show("outlineCode", part.packageOutlineCode),
      show("jedec", part.jedecOutline)
    ].join("  ")
  );

  const resolved = resolveForExport(part);
  console.log("   resolves:", resolved.ok ? "yes" : JSON.stringify(resolved));

  const choice = packageOptions(part);
  if (!choice.ok) {
    console.log("   packageOptions BLOCKED by:", choice.blockedBy.join(", "));
  } else {
    for (const option of choice.options) {
      const needs = option.status === "needs-input" ? ` needs ${option.needs.map((n) => n.field).join(",")}` : "";
      console.log(`   option ${option.designator.padEnd(16)} ${option.status}${needs}`);
    }
  }

  console.log(`   spent this probe ~$${(chargedSpend().usd - before).toFixed(4)}, cumulative ~$${chargedSpend().usd.toFixed(2)}`);
}

main().catch((error) => {
  if (error instanceof FootprintUnavailableError) console.log("   footprint unavailable:", error.message);
  else throw error;
});
