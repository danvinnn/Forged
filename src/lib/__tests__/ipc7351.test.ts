import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLandPattern, LandPatternError, type LeadDimensions } from "../ipc7351";

// The point of these tests is that they can FAIL against reality. A land pattern
// calculator that only agrees with itself is worth nothing.
//
// This file used to be sixty tests, fifty-five of which pinned a hand-typed
// table of package families to the land patterns their vendors publish. The
// table was deleted on 2026-08-14: every entry was read off ONE drawing and then
// asserted about a whole family, which is the thing `RULES.md` rule 1 forbids.
// Those tests went with it, because a test that only holds for the constants
// that fitted it defends those constants rather than the behaviour.
//
// What remains here is the standard's own arithmetic. What replaced the rest is
// `landpattern.test.ts`, which drives the real generator off a datasheet's own
// numbers.

/** How close a computed land has to sit to the published one, in mm. */
const TOLERANCE_MM = 0.05;

function assertClose(actual: number, expected: number, what: string): void {
  assert.ok(
    Math.abs(actual - expected) <= TOLERANCE_MM,
    `${what}: computed ${actual.toFixed(3)} mm, published ${expected.toFixed(3)} mm, difference ${Math.abs(actual - expected).toFixed(3)} mm exceeds the ${TOLERANCE_MM} mm tolerance`
  );
}

test("a missing lead dimension refuses instead of defaulting", () => {
  // The failure this whole module exists to prevent. The old exporter defaulted
  // an unknown pitch to 1.27 mm and carried on, which is how a part that does
  // not fit the board gets a footprint that looks authoritative.
  const incomplete = {
    form: "gullwing",
    span: { minMm: 5.8, maxMm: 6.2 },
    contact: { minMm: Number.NaN, maxMm: Number.NaN },
    width: { minMm: 0.31, maxMm: 0.51 }
  } as LeadDimensions;

  assert.throws(
    () => computeLandPattern(incomplete),
    (error: unknown) => {
      assert.ok(error instanceof LandPatternError);
      assert.ok(
        error.missing.some((entry) => /contact length/.test(entry)),
        "the refusal must name what is missing"
      );
      return true;
    }
  );
});

test("inconsistent lead dimensions are refused, not silently inverted", () => {
  // Feet longer than half the span put the heel past the toe. That is a data
  // error, and emitting overlapping lands from it would be worse than refusing.
  const impossible: LeadDimensions = {
    form: "gullwing",
    span: { minMm: 5.8, maxMm: 6.2 },
    contact: { minMm: 3.0, maxMm: 4.0 },
    width: { minMm: 0.31, maxMm: 0.51 }
  };

  assert.throws(() => computeLandPattern(impossible), LandPatternError);
});

test("a drawing-derived land pattern agrees with the hand-characterised entry", () => {
  // The hand-read family constants from packages.ts, against the same drawing
  // read as four plain dimensions with a single nominal contact length.
  const cases = [
    {
      family: "SOIC narrow",
      hand: { span: { minMm: 5.8, maxMm: 6.2 }, contact: { minMm: 0.4, maxMm: 0.625 }, width: { minMm: 0.31, maxMm: 0.51 } },
      drawn: { span: { minMm: 5.8, maxMm: 6.19 }, contact: { minMm: 0.55, maxMm: 0.55 }, width: { minMm: 0.31, maxMm: 0.51 } }
    },
    {
      family: "TSSOP",
      hand: { span: { minMm: 6.2, maxMm: 6.6 }, contact: { minMm: 0.5, maxMm: 0.6 }, width: { minMm: 0.19, maxMm: 0.3 } },
      drawn: { span: { minMm: 6.2, maxMm: 6.6 }, contact: { minMm: 0.55, maxMm: 0.55 }, width: { minMm: 0.19, maxMm: 0.3 } }
    },
    {
      family: "VSSOP-8",
      hand: { span: { minMm: 4.75, maxMm: 5.05 }, contact: { minMm: 0.4, maxMm: 0.5 }, width: { minMm: 0.25, maxMm: 0.38 } },
      drawn: { span: { minMm: 4.75, maxMm: 5.05 }, contact: { minMm: 0.45, maxMm: 0.45 }, width: { minMm: 0.25, maxMm: 0.38 } }
    }
  ];

  for (const { family, hand, drawn } of cases) {
    const characterised = computeLandPattern({ form: "gullwing", ...hand });
    const derived = computeLandPattern({ form: "gullwing", ...drawn });

    // Pad WIDTH follows from the lead width alone, so it must match exactly.
    // This is the dimension that decides whether adjacent lands can bridge.
    assert.equal(
      derived.padWidthMm.toFixed(4),
      characterised.padWidthMm.toFixed(4),
      `${family}: land width must not depend on how the contact length was obtained`
    );

    // Length and span carry the contact tolerance a single nominal cannot, so
    // they are allowed to differ, and by how much is measured rather than
    // assumed. 0.1 mm is the observed worst case (SOIC, 0.079).
    assert.ok(
      Math.abs(derived.padLengthMm - characterised.padLengthMm) < 0.1,
      `${family}: land length drifted ${(derived.padLengthMm - characterised.padLengthMm).toFixed(3)} mm from the characterised entry`
    );
    assert.ok(
      Math.abs(derived.padCentreMm - characterised.padCentreMm) * 2 < 0.1,
      `${family}: centre span drifted from the characterised entry`
    );

    // The direction is systematic and worth stating: one nominal contact means
    // no contact tolerance, which shortens the land and widens the span. Both
    // reduce heel fillet slightly, so a drift the other way is a real change.
    assert.ok(derived.padLengthMm <= characterised.padLengthMm + 1e-9, `${family}: derived land should not be longer`);
  }
});

