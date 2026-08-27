# Plan: finishing parsing and generation

> **Status, 2026-08-21.** This replaces the 2026-08-14 plan, which is complete
> and kept at the bottom of this file. What follows is scoped to LAYER 2
> (extraction) and LAYER 3 (generation) only. Deployment, hosting and retrieval
> beyond one fallback are deliberately out of scope.
>
> **Phase 1: done.** Both benches enforce the route deadline; VERIFIED is
> reported apart from SHIPS; `bench:mutation` recovers from a write-ahead
> journal; all seven guards are proven to fire by `guards-fire.test.ts`.
>
> **Phase 2: done except 2.4.** The generator is a function of its inputs, held
> there by three tests. 2.4, the record store, is deliberately still last and
> still optional.
>
> **Phase 3: advanced and continuing.** 23 drawings hand-read. VERIFIED is 9/9:
> every SHIPPING part in the tuned corpus now has its drawing read by a person.
>
> **Phase 4: done for the two things that blocked a bundle** - `NOT_A_DATASHEET`
> and `WRONG_PART_DATASHEET`. The land-pattern and `vacantLeadSlot` items reduce
> QUESTIONS rather than unblock parts, so they are ordinary feature work.
>
> **Phase 5: not started, and cannot be by me.** It needs part numbers chosen by
> someone who did not build the corpus.

---

## Finishing parsing and generation, 2026-08-22

> **Status, end of 2026-08-22.** Items 1a, 2 and 3 are done. Item 1b is PARTLY
> done: nine drawings read, covering eight of the twenty-one shipping parts that
> had none, and it found what the rate predicted. Item 4 turned out to be
> settleable for free and is now answered. Two of the four items changed shape
> once measured, and both changes are recorded below rather than quietly applied.
>
> **Two live wrong footprints were found and fixed**, plus a third defect nobody
> was looking for. Details in `LEARNINGS.md`, 2026-08-22.

### What the work actually found

| | |
|---|---|
| **Thermal via grid transposed from its own pad** | `nx` counted from the pad's LENGTH while `emitThermalPad` puts length on Y. On DRV8825's 4.83 x 2.75 PowerPAD that put two of four via columns off the pad, through bare soldermask beside the joint. Four shipping parts print a rectangular pad and a via grid. Fixed; `exporters-geometry.test.ts` asserts every via lies inside its pad. |
| **`landSpanMm` named no axis** | The generator has always had a convention; the prompt, the record type and the oracle all described the field without naming one. Both rectangular quads in the corpus were swapped. LTC6563 put its lead lands on the thermal pad and was refused; **TXB0104 SHIPPED**, with its short-side lands entirely under the body clear of their terminals, and nothing overlapped so no invariant fired. Fixed in all four places, with a test that goes red when any two disagree. |
| **`bench:dimensions` read the wrong record** | It compared `record.dimensions` while the product builds from `packagesInThisDocument`. Every part shipping through the chooser scored "not read". Comparisons went 252 -> 496 once fixed. |
| **The bench overrode a known outline code with a part-list guess** | AD8628 ships as a UJ-5 TSOT and was scored against the R-8 SOIC in the same datasheet; NCP1200 ships as a DIP and was scored against a SOIC. Twelve spurious WRONG values. An unmatched code is now UNCHECKED, which is true. |

---

### 1. Verify the copper we already ship  (partly done)

**1a. Name the package each part shipped AS.** DONE, and it moved the number by
itself: VERIFIED went 17/46 to 25/46 the moment the bench stopped printing the
record's outline code beside parts that ship as something else. Now **36/48
(75%)**.

**1b. Read those drawings.** DONE - the queue is empty. Twenty-four drawings: `R-8` (AD8628, ADR4525, AD590 -
cross-checked across all three datasheets), `RU-16`, `DRM0008A`, `NS0016A`,
`DW0016B`, `BQA0014A`, `0016023_Rev_G`, `0015988_21_Type A`, `05-08-1668 Rev A`,
`CASE 626-05`, `UJ-5`, `DFN8 2 x 2 (ST)`, `Ceramic Flat-8 (ST)`,
`DFN8 2 x 2 (ST, DS9216)`, `RUG0010A`, `48-Lead Flatpack (CAES)`, plus TS922
cross-checked onto the ST SO-8.
**Four live wrong footprints found**, at the predicted rate of about one per four:

  - **TXB0104** shipped its land spans transposed. FIXED.
  - **TSV911 and TSZ121** both ship a land 0.30 mm short at the heel - TSV911's
    overlaps its terminal by 0.05 mm where the drawing wants 0.35. Both readers
    took the THERMAL land's 0.45 as the lead land's length and then derived the
    span from it correctly, so both records are self-consistent and no check can
    see either. **2 of 2, so this is a class**, and it is the first thing queued
    for the next paid run.
  - **LTC3105** ships pads computed from the lead THICKNESS (0.22-0.38) where the
    width (0.406 +/- 0.076) was wanted; about 0.1 mm narrow.
  - **DRV8825 and three others** return the inner gap as the centre span; all but
    TPS7A4700 are contained by the band guard.

**Nothing is unread.** Every part that ships in the tuned corpus now has the
drawing its copper came from read by a person, and VERIFIED reports the residue.

Three of those appeared only after the VERIFIED metric stopped preferring the
part list over the code a part actually shipped as - AD8628 ships as a TSOT and
was being reported `checked` against the R-8 SOIC listed beside it. **VERIFIED is
honestly 33/48 (69%)**, not the 36/48 the overstating version printed.

Two of them need something this record cannot express, and that is worth knowing
before starting:

  - **05-08-1668 Rev A (LTC3105)** is LESS PRECISE than this answer key. It
    prints a pad length, an inner gap and an outer extent marked MIN, and never a
    centre distance; the two routes to one disagree by more than the 0.005 mm the
    bench compares at. Its entry records no land block and says so.
  - **RUG0010A (ADS1115)** prints TWO LAND SIZES in one footprint - 0.55 x 0.25
    on the eight side lands and 0.30 x 0.60 on the two end lands. The record
    holds one `landPadLengthMm`. There is no right single answer.
  - **DW0016B (ISO7741)** prints two COMPLETE footprints, an IPC nominal at
    7.3 mm creepage and an HV option at 8.1 mm, and does not say which. On an
    isolator that is a safety-relevant choice belonging to the engineer.
    `landAlternatives` now records both so the oracle stops asserting one; the
    PRODUCT still picks whichever the model returned, which is a real gap.

---

### 2. Two parts refused for a pad we are already holding  (done, and the premise was wrong)

**TPS54360 was never refused by the product.** `merge.ts` has reclassified a
numbered thermal-pad row since 2026-08-17. Only `bench:replay` saw the refusal,
because it builds records straight from cached answers and its own `pinsFrom`
reimplemented HALF the rule - the non-numeric half - with a comment saying it was
copying merge.

**LTC6563 was refused, for something else entirely.** Not "pin 25 has no land":
`lands 9 and 25 overlap, which shorts them together`, because its land spans were
transposed. That is item 4's defect wearing item 2's clothes, and reading the
truncated 60-character bench message instead of the whole one is what hid it.

Fixed by exporting the rule from `merge.ts` and calling it from both. `bench:replay`
REFUSED is now **0**, down from 2, and LTC6563 ships.

---

### 3. Pin names  (done for the oracle half; the prompt half is a measured wash)

`TPS7A4501-SP` was the ORACLE's error, not the reader's. Page 3 prints pin 9
twice: `SENSE/ADJ` on the package figures and `ADJ` in the Pin Functions table's
NAME column. The entry took the figure and recorded the table's answer as wrong
in a comment. Corrected to the NAME column - the device is adjustable-only, so
SENSE is a fixed-output sibling's name on a shared figure - with the reasoning
written down rather than the change made silently.

The prompt half **did not improve the score and should not be claimed as a win.**
It fixed what it was aimed at and broke two others:

    before   LTC6563 invents GND1/GND3   RHF1201 drops (MSB)          16/18
    after    both fixed                  RHF310A returns NC(1)         16/18
                                         STM32F407VG returns PA14 (JTCK/SWCLK)

"Do not invent a suffix" is clean and has no downside. "Do not drop a
parenthesised part of the name" cannot tell `(MSB)` from a footnote marker or an
alternate-function annotation. It is left in place rather than iterated on,
because a second prompt change costs another $3 run and the run-to-run variance
is larger than the effect being chased - AD8628 and NCP1200 changed PACKAGE
between two runs with nothing in the prompt touching them.

---

### 4. The land-span question  (settled, for free, and it did not need the blind set)

The plan said this could not be settled without the blind set. It could, as soon
as `bench:dimensions` stopped being blind to per-package dimensions. The count
went from 3 misreads to 7, all the same error - the inner GAP where the centre
DISTANCE was asked, always exactly one land length short - and the census kills
the "the figure draws thermal vias" hypothesis outright:

    D0008A      6 correct at 5.4,  1 wrong at 3.85
    DBV0005A    4 correct at 2.6,  1 wrong at 1.5
    DGK0008A    4 correct at 4.4,  1 wrong at 3.0

The SAME drawing, in different datasheets, read right six times and wrong once.
The drawing is not the variable; it is model variance on a field that admits both
readings.

