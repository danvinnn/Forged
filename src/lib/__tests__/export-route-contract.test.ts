import { test } from "node:test";
import assert from "node:assert/strict";
import { POST } from "../../app/api/export/route";
import { extractedValue, unknown, type PartRecord, type PinRecord } from "../types";

/**
 * The shape `/api/export` answers a refusal with, which the UI reads directly.
 *
 * The route makes a distinction the exporter hands it and the user depends on:
 * a refusal they can ANSWER carries `code: INPUT_REQUIRED` and a populated
 * `needs`, and a refusal they cannot carries `PACKAGE_NOT_CHARACTERISED` and an
 * empty one. The UI prompts on the first and only reports the second, so if the
 * two ever collapse into one the user is either asked for something no answer
 * exists for, or not asked for something one number away.
 *
 * `exporters-geometry.test.ts` already proves the exporter raises the right
 * distinction. This proves the route still carries it across the wire, which is
 * the half the UI actually sees.
 */

function citedValue<T>(value: T) {
  return extractedValue(value, 0.95, { page: 1, snippet: "fixture", region: null });
}

function pins(count: number): PinRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    number: String(index + 1),
    name: `P${index + 1}`,
    electricalType: "passive" as const
  }));
}

/** A record complete enough to reach the footprint step, in the given package. */
function exportablePart(packageType: string, pinCount: number): PartRecord {
  return {
    id: "fixture",
    partNumber: citedValue("ACME1234"),
    manufacturer: citedValue("ACME"),
    packageType: citedValue(packageType),
    packageOutlineCode: unknown<string>(),
    packageVariants: [],
    pinCount: citedValue(pinCount),
    pins: citedValue(pins(pinCount)),
    dimensions: {
      bodyLengthMm: citedValue(8.65),
      bodyWidthMm: citedValue(3.9),
      bodyHeightMm: citedValue(1.5),
      pitchMm: citedValue(1.27),
      leadLengthMm: citedValue(0.8),
      leadCount: citedValue(pinCount),
      leadWidthMm: citedValue({ minMm: 0.35, maxMm: 0.5 }),
      leadSpanMm: citedValue({ minMm: 5.8, maxMm: 6.2 }), leadContactMm: citedValue({ minMm: 0.4, maxMm: 0.625 })
    },
    radiation: {
      tid: unknown<string>(),
      see: unknown<string>(),
      sel: unknown<string>(),
      qmlClass: unknown<string>()
    },
    sourceFileName: "fixture.pdf",
    notes: []
  };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

test("a refusal the user can answer arrives as INPUT_REQUIRED with the field named", async () => {
  const response = await POST(post({ part: exportablePart("14-lead CFP", 14), format: "kicad" }));
  const payload = await response.json();

  assert.equal(response.status, 422);
  assert.equal(payload.code, "INPUT_REQUIRED");
  assert.ok(Array.isArray(payload.needs) && payload.needs.length > 0, "the UI prompts off this array");
  assert.equal(payload.needs[0].field, "formedLeadSpanMm");
  assert.equal(payload.needs[0].unit, "mm");
  assert.equal(payload.needs[0].scope, "install", "asked once per assembler, not once per part");
  assert.ok(payload.needs[0].label, "the prompt needs a label");
  assert.ok(payload.needs[0].why, "and a reason no datasheet carries it");
});

test("supplying the value over the wire produces the bundle", async () => {
  const response = await POST(
    post({ part: exportablePart("14-lead CFP", 14), format: "kicad", formedLeadSpanMm: 10.16 })
  );

  assert.equal(response.status, 200, "the same request that 422'd now succeeds");
  assert.equal(response.headers.get("Content-Type"), "application/zip");
  const bytes = await response.arrayBuffer();
  assert.ok(bytes.byteLength > 0);
});

test("a refusal the user cannot answer is not dressed up as one they can", async () => {
  const response = await POST(post({ part: exportablePart("12-Pin BGA", 12), format: "kicad" }));
  const payload = await response.json();

  assert.equal(response.status, 422);
  assert.equal(payload.code, "PACKAGE_NOT_CHARACTERISED");
  assert.deepEqual(payload.needs, [], "an empty needs array is what stops the UI prompting");
});

test("a nonsense lead span is refused before it reaches the generator", async () => {
  for (const span of [0, -1, 500, "10.16"]) {
    const response = await POST(
      post({ part: exportablePart("14-lead CFP", 14), format: "kicad", formedLeadSpanMm: span })
    );
    assert.equal(response.status, 400, `formedLeadSpanMm ${JSON.stringify(span)} must be rejected`);
  }
});