test("the printed L range and its midpoint are materially different inputs", () => {
  // IPC-7351B's contact length is the SEATED FOOT that lies flat on the land; a
  // gull-wing drawing's L is often the whole lead including the vertical run.
  // Same letter, different dimension.
  //
  //   LM358  D0008A   prints L 0.41-1.27   seated contact ~0.40-0.625
  //   INA240 PW0008A  prints L 0.50-0.75   seated contact ~0.50-0.60
  //
  // So WHICH figure the reader supplies matters, and this pins how much: enough
  // that nobody can swap one for the other as a tidy-up.
  const soic = { span: { minMm: 5.8, maxMm: 6.2 }, width: { minMm: 0.31, maxMm: 0.51 } };
  const seated = computeLandPattern({ form: "gullwing", ...soic, contact: { minMm: 0.4, maxMm: 0.625 } });
  const wholeLead = computeLandPattern({ form: "gullwing", ...soic, contact: { minMm: 0.41, maxMm: 1.27 } });

  assert.ok(
    Math.abs(wholeLead.padLengthMm - seated.padLengthMm) > 0.5,
    "reading the whole lead where the standard wants the foot is worth half a millimetre of land"
  );

  // And the RANGE is what the generator feeds in, not its midpoint.
  //
  // A previous version of this test asserted the opposite, on a 2026-08-05
  // measurement against the hand-typed family entry that no longer exists. Both
  // sides of that comparison were the table's. Collapsing a min-max pair to one
  // figure is the worked example of an assumption in `RULES.md`, and the standard
  // consumes the spread directly: it is one of the two inputs to the RSS term.
  const midpoint = computeLandPattern({
    form: "gullwing",
    ...soic,
    contact: { minMm: 0.5125, maxMm: 0.5125 }
  });
  assert.ok(
    Math.abs(midpoint.padLengthMm - seated.padLengthMm) > 0.1,
    "the midpoint is not a rounding of the range, so which one is used is a decision"
  );
  assert.equal(seated.zMaxMm, midpoint.zMaxMm, "the toe is unaffected either way; the heel is what moves");
});


/**
 * The no-lead rule, against the land patterns the vendors publish.
 *
 * Each case is TWO hand reads off the same datasheet: the package drawing for
 * the inputs, and the `LAND PATTERN EXAMPLE` page for the expected result.
 * Neither came from this code's output. The four span two body sizes, three
 * families and two pitches, which is what makes them a check rather than a
 * restatement: a rule fitted to the 3 mm parts alone would pass three of these
 * and fail the fourth, and that is exactly how the RSS model was ruled out.
 *
 * TI prints the land as a CENTRE-to-centre span with a separate pad length, so
 * the expected span below is `2 * padCentreMm` and compares against that number.
 */
/**
 * No-lead, after the retirement.
 *
 * These tests used to pin a rule recovered by reverse-engineering four TI
 * package drawings, because IPC-7351B's own no-lead fillet goals are not
 * transcribed in this file. It reproduced those four drawings exactly and had no
 * standing on anyone else's silicon, so it applied one vendor's house rule to
 * every vendor's parts. Retired 2026-08-13 under the rule the project works to:
 * nothing is invented.
 *
 * What replaced it: a no-lead package builds from its datasheet's OWN printed
 * footprint, which is the common case, and asks when the document prints none.
 * Bringing computation back means transcribing IPC's published no-lead goals
 * from the standard and pinning the result here, exactly as gull-wing is pinned.
 */
test("a no-lead package is not computed from an invented rule", () => {
  assert.throws(
    () =>
      computeLandPattern(
        {
          form: "nolead",
          span: { minMm: 2.9, maxMm: 3.1 },
          contact: { minMm: 0.4, maxMm: 0.4 },
          width: { minMm: 0.18, maxMm: 0.3 }
        },
        { densityLevel: "B" }
      ),
    (error: Error) => {
      assert.ok(error instanceof LandPatternError);
      assert.match(error.message, /not transcribed here/);
      return true;
    }
  );
});