**Where it ends up in copper**, which is the number that matters and was never
counted: four of the seven are caught by the IPC band check and fall back to a
computed pattern, one refuses for `vacantLeadSlot`, one refuses for no land
pattern, and **TPS7A4700 - no-lead, where the band check cannot run - ships
0.75 mm narrow.** One wrong footprint, not seven.

The prompt now names the gap-versus-extent-versus-centre distinction explicitly.
Whether that helps is for the blind run to say.

---

## Not doing, and why

Unchanged from the morning except where measurement moved something.

| | why not |
|---|---|
| **A no-lead land rule to catch TPS7A4700** | `computeLandPattern` refuses no-lead ON PURPOSE; that rule was retired 2026-08-13 for being reverse-engineered from four TI drawings. Re-adding it restores exactly what was deleted. |
| **"A land must reach the body edge"** | Catches TPS7A4700, misses ADXL345, false-positives on PULL-BACK QFNs. Nothing in the record says which a part is. |
| **Refusing a degenerate min==max range** | 7 spans come back min==max and 6 are CORRECT: ST prints the LQFP span as a single basic value. |
| **More plausibility guards** | Still measured: only the band check fires, and it is already right. It is also now shown to be load-bearing - it contains four of the seven land-span misreads. |
| **A second prompt iteration on pin names** | The run-to-run variance is larger than the effect. Two parts changed package between runs with nothing in the prompt touching them. Chasing it costs $3 a try and cannot be attributed. |
| **Re-parse reproducibility** | The half we control is DONE. The rest is the provider not being a function at temperature 0, and this run made the size of that plain. |
| **Retrieval coverage** | Descoped. `namesThePart` turns a wrong document into an honest refusal. |
| **README** | Anthony's decision, 2026-08-17. |

---

## What is left

1. **Thirteen more drawings**, listed under 1b. Free, and it is the only work here
   that finds defects nobody knows about.
2. **The two-pattern gap**: `DW0016B` proves a datasheet can print two footprints
   for one package. The product picks whichever came back. It should ask.
3. **The blind set**, when it arrives. Run it once, report what happens.

---

## What "finished" means, stated so it can fail

Four guarantees. Each one has a test that can go red; none of them is a feeling
about the code.

| # | Guarantee | The test that proves it |
|---|---|---|
| 1 | **Correct** — every value that places copper is read from the document and confirmed against a human read, or supplied by the user | `bench:dimensions` WRONG 0, at meaningful coverage |
| 2 | **Complete** — the product never refuses what it is already holding | `bench:holdout` SHIPS with settings and answers |
| 3 | **Reproducible** — the same datasheet produces the same bytes | `bench:repeat`, plus a byte-identical export test |
| 4 | **Honest** — it refuses rather than guesses, and names its source | RULES.md rule 1; citation coverage; the guards |

Coverage is not correctness. `SHIPS 98%` says a bundle came out, not that the
bundle is right. Those are different numbers and this plan keeps them apart.

## Where we stand, measured

Restated 2026-08-22. Every row moved, and two of them moved because the
instrument was fixed rather than because the product changed.

| Guarantee | Measured | Gap |
|---|---|---|
| Correct | 243 values, 31 drawings, **4 wrong** on 3 parts | **29 of the 46 SHIPPING tuned parts have no hand-read drawing at all**, see item 2 |
| Complete | hold-out READ 58/59, SHIPS 58/59, 46 asking nothing | 1 part: retrieval fetched the wrong document. Honest now - a wrong-part datasheet used to be counted here |
| Reproducible | 2 of 6 parts bit-identical across runs | **the generator itself is nondeterministic**; drift on 4 parts, 1 uncharacterised |
| Honest | citations enforced; the band guard fires on 2 tuned parts and 3 hold-out parts | it used to read "no guard fires anywhere", which was the BENCH not looking at guards that fire and still ship |

The WRONG count going 0 -> 4 is progress, not regression. Nothing changed in the
generator; `bench:copper` and `DIMENSION_ORACLE` can now see copper they could
not see before. A zero produced by an instrument that cannot look is worth less
than a three produced by one that can.

---

## Phase 1 - make the instruments measure the product

Free. Nothing else is trustworthy until this is done, because every number above
is produced by these benches.

**1.1 The benches must enforce the route deadline.** `bench:extraction` and
`bench:holdout` call `runExtraction` bare. The routes wrap it in `withDeadline`
and discard the whole pass on expiry. Every accuracy number this project has
published was therefore measured on a pipeline with unlimited time.
`bench:repeat` already does this correctly and is the model to copy.
*Exit: all three benches apply `modelBudgetMs`, and the hold-out is re-measured under it.*

**1.2 Report CORRECT separately from SHIPS.** Today one number carries both
meanings. Add a second: of the parts that shipped, how many had every
geometry-determining value either oracle-checked or citation-verified. This is
the number that should be quoted to a customer.
*Exit: `bench:holdout` prints READ, SHIPS and VERIFIED.*

**1.3 `bench:mutation` must restore source on timeout.** It left a live
10x error in the gull-wing fillet on 2026-08-20 and all 703 tests passed with it
in the tree. A wall-clock kill is the normal outcome, not an exceptional one.
*Exit: a killed run leaves `git status` clean; a test asserts it.*

**1.4 Resolve the guards.** Seven plausibility guards fire zero times across
three corpora. Either the population never violates them, or they are
miscalibrated and are dead code wearing a safety label - which is worse than no
guard, because it invites false confidence. Decide, with evidence, and delete or
fix.
*Exit: each guard has either a firing case in a corpus or a recorded reason it cannot.*

---

## Phase 2 - reproducibility, end to end

Free. The order matters: the generator is fixed first, because no amount of
extraction stability helps if the exporter stamps the clock into the file.

**2.1 Make the generator a function.** `exporters.ts:372` and `exporters.ts:2481`
call `new Date()`. Two exports of one record differ byte-for-byte today. Follow
the reproducible-builds convention: accept the timestamp as an input, default it
from the record rather than the clock. Provenance is kept; nondeterminism is not.
*Exit: exporting the same record twice yields identical bytes, asserted by a test.*

**2.2 A byte-identical export test.** Golden files for one part per package
family, compared byte for byte. This is what catches the next `new Date()`
before it ships.

**2.3 Characterise the drift that is left.** STM32F407VG had 92+ values differ
between runs and nobody knows what they were. Presence-versus-absence drift
(`solderMaskExpansionMm` flipping null to 0.07) is a READING gap with a cause,
not noise, and is fixed at the source the way the outline code was.
*Exit: every drifting field on the repeat corpus has a named cause.*

**2.4 A record store, LAST and optional.** Keyed on PDF bytes + extractor
version + prompt fingerprint. It makes the product bit-reproducible by
construction. It is deliberately last: it does not create errors, but it does
stop us seeing disagreements, so it should land only once 2.1 to 2.3 have
removed the causes rather than hidden them. `bench:repeat` must keep bypassing it.

---

## Phase 3 - correctness

Free, slow, and the highest-value work in this plan. It is also the only item
here that finds bugs we do not already know about.

**3.1 Oracle coverage, 18 drawings to 60+.** A person renders the page, reads the
dimension lines, and writes down what the drawing says - including which values
it does NOT print, because omission in that file is an assertion.

Order: parts that SHIP first (a wrong value there is already in a customer's
hands), then one drawing per package family, then the rest.

The value is not the per-part answer key. It is the failure SHAPES that
generalise: ISL71001M's wrong body height was "a drawing prints `1.20 Max` on the
side view and `1.00` in Detail A, and the reader takes the wrong one", which
recurs on every drawing with a Detail A. The fix that followed applies to
datasheets we will never see.

Rate observed 2026-08-20: about four drawings an hour, one real defect per four.

*Exit: every SHIPPING part in both corpora has an oracle entry, and WRONG is 0.*

**3.2 Pin-name oracle parity.** 38 parts have entries and 17 are checked on a
given run, because the rest did not return pins. Track the checked fraction so a
falling denominator cannot look like a rising score.

---

## Phase 4 - close the coverage classes

These are the named reasons a read part does not ship. Each is a question we do
not ask or a value we do not read.

**4.1 The land pattern.** The dominant blocker in every breakdown:
`landSpanMm`, `landPadLengthMm`, `landPadWidthMm`. Most affected parts have a
printed footprint we failed to read. For no-lead packages there is no computed
route at all and there must not be one - measured 2026-08-20, neither published
IPC table reproduces a single one of eight real drawings, and RULES.md rule 1
forbids reverse-engineering one vendor's house rule. So: read the printed
pattern, or ask.

**4.2 `vacantLeadSlot`.** Four hold-out parts. An odd lead count on a two-row
package leaves one position empty and the drawing shows which. Read it or ask it.

**4.3 One retrieval fallback.** The last non-shipping hold-out part is a
3-page hobby-shop breakout page fetched instead of a datasheet. Detect
"this is not a datasheet" and let the user hand us the PDF. That is Layer 1, but
it is the last thing standing between the corpus and 59/59.

---

## Phase 5 - honest external validation

Everything above is measured on 135 datasheets we chose. The published gap
between benchmark and reality is large and well documented: text-to-SQL systems
score 85% on their own benchmark and 10-20% on real enterprise databases.

