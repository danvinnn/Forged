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
> **Phase 2: done except 2.4.** The generator is a function of its inputs and
> three tests hold it there. The one known remaining drift is TPS54360's solder
> mask pair, written up in LEARNINGS.md and needing a decision rather than a fix.
> 2.4, the record store, is deliberately still last and still optional.
>
> **Phase 3: advanced and continuing.** 13 drawings to 20, 163 values to 228,
> zero wrong. This does not have a finish line in one sitting; the rate is about
> four drawings an hour and roughly one real defect per four.
>
> **Phase 4: done for the part that blocked a bundle** (`NOT_A_DATASHEET`). The
> land-pattern and `vacantLeadSlot` items reduce QUESTIONS rather than unblock
> parts - every affected part already ships once answered - so they are ordinary
> feature work, not a gate.
>
> **Phase 5: not started, and cannot be by me.** It needs part numbers chosen by
> someone who did not build the corpus. Mechanism is ready: add them to a corpus
> list and run `npm run bench:holdout -- --fetch --model`.

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

| Guarantee | Measured | Gap |
|---|---|---|
| Correct | 204 values, 18 drawings, 0 wrong | **114 of 135 cached parts have no oracle entry** |
| Complete | hold-out READ 58/59, SHIPS 58/59, 45 asking nothing | 1 part: retrieval fetched the wrong document |
| Reproducible | 2 of 6 parts bit-identical across runs | **the generator itself is nondeterministic**; drift on 4 parts, 1 uncharacterised |
| Honest | citations enforced; no guard fires anywhere | 7 guards, 0 firings across 3 corpora - unresolved |

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
