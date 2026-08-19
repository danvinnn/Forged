# Handoff, 2026-08-18 evening

The line-by-line audit is finished and closed. This session was the follow-on:
finishing the product against the three-number definition of done.

**Nothing is committed.** 26 files modified, 2 new (`src/lib/__bench__/copper.ts`,
this file's sibling `AUDIT-FINDINGS.md` was already tracked). Anthony's
instruction, twice: do not commit during this effort. Ask each time.

## Where it stands

    READ    49/54  (91%)   hold-out run 5, the current tree
    SHIPS   34/54  (63%)   was 14/54 (26%) at the start of the session
    copper  56/56 emitted footprints agree with their records
    suite   661 tests green, 20/20 mutations killed (was 17/20)
    oracle  10 drawings, 145 hand-checked values, 2 known-wrong pending re-read
    server  built, started, real export POSTed and read back

Definition of done:

    SHIPS >= 60%              MET, 63%
    zero wrong-copper         MET
    one click, one number     MET on the family path (4 of 6 tuned parts)

## Spend

    ~$23.23 cumulative, over 1092 billed calls. Five runs; the fifth was
    authorised separately after the four.

The ceiling in `spendLimitUsd()` is a LIFETIME total defaulting to $10, and
lifetime spend passed it before this session began. It therefore cannot be
reached without being exceeded, and every run now pays for one call per part
before throwing. Raised per-command to $20, then $22 with Anthony's approval for
run 4. **Never persisted.** This is his guard and his money; ask.

## Which number describes this tree

Neither run does, exactly. After the F83 revert the prompt is run 3's prompt plus
the one-field `bodyHeightMm` wording correction, so **run 3's 93% / 57% is the
best available figure** and that single field is unmeasured. Two prompt changes
rode on run 4 and cannot be separated by measurement; that was my error, and the
rule it produces is in `AUDIT-FINDINGS.md`: one hypothesis per paid run.

## The one thing left, and it is measured

Ten of the twenty-three parts that do not ship are blocked on the LAND PATTERN.
That is the single remaining bottleneck and it is much smaller than the one it
replaced.

`pageRequestGuidance` was generalised (F83) on the same principle that moved the
session, run 4 measured it, and **it was worse on every field**: READ 93% to 91%,
SHIPS 57% to 54%, `landPadLengthMm` 15 to 13. Run 4 had zero failed calls where
run 3 had three, so the comparison favours run 4 and the result still went down.
**Reverted**, with the numbers written into the function so nobody retries it.

The finding that replaces it: **the eight-page render cap is the binding
constraint, not the wording.** Spreading eight pages across six packages buys a
thinner look at each and squeezes the pinout page out. A future attempt has to
raise the budget or choose pages better.

## What moved the product, so it is not re-derived

Not the reader. READ was 93% before and 93% after.

1. **Ordering.** `/api/export` ran the traceability gate before `asPackage`, which
   is the function that supplies a family datasheet's pinout, so it refused for
   "missing pins" one step early. The chooser had done it right for two days: the
   two halves of the product disagreed about the same click.
2. **The hold-out bench had the identical defect**, which is why nobody saw the
   first one. `shipOutcome` returned on `!resolved.ok` and never reached route
   two, where the chooser runs.
3. **Dimensions asked per package.** 27 of 57 hold-out parts returned not one
   dimension from either pass, the model's own notes explaining that the part
   number does not specify a package designator. Six tuned family datasheets went
   0-of-6 shipping to 4-of-6 on one click.
4. **Two refusals made answerable**: the quad corner short, and the body size the
   chooser never asked for but the export did.
5. **`withSupplied` refused to use the answer it asked for.** The four land fields
   are now CORRECTED by a supplied value; every other field is still only filled
   when blank.

## Known-open, in priority order

1. **The land pattern, ten parts.** Run 4 answered the first question: the render
   BUDGET is the binding constraint, not the wording of the page request. Raising
   `MAX_PAGES_TO_MODEL` above 8, or choosing pages better, is the next thing to
   measure. Asking for more pages inside the same cap is measured and rejected.
2. **ADC128S102QML-SP body height** reads 1.778 (the ceramic) where the drawing's
   title block says 2.33 max (the seated envelope). Fixed at the source: the
   FIELD GUIDE now asks for the seated height, because `buildStepModel` stands
   the solid on the board. The cached answer predates the fix, so `bench:dimensions`
   still shows it WRONG. A tuned re-read of that one part (~$0.05) proves it.
3. **Two parts: "drawings read, no pin table for that package."** Created by the
   per-package work and visible in the run 3 buckets. A reading gap, not a
   structural one.
4. **Cadence.** Still refuses honestly. NOT delivered and named rather than
   dropped: emitting an Allegro library without the format spec means guessing at
   a binary padstack format, and a wrong CAD file that opens is worse than an
   honest refusal.
5. **README.** Anthony deferred it until the product is done. Two known-stale
   claims are recorded in `CLAUDE.md`.
6. **`packageOutlineCode` and `jedecOutline`** come back inside the per-package
   dimension block and are filtered out by the `dimensions.` prefix check. We
   have the data and drop it. Unblocks no part.

## New instrument

`npm run bench:copper` builds every cached record's footprint and measures the
PADS back out: pitch, both centre spans, land size, and the exposed pad's axis,
against the record and against the oracle's printed footprint where one exists.
Free, offline.

Its first three runs reported 454, then 15, then 1 finding, every one of them the
instrument being wrong. **Validate a new bench on a case whose answer you already
know before believing it.** Written up in LEARNINGS section 10.