Before quoting a number to a customer, run a batch of 20 parts chosen by
somebody who is not the person who built the corpus, once, and report what
happens. Treat today's 98% as an upper bound until then.

---

## What NOT to do

Each of these was tested or reasoned through on 2026-08-20 and rejected on
evidence. Do not reopen without new data; the reasoning is in LEARNINGS.md.

| Rejected | Why |
|---|---|
| Canonical merge keys | All 19 within-run candidates were sibling devices or different drawings |
| Deterministic rules for pitch / lead count | 0 contradictions in 6 and 234 checkable cases |
| A solder-mask rule from the text layer | TI prints both variants as a legend; the text interleaves them |
| Computed no-lead land patterns | 0 of 8 printed patterns reproduced, two vendors, both published tables |
| A verifier feedback loop | 1 geometry refusal in 135 parts; nothing to feed back |
| Constrained decoding | 0.59% unparseable, already handled, and it strands the whole cache |
| Thinking budget, Pro models, panel-of-judges | All buy accuracy with latency, against a route budget we had already blown |

---

## Sequencing

Phases 1 and 2 are free and unblock honest measurement of everything else.
Phase 3 runs continuously alongside them and is the long pole. Phase 4 is
ordinary feature work. Phase 5 is a gate, not a task.

Nothing in this plan requires model spend except re-measuring after Phase 1.1,
and the Phase 5 batch.

---
---

# Superseded: the 2026-08-14 plan

Kept for the record. Steps 1 to 9 are done and what each found is in `AUDIT.md`.

> **Status, 2026-08-14.** Steps 1 to 9 are done. See `AUDIT.md` for what each one
> found and what it measured. Step 10, the hold-out run, is the only step that
> spends money and has not been run.
>
> Two things are deliberately left open and are written down rather than closed:
> the Altium writer cannot emit a through-hole pad (the geometry carries the
> hole; KiCad output for the same part is complete), and the thinking-budget
> default is unmeasured because measuring it costs money.

## The goal

A cleaner, simpler product that a working engineer would choose to use, with the
best datasheet reading and the best output files we can manage.

Those are one goal, not three. An engineer does not pay for extraction accuracy;
they pay for a symbol, a footprint and a 3D model they can drop into a library
without checking every number by hand. Reading well is how we get there, and the
output is what they actually receive.

Everything below is free except the last step. See `RULES.md` for how decisions
get made; nothing here overrides it.

---

## 1. Audit every process, workflow and feature

Not a value-by-value pass. That is the decision register, and it is a subset of
this. This is the whole product asked from the customer's side: **would an
engineer want to work this way, and what would they expect that we do not do?**

Everything gets examined, including the things nobody has questioned:

**Getting a part in** — upload, search by part number, what happens on a bad or
scanned PDF, what happens with a document covering fifty devices

**Reading** — which fields, whether the set is the set an engineer needs, what is
missing that a library entry wants (temperature range, MSL, RoHS, orderable
numbers, datasheet link, description)

**Deciding** — package selection when the part number does not settle it, what we
ask, when we ask, how many questions a part is worth, what a refusal says

**Reviewing** — what a person sees before accepting a part, whether provenance is
visible enough to sign off on, whether a wrong value is easy to correct

**The output** — footprint, symbol, 3D body, and everything about them: naming,
pin ordering, layer use, courtyard, silkscreen, origin, metadata fields, how they
link to each other

**Delivery** — a zip of files, or something that goes into an existing library.
Whether one part at a time is the right unit at all.

**Settings** — which exist, which should, whether the defaults match practice

### How we find out what engineers want

The library diff alone is not enough: it tells us whether one footprint matches
one reference, not how people work. Use all of these:

- **Search published practice** per decision, as already done for land patterns
  and density levels. Cheap, and it has corrected me repeatedly.
- **Read real library files.** KiCad's official libraries are public. Their
  structure, naming, metadata fields and conventions are a direct statement of
  what the ecosystem expects.
- **Look at what comparable tools do.** SnapEDA, Ultra Librarian, Component
  Search Engine, PCB Libraries Footprint Expert. Their feature sets and their
  output formats are evidence about what customers ask for, including features we
  have not thought of.
- **Read what engineers complain about.** Forum and community threads about
  library workflow are the most direct available account of the pain.
- **Read the CAD tools' own documentation** on library conventions, which is the
  closest thing to a specification of expected behaviour.

Anything found this way that we do not do becomes a gap with a source attached,
not an opinion.

## 2. Library diff

Generate our output for several common parts and compare against the same parts
from a real library. Independent, free, and it lands directly on naming, pin
numbering, courtyard, origin and 3D alignment.

Runs alongside step 1, not instead of it.

## 3. Fix what 1 and 2 find

Sized by what they actually turn up rather than by anyone's suspicions.

## 4. Confidence system

Replaces what the cross-check did, from evidence already in hand: citation
verified, the document agreeing with itself, geometry being physically possible,
the text pass agreeing with the render pass, the printed pattern sitting inside
the IPC band. No new model calls.

## 5. Delete the parser

`packageOutlineCode` becomes a model read first. Confirm the package hint is no
longer needed. Remove the modules. Model failures get reported loudly rather than
papered over with a worse reading.

## 6. Remaining fixes

Table fallback asks instead of substituting. Source or remove `MAX_APERTURE_MM`.
Through-hole via IPC-7251. Altium pad shapes. Then delete the table if nothing
uses it.

## 7. Test everything that can be tested for free

**Do not stop at the first method.** Each of these covers something the others
miss, and the local model is the weakest of them, not the plan.

- **Replay real model answers.** The cache holds hundreds of genuine responses
  for real datasheets. Even where a prompt change has stranded them for caching,
  the answers themselves remain valid test input: feed them straight into merge,
  confidence, export and emit. This exercises the entire downstream on real data
  for nothing, and it does not care what the model would say today.
- **Round-trip every output.** Parse our own KiCad footprint back and check the
  geometry is what we intended. Same for Altium through `pyaltiumlib`, and for
  the STEP body.
- **Validate against the tools themselves.** `kicad-cli` can read and check
  footprint and symbol files. A file the real tool rejects is a defect no unit
  test of ours would catch.
- **Diff against reference libraries**, several parts across several package
  families, not one.
- **Property tests.** Generate valid records across the space and assert
  invariants: pads never overlap, the courtyard contains every pad, pin numbers
  are unique and complete, nothing lands off-grid.
- **Trip every confidence signal deliberately**, with records built to fail each
  one, so we know they fire rather than assuming.
- **Local model end to end**, last and least. Free, and it will find crashes and
  plumbing breaks even if its reading is poor.

If a method turns out not to work, find another. The bar is that nothing reaches
a paid run untested.

## 8. Cost and latency, without giving anything up

Constraint first: **no saving is worth a worse read or a worse file.** Anything
here that cannot be shown to leave quality alone does not ship. Measure, do not
assume — rule 2 applies to performance work exactly as it does to geometry.

Two different problems, and conflating them wastes effort:

- **A user uploading one datasheet** cares about latency. The cost of a single
  part is pennies and irrelevant.
- **A bench run over the corpus** cares about cost. Nobody is waiting for it.

### What is measured and available

**Thinking tokens are the whole cost story.** Over 246 real calls: output is 68%
of the bill, and 92% of output tokens are reasoning never returned to us. A
CD4017B call that returned thirteen characters of JSON was billed for 2,726
output tokens. Capping the thinking budget is worth roughly 60% of the bill.

It is also the one most likely to cost accuracy, so it gets measured on the tuned
corpus before it goes near a default. `FORGE_THINKING_BUDGET` already exists.
Note that the production model rejects a budget of 0 and needs 1.

**Batch mode for bench runs.** Providers price asynchronous batch work at around
half of interactive. A hold-out run is the ideal case: dozens of independent
calls and nobody waiting. No effect on what production does, so no quality
question at all. Worth checking availability before the next paid run.

**Rendered pages are the expensive input.** Up to eight per part at roughly 1,550
tokens each. Both the page cap and the render resolution are levers, and both
trade directly against reading a drawing correctly, so neither moves without a
measurement showing what it costs in reads.

### Latency

The two passes are sequential by necessity: the model has to read the text before
it can say which pages to render. That is structural and it stays.

What is available without touching the design: render pages concurrently rather
than in series, and keep the retry budget generous enough that a transient 503
becomes a delay rather than a failed part, now that no parser sits behind it.

### What is not on the table

Page selection by heuristic, to cut input. It has been tried three times and lost
whole parts every time. Cheaper and wrong is not cheaper.

## 9. Compliance audit: every rule, against the whole codebase

The last thing before spending, and it is a fresh pass rather than a recollection
of what was fixed along the way. Everything built in steps 1 through 8 gets
checked against `RULES.md` as if seeing it for the first time, because the way
these violations arrive is that each one looked reasonable when it was written.

Take the rules one at a time and go looking for counterexamples:

**1. Do not invent** — sweep every constant, threshold, ratio and table entry in
the source. For each, name the source. Anything that cannot be traced to a
published standard, the document being read, or a stated preference is invented,
and it is a defect regardless of what it is doing for a number.

**2. Do not assume** — sweep every derivation. For each, say why a working
engineer would want that operation, with evidence. Arithmetic being sound is not
the justification; "we know engineers do this because X" is. Collapsing a
tolerance to one figure, choosing a grid, picking a coverage fraction all belong
here.

**3. Read, ask, or setting** — sweep every refusal and every question. For each:
is it refusing because the document is silent, or because our code cannot handle
it? The second is a defect wearing a refusal's clothes. Check the reverse too —
anything we ask about that we never tried to read first.

**4. General, never tailored** — sweep every rule and branch for a vendor name, a
part number, a package family or the symptom that prompted it. Check the tests as
well: a test that only passes for one document is fitted, and it will defend the
thing that fitted it.

**5. Do not overengineer** — sweep for machinery that exists to work around
something that should have been fixed at the source. Extra passes, extra modes,
extra fallbacks, abstraction for a case nobody has met. For each, ask what would
have to be true for it to be unnecessary.

**6. The engineer's expectation** — every decision has an answer to "how do we
know an engineer wants this", and the answer is a source, not a judgement.

The output is a list with a verdict per item: compliant with its source named, or
a defect with what it takes to fix it. **Nothing goes to a paid run with an open
defect on this list** unless it is deliberately accepted and written down.

This is also the pass that catches drift introduced by the earlier steps. A fix
made in step 3 can quietly break rule 5, and the only way that gets found is by
reading the finished thing against the rules rather than trusting the intent
behind each change.

## 10. Hold-out run

The only step that costs money. Everything above has landed.

**Before spending, know that the cache is stranded.** The prompt gained four
fields this pass (`dimensions.mounting`, `dimensions.leadDiameterMm`,
`packageOutlineCode`, and the `straight` lead form), so every cached entry is
unreachable for caching purposes and the run pays full price. That was expected
and is the reason this step is last.

**What the free work says to expect.** Replay puts the generator at 48% shipping
on real model answers with zero refusals, and the questions concentrate in four
fields: `landSpanMm` (22), `landPadLengthMm` (20), `landPadWidthMm` (20) and
`leadSides` (15). Those four are where prompt work would move the number, and
they are readable off pages the model is already being shown. Worth a look before
paying for a run that measures the same gap again.

---

## Deferred: three items parked on 2026-08-24

> Parked to build and connect the frontend (`forged-ui`). Nothing here is
> blocked; it is sequencing, not difficulty. Resume from this section.

### D1. Commit the extraction/oracle working set

Five files carry finished, tested work and are uncommitted on `main`:
`LEARNINGS.md`, `src/lib/__bench__/dimension-oracle.ts`,
`src/lib/__bench__/dimensions.ts`, `src/lib/__tests__/rectangular-quad.test.ts`,
`src/lib/extraction/models/prompt.ts`.

They contain the two live wrong-footprint fixes and their tests, twenty new
hand-read oracle entries, four `bench:dimensions` instrument fixes, and the
prompt changes whose negative result is written up in `LEARNINGS.md` under
2026-08-24. Split into logical commits. Do not push unless asked.

### D2. TSV911 and TSZ121: the land whose centre is not on its terminal

**Do not attempt this with prompt wording.** That route is measured dead: two
well-evidenced field-guide changes, one with 2-of-2 supporting reads and a
mechanism legible on the page, moved neither part, while run variance
introduced five new misreads on parts nobody had touched. Written up in
`LEARNINGS.md`, 2026-08-24.

**What is actually wrong.** Both parts take the *thermal* land's 0.45 mm as a
*lead* land's length, then correctly derive the span from that wrong number
(2.80 - 0.45 = 2.35). TSV911 ships with its pads overlapping their terminals by
0.05 mm where the drawing wants 0.35, about a seventh of the intended contact.
Both parts ship today. Nothing in the product objects, because every number is
individually plausible and no land overlaps another.

**The structural check to try, on our own output, from numbers we already read.**
The terminal is 0.425 mm long and ends at the body edge, so its centre sits
1.0 - 0.425/2 = 0.79 mm from the package centre. We emit the land centred at
2.35/2 = 1.175 mm. The land's centre is 0.39 mm outboard of a 0.425 mm
terminal, so it is not on the terminal at all.

Proposed invariant: *the centre of a lead land must lie somewhere on the
terminal it solders to*, i.e.
`|landSpanMm/2 - terminalCentre| < leadContactMm/2`, where `terminalCentre`
comes from the body extent and the contact length. This invents no threshold,
uses only values read off the drawing, and is a statement about our geometry
rather than an argument with the document.

**Validate before believing it.** Run it across the whole tuned corpus first;
that is free. If it fires on parts whose footprints are correct, it is dead and
should be recorded as dead, not softened with a fudge factor until it passes.
Watch gullwing packages in particular, where the foot centre and the land
centre relate differently than on a no-lead part.

### D3. The blind set

Still the only external validation. Every number the product reports is
measured on 57 datasheets we chose ourselves. Waiting on part numbers picked by
someone who did not build the corpus. Not actionable here.

### Also still open (unchanged, lower priority)

- **ISO7741 / DW0016B prints two complete land patterns**, an IPC nominal
  (7.3 mm creepage) and an HV option (8.1 mm), and does not say which applies.
  The product silently takes whichever the model returned. On an isolator this
  is a safety-relevant choice, so it needs a question in the chooser rather than
  a default. See `forge-datasheet-first-lands`.

---

## Frontend, connected and checked in a browser, 2026-08-24

> **Status: done.** The `forged-ui` branch is closed out and `main` runs end to
> end in a real browser. What follows is the record, not remaining work.

### What `forged-ui` actually was

Not a separate frontend. It branched from `a896c62`, nine commits behind main,
and carried exactly one commit of its own, `d851859`, a restyle of the step
headers and the colour tokens. Everything else in a diff against main is main
being ahead: the settings gate, `chosenPackage`, the retry path and the wider
`/api/lookup` all postdate the branch point.

It builds clean on its own (`tsc` and `next build` both exit 0). The restyle was
ported onto main rather than reimplemented: `globals.css` applied with a
three-way merge, and all six step headers converted to the stacked eyebrow and
title layout, main having a "Step 00" settings section the branch never had.
Nothing else on that branch is worth taking, and it can be deleted.

### The defect that mattered

`next.config.ts` set `script-src 'self'`. Next boots the App Router client from
INLINE script elements, so every one was blocked, React never hydrated, and the
page was served as dead HTML. That is the reported "cannot upload files": the
input had no handler on it.

Fixed with a per-request nonce in `src/middleware.ts`, which is stricter than
the alternative. Then fixed a second time with `force-dynamic` in
`src/app/layout.tsx`, because a statically prerendered route has no request to
take a nonce from and the PRODUCTION build was still dead while `next dev`
worked. Written up in `LEARNINGS.md`.

### Three more, all found by driving the app rather than by reading it

- The settings gate refused a file and then had no way forward, because
  re-picking the same file fires no `change` event. The file is now held and run
  when the gate opens, and the input is cleared on every change.
- An out-of-range setting was dropped in silence while the gate went on
  demanding the field. `outOfRange` now names the field and its limit.
- The chooser printed "TSOT, 23 leads" on a five-lead part, and underneath that,
  `5-Lead SOT` and `5-Lead TSOT` were declaring NO lead count on documents that
  write it in words. Measured neutral on the tuned corpus, both ways.

### The instrument, which is the part worth keeping

`npm run bench:browser` loads the production build in a real browser and fails
on any console error, uncaught exception, blocked request or 4xx. It was
validated by reintroducing both CSP defects and confirming it fails and names
the cause, per the standing rule about instruments that have never failed.

It separates what MUST happen from what a document merely offers, and prints the
optional paths a run did not exercise, so a set of datasheets that quietly stops
covering the review panel or the question flow says so instead of passing.

`npm run lint` also works again. `eslint-config-next` is still eslintrc-format
and loads `@rushstack/eslint-patch`, which refuses to start under ESLint 9.39;
the config is now built from `@next/eslint-plugin-next`'s flat export directly.

---

# Plan: read correctly, ship correctly, ask only what is genuinely missing

> Rewritten 2026-08-25. The first draft was organised around instruments and
> "failing loudly", which is not the goal. The goal is that the product reads
> what the datasheet prints, ships a correct bundle from it, and asks a person
> for a number ONLY when the document genuinely does not carry it, and then asks
> for the right number.
>
> Each section below is one of those outcomes, with the target stated as a
> number that is currently wrong, and the judge named.

## The judge is the hand-read oracles

We already have ground truth, built by a person reading drawings:

```
DIMENSION_ORACLE   51 drawings, 504 hand-read values, 28 with a printed land pattern
PINOUT_ORACLE      38 hand-read pin tables
```

**A value in the oracle is a value the datasheet demonstrably prints.** That
makes every question the product asks falsifiable: ask for a field the oracle
holds for that drawing, and the question is provably wrong. No judgement call,
no sampling, no spending.

Everything below leans on that, which is why extending the oracle is not
bookkeeping but the thing that makes the rest decidable.

## 1. Ask only when the datasheet genuinely does not have it

**Target: zero questions for a value the oracle says is printed. Unknown today,
never measured.**

For every part, take the questions the product would ask and check each field
against that part's oracle entry. Any hit is a false question: the number is on
the drawing, a person has read it, and we are asking anyway.

Each hit is then one of two defects, and the check says which:

- the model returned it and we discarded it (the `asPackage` capital letter, the
  numberless pad row)
- the model did not return it, and the value is printed, so the reading is at
  fault and the page is known

Free, deterministic, and it turns "why is it asking me for this?" from a
judgement into a list. **This is the first thing to build**, because it is the
exact complaint and it is answerable with data already on disk.

## 2. When we do ask, ask for the right thing

**Target: every question is answerable, and answering it completes the export.**

Two failures here, both seen:

- A question with no possible answer. `leadForm` was offered two of its three
  values, so a no-lead package could not be described. Written up 2026-08-17.
- A question that is answered and changes nothing.

`shipOutcome` already supplies answers and checks the export really completes,
which covers the second. The first needs the question CATALOGUE audited: for
each field the product can ask for, can a correct answer be expressed in the
form we accept?

Free. Small, and it has already produced one defect.

## 3. Read correctly

**Target: `bench:dimensions` WRONG goes to zero. It is 16 today, out of 482
compared.**

Every one of those sixteen is a number that would place copper. They are already
identified by part and field. Two acceptable outcomes per item: read it right,
or refuse it and ask. Emitting a wrong number is the only unacceptable one.

Related and known: three parts take a thermal land's dimension for a lead land's
and derive a plausible span from it. TSV911 ships with its pads overlapping
their terminals by a seventh of what the drawing intends. Prompt wording has
been measured dead on these; the remaining routes are structural.

## 4. Ship correctly

**Target: every shipping part's copper is checked against a hand-read drawing.
47 of 52 today.**

`bench:copper` measures emitted pads back out and reports no disagreement with
the record, and `bench:dimensions` checks the record against the drawing. The
chain is only closed where the drawing has been read, so the five unchecked
shipping parts are the gap: LM139AQML-SP, AD590, VA10820, STM32G071RB,
STM32F103C8.

## 5. Never discard what was read

**Target: every discarded value is explainable in one sentence.**

Six of six defects on 2026-08-24/25 were this: pins thrown away over a
thermal-pad row, eight dimensions blanked over a capital letter, a whole Altium
export refused over a character the format holds.

`bench:discards` does this for pins and found four broken parts in a second.
Generalise it to every field, grouped by the reason the code gives. A discard
with a stated deliberate rule behind it is fine. One without is a defect.

## 6. Never claim what was not checked

**Target: no sentence asserts what a document contains unless we looked and can
say where.**

We told a user their datasheet printed no footprint while displaying the page
that printed it. Enumerate every sentence of that kind and either produce the
evidence or rewrite it to say what we did.

## 7. Extend the oracle, because it decides everything above

**Target: a hand-read drawing for every part the product ships, and a hand-read
pin table for every part it claims a pinout for.**

Ten cached parts have no oracle entry at all, so nothing about them can be
judged right or wrong: AD590, DF13-4P-1.25DSA, LM139AQML-SP, RTAX2000S,
STM32F103C8, STM32G071RB, TSZ121, UT32M0R500, VA10820, VA41630.

This is the slow part and it is a person reading drawings. It is also what makes
sections 1, 3 and 4 decidable, so it paces the whole plan.

## Order, and why

1. **Section 1**, the false-question list. Free, answers the actual complaint,
   and its output is the work list for sections 3 and 5.
2. **Section 5**, generalised discards. Free, and section 1 will point straight
   at the cases.
3. **Section 6**, the claims audit. Free, small, mostly reading.
4. **Section 2**, the question catalogue. Free, small.
5. **Section 3 and 4**, the sixteen wrong numbers and the five unchecked parts.
   Needs section 7 to keep going.
6. **Section 7** runs alongside all of it.

Everything before the paid work is free and deterministic. Nothing here needs a
model call until the reading fixes in section 3 are being verified.

## What is deliberately NOT in this plan

**Variance measurement.** The same datasheet read three times gave three
different records, and the error bar on every corpus figure is unmeasured. It is
worth knowing eventually and it is not worth knowing yet: three of the six
defects looked exactly like variance until they were opened, and each turned out
to be a discard. Measure the error bar after the defects it is hiding are gone.

**A promise that this finds everything.** The Content-Security-Policy defect
made the whole application dead for its entire life and was invisible to the
type checker, 760 tests, the production build and every route test. It was found
by loading the page in a browser for the first time. The next one will be
somewhere nobody has looked either, and the only reliable finder of those so far
has been a person using the product and refusing to believe it.


---

# Executed, 2026-08-25

The seven sections above were worked in the order they set out. What follows is
what each one actually measured, because a plan whose outcome is not written
down beside it is a plan that gets re-run.

## The headline numbers, before and after

```
                              before   after
SHIPS UNAIDED                 44/57    45/57      one click, nothing asked
SHIPS A BUNDLE                52/57    52/57      after choosing and answering
VERIFIED (copper hand-read)   47/52    52/52      every shipping part
PACKAGE FAMILY                27/28    28/28      the designator names a real package
packages the chooser offers   162      196        of which buildable, 76 -> 89
bench:dimensions CORRECT      466      502
bench:dimensions WRONG        16       21         the instrument got better, see below
silent discards               28       0
false questions               unknown  1
tests                         770      784
```

WRONG rising is not a regression. Five drawings were hand-read into the oracle
for the first time (section 7), which made nine previously unjudgeable numbers
checkable, and four of those were wrong. Four other WRONG rows were fixed. The
product got better and the instrument got better faster.

## 1. Ask only when the datasheet genuinely does not have it - BUILT, 1 found

`npm run bench:questions`. For every part it takes the questions the product
would actually ask - from `shipOutcome`, so there is one definition of "what
does the product ask" - and checks each field against that part's hand-read
drawing. A hit is a false question, classified three ways: HELD on the record
and asked anyway, DROPPED by the merge, or never read.

Validated by injecting a land pattern into an oracle entry and confirming four
questions flipped to FALSE, then reverting.

**Result: 18 questions across 7 parts. 12 legitimate (a person read that drawing
and it prints nothing), 4 settings, 1 unjudgeable, 1 FALSE.**

The false one is `STM32G071RB.bodyHeightMm`. Its LQFP64 mechanical data prints
`A - - 1.60` on page 131, and the model asked to be shown pages 130 and 132 -
the outline figure and the notes - and never saw the table between them.

It is left open deliberately. The category is 4 of 57 datasheets, all of which
carry three to six such tables, so any fix has to be page-scoped, and the page
in question was never rendered. Reaching it means changing the request, which
invalidates all 2294 cached model answers and turns every free bench into a paid
one. That is a spend decision, not a code decision.

## 2. When we do ask, ask for the right thing - CLOSED

The catalogue of askable fields is now a value, `REQUIRED_INPUT_FIELDS`, and the
export route derives its accepted millimetre fields from it rather than
repeating the list. The list had fallen behind the generator twice before, each
time producing a question whose answer the route rejected as unknown.

`question-catalogue.test.ts` proves the partition: every askable field is
answered by exactly one route, nothing accepted is unasked, and each of the three
shaped fields has its branch.

The other half - a question that is answered and changes nothing - was already
computed by `shipOutcome` as `brokeWhenAnswered` and **printed by nothing**. The
one outcome the input model cannot tolerate was the one no run reported. It is
now printed, and validated by forcing it. **Result: zero.**

## 3 and 4. Read correctly, ship correctly - VERIFIED 47/52 -> 52/52

Five drawings hand-read: `NAJ0020A`, `H-03-1`, `CQZ12805`, `5W_LQFP64_ME_V1`,
`A0B9`. Every shipping part's copper is now checkable against a page a person
has looked at. Two of the five were shipping wrong copper and nothing could have
said so.

**Fixed - the inner gap read as the centre span.** Four parts (DRV8825, ISO7741,
TPS54360, UCC27524) reported the distance between the INNER EDGES of two land
rows where the field asks for centre to centre. A gull-wing foot sits beyond the
body edge, so its land rows are further apart than the body is wide; a reading
that does not clear the body is the gap. True on 22 of 22 hand-read gull-wing
footprints, and false only for `nolead` packages, whose terminals are on the
underside - which is the physical basis, not a hedge. The centre span is the gap
plus one land, and that lands on the hand-read value exactly on all four.
Corrected on the RECORD, not in the generator, so the number a reviewer sees is
the number that places the copper.

**Fixed - a land pattern read out of a document that prints none.** The oracle
can now assert absence per field (`printsNothingFor`), which `leadContactMm` has
been able to do since the oracle existed and nothing else could. STM32G071RB was
carrying a 1.2 x 0.3 land on an 11.5 mm span cited to its LQFP64 notes page; that
section is three pages and draws no footprint at all.

**Still wrong, measured and named, 21 rows.** The two worth naming:

- `STM32F103C8` emits 0.75 mm lands on a 6.55 mm span where its own printed
  footprint says 0.55 on 6.75. Both readings sum to the drawing's 7.30 mm outer
  extent, so the model split it in the wrong place: 0.75 is the corner clearance
  between one row and the row at right angles to it.
- `VA10820` reads a 15.6 mm lead span where the drawing prints 13.97. 15.60 REF
  is on the cross-section, not the plan view.
- `AD590` builds three collinear pads on a 2.54 mm pitch for a TO-52 whose three
  leads sit on a 0.050 inch grid around the can's centre. The oracle now records
  that the drawing states no lead pitch, so this reads as WRONG rather than as
  nothing.

## 5. Never discard what was read - 28 -> 0

`bench:discards` was generalised from pins to every field and to the per-package
tables, which is where a family datasheet's copper actually comes from and which
had no reason channel at all. Three defects, all of them the same shape:

- **LT1013 lost two whole packages.** Its 8-lead and 14-lead PDIPs came back
  under one drawing code, and the merge joined on that key with no check of any
  kind, so the second entry overwrote the first's slot. Five packages reached the
  record where the document describes seven. A key match now has to survive a
  lead-count contradiction.
- **RHFL4913A was split in half by reading more.** Both passes call the package
  `SMD5C`; pass 2 also read its drawing code, which sent it to a different key
  where nothing could establish identity. The pinout ended up in one entry and
  the measurements in another. Two entries the document itself calls by the same
  name are now an identity.
- **`SMD5C` was read as a sibling device.** It is letters then digits and five
  characters long, which is the shape of a part number, so the entry was
  discarded as belonging to another part. A caption naming a device always names
  a package beside it; a caption that is nothing but a device-shaped token is
  naming its own package.

And a fourth, found while chasing them: **the chooser offered only what the
ordering table named.** 18 of 57 parts held a complete, located pin table for a
package the user could not pick - 34 packages in all. The ordering guide is one
of the two places a datasheet names its packages and it is the one that goes
stale. Offered packages went 162 to 196, buildable 76 to 89, and every offered
label is now required to resolve back to the table it was made from.

## 6. Never claim what was not checked - CLOSED

Six sentences asserted what a document contains without evidence. Each now says
what the reading returned, which is both true and more useful: "this was not
read" tells a user to look, "the datasheet does not have it" tells them to stop.

`document-claims.test.ts` scans the source and refuses the phrasings. Scoped to
what a user sees: the extraction prompt is exempt, because telling a model to
answer null when it sees no drawing is the correct instruction. Validated by
reintroducing one of the removed sentences.

## 7. Extend the oracle - 10 parts unjudgeable -> 5

The five that block nothing remain: DF13-4P-1.25DSA, RTAX2000S, TSZ121,
UT32M0R500, VA41630. None of them ships.

## What did NOT get done, and why

**`bench:dimensions` WRONG is 21, not 0.** Every one is named above or in the
run output. The remainder are model misreads of a rendered drawing, and the
cheap fixes are used up: the ones with a general rule behind them have been
taken. Moving the rest means changing what is asked or how the page is shown,
which invalidates the model cache and costs money to re-measure.

**The hold-out has not been re-run.** Nothing here was tuned against it and
nothing in it was opened. It is a paid run and the decision to spend is not mine.


---

# Pin tables, 2026-08-25

Fourteen shipping parts had a pinout nothing could contradict. Eleven are now
hand-read. **Ten were correct and one was wrong on every pin.**

    correct   LD1117  LTC3105  MAX232  NCP1200  TSV321  PCF8574
              TPS54360  TS922  TSV911  TSZ121
    WRONG     LT1013

Plus OPA2277, whose entry already existed and had never been compared: pins 7 and
8 swapped, `V+` and `Out B`.

## The check could not see most of its own oracle

`PIN NAMES: 23/24 parts match` had been printed for weeks. The oracle had 44
entries and **twenty were never compared to anything** - `checkNames` read
`record.pins`, which is empty by design on a family datasheet. Same defect
`bench:dimensions` carried until 2026-08-22, same cause, same fix.

    PIN NAMES   23/24 (of 44 entries)  ->  36/40 (of 49 entries)

## The model read LT1013 correctly and the merge discarded it

    pass 1   "8-Lead Plastic SO"              1:OUTPUT A 2:-IN A 3:+IN A 4:V- ...
    pass 2   "8-Lead Plastic Small Outline"   1:+INA 2:V- 3:+INB 4:-INB ...

Pass 2 matches the hand read exactly. Pass 1 had copied the PDIP's assignment
onto the SO entry - it gives byte-identical lists to `8-Lead Plastic SO` and
`8-Lead PDIP`. `mergePackageEntries` prefers pass 1 for pin tables.

**Not changed.** That precedence has three measured parts behind it and altering
it on the strength of one is the tailoring RULES.md 4 forbids. Two discriminators
were considered and rejected: "identical pin lists within one pass" fires on
legitimate cases, and "prefer the pass that cited a rendered page" is the flat
field's rule, which per-package entries have no page to apply. **This needs a
corpus measurement, and it is the highest-value open item.**

## Still unread

`TPS7A4700` (20-pin VQFN), `UT54LVDS217` (48-pin), `VA10820` (128-pin), plus the
seven printed footprints and TSZ121's outline drawing.

## A flaky test, named as such

One run in seven failed. It did not reproduce across six further runs and the
failing test was not captured, so it is recorded as observed rather than
diagnosed. `LEARNINGS.md` already says to run the suite more than once because
`node:test` parallelises; this is that, and it is not evidence the tree is clean.


---

# Making the downstream code correct, 2026-08-25

The question: how do we make sure everything between "we read it" and "we ship
it" cannot lose or corrupt what was read.

## What every defect this week had in common

Nine defects were found on 2026-08-24 and 25. Not one of them was a wrong
calculation. Every single one was the pipeline **making a decision and not
recording that it had made one**:

    pins discarded over a thermal-pad row          a DROP nobody was told about
    8 dimensions blanked over a capital letter     a DROP nobody was told about
    an Altium export refused over one character    a DROP nobody was told about
    two LT1013 packages destroyed by a merge       a CHOOSE nobody was told about
    RHFL4913A split in half by reading more        a CHOOSE nobody was told about
    34 packages the chooser never offered          a DROP nobody was told about
    4 land spans read as the inner gap             a TRANSFORM nobody was told about
    a land pattern read from a page printing none  a DROP nobody was told about
    LT1013's netlist, wrong on every pin           a CHOOSE nobody was told about

The code was not careless. Each site was written deliberately, with a comment,
and was correct for the case in front of its author. What was missing in all nine
was any way to ask "what did the pipeline decide today, and why".

## The three kinds of site, and their coverage now

Every place a read value can change has one of three shapes. Counted across
`run.ts`, `merge.ts` and `exporters.ts`:

    DROP       a value goes in and nothing comes out
               10 sites report a reason, 35 are silent
    CHOOSE     two values go in and one comes out
               65 sites, and NONE of them report anything
    TRANSFORM  a value goes in and a different one comes out
               2 sites report (statedMaxHeightMm, the inner-gap span), the rest do not

**CHOOSE is the whole gap.** It is where the wrong netlist lived, where LT1013's
two packages died, and where RHFL4913A was split. Sixty-five sites, no register,
no measurement, no way to see what happened.

## Phase 1 - one register, and every site declares into it

Add a single decision log carried on the record: field, package, what came in,
what went out, and the one-sentence reason. Then convert the sites:

  1. the 65 CHOOSE sites, highest value first: pins, then the fields that place
     copper, then everything else
  2. the 35 silent DROP sites
  3. the TRANSFORM sites

This is mechanical work on code that already exists. It changes no behaviour.

What it buys is the thing that was missing every time: **"is downstream
correct?" stops being a question about 178 branches of control flow and becomes a
question about a list of decisions, which a person can read.** A decision with no
justification in the register is a defect, exactly as a silent discard is now.

## Phase 2 - collapse the facts that are written twice

A distinct class, hit five times this week: **one fact expressed in two places,
which then drift.** Each was invisible until something broke.

    the thermal pad's number       "EP" in the check, pinCount+1 in the emitter
    the shipping pin table         flat record in the check, per-package in the product
    the shipping dimensions        flat record in the check, per-package in the product
    the askable field list         a union in exporters, a literal list in the route
    the package identity           caption in one path, drawing code in another

These do not need a register, they need deleting. One definition, imported by
both users. `REQUIRED_INPUT_FIELDS` was done this way on 2026-08-25 and the
drift it allowed is now impossible rather than merely absent.

Sweep the pipeline for the pattern: any constant, key or identity that appears in
two files is a candidate, and the test is whether one could change without the
other.

## Phase 3 - rank the CHOOSE sites by what they touch

Not all 65 matter equally. Ranked by consequence:

  1. **pins** - a wrong choice is a wrong netlist under a real part number, which
     no geometric check can see. One site, now fixed and pinned.
  2. **the copper fields** - landPad*, landSpan*, pitch, leadSpan, thermalPad*.
     A wrong choice is a wrong footprint. `bench:copper` measures these back out
     of the emitted pads, so a bad choice here is at least catchable.
  3. **the body fields** - silkscreen and courtyard only. Wrong is ugly, not
     scrap.
  4. **everything else** - names, notes, metadata.

Work them in that order and stop when the remaining ones cannot place copper.

## What this gives you, and what it does not

It gives you: every loss and every choice in the pipeline visible by
construction, the same way silent discards became visible and immediately
produced three fixes. It makes the class of bug that has caused every defect this
week detectable the moment it is introduced rather than months later.

It does not give you: a promise that every choice is the RIGHT one. LT1013 needed
a hand-read pinout to know which of two readings was correct, and no amount of
logging supplies that. Visibility is the precondition, not the whole answer - but
every one of the nine was invisible first, and none of them survived being seen.


# The downstream audit, executed, 2026-08-25

The plan above ranked the decision surface and said CHOOSE was the whole gap.
Executing it found something the count did not predict: **the defects were not in
the CHOOSE sites at all.** The one CHOOSE site named as highest risk measured
clean over the whole corpus, and five real defects turned up in places the count
did not cover - axis mappings, an unchecked output, and a validator that two
callers ran differently.

## Method

Build every package the corpus documents, offline and free, and look at the pads.
100 footprints in about forty seconds. Then compare what the chooser promises
against what the export actually does, for every option.

## Fixed

| | |
|---|---|
| LT1013 TO-5 built 8 pads in a 35.56 mm line on an 8.95 mm can | refused |
| a body grown to hold its lands, redrawing VA10820 0.4 mm too large | backed out |
| every TO-220 / TO-92 / SIP drawn 90 degrees from its own pins | transposed |
| a gapped pin table shipped N lands against fewer symbol pins | `symbolViolations` |
| the chooser offered options the export then refused | same invariants both sides |
| `pinCount + 1` written out by hand in four places | one `thermalPadNumber` |

## Measured clean

- `run.ts:596`, the pass-2-overwrites-pass-1 dimension spread: 89 joins, pass 1
  contributes nothing in any of them.
- 81 of 81 "ships" options export. Before the chooser fix, 81 of 83.
- The refusal census is questions, not defects.

## Cost

No model calls. No spend. Tests 786 to 791, all green; typecheck and lint clean;
`bench:copper`, `bench:discards` and `bench:guards` unchanged. One package lost
its "ships" label and it was the wrong one.

## Corrected the same day

The first version also GREW the drawn body on a dual or quad whose lead row did
not fit it. `bench:dimensions` disproved the premise: VA10820's body reading is
correct, and its drawing prints a 12.40 mm lead row on a 12.00 mm ceramic body,
because a brazed lead frame overhangs. The growth was backed out, the single-row
bound widened to `body + pitch` from that same measured overhang, and the property
test scoped to single rows.

## What is NOT closed

- **AD590's TO-52.** Three leads on a 2.54 mm bolt circle, built as three
  collinear pads. The row (5.08 mm) FITS the body (5.31 mm), so no invariant can
  prove it wrong: the record honestly describes a consistent single row. This is a
  reading defect, not a downstream one, and it needs a circular arrangement to fix
  properly.
- **Grid arrays.** BGA and LGA pinouts are correctly refused at the pin table, but
  their packages are still OFFERED by the chooser and can never build.
- The remaining wrong dimension rows in `bench:dimensions`.


---

# The release plan, 2026-08-27

## Why the previous weeks felt like nothing changed

Work has been converging on nothing because **there is no definition of done and
no instrument that measures the thing the release bar is about.**

Everything we measure - READ, SHIPS, fields filled - asks whether a part REACHES
a bundle. Nothing measures whether the numbers in it are RIGHT, except on the 57
parts a person read by hand. So no number can ever say "good enough", and each
session ends by handing over a fresh list of defects found by whatever ad-hoc
method was to hand that day.

Hand-reading is the bottleneck. It found every real defect this week, including
STM32F407VG's twenty-two shifted pins, and it caps at dozens of parts. A consumer
uploads parts nobody has read.

## The bar, in numbers

The goal, agreed: **correct, or it tells you precisely what it could not read and
asks you for that** - where the ask is genuine, the ask is rare, and the user
trusts everything else without checking it.

| the promise | how it is measured | today |
|---|---|---|
| the numbers are correct | share of shipping parts whose pinout and copper are CONFIRMED by a second independent reading | not measured |
| or it says what it could not read | false questions | 0 |
| the ask is genuine | every ask checked against the page it claims is silent | 12 asks, all genuine |
| the ask is rare | parts asking anything at all | 3 of 57 |
| works end to end | full browser journey green in CI | partial, and costs money to run |
| any datasheet | parts producing a bundle | 93% hold-out |

Three of six are already met. This plan is the other three, and row one gates the
rest.

## The idea the plan rests on: THE DOCUMENT AGAINST ITSELF

To know whether a document was read correctly you need what the document says.
There are three sources and only one is always available:

1. a human reads it - does not scale
2. another library carries that part - exists for SOME parts, and our market of
   rad-hard ceramics is exactly the part of the space those libraries omit
3. **read the document a second, independent way** - available on every document,
   by construction

A datasheet states its important facts twice, and we have only ever read them
once:

    pinout        the pin diagram AND the pin-function table
    dimensions    the outline drawing AND the mechanical data table
    land pattern  the printed footprint AND what IPC computes from the lead data

Every real defect found this week was a first-column reading that the second
column would have contradicted. LT1013 shipped the PDIP's assignment on an SO;
STM32F407VG dropped pin 28 and shifted twenty-two.

### Why this is not the cross-check that was deleted

That one compared two READERS of different quality, went inert when the parser
was removed, and reported "0 disagreements on 0/56 parts", which reads like a
pass and means nothing was examined.

This compares two STATEMENTS IN ONE DOCUMENT. It cannot go inert, because the
second statement is on the page whatever else changes.

### The false conflicts, and the rule that separates them

The objection that killed the last attempt is real: readings disagree for
innocent reasons. Measured on STM32F407VG, the one part hand-read completely:

    pin 12   figure "PH0"   table "PH0/OSC_IN (PH0)"    one CONTAINS the other
    pin 29   ours "PA5"     figure "PA4"                 neither contains the other

**All eight false conflicts were containment. All twenty-two real ones were not.**
That is not a threshold fitted to the data; it is ST's printed convention, the
pin name beside its function after reset, in one table cell.

---

# Phase 1 - the self-check, validated before it is trusted

## 1a. Measure whether the second reading is free

The pin table is TEXT. Whether the text layer can supply a pin-number-to-name
mapping decides the entire cost of this plan, and it is free to find out.

    On how many corpus parts can the text layer produce a pin mapping at all,
    and where it can, does its ASSIGNMENT match the model's reading?

Known counter-example: STM32F407VG's Table 7 is mangled at the row that mattered
and gave a third wrong answer. One part is not a verdict.

- **clean** -> the second opinion costs nothing
- **noisy** -> it needs a second model call, and the cost is measured before it is
  spent
- **either way** -> the answer is recorded so nobody re-opens it

## 1b. Measure the false-positive rate against what we already know

`PINOUT_ORACLE` holds 40 hand-read pinouts. Run the containment rule over them
and count how often it flags a part we KNOW is right.

**This gates everything.** If it fires on correct parts it dies here, and goes in
LEARNINGS beside the other measured negatives so nobody proposes it a fourth
time.

## 1c. Ship it, narrowly

Only where both readings exist. Never holds a part on a containment difference.
Where two readings disagree substantively, that is the rare case worth a human
glance, and the user is shown the two pages and the one difference.

**Phase 1 is done when** every shipping part carries a per-part answer to "was
this confirmed twice", and the false-positive rate of that answer is measured
rather than assumed.

# Phase 2 - drive the confirmed rate up, by class

Every disagreement is classified before anything is fixed, and the fix covers the
class. RULES.md rule 4 stands: state the rule without naming a vendor, a part, a
package family, or the symptom.

**Done when** the confirmed rate clears a threshold stated in advance AND every
remaining disagreement has a named, understood reason. Not "still looking".

# Phase 3 - the bounded coverage holes

Three, all known and finite:

- **no-lead land patterns** - QFN, DFN, SON, LGA, the largest modern family,
  buildable today only when the datasheet prints a footprint. Confirmed twice as
  the biggest limit, including by the hold-out.
- **grid arrays** - BGA and LGA are correctly refused and still OFFERED by the
  chooser, which is a promise the product cannot keep.
- **metal cans** - leads on a bolt circle cannot be expressed at all.

**Done when** every package family either builds or refuses with a reason the
user can act on.

# Phase 4 - end to end as a gate rather than an occasional check

`bench:browser` covers upload, chooser and export, but the full path needs
`--full`, which spends money, so it is not routine. That is why frontend-to-
backend defects survive: the app served a dead page for its entire life with
every other instrument green.

Make the full journey replay from cache so it runs free, and put it in CI.

**Done when** the complete user journey is green on every commit.

# Phase 5 - beta

Five to ten engineers, their own parts, instrumented so we see what they upload
and what fails.

**Done when** their parts hit the same numbers as our corpus. If they do not, the
corpus was the problem and we will finally know.

---

# The rule that stops the churn

**No more ad-hoc defect hunting, and no more passes over the 57 tuned parts.**
Yield there is falling and it is why this feels endless.

Every fix from here comes from an instrument in this plan. If no instrument
caught it, the gap is the instrument, and that is what gets fixed.

"I found another defect" is not progress. It is progress only when one of the six
numbers in the table above moves.

# What this plan does NOT give

It does not certify an individual rad-hard part. Nothing does, short of a person
reading the drawing, and that stays true for the parts a customer signs off on.

What it changes is that hand-reading stops being the only DETECTOR. The classes
of defect become visible on every datasheet, automatically, and the human read is
spent confirming rather than searching.


---

# THE FINISH PLAN, 2026-08-27

Supersedes the phases above. This is the plan that ends the project.

## The goal, stated as something a machine can enforce

> Correct, or it tells you precisely what it could not read and asks you for
> that. The ask is genuine, the ask is rare, and the user trusts everything else
> without checking it.

That goal forbids exactly ONE thing: **a value that is wrong and silent.** It
does not require perfect reading. It requires perfect classification.

So the whole product reduces to one invariant and one number.

## THE INVARIANT

> **No value ships silently unless two INDEPENDENT sources agree on it.
> Everything else is put in front of the user.**

There is no third state and nothing falls through. "We could not confirm this" is
not a caveat on the rule; it is an outcome the rule already handles.

### Independent means read by different MEANS, not the same means twice

This is load-bearing and it is what removes the last residual. A model that
misreads a rotated figure will misread it the same way twice. So the two sources
must fail differently:

    one from the TEXT LAYER          a pin-function table, a mechanical data table
    one from the RENDERED IMAGE      a pinout figure, an outline drawing
    or one from ARITHMETIC           IPC-7351B computed from the lead data

A text-layer read and an image read cannot share a failure mode. That is what
makes agreement mean something.

## THE NUMBER

**Flagged values per part.** Anthony's gate, 2026-08-27:

    no part ever shows more than 5
    most parts show 0            target 80% of parts
    average under 1 per part

### What happens to a part that would need more than five

It is REFUSED, with the list of what could not be confirmed. It is never shipped
with twelve boxes to fill in.

That keeps the invariant whole and keeps the promise: the user never faces more
than five, because past five we say this datasheet cannot be done automatically
rather than handing them the job back.

---

# Step 1 - turn the invariant on and measure the truth

Every value carries a state: CONFIRMED, FLAGGED, or ABSENT. Publish
flagged-per-part on every run.

**The number will start bad.** Today we confirm almost nothing and ship it
silently, so turning this on makes the real state visible all at once. That jump
is the measurement arriving, not a regression, and it is the first honest picture
of the product we will ever have had.

**Done when** every shipping value has a state and the distribution is published.

# Step 2 - wire the three confirmations, cheapest first

**2a. The land pattern. Free, and already written.**
`contradictsPrintedLand` compares a printed footprint against one computed from
the lead data by IPC-7351B. It exists, it is tested, and it is stranded behind an
`else`: it runs ONLY when the printed pattern could not be read, so on the 48 of
64 footprints built FROM the printed pattern it never runs at all. Compute both,
always, and compare. Pure arithmetic on data already on the record.

**2b. The dimensions. Probably free.**
The outline drawing carries arrows; the mechanical data table carries the same
numbers as TEXT. Measure first whether the text layer yields the table on enough
parts. If yes, this costs nothing.

**2c. The pinout. Measure the cost before spending.**
The pin-function table against the pinout figure. The table is often text; where
it is not, this needs a second model read. Measure which before committing.

Every real defect found this month was a pinout, so this is the highest-value
one even if it is the only one that costs money.

**Done when** all three run on every part and each contributes to the flagged
count.

# Step 3 - drive flagged-per-part under the gate

Every flagged value is classified before anything is fixed. Fix the class, never
the instance. RULES.md rule 4 stands.

Two ways a value leaves the flagged bucket, and only two:

1. we read the second source better, and the two now agree
2. the datasheet genuinely states it once or not at all, and it stays an ask

**Done when** no part exceeds 5, 80% of parts are at 0, and the average is under
1.

# Step 4 - the false-conflict guard, measured not assumed

A disagreement that is not a defect is an ask the user should never have seen.
The known shape is CONTAINMENT: ST prints `PH0` in the figure and
`PH0/OSC_IN (PH0)` in the table, the same pin under two printed names. All eight
false conflicts on STM32F407VG were containment; all twenty-two real ones were
not.

Validate the rule against the 40 hand-read pinouts in `PINOUT_ORACLE` BEFORE it
ships. If it flags parts we know are correct, it does not ship.

**Done when** the false-positive rate is measured and stated.

# Step 5 - end to end, as a gate

`bench:browser` covers upload, chooser and export, but the full path needs
`--full`, which spends money, so it never runs. That is why frontend-to-backend
defects survive: this app served a DEAD PAGE for its entire life while every
other instrument was green.

Make the full journey replay from cache so it is free, and put it in CI.

**Done when** the complete user journey is green on every commit.

# Step 6 - beta, with the market

Five to ten RAD-HARD engineers on their own parts. Not commodity parts: rad-hard
is where no external library exists, where the cost of being wrong is highest,
and where this product is the only option.

**Done when** their parts hit the same flagged-per-part distribution as ours.

---

# Why this finishes the product

| the promise | what delivers it |
|---|---|
| the numbers are correct | everything shipped silently was confirmed by two independent sources |
| or it tells you what it could not read | the invariant, which has no third state |
| the ask is genuine | flagged means two sources disagreed or only one exists, which IS "we cannot determine this" |
| the ask is rare | the gate: never more than 5, most parts 0 |
| the user trusts the rest | the rest is the confirmed set, backed by the datasheet rather than by us |

Five for five, and none of them rests on reading perfectly. They rest on never
shipping a number that nothing checked.

# The rule that keeps it finished

Progress is flagged-per-part going down. Nothing else is reported as progress:
not defects found, not tests added, not SHIPS, not READ. If work does not move
that number, it is said plainly that it did not.

---

# THE FINISH PLAN: EXECUTED, 2026-08-27

What was built, what it measured, and what is left. The plan above is the
intent; this is the record.

## The invariant is live

`RULES.md` rule 7 and `src/lib/confirm.ts`. Every value that reaches the output
is **confirmed** - two independent readings of the datasheet agree on it, and it
ships without being mentioned - or **flagged**, and the user is shown it. No
third state.

Wired into the product end to end: `packageOptions` computes it per offered
package against the real geometry, `PackageOption.toCheck` carries it, the
readout and both routes return it, and the screen leads with it. A package that
would need more than `MAX_FLAGGED` is refused with the list rather than shipped
with a form.

## The number

`npm run bench:confirm`, free and offline.

```
                         first run     now
  average per part          1.72        1.53
  parts with nothing          0%         34%
  worst part                   4           4      gate: never above 5   MET
```

**The gate Anthony set is met and was met from the first run.** No part in the
tuned corpus asks for more than four glances, and a third ask for none.

The two aspirational targets in the plan above - 80% of parts at zero, average
under one - are NOT met, and the reason is measured rather than guessed: see
"what is actually left" below.

## Was the confirmation worth anything?

Scored against the 36 hand-read pinouts in `PINOUT_ORACLE`, which is the only
ground truth this project has:

```
  confirmed and the oracle agrees      23
  CONFIRMED AND THE ORACLE DISAGREES    0    <- would have sunk the whole idea
  flagged and the oracle disagrees      1
  flagged though the oracle agrees     13    <- glances we did not have to ask for
```

Zero false confirmations. That is the property the reader is tuned to protect and
three further refinements were rejected for risking it.

## Steps, against the plan above

| step | state |
|---|---|
| 1. turn the invariant on and measure | done, `bench:confirm` |
| 2a. the land pattern, free | done, and it was stranded behind an `else` |
| 2b. the dimensions | done for the pitch; the lead dimensions are the next lever, measured below |
| 2c. the pinout | done, `pinevidence.ts`, free, zero false confirmations |
| 3. drive the number under the gate | gate met; the two stretch targets are not |
| 4. the false-conflict guard, measured | done, and the accusations were then dropped entirely |
| 5. end to end as a gate | the free pass is in CI; `--full` still costs money |
| 6. beta with rad-hard engineers | not started, and it is not a code step |

## What is actually left, with numbers

Every remaining flag falls into five classes. Three of them are the datasheet
being silent and are correctly reported as such; two are ours.

```
  51  pitch/no-printed-footprint         the datasheet prints no footprint we found
  33  land-pattern/no-printed-footprint  the same, for the pads
  17  pinout/partly-corroborated         some pins are drawn as artwork
  15  land-pattern/no-ipc-model          no-lead: the STANDARD is not transcribed
  12  body/no-span-to-bound-it           a no-lead package has no lead span
```

**The measured next lever:** 28 of 85 parts restate all three lead dimensions -
span, contact and width - as min-max pairs in their text layer. That is a second
reading of the numbers a computed land pattern is built from, and it would move
the largest class above. It was not built here because being HONEST about it
requires the extraction method to reach `ResolvedPart`: a text-layer restatement
corroborates a value read off the RENDERED page and is circular for one read from
the text, and `ResolvedPart` currently carries neither. That plumbing is the
work.

**Two things that will not move and should not be chased:** a pinout drawn as
artwork has no text layer to read twice, and IPC-7351B's no-lead fillet goals are
not transcribed here for reasons `computeLandPattern` states at length. Both are
reported to the user in those words.

## Everything green, 2026-08-27

```
  tsc, lint, npm test           813 tests, 0 fail
  bench:extraction              SHIPS 49/57 unaided (86%), 52/57 with a choice (91%)
  bench:dimensions              pass
  bench:questions               pass
  bench:copper                  pass
  bench:guards                  pass
  bench:corpus                  pass
  bench:discards                0 silently discarded, up from 9
  bench:browser                 4/4 stages, 0 browser problems, now in CI
  VERIFIED                      52/52 shipping parts hand-read
  PIN NAMES                     38/39
  PACKAGE FAMILY                28/28
```
