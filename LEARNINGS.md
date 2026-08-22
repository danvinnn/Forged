# Learnings

Everything this project has paid for twice, so it is not paid for a third time.

**This file is about how to WORK on Forge.** `RULES.md` is about how the product
decides what to emit; the two do not overlap and neither replaces the other.

Every entry earns its place by having actually cost something. If an entry cannot
name the failure that produced it, delete the entry.

**Naming parts and vendors here is deliberate and is not a breach of RULES.md
rule 4.** That rule forbids fitting PRODUCT CODE to a datasheet you happened to
look at. Evidence for a process lesson is the opposite: an entry that cannot name
what it cost is the one to distrust.

Claims in this file were last verified against the code on **2026-08-17**. Section
8 says how to keep that true.

---

## 1. Before claiming anything works

A green suite is necessary and not sufficient. Every failure that mattered in
this codebase was in the gap between what the tests cover and what the product
does.

```bash
nvm use 22                      # .nvmrc pins 22; the local default is 21
./node_modules/.bin/tsc --noEmit
npm test                        # run it MORE THAN ONCE, node:test parallelises
npm run build                   # passes tsc and tests, fails to bundle
npm start                       # then POST a real export and READ the files
```

**Name which of these you actually ran.** If you only ran the suite, say only
that. Implying more is the cheapest possible way to lose the user's trust in
every number you report afterwards.

**The benches are NOT part of this list, because they cost money.**
`bench:holdout` and `bench:extraction --model` call a paid API. `bench:replay`
and `bench:guards` run off the cache and are free. Do not run a paid bench
without asking, and see section 5 first.

Two checks the suite structurally cannot do:

- **Dump every pinout in both caches and diff against the previous state, one
  variable at a time.** This caught every regression on 2026-07-31 (RHFL4913A
  16 pins to 7, SN74LVC1G08 pin 6 back to `V`, eight wrong DRV8825 names). No
  bench figure showed any of them.
- **Dump every FOOTPRINT the same way.** Export each cached part, parse the pad
  coordinates back out, read the centre-to-centre spans. That is how an ISO7841
  was found shipping pads underneath its own body, having done so for some time.
  **A part that ships the wrong copper counts as a success in every coverage
  figure**, so no bench will ever tell you.

### The oracles are the only correctness check

`PINOUT_ORACLE` and `PACKAGE_ORACLE` in `src/lib/__bench__/` are hand-read from
the actual PDFs. **Never copy an oracle entry from extractor output**; that makes
it agree with itself forever. They have caught changes that all 600+ tests and
every bench number called green.

There is still no oracle on any dimension.

---

## 2. The failure shapes that recur here

These four account for most of what the audits have found. When something is
wrong, suspect these before writing anything new.

### "We had it and threw it away"

**The recurring failure is not that the model cannot read. It is that Forge
collects an answer and never consumes it.** Five instances so far, all since
fixed, listed because the SHAPE keeps coming back and not as open bugs:

- pinouts discarded for want of a citation (LM139AQML-SP)
- a thermal-pad discard that hid three parts
- `pinTablesByPackage` populated, paid for on every call, and never reached by
  the package chooser: 12 hold-out parts reported "no pins" with complete
  pinouts sitting on the record
- `findUnreadableFootprint` written and never called
- `formedLeadSpanMm` reachable in code and asked for by nothing in the UI
- pass 1 read the pin TABLE correctly and `combine` let pass 2's pinout FIGURE
  overwrite it, because pass 2 won every field unconditionally (RHF1201 lost 48
  electrical types and had `D11(MSB)` broken to `(MSB)D11`; LIS3DH came out
  rotated one position). Both were the whole of the corpus's pin-name defects

**When coverage looks bad, measure what is already on the record before writing
a reader.** Every one of these was found by reading, never by a test.

### The hold-out was contaminated, and nothing checked it

Three parts were in `BENCH_CORPUS` and `HOLDOUT_CORPUS` at the same time: L7805,
LTC3105 and TPS7A4700. Each had reader rules fitted to it while counting toward
"the number that predicts a stranger's datasheet".

**Found by accident on 2026-08-17**, when promoting L7805 created a duplicate
entry and a two-part run reported three parts. Nothing else would have surfaced
it: a contaminated hold-out does not look broken, it reads slightly high forever.

Fixed by removing them from the HOLD-OUT (never from the tuned corpus, which is
where the fitting actually happened) and adding blind replacements.
`corpus-separation.test.ts` now fails on any overlap or any repeated entry.

**Every assumption a headline number rests on should have a test.** This one was
stated forcefully in a 30-line comment at the top of `holdout.ts` and enforced
nowhere.

### The bench measures the product WITHOUT the user, so its blocked figures are a floor

`oneClickCheck` calls `packageOptions` on the record as it stands. Naming a
package in the product does something it cannot: it re-posts to `/api/parse`,
which sets `packageType` with method `user` and puts it in the model's prompt, so
the whole document is re-read FOR that package.

Measured 2026-08-17. Six parts the bench reported as reading no geometry at all
(LM358, ADS1115, OPA2189, MAX232, UCC27524, ISO7741) read completely and ship
once the package is named, 6 for 6, for about $0.30. Nothing was broken; the
model had correctly declined to pick among several packages and declined every
dimension with it.

**Before treating a bench refusal as a defect, check whether the product asks the
user something the bench never answers.** `src/lib/__bench__/packagehint.ts` is
the instrument for this and it costs a call per part.

### Fixed in one place, not the other

When a format or a pipeline stores something twice, we fix the copy that broke
and leave the other. Four instances in one session:

- the traceability gate checked a hand-written list of dimensions, not all of them
- billed attempts were counted on success and not on failure
- Altium stores height and description twice; the first copy of each was fixed
- `local-focused.ts` narrowed the fields and the pages, and not the images

And a fifth, on 2026-08-17, which is the one that cost money: `shipOutcome` in
`holdout.ts` rethrew anything that was not a `FootprintUnavailableError`, so a
`FootprintInvalidError` from the output invariant ENDED a paid 56-part run
partway through. 28 answers bought, $0.57 spent, no figure produced. `shipCheck`
in `extraction.ts` had recorded ANY error as a non-ship for months. One rule, two
implementations, only one hardened.

**Ask where else this value lives.** This shape appeared FOUR times in the single
day of 2026-08-17 alone (the billing allowlist, the pass-2 precedence, a stale
mutation, and this), which makes it the dominant failure mode in this codebase by
a distance. It is worth asking "is there a second copy of this rule?" as the
FIRST question on any change here rather than the last.

**And ask it of the instruments too, not only the product.** The three earlier
finds that day were all in product code; this one was in the bench measuring it,
and it was the only one that cost anything. A benchmark that dies on one part is
worse than one that never ran, because it spends the money first.

### An allowlist of the known cases, broken by the next case

A test written as "which things are X" silently answers NO for anything added
later, and the failure is invisible because nothing is missing, it is just off.

- `wasPaidFor` asked `model.startsWith("gemini")`, a list of the providers that
  bill. Adding `vertex:gemini-3.6-flash` therefore made it free: no ledger entry,
  the projection reporting "this model is local", and — because the
  `SpendLimitReached` throw sits INSIDE that test — no spend ceiling at all on a
  paid account. Now inverted to name the free case, so a new provider bills by
  default. Over-reporting a free provider is visible; under-reporting is not, and
  under-reporting has now been three separate defects in that one file.

**Write the test so the unknown case lands on the SAFE side.** Then ask which
side that is, and say why in the comment.

### Two readers disagreeing is not the same as one being better

When two passes, or a model and the code, answer the same question, the instinct
is to rank them. Measured, neither is systematically better, and every rule built
on "pass N is more reliable" scored worse than the one it replaced. See section 6
for the two that were measured and rejected.

**The rule that worked names the CONFLICT, not the reader:** prefer the earlier
reading only where the two actually disagree, and where they agree keep whichever
one can be cited. On this corpus the override fired on 5 parts when only 2 held a
real disagreement, and on one of the other three (MSP430F5529) it swapped a
shipping part for an identical answer that no page could cite.

### "The model can't read it" is usually a question it cannot answer

`leadForm` came back empty for 37 of 81 parts and was the single biggest blocker
in the corpus. The record accepts `gullwing`, `nolead`, `straight`. **The prompt
offered only the first two.** A ceramic flat pack, which is most of the rad-hard
market and has its own branch in the exporter, had no valid answer, so the model
returned null. Correctly. Every time.

It was compounded by the parser dropping explicit nulls, which stored "I looked
and it is not stated" identically to "I never answered."

**Check the question before blaming the reader.** Specifically: every field the
record constrains to a set must offer that whole set to the model. There is now a
test that reads the enums out of `types.ts` and asserts the prompt mentions every
value, so this cannot return silently.

The wider version, and the one that keeps costing days: when coverage is bad, the
cause has never once been "the model is not capable." It has been an unconsumed
answer, a discarded answer, or an unanswerable question.

### Null treated as a default instead of as a question

`throughHoleFootprint` hardcoded two rows and never read `leadSides`, so a 3-lead
TO-220 shipped as two columns 5 mm apart and counted as a SHIP. The prompt tells
the model to answer null for a one-sided package, so the state a TO-220 arrives
in is exactly the state that fell through.

**Where a field's unread state and a legitimate reading collapse to the same
value, a default becomes a silent wrong answer.**

### Vocabulary gaps and word-boundary traps

Worth more than clever geometry, and much cheaper.

- `\bLQFP\b` cannot match `LQFP64`, because a digit is a word character. Three
  separate instances in two days.
- `LGA` and `HTSSOP` were simply missing from `PACKAGE_FAMILIES`. Every MEMS
  sensor therefore named no package, so nothing declared a lead count, so a pin
  table that read perfectly had its count refused.

**Audit vocabularies before writing readers.**

---

## 3. Guards

Settled by measurement on 2026-08-16, after a session spent believing the
opposite.

**A guard should check our work, not the document's.** Three kinds:

| kind | verdict |
|---|---|
| output invariants (checking what we emit) | earn their place, cannot rot |
| refusals for genuinely absent input | necessary; the alternative is invention |
| plausibility checks arguing with the document | the expensive kind |

**Measured: no plausibility guard fires at all on the tuned corpus.** The only
thing that stops a part is the output invariant. Of 13 non-shipping tuned parts,
10 had no printed land pattern on the record at all. Nothing was being rejected;
nothing was being read.

So "our guards are costing us coverage" was a plausible story that explained the
symptoms and was false. **Explaining the symptoms is not evidence.**

Related: refusing is a safety net, not an achievement. The goal is to read more,
not to refuse more gracefully. Only refuse when the value would be wrong, and say
plainly what the refusal cost.

### The dangerous defect is the one every input passes

Two guards now exist for one shape: a footprint built from a DIFFERENT package's
data than the name says. It is the worst failure this product has, because every
input is individually valid and the result looks entirely ordinary in CAD.

- **Lead count** (2026-08-16): the designator declares a count and the pin table
  disagrees. Catches an SSOP-20 pinout labelled SSOP-28.
- **Outline code** (2026-08-17): the vendor's drawing number carries the package
  designator as its leading letters, so `DW0016A` against `SOIC (D)` is a proven
  contradiction. Catches what the first one CANNOT, which is two packages with the
  SAME lead count. MAX232 was asked for the narrow `SOIC (D)`, and since that
  datasheet prints outlines only for NS0016A and DW0016A it returned the WIDE
  drawing: a 9.3 mm land span where a narrow SOIC-16 is nearer 6 mm. Both 16 lead,
  so nothing fired.

**Both fire only where they can PROVE a disagreement.** `declaredLeadCount`
returns null where a number in a name is not a lead count (SOT-223, TO-220);
`outlineCodeDesignator` returns null for a JEDEC registration like `MS-013` or
anything not letters-then-digits. Measured over the six multi-package parts, the
outline guard fires on the one that is wrong and none of the five that are right.

**When a guard cannot fire, ask what the same defect looks like in that blind
spot.** The lead-count guard had been shipped for a day and read as covering this.

**The outline-code guard's own blind spot is measured and is NOT closed.** Only
Texas Instruments prints designator-prefixed outline codes. Of 49 parts, 24 carry
one and the guard can fire; 5 carry none but describe a single package, so there
is nothing to confuse; and **20 carry none AND describe several packages**, where
this defect could occur unseen. TSV321 is one, ships, and offers six packages;
its numbers are right (0.95 pitch and a 2.6-3.0 span are distinctively SOT-23-5)
but nothing checks that.

A vendor-neutral replacement was proposed and measured and does not work; see
section 6. **State this as a residual risk rather than papering over it:** the
guard proves what it can prove, and for the other 20 the protection is that the
chosen package goes into the model's prompt, which is a mitigation and not a
check.

### Guard the output, not each input

A pin table with a gap had three ways in: the model, a posted record at
`/api/export`, and the UI edit box. Input guards mean one fix per door and a new
door with every feature. The output has one door.

---

## 4. Traps in this environment

Each of these has cost real time, more than once.

- **`pkill -f "next start"` DOES NOT STOP THE SERVER.** It kills the npm wrapper
  and leaves `next-server` on port 3000, so the OLD build keeps answering and you
  draw a conclusion from a route you did not rebuild. Has caused two wrong
  conclusions. Use `lsof -ti:3000 | xargs kill -9`.
- **`npx tsc` misbehaves after a cwd reset.** Use `./node_modules/.bin/tsc`.
- **The model key needs sourcing and `NODE_OPTIONS` will not do it.**
  `set -a && . ./.env.local && set +a && npm run bench:extraction -- --model`
- **`npx eslint` is broken on this machine** (`@rushstack/eslint-patch` against
  ESLint 9.39). Pre-existing, reproduces on untouched files. Do not chase it.
- **The Altium cross-check needs the .NET oracle built** (`npm run oracle:build`).
  The SDK is at `~/.dotnet` and is NOT on `PATH`. Tests FAIL rather than skip when
  an oracle is missing, on purpose.
- **`parse-limits.test.ts` "a compressed text bomb is refused by the character
  limit" is load-sensitive**, not a real failure. It races a 30s wall-clock budget
  and reports `kind: "time"` instead of `"text"` on a busy machine. Check `uptime`
  before believing it.
- **Do not edit the working tree while `bench:mutation` runs.** A file changed
  mid-run poisons every mutation after it. This is written down and it happened
  anyway: it left a corrupted IPC-7351B constant in the tree and three unrelated
  tests failing, which I began explaining as my own bug.

**The habit that actually caught it was `git status`, not the test failures.**
When tests fail unexpectedly, check that the tree is what you think it is before
explaining why your code is wrong.

- **The shell cwd resets between calls.** A bare `npm run ...` executes outside
  the repo and fails with "list of scripts", which looks like a broken script and
  is not. `cd` in every command that needs the repo.

### Check the instrument before you believe the result

Five times in one session the MEASUREMENT was wrong, not the thing measured:

- a dead-code scan that counted mentions inside comments, hiding real dead code
- guard regexes reporting 0 hits, until a flag was added to dump raw refusals
- `npm test | tail -8`, which threw away the name of the one failing test and
  very nearly got a green reported
- two `npm run` invocations that ran outside the repo after a cwd reset
- a trailing `grep -c` exiting 1 on zero matches, reporting a clean run as failed

**A surprising result in EITHER direction is a reason to check the instrument
first.** A suspiciously clean output is the more dangerous half, because nothing
prompts you to look. Before believing a measurement, confirm it could have
detected the thing it says is absent.

---

## 5. Spending the user's money

- **Quote the CUMULATIVE total, never the last run's figure.** A per-run number
  reads as "what this costs you". Six or seven runs were once reported as one,
  under-reporting by 3x, and the user found it rather than me.
- **Measure who is affected before proposing to spend.** A proposal to re-run all
  38 hold-out parts after fixing one bug turned out, when measured for free, to be
  about $1.15 to possibly move 3 parts.
- **Re-measure the hold-out once after a batch of changes worth measuring**, not
  once per fix.
- Free-tier rate limit is 20 per rolling minute. **Retrying a 429 consumes the
  quota you are waiting for.** Requests are paced before sending.

---

## 6. Measured and settled: do not retry without new evidence

Re-deriving these costs a day each.

- **Extending the table/figure agreement rule to the uncorroborated branch:**
  0 parts, reverted.
- **Letting a claimed table outrank a front-matter-only declared count:** 0 parts,
  reverted. The case it targeted was genuine ambiguity the chooser handles.
- **Geometric number-first pin reading with no header required:** 0 parts and it
  BROKE 2. Caught only by the hand-read oracle.
- **Bounded clustering and extent-overlap clustering:** 0.
- **Caption harvesting for the package chooser:** dead end.
- **The local model on the production prompt:** qwen2.5vl:7b returns nothing when
  asked 23 fields over the whole document, and reads a pin table 8/8 when asked
  only that over one page. The blocker is context size, not field count.
- **Holding pass 1 for EVERY field whose page was not rendered:** pin names
  18/21 to 20/21 and package family 13/14 to 14/14, but fields-complete 53% to
  **39%**. It sounds more principled than the rule that shipped and is much
  worse: pass 1 answers dimensions off front-page prose and pass 2 answers them
  off the drawing, so it re-broke RHF1201's `leadForm` to `gullwing` and took
  REF5025's page-1 6.9mm over the drawing's 7.035mm.
- **Always keeping pass 1's pins:** dominated by both alternatives, 18/20 and
  49%. It discards the case where the rendered figure CORRECTS the table
  (RHF310A, `-VCC` to `VCC-`).
- **Requiring the page a dimension came from to NAME the package it describes:**
  17 of 24 agree, and the 7 that do not are mostly RIGHT. Four of them
  (UCC27524, DRV8825, SN65HVD230, ISO7741) read body size off PAGE 1, the
  front-page package table, and get it correct: UCC27524's 4.905 mm is exactly
  SOIC-8. The guard would refuse seven correct parts to catch nothing. Proposed
  as a vendor-neutral replacement for the outline-code guard and measured before
  being written, which is the only reason it cost minutes.

Two of these actively corrupted parts and were caught by the pinout oracle alone,
never by the test suite or any bench figure.

**A table of contents is geometrically identical to a number-first pin table:**
numbers 1..N in a column, names to the right, nothing to the left. Any shape-only
rule will read a contents page and report pin 1 as `Features`.

---

## 7. Working with Anthony

- **Act like a technical cofounder.** Direct. Push back when something contradicts
  the positioning or the air-gap constraint. Verify empirically rather than
  asserting from memory.
- **No em dashes anywhere**, prose or code or comments. Commas, colons, periods.
- **Work directly in the repo.** No patches.
- **Commit straight to main, no feature branches.** Do not commit without explicit
  permission each time. Do not push unless asked.
- **Simpler language.** Shorter sentences, fewer clauses.
- **Ask a process question once, not every turn.**

---

## 8. Keeping this file honest

The failure this file is most likely to suffer is the one already documented in
`types.ts`: **a comment describing a fix in the past tense, standing in for
behaviour that was never wired up.** Nothing measured it, so the comment was
believed for months.

So:

- An entry that names a file, function, or flag is a claim. **Verify it still
  exists before acting on it.**
- When an entry is disproved, delete it rather than softening it. The parser-first
  strategy that governed weeks of work is gone from this file because the parser
  was switched off on 2026-08-12 and measurement showed it was subtracting.
- Add an entry when something costs a second time, not the first time.

---

## 9. What a line-by-line audit found that nothing else could, 2026-08-18

Every line of all 22,580 production lines was read by hand. 69 findings. The
value is not the count, it is the SHAPE of what only reading catches, so this
records the shapes rather than the list (which is in `AUDIT-FINDINGS.md`).

**The instrument had the defect it was built to find, three times.** The guard
bench and the replay bench each read `dimensions.landSpanMm` into
`landSpanCrossMm`, so every part they built was a square quad by construction and
neither could ever see a rectangular one. The extraction bench scored
`bodyLengthMm, bodyWidthMm, pitchMm` as "geometry", which stopped being the
fields that place copper on 2026-08-12; the same lesson was written above
`untraceableDimensions` in types.ts and did not reach the bench measuring it.
**Audit the instrument in the same pass as the product, not after it.**

**Two tests asserted the defect.** `leadSides 1 must be rejected` pinned the
unanswerable question; two route tests pinned `method` starting with
`deterministic`, a label naming a reader deleted four days earlier. A test that
pins a LABEL rather than a PROPERTY converts a fix into a failure and defends the
bug. When a test fails after a fix, read what it asserts before assuming the fix
is wrong.

**A guard defeated by the line below it.** `neutralizeUntrustedText` inserted
U+200B to break `<<<`, and the next replacement stripped the class containing
U+200B. `<<<` came out unchanged for the whole life of the function while its
comment said otherwise. **Order is behaviour.** Running the four replacements by
hand took ten seconds and no test had ever done it.

**A refusal that could not tell "no" from "cannot tell".** The `drawnPackages`
guard compared a package named by family and lead count against a drawing named
by a vendor outline code, found nothing in common, and refused the part. A
refusal has to be a PROOF of disagreement; where two labels share no comparable
feature the honest verdict is undecidable, and the guard must stay quiet.

**The one function, bypassed by the caller that mattered.** `asPackage` is the
only place the relabelling rule lives, and the UI never reached it: it wrote the
chosen designator into the record and posted that, so the rule ran in the chooser
that computes the button's label and never on the export the button leads to. A
shared function is only shared if every path actually calls it. **Ask which
caller does NOT go through it.**

**The 3D body did not close.** Two of six faces named a vertical edge belonging
to the opposite side. Invisible in the text, immediate to any CAD tool. Found by
walking the loops on paper. The fix derives edge orientation by walking rather
than tabulating it, so a loop that does not close now throws.

**"Every dimension" was fifteen of twenty-five.** The record panel's own
disclosure said "every dimension"; the exposed pad showed one number for a
two-number field, and the cross-axis span was invisible. A list that has to be
maintained beside a record falls behind the record. Prefer enumerating the
object.

### The cheapest check in this project

`bench:replay` is free, runs the real generator over 113 real model answers, and
answered "does asking for the cross span cost any parts" in ninety seconds: five
parts gained the question and all five were already asking three others, so no
shipping part was lost. **Measure a trade before defending it.**

## 10. Measuring, and getting the measurement wrong first, 2026-08-18

Four lessons from the session that moved the bottleneck. Every one of them cost
real time, and three of them nearly produced a fix to a defect that did not
exist.

**A new instrument is wrong until it is validated against a case you already
understand.** `bench:copper` measures the emitted pads back out and compares them
with the record. Its first run reported **454 findings**. Every one was the bench:
it grouped lands by the wrong axis, so for an SOIC-8 it treated one land from
each row as a "row" and reported the SPAN as a failed pitch check. Fixed, it
reported 15. Of those, 14 were the bench comparing against a printed land the
generator had deliberately DISCARDED in favour of IPC. Fixed, it reported 1. That
last one was the bench rounding coordinates to a hundredth and then reporting its
own rounding as a 0.005 mm defect in the product. The true count was **zero**.

Nothing in the product was wrong. Had I reported the first number, the day would
have gone into "fixing" correct copper. **Before believing an instrument, run it
on something whose answer you already know.**

**A cache holds answers to questions you no longer ask.** Counting how often the
model answered a field, over every entry in `.model-cache`, said the model read a
printed land pattern for **39 of 57** hold-out parts while only 16 reached the
record. That looks exactly like a merge throwing half of everything away, and I
was three minutes from hunting it. The cache holds up to sixteen entries per
part, going back to older prompts. Restricted to the entries the CURRENT prompt
actually hits, the model answered 19 and the record kept 16, which is nearly all
of them. **Filter a cache measurement to the entries the current run would hit,
or you are measuring history.**

**"The model cannot read it" has still never once been the cause.** Half the
hold-out corpus returned NOT ONE dimension from either pass. The model said why
in its own notes, in the same words each time: the part number does not specify a
package designator. The pinout was asked per package and everything else was
asked once, so on a family datasheet the question had no answer and declining was
correct. The same session, the dimension oracle marked a body height WRONG; the
drawing prints the ceramic thickness with a dimension line and the seated height
in the title block, and the model returned the one the FIELD GUIDE asked for.
**Two for two, again. Read the question before doubting the answer.**

**A recorded value that nothing compares against is a comment.**
`DIMENSION_ORACLE` has carried `bodyLengthMm`, `bodyWidthMm` and
`bodyHeightMaxMm` since it was created, hand-read off rendered drawings, and
`bench:dimensions` never looked at any of them. Wiring the three in took ten
minutes and immediately found the wrong body height above. **When you add a field
to a fixture, add the assertion in the same edit, or it is documentation.**

### What actually moved the product

Not the reader. Two orderings and one question:

- `/api/export` ran the traceability gate BEFORE the function that supplies the
  pinout, so a family datasheet was refused one step early. The chooser had done
  it in the right order for two days, so the two halves disagreed about the same
  click.
- `shipOutcome` in the hold-out bench had the identical defect, which is why
  nobody saw the first one. **A bench that stops before the product does measures
  a product that does not exist.**
- The dimensions were asked for once, for a document that describes several
  packages. Asked per package, six tuned family datasheets went from 0 shipping
  to 4 shipping on one click.

### Asking for a value and then refusing to use it

`withSupplied` filled BLANKS only, for a good reason written above it: a user
must not silently redefine a value the document states. The quad corner check can
PROVE a read span wrong, and when it did, the product asked the user for the
span, with the drawing's page beside it, and then kept the wrong value because it
was not blank. Same refusal, twice. **Whenever you add a question, follow the
answer all the way to the thing it is supposed to change.**

---

## 11. The prompt is a shared vocabulary, 2026-08-19

### Diffing the model cache by prompt fingerprint is a free A/B test

Every cache entry records the `promptFingerprint` it was stored under, so two
prompt variants that have both been paid for can be compared **offline, for
nothing**, per part and per field:

```bash
# group .model-cache/*.json by entry.prompt, then diff the results per label
```

This is how a 20-part SHIPS regression was diagnosed in twenty minutes without
spending anything. Do this BEFORE forming a theory about why a run moved.

The same trick settles which of two trees is better: `git stash` the working
changes, replay `bench:holdout --model --offline`, and compare. Both prompts were
already on disk, so the answer cost nothing.

### The per-package channel is load-bearing for SHIPS. Do not discourage it.

An instruction was added to recover flat pinouts on family datasheets:

> Only where the packages genuinely have DIFFERENT pin assignments does the
> pinout belong per package.

It worked on pins, and the model read it as permission to stop enumerating
packages at all. `packagesInThisDocument` collapsed: TLV9002 30 entries to 3,
OPA192 14 to 4, TSZ121 21 to 7, M24C02 16 to 6. That list is where per-package
DIMENSIONS live, which is what took SHIPS from 26% to 57% the day before.

    READ 91% -> 87%      SHIPS 63% -> 26%

Ten parts gained a pinout and twenty lost a footprint. **Before adding a sentence
to the prompt, ask which other answer it competes with.**

### The two passes were using different names for the same package

`packagesInThisDocument` is filled by BOTH passes and joined on the designator.
Nothing told either pass what to CALL a package, so each used the vocabulary of
whatever part of the document it was reading, and the join found nothing:

    pins  "HTSSOP (20)"     dims  "HTSSOP (PWP)"
    pins  "D (OPA1612)"     dims  "SOIC (D)"
    pins  "RGT (VQFN, 16)"  dims  "VQFN (16)"

Twelve of fifty-four hold-out parts. The chooser then told the user "this
datasheet's drawings were read, but no pin table was found" with the pin table in
the row above. Same shape as everything in section 2: **we had it and threw it
away.**

Fixed at the source, not in the join. A looser join is guesswork about which
parenthesised token is a package code and which is a device; the document already
supplies one vocabulary, the ordering table's, and both passes are now given it.

A pin table's caption also names several packages at once (`D, N, NS, J, DB, or
PW Package`), and that was arriving as one entry naming no package anything could
look up. The caption is the document ASSERTING a shared pin assignment, so it
becomes one entry per package it covers.

### A guard that is skipped exactly where it is most needed

The glued designator form (`SO48`, `SOT23`) is marked by nothing but adjacency,
so it demands a plausible lead count. For an OUTLINE-NUMBERED family (`TO`,
`SOT`, `SC`, `DO`, `SOD`, `DPAK`) the number is a name rather than a count, so
`count` is null and the minimum silently never applies. The weakest form in the
module ran with no check at all, on precisely the families whose number cannot be
checked against anything.

An accelerometer's register map prints DO0 through DO15 and every one became a
package the chooser offered the user: sixteen options, fifteen fiction.

The rule that fixes it without losing `SOT23` (two tuned parts have no hyphenated
twin): an outline number identifies ONE package, so a document that glues several
different numbers to the same outline-numbered family is enumerating something
else, and none of them is a designator. Measured blast radius on the tuned
corpus: **0 designators lost, 0 gained.**

### Once the prompt changes, there is no free measurement left

Obvious in hindsight and it cost a wasted analysis anyway. After editing the
prompt, an offline replay does not measure the new tree: every call misses,
`runExtraction` throws `ModelCacheMiss`, the bench swallows it, and every part
falls back to the DETERMINISTIC record. The output looks like a real run and
reports zero of everything.

It nearly produced a reported finding of "0 parts carry an uncited dimension",
which is true of a record no model ever touched. **Change the prompt last.** Do
every free measurement first, then edit, then pay.

### No-lead land patterns are refused on purpose, and this is what would close it

`leadFromDrawing` returns null for `leadForm === "nolead"`, so every QFN, DFN,
SON, LGA and LFCSP goes to the questions. That is not a bug: `ipc7351.ts` has
gull-wing fillet goals only, IPC-7351B publishes them per lead form, and the rule
that used to serve no-lead was reverse-engineered from four vendor drawings.

Four hold-out parts blocked on it have every other input already read: AD7124-8
and AD5679R carry body, pitch, lead width, lead contact, BOTH spans, sides, form
and thermal pad, and are refused for want of three published constants.

Do NOT make it a setting. RULES.md 5 names that exact move as a failure ("a
setting offered because the right answer was not looked up"), and the goals do
not differ between users. The one thing that closes this class is the IPC-7351B
no-lead fillet goal table, entered from the standard with the source recorded,
the same way the gull-wing one was.

### `bench:mutation` edits source files in place. Never run it alongside anything.

It writes a mutation into a real source file, runs the suite, and writes the
original back. Two consequences that are not obvious from the name:

- **Killing it leaves the mutation in your tree.** Stopped mid-cycle on
  2026-08-19, it left `FILLET_GOALS.B.side` at 0.35 instead of 0.03 in
  `ipc7351.ts`. That is a live wrong-copper defect sitting in the working tree,
  and `git status` is the only thing that shows it. **After any interrupted
  mutation run, `git diff` the source tree before trusting anything.**
- **Anything else running at the same time can read the mutated file.** A bench
  that started earlier is safe, because the module was already loaded, but
  nothing guarantees that for a process that starts mid-run.

Run it alone, let it finish, and check `git status` afterwards.

### The worst thing found today: a dense pinout figure read 15% wrong, and shipped

STM32H743ZI's LQFP144 figure prints VSS at pin 51 and VDD at 52. The model
emitted ONE pin there instead of two, ran one behind for twenty-one pins, and
re-synchronised at 73 by giving pin 72 a name that belongs to its neighbour.
Verified by rendering page 57 and reading it by hand.

**Every automated check passes.** The table numbers 1..144 with no gaps, the
count agrees with `pinCount`, the cited page is real, the pads come out exactly
as `validateGeometry` expects, and the part exports a complete bundle. Even
comparing the names against the page's own text cannot catch it: a dropped row
plus renumbering MOVES a name rather than losing it, so the multiset is
unchanged. Only the hand-read oracle saw it.

The same reader got STM32F407VG's 100-pin figure exactly right, and MSP430F5529's
80. So this is not "the model cannot read figures". It is that a dense
four-sided figure is read correctly most of the time and silently wrongly some of
the time, and the product cannot tell the two apart.

Two changes reached it, and BOTH were in the same paid run, which is the mistake
this file already warns about: a focused pinout pass, and a sentence in
`imageGuidance` about multi-column pin tables. Bisecting them offline afterwards
showed the SENTENCE was doing the work: reverting the pass alone left the wrong
netlist in place.

Both are reverted. The measured cost of reverting, on the tuned corpus:

    fields   55% -> 45%      SHIPS   23% -> 19%      wrong netlists  1 -> 0

That trade is not close. A wrong netlist is worse than a refusal by a wide
margin, and it is the one failure a customer cannot catch either.

**What would make it safe**, and it is a check the document supplies rather than
a heuristic: these datasheets state their pinout TWICE, as a figure and as a
pin-definition table. `combine` already prefers pass 1 when the two passes
disagree about pins; what is missing is that pass 1 produces NO pin table on
exactly these documents, because its own reading is truncated and correctly
refused for having gaps. Getting a second, independent statement of the pinout on
these parts is the thing to build before the coverage is taken again.

### Where 2026-08-19 ended, and what is actually left

Shipping state, measured on the hold-out with a warm cache:

    READ   49/54  (91%)     unchanged across the whole session
    SHIPS  33/54  (61%)     63% at the start; the one part is a re-roll, below

Kept: the enumeration filter in `packagevariants.ts` (fifteen fictional `DO*`
packages removed from one chooser, `SC1`/`SC2` from another, zero blast radius on
the tuned corpus). Reverted: everything else that was tried.

**A candidate-list change re-rolls the model's whole answer.** ADA4522-2 shipped
before and needs six numbers after, and the filter did not cause that: removing
`SC1` and `SC2` changed `packageCandidates`, which changed the prompt, which
changed every dimension the model read. Any change touching `findPackageVariants`
moves parts that have nothing to do with it, so a one-part delta after such a
change is noise until a second sample says otherwise.

The remaining 21 non-shipping parts, by cause:

- **4  no-lead land pattern.** Everything else is read. Blocked on three
  published constants, see above. The single biggest class.
- **3  a per-package pinout the chooser cannot match** to the designator the
  ordering table uses. The join, not the reading.
- **3  the datasheet prints no footprint** and the package is not gull-wing.
- **2  `vacantLeadSlot`**, which the model declines on both parts.
- **2  through-hole and uncitable-dimension singletons.**
- **7  read but short of one or two body numbers.**

And 5 parts do not read at all. Two known non-defects live in the tuned corpus
and are worth remembering before anyone counts them as failures:

- **VA41630 is not a datasheet.** Retrieval fetched a four-page marketing web
  page: a product photo, a block diagram, an ordering table, a newsletter footer.
  It links to the real document. Nothing in Layer 2 can fix a Layer 1 miss.
- **DF13-4P-1.25DSA is a connector**, and a connector's terminals are NUMBERED,
  not named. Page 4 prints everything else: 1.25 pitch, 4 contacts, board hole
  0.6, square post 0.35. `normalizeModelPins` refuses a row with no name, which is
  right for an IC and wrong for this whole category.

### The no-lead table was not the blocker, 2026-08-19

Anthony asked me to look the standard up online. I found it: IPC-7351B table 3-15
(Flat No Lead with toe fillet) and table 3-18 (pull back), transcribed with their
table numbers in KiCad's footprint generator `ipc_7351b.yaml` (MIT). That source
is trustworthy: its gull-wing block is digit for digit identical to the one in
`ipc7351.ts`, entered here independently and months earlier.

The equations are the same as gull-wing. KiCad's no-lead calculator and its
gull-wing calculator are line for line identical, so there is no separate
derivation to get wrong.

Implemented it, then checked against two vendors' printed patterns, hand-read:

                       printed           table 3-15         table 3-18
    TI RGT0016C   0.600 x 0.240 @2.200  0.905x0.232@2.803  0.605x0.312@2.503
    ADI CC-14-1   1.145 x 0.550 @2.195  1.169x0.476@2.487  0.869x0.556@2.187

**No single table reproduces both.** TI's pad length matches 3-18, ADI's matches
3-15. ADI's width and centre span match 3-18, TI's match neither. Under 3-15 the
centre span is 0.3 to 0.6 mm too far out on both.

Reverted. Picking the table that fits one vendor is exactly what got the previous
no-lead rule retired on 2026-08-13.

**The lesson is about the diagnosis, not the numbers.** "We are blocked on three
published constants" was wrong, and it was stated confidently in a handoff. The
constants were an hour's work to find and they did not unblock anything. What is
actually missing is a way to know WHICH no-lead construction a package is, and
the datasheet drawing may not say.

Next thing to try, and it is not another table: run these two packages through
Altium's IPC Compliant Footprint Wizard and compare. That wizard is the tool this
whole computed path replaces, so matching it is the definition of correct, and it
would settle the table question with one data point per package.

## The designator join: five separate defects wearing one costume

Written 2026-08-19, after the join matcher was implemented, verified safe, and
then moved the number by one part instead of the ten it was built for.

The two extraction passes name the same package differently, and joining their
halves is worth about 15% of SHIPS. The matcher itself was correct on the first
try. What kept it from firing was five smaller things underneath it, and every
one was invisible until the merged records were dumped and read:

1. **Rows are not leads.** A pin table carries a row for the exposed pad and a
   drawing counts only leads, so the "proof" contradicted itself by exactly one
   and refused. Both LM5117 packages died here.
2. **The brackets do not always hold the code.** `SOIC (D)` puts the code
   inside; `D (OPA1612)` puts a DEVICE there. Reading brackets unconditionally
   compared `OPA1612` against `D` and invented a contradiction.
3. **`DW0016A` and `DW` are the same package.** Pass 2 reads the code off the
   drawing's title block, where it is a full outline number.
4. **`SOIC_W` is not a SOIC** to any reader matching on a word boundary, because
   `_` is a word character. This is the third time this exact trap has been hit
   in this repo.
5. **A joined entry has to be filed under a name the CONSUMER uses**, and the
   consumer speaks a third vocabulary: the ordering table's. Picking the pinout
   section's name loses OPA1612; picking the drawing's loses OPA192. Both names
   are known, so the entry now carries both (`alsoKnownAs`).

**The lesson is about the diagnosis, not the fixes.** "The join does not fire"
was one symptom with five causes, and no amount of reasoning about the matcher
found any of them. Dumping both passes' raw entries beside the merged result for
all 54 parts, free and offline, found all five in one pass. When something
correct is not working, print what it is actually being given.

## Two guards that were protecting the wrong half

The multi-package caption (`16-lead PDIP/SOIC_N/TSSOP/SOIC_W`) must not lend its
BODY SIZE to any one package, and that refusal is right: four packages, four
bodies. Refusing its PINS as well threw away a pinout the document states
plainly, and left every one of those packages reported as "no pin table found"
with the pin table one row above. Five hold-out documents publish their pinout
this way and no other.

The same shape appeared in the sibling-device check. A caption naming a device
other than the requested one is not this part's pinout, and until this was fixed
an ADM1385's netlist sat inside an ADM3202's footprint: correct pads, wrong
connections, invisible to every automated check. That one was found by reading
the merged entries by hand, not by any test.

**Ask what a guard is protecting, then check it is refusing only that.**

## SHIPS now means "with the customer's settings and their answers"

Changed 2026-08-19, on Anthony's instruction: **always account for user answers
and user settings when calculating the ships percentage.**

The old number counted a part as a failure when its only remaining blocker was a
question the product knows how to ask. That measures a product that refuses
where this one asks, and the whole input model says a number no datasheet
carries is ASKED rather than invented. So `bench:holdout` now reports the
answered figure as the headline, with the zero-question figure beside it.

It is not a free pass. A part counts only when every remaining blocker is a
question the product asks AND the export really completes once the answers
arrive, which the bench checks by supplying them and running the real export.
Anything that answers every question and still refuses is printed BY NAME under
"ANSWERED AND STILL REFUSED" and never folded into the total.

**That line is the most valuable thing the change produced.** On its first run it
named three parts, and all three were defects rather than hard datasheets:

- `askForLandPattern` never asked for `pitchMm`, while the refusal it threw said
  "that comes from the pitch and how many sides carry leads. Answer what is
  missing". The pitch was on no list, so there was nothing to answer and no
  input could ever unblock the part.
- The questions arrive in ROUNDS. Supplying the land pattern reveals that the
  arrangement is missing. A bench that asks once measures a product that gives
  up when the user answers, so it now answers until nothing new is asked, and
  reports the round count as friction.

## Three more guards standing one step away from what they are about

The pattern from the run-8 note keeps paying. All three found the same way: by
listing every part that did not ship and asking, for each, what exactly stopped
it.

- **`classify` in the hold-out bench** treated "a pinout per package" as a
  reading only when the record ALSO had no pin count. TCA9548A, LD39050 and
  ADG1211 each carry two or three located per-package tables and a count, so
  they were filed as unread and never offered to the chooser at all. READ 91% to
  96% for a one-line change, and it was the bench that was wrong, not the
  product.
- **`pinTableFor` compared names as strings.** `VQFN (RGT)` and
  `RGT (VQFN, 16)` state the same two facts in the opposite order, and no
  punctuation-stripping makes one contain the other. It now falls back to
  comparing what the names SAY - family and code, both known, both agreeing -
  which is the same proof the two-pass join uses.
- **The chooser offered only the ordering table's names.** LD39050 draws a 3x3mm
  and a 2x2mm DFN6 and its ordering table calls both `DFN6`, so the lookup had
  two right answers, refused, and told the user none of the document's pinouts
  matched DFN6 with both of them on the record. A variant naming several located
  tables is now replaced by those tables, and the user picks.

## The model cites the page the DOCUMENT prints, not the page the file counts

Found 2026-08-19 by asking, for the one part that had read everything and
shipped nothing, which check refused it.

AD9833 read seven dimensions off its package drawing - body height, pitch, lead
width, lead span, lead contact, lead form, mounting - every value correct, and
every one thrown away as untraceable. The model cited page 24. The drawing is on
file page 27. **Page 27 of that PDF prints "Page 24 of 24" in its footer.** The
document has a cover, a revision history and a contents page, so the two
numberings are three apart, and the model is looking at an IMAGE whose only page
number is the printed one.

Nothing in the prompt ever told it which numbering we check against, so quoting
the footer is the correct reading of what it can see. The bug was ours.

`pageBearingPrintedNumber` now resolves a claim against the page the document
labels with that number, and then runs the SAME two checks - the value must be
quoted in that page's text, or the page must be one we rendered and sent. It
resolves a page; it never accepts a value. Only the explicit `Page N of M`
footer counts, and only when exactly one page prints that N.

**Every vendor with front matter is affected**, which is most of Analog Devices
and much of ST. This was worth one part today and is worth a citation on every
drawing-read value in the corpus.

The lesson is the diagnostic, again: the refusal said "uncitable", which sounds
like the document's fault, and the actual cause was an off-by-three in whose
page numbering we believed.

## Measure frequency before arguing from severity

2026-08-19. I proposed building a figure-versus-table cross-check to close the
multi-column pin table class (one row per terminal, several pin-number columns,
one per package; read the wrong column and you get a complete, gap-free,
correctly-numbered pin table for the WRONG package). The argument was that a
wrong netlist under correct pads is worse than a refusal, which is true.

Anthony asked what the point was. Measured across every page a pinout was
actually read from, all 52 hold-out documents:

    parts whose pinout was read from a page   52
    pages carrying the multi-column shape      3
    of those, real instances                   0

All three were false positives: two ordinary two-sided pinout figures and one
internal schematic full of transistor labels.

The class is real - it produced two wrong pin names on STM32F407VG - but it
lives in large multi-package MCUs, and every one of those is in the TUNED
corpus, which is exactly where the hand-read pin-name oracle runs. The one place
the defect occurs is the one place a check already exists.

**Severity is a reason to care, not a reason to build.** Building would have
meant more prompt text - the thing that has lost population four times out of
four - to guard something that appears in no document we would measure it on.

Recorded as known, unguarded and currently unobserved. Revisit if a hold-out
part with a large multi-package pin table appears, or if the oracle flags a
second instance.

## Pass 2 could see the pinout and had nowhere to put it

2026-08-19, and the most valuable finding of the day because it was invisible
from every angle except reading the prompt.

TS922 and TSZ121 came back with every package named, every package drawing
measured, and NO pin table for any of them. The model's own note said the part
number does not pin down a package. That reads like a model limitation. It was
not.

Rendering both pinout pages and reading them by eye: they are perfectly legible.
Six labelled figures on TSZ121, full words on TS922 ("Output 1", "Inverting
input 1"). The text layer carries only the package captions, so a render is the
only path - and we DID render them. Page 2 was in `renderedPages` for both.

The two response shapes we hand the model:

    pass 1 (text only)     "packagesInThisDocument": [{"packageType", "pins"}]
    pass 2 (with images)   "packagesInThisDocument": [{"packageType", "dimensions"}]

**Pass 1 is asked for the per-package pinout and cannot see it. Pass 2 can see
it and has no key to put it in.** The model answered exactly what was asked.

This is NOT the class the four failed prompt experiments belong to. Those were
rewordings of pass 1's guidance about how to DECIDE. This was a field missing
from an output shape.

Verified on two blind ST op-amps fetched the same day, same vendor and document
style: TSV991 and TSU101 now read their drawn pinouts per package, cited to
page 2. TS922 too. Cost $0.89, and only 29 of 117 requests changed key, because
the edited block only appears when a part has images AND no settled package.

### And the citation path behind it was text-only

Once TS922 read, its pin table was stored UNCITED and refused. The flat `pins`
field has had a render-citation path since 2026-08-06, for exactly the reason
recorded there: a pinout drawn as a figure has no text to quote. Per-package
tables never got one, and they are now the main way a multi-package document
states its pinout. `citeSoleRenderedPinoutPage` closes it, and PROVES the page
rather than accepting a claim: of the pages actually sent, exactly one must
identify itself as a pinout page.

**Two fixes, one shape: the value was read correctly and the pipeline had no
place to keep it.**

## Both remaining failures were the BENCH, not the product

2026-08-20. Two parts were left after the paid run, reported as "answered and
still refused" and "read nothing at all". Neither was a product defect.

**MSP430FR2433 was the bench inventing a bad number.** `answerFor` derived its
stand-in answers from `record.dimensions`, which on a multi-package record is
entirely null - correctly, because there is no such thing as "the body size" of a
part sold in seven packages. The real measurements live in
`packagesInThisDocument`. So every stand-in fell back to its constant, and a 3 mm
span invented for a 4 mm VQFN puts the pads inside the body. Answered with the
package's OWN numbers, it ships. Fixed by passing the option's designator into
`answerFor` and reading that package's dimensions.

This one stings: the `ANSWERED AND STILL REFUSED` line was added the same day and
described as the most valuable thing the measurement produced. It was also
generating false positives, and the first three it reported were real while the
fourth was its own arithmetic. **A check that finds real defects can still be
wrong; keep verifying it after it earns your trust.**

**AD8495 was a retrieval failure wearing an extraction failure's clothes.** The
fetched PDF is a three-page Soldered Electronics breakout-board product page:
2,318 characters, no pinout, no mechanical section, a shipping weight and an
order code. The model correctly refused all 36 fields including the manufacturer.
Counting that as "we could not read the datasheet" is wrong in both directions -
it makes extraction look worse than it is and hides a retrieval failure a user
would hit just as hard. `classify` now names it, on SIZE rather than content: a
component datasheet is not three pages and two thousand characters.

Audited the whole corpus for the same thing; AD8495 is the only one.

**Final: READ 58/59, SHIPS 58/59. Every part whose datasheet we actually
fetched ships.**

## A failed drawing pass is a failed parse, not a thinner one

2026-08-20, Anthony's call, and the reasoning is worth keeping because it
overturned what I proposed.

`runExtraction` swallowed every second-pass failure with a bare `catch {}` and
fell through to pass 1. That looks harmless and is not: pass 2 exists BECAUSE
pass 1 reads dimensions off the text layer and is measurably wrong there.
REF5025's page-1 prose says 6.9mm where its drawing says 7.035mm; RHF1201's front
page implies `gullwing` where its drawing on page 33 shows `straight`. A lead
form read wrong does not shift copper by a fraction of a millimetre - it changes
the whole land pattern and the board does not solder.

I proposed marking such values as text-read so the user could see it. **Anthony
rejected that, correctly: a caveat on the deliverable makes the user verify
everything, which is the entire job they came here to avoid.** It spends trust
and buys nothing.

So the product is binary. Either files nobody has to second-guess, or "we could
not read it, try again". Three changes:

1. **`askTwice`** - one further attempt at the pass level. `callWithRetry`
   already retries three times inside a call and it is not enough: ADM3202 failed
   on four separate runs, roughly a dozen provider attempts, then succeeded on
   the fifth with no code change. Exactly one extra, because this pass carries a
   megabyte of images and a loop would multiply the worst case.
2. **`SecondPassFailedError`** - both routes answer 503 with `Retry-After` and a
   `MODEL_UNAVAILABLE` code, and no half-built record. The UI keeps the file and
   offers "Try again".
3. **Logging** - a warn on the retry, an error on the second failure. Until now
   a second-pass failure produced no note, no error and no log line anywhere, so
   nobody could say whether this happens once a week or once a day. Today's
   evidence: 5 of 42 live calls failed, and the image-carrying pass fails about
   three times as often as the text-only one.

**A RENDER failure is deliberately NOT this.** A host with no working renderer
produces the first-pass answer, which is a supported deployment. One `catch` had
been treating a missing rasteriser and a dead model as the same event, and the
difference is exactly whether the user should press the button again.

## A lead count is not an identity

2026-08-20, and it is the same lesson as the `SOIC (D)` / `SOIC (DW)` one, found
from the other end.

`sameDesignator` accepted agreement on ANY of code, family or lead count. Two of
those name a package; the third is shared by every 8-pin part ever made. The
weak clause never fired while two pin tables were refused outright, so it sat
there looking correct for a day. The moment that refusal was relaxed - because
pass 2 started returning pinouts too - it chained four of OP27's packages into
one entry:

    8-Lead TO-99  aka  ["8-Lead PDIP", "8-Lead CERDIP", "8-Lead SOIC"]

A metal can, a ceramic through-hole body and a 3.9mm surface-mount one, merged
on "all three have 8 leads". `8-Lead CERDIP` is what let it start: its family
reads as NULL, because `\bDIP\b` does not match inside "CERDIP" - the
word-boundary trap for the fourth time in this repo - so the count was the only
thing left to compare, and it agreed.

The count may now CORROBORATE or CONTRADICT and can never be the whole case.

**Two things worth keeping.** A guard that has never fired is not a guard that
works; it is an untested branch, and relaxing something upstream is exactly when
it gets its first real input. And when a fix costs one part, chase that part:
OP27 going quiet-to-asking was the only visible symptom of a merge that was
putting a TO-99's identity on a SOIC.

## The pin-name oracle, run at last: 15/18, and nothing structural

2026-08-20. The pinout path was rewritten across two days - pass 2 given a
`pins` slot, shared captions distributed, the sibling-device rule, render
citations - and none of it had been checked against a hand read. This is that
check.

    PIN NAMES       15/18 parts match       (38 parts have an entry)
    PACKAGE FAMILY  13/13 designators
    RHF1201       pin 7   got "D11"       want "D11(MSB)"
    RHF1201       pin 18  got "D0"        want "D0(LSB)"
    TPS7A4501-SP  pin 9   got "ADJ"       want "SENSE/ADJ"
    ADS8688       pin 20  got "AIN_2GND"  want "AIN2_GND"

**The thing to notice is what is NOT there.** No pin is in the wrong position,
no package's names landed on another package, no table ran one row behind. Those
are the failures that produce a board that does not work, and the ones this
rewrite could plausibly have introduced. All four misses are name RENDERING:
two dropped a bit-significance annotation, one truncated a dual-function name,
one transposed an underscore.

Only the last is a defect worth calling one - `AIN_2GND` is not `AIN2_GND` and a
schematic would carry the wrong label - and it is a character slip rather than a
wiring error.

A floor, not a figure: 9 of 94 calls failed, so 18 of the 38 available entries
were actually checked.

## `--estimate` cannot price a two-pass run

I quoted $1.16 for that run from `--estimate`, and it cost $2.43. The estimate
said 53 live calls; the run made 94.

The reason is structural and worth knowing before the next quote: pass 2's
request contains the RENDERED PAGES, and which pages those are is pass 1's
answer. Until pass 1 has run there is no pass-2 request to hash, so `--estimate`
can only count first-pass misses and silently assumes the rest hit. On a cold
corpus it therefore under-reports by roughly half.

Two runs in two days have now been mispriced in opposite directions - the
projection said $2.57 for a run that cost $0.89, and `--estimate` said $1.16 for
one that cost $2.43. Quote a RANGE, and say which end is which.

## 20/20, up from 17/20

`bench:mutation` now kills every seeded defect, where it left three alive when it
was last run. The suite grew by six tests over two days and they were not
written for this; the score moved because the tests pin behaviour rather than
shape.

Snapshot every source file's hash before running it. It edits source in place and
has left a live mutation in the tree before; a hash diff afterwards is what
proves it did not.

## Measured: the same datasheet does NOT produce the same record twice

2026-08-20, `npm run bench:repeat`. Four tuned parts, three live parses each, a
throwaway cache directory so nothing was replayed. 23 live calls, $0.61.

    DRV8825       IDENTICAL across 3 runs (56 values)
    LM358         same 8 pin names, filed under a REORDERED caption
    TPS54360      landSpanMm 3.85 -> 5.4, and two mask fields null -> read
    STM32F407VG   a complete 100-pin table in one run, NOTHING in another

**One part in four is reproducible.** `temperature: 0` narrows the sampling and
does not make the reader a function.

Two of these are worse than "unstable":

- **TPS54360 produced two different land spans from one datasheet.** 3.85mm and
  5.4mm are two different footprints, both built faithfully, and an 8-pin HSOIC
  is a 5.4mm part - so one run emitted copper that is simply wrong. This is a
  correctness finding that fell out of a reproducibility test.
- **STM32F407VG is complete or unreadable depending on the attempt.** Nothing in
  the product tells the user which one they got.

LM358 is the mildest and still awkward: the pin NAMES are identical and the
entry they live under is keyed on a caption the model reordered, so the record
differs even though the reading did not. Keys built from model prose are not
stable identifiers.

**Why this matters more than speed.** An engineer reviews a footprint, approves
it, re-runs it next week and gets a different library. That is disqualifying
regardless of which version is right, and no amount of accuracy work fixes it.

The objection recorded in `modelcache.ts` - that a production cache "would have
to answer when a stale answer becomes wrong" - has a good answer: key on the PDF
bytes, the prompt fingerprint and the extractor version. Same document and same
code returns the same record; change either and it re-asks. Staleness is solved
when the key contains everything that could cause it.

## Thinking budget: most of the instability for ~11% more

2026-08-20. Same four parts, two live parses each, `FORGE_THINKING_BUDGET=8192`
against the default (unset).

                    default            thinking 8192
    DRV8825         identical          identical
    STM32F407VG     100 values         2 values
    TPS54360        4 values           2 values
    LM358           unstable           unstable

STM32F407VG went from "a complete 100-pin table or nothing, depending on the
attempt" to a stable pinout with two land-span values wobbling. **TPS54360's
landSpanMm 3.85-vs-5.4 disagreement disappeared** - the one that was emitting
two different footprints from one datasheet.

Cost: $0.0294 per call against $0.0265, about 11%. No timeouts, so it still fits
the route's 30 second budget.

Not a fix: LM358 is still unstable, and a land span still moves on
STM32F407VG (14.3 vs 15.5). But the failures that changed a part from readable
to unreadable, and from one footprint to another, are gone.

## A stronger model does not fit the product, and the reason is the ROUTE

I proposed switching to a Pro-tier model as "a config line". It is not.

    gemini-3.6-pro / gemini-3.5-pro    404, not published to this project
    gemini-2.5-pro                     reachable, and every call timed out at 60s
    parse route maxDuration            30 seconds

`MODEL_TIMEOUT_MS` is already 60s, twice what the route can wait for. A model
that needs longer cannot be used from a request/response path at all: it needs
the parse to become a job the client polls. That is real work, not a flag.

**Check the deadline before proposing a slower reader.** The constraint was two
files away and I reasoned past it.

# The exploration pass, 2026-08-20

Nine candidates came out of a day of cross-industry research into how other
people build LLM parsers. **Seven were killed by free measurement, one was
adopted, one is still running.** Written down because the value of this pass was
almost entirely in what it stopped us building.

## Five instruments lied to me in one day

This is the headline, above any individual result. Every one of these was a
throwaway script I wrote to answer a question quickly, and every one produced a
confident wrong answer that I nearly acted on:

1. A package-name scan reported **0 order-variant collisions** across 1,974
   names. It split on `/` without handling the device suffix, so it could not see
   `ADA4522-4 (14-Lead TSSOP / 14-Lead SOIC)` against
   `14-Lead SOIC / 14-Lead TSSOP (ADA4522-4)` sitting in its own input.
2. The fixed version then grouped `X2SON (DPW0005A)` with `X2SON (DPW0005B)` -
   two different drawings - and `TSSOP-38 (ADS8688)` with `(ADS8684)`.
3. A lead-count audit reported **47 contradictions**. All 47 were the `23` in
   `SOT-23` and the `220` in `TO-220`. Real count: zero.
4. A "what did the model say" dump picked the cache entry with the MOST FIELDS
   FILLED rather than the one the record uses, and told me ADXL345 was shipping a
   wrong land pattern. It is not; the oracle proved it.
5. **`bench:extraction`'s "parse latency p50 58.7s" is very nearly all rate
   limiting.** The bench paces itself against a rolling 60s window and sleeps up
   to a minute between calls. I got as far as drafting a production-readiness
   finding on it.

`validate-the-instrument` was already in this file from 2026-08-18. It did not
save me once. The rule that would have: **a measurement that agrees with what
you already suspected deserves MORE scrutiny than one that surprises you**, and
every one of these five agreed with a story I was already telling.

`CacheStats.pacedMs` now exists so latency can be reported net of the limiter.

## What was killed, and by what

    canonical merge keys    19 within-run candidates, ALL of them sibling
                            devices or different outline codes. Merging any
                            would reintroduce a defect we already fixed.
    pitch from prose        6 checkable, 0 contradictions
    lead count from name    234 explicit declarations, 0 contradictions
    solder-mask from text   a TRAP: TI prints both variants as a LEGEND and the
                            text layer interleaves them into "NON SOLDER MASK
                            SOLDER MASK DEFINED DEFINED (PREFERRED)". A presence
                            rule is wrong on nearly every TI datasheet.
    no-lead IPC tables      0 of 8 printed patterns reproduced, two vendors
    verifier feedback loop  REFUSED 1 of 135. Pre-registered kill line was 5.
    constrained decoding    0.59% of 1,865 responses were unparseable, already
                            handled, and the fix strands the whole cache

The no-lead result deserves its own line. `ipc7351.ts` refuses to compute a
no-lead land and its comment rests on **two** hand-read drawings. I widened it to
eight across two vendors: **neither published table reproduces a single one.**
Even on square packages where the axis is unambiguous, printed pad length is
0.6 where the tables say 0.83 and 0.53. The likely root cause is now clearer -
for a pull-back QFN the terminal-tip span is not the body size, and we do not
extract it - so the refusal is not just correct, it is correct for a reason.
RULES.md rule 1 already names this case.

## Text-layer rules only work on TITLE BLOCKS, not on drawings

The one deterministic rule that ever paid (`statedMaxHeightMm`) works because
the number and its meaning are ADJACENT IN ONE STRING: "2.33mm max height". Every
candidate that failed above needed the number's meaning to come from where it
sits on the page, and the text layer destroys exactly that.

**Filter for new rules: can the value and its meaning be read from one
uninterrupted run of characters?** If the answer is "the label is above it on
the drawing", the text layer cannot help and only the rendered page can.

## Hand-reading four drawings found a defect that shipped

`bench:dimensions` went from 13 drawings / 163 values to 18 / 204. Four
drawings hand-read; **one of them was wrong, and the part SHIPS.**

    ISL71001M  Q64.10x10J  bodyHeightMm   record 1.00   drawing "1.20 Max"

The reader took `1.00 +/- 0.05` from Detail A - the lead's height above the
seating plane - on a page that also prints `1.20 Max` on the side view. Two
heights, wrong one taken. It is not copper, but it is what the exported STEP
solid is built to, so every mechanical clearance check against that bundle was
0.2mm short.

Nothing else could have caught it. `bench:copper` reports no disagreement and is
RIGHT to: the copper faithfully reproduces the record. The record was wrong.
Guards never fire. Only a person looking at the drawing finds this.

**115 of 135 cached parts still have no oracle entry.** At one defect per four
drawings hand-read, that is not a comfortable place to be.

## The fix, and why it is not a general rule

`statedMaxHeightMm` now also accepts the ENVELOPE spelling: Renesas heads that
drawing "64-QFP 10.0 x 10.0 x 1.2 mm Body, 0.5 mm Pitch", which is the same claim
about the same measurement.

Deliberately not generalised into "read dimensions off the title block". That
phrasing appears on **one page of 55 datasheets**. It earns its place only as a
second spelling of a rule that already exists, page-scoped, and required to agree
with anything else the page says - a page stating a height two ways corrects
nothing. Both behaviours have tests.

## Absence is an assertion, and guessing it is worse than leaving it out

Two entries this pass carry a deliberate hole:

- `CC-14-1` has no `leadSides`. The obvious read is 2 - six pads left, six right.
  But terminals 7 and 14 sit alone at the centre of the other two edges. The
  record answers 4. **Asserting 2 would have marked a defensible answer WRONG on
  the strength of my glance.**
- `7983231_13` has no terminal dims. The drawing prints `0.25 +/-0.04 (9X)` and
  `0.35 +/-0.04 (16X)`, and those counts do not describe one terminal.

An oracle that guesses is worse than one with holes, because a false WRONG sends
someone to fix working code.

## What the failures actually are

Three instruments agree and it changed how I read our numbers:

    bench:guards    no guard fires anywhere, on any corpus
    bench:copper    59 footprints, no disagreement with the record
    bench:replay    REFUSED 1 of 135

I first wrote this up as "our failures are absent values, not wrong ones." **That
was wrong, and the oracle disproved it within the hour.** Wrong values exist -
ISL71001M is one. What is true is narrower and worse: *we have almost no
instrument that can see a wrong value.* Everything above measures internal
consistency, and a confidently wrong reading is perfectly self-consistent.

That is the argument for the oracle over every other candidate in this pass.

## The route budget cannot fit the pipeline, measured net of pacing

The thinking-budget trial was run with latency instrumented, because thinking
costs time and time is what the routes are short of. The BASELINE arm settled a
much bigger question and the trial became unnecessary.

Six parts, two runs each, thinking OFF, every call live, **pacing subtracted**:

    wall clock per parse   p50 75.6s   p90 128.8s   max 128.8s
    parses over the ~25s the routes allow    9 of 9

Both routes carve the model pass a budget out of `maxDuration = 30`, race it with
`withDeadline`, and on expiry **discard the whole outcome** - including a pass 1
that already succeeded. `budget.ts` says in its own header that a call takes up
to 41.6 seconds. Two calls per part is ~75 seconds against a ~25 second budget.

This is enforced in our own code, not by a platform, so no deployment escapes it.

**Every accuracy number this project has ever published was measured with no
deadline at all.** Both benches call `runExtraction` bare; only the routes wrap
it. READ 98% / SHIPS 98% describe a pipeline given unlimited time.

Two further things the same run showed:

- `MODEL_TIMEOUT_MS` (60s) is being HIT, not approached. STM32F407VG timed out;
  LM358 timed out on both runs and both retries and returned nothing at all;
  ADS1115 timed out once per run and only succeeded on the retry.
- A deadline and a second-pass failure get **different treatment for the same
  user-visible outcome**. `SecondPassFailedError` returns 503 with a retry
  button. `ModelDeadlineError` returns a record carrying a note that says
  nothing was read - which cannot ship either, but offers no retry.

### Why thinking budget was dropped without running the second arm

It buys stability and costs ~11% more tokens and more wall clock. We are already
**three times over** the budget the routes enforce. Spending another $0.53 to
confirm that a slower reader is worse for a pipeline that cannot finish in time
would have been buying a foregone conclusion.

Same shape as the Pro-model finding above, and I walked most of the way into it
again: **check the deadline before proposing anything slower.** The difference
this time is that the deadline is not a limit on some better model we might
adopt - it is being missed by what we ship today.

### Stability, for the record (baseline arm)

    DRV8825      IDENTICAL (56 values)
    ISO7741      IDENTICAL (78 values)
    TPS54360     2 values differed (solderMaskDefined, solderMaskExpansionMm)
    ADS1115      22 values differed - the PACKAGE NAME moved, "SOT-5X3 (10)"
                 one run and "SOT (10)" the next, taking the whole pin table
                 with it
    STM32F407VG  one run timed out, nothing comparable
    LM358        both runs failed entirely

ADS1115 is worth noting: nothing about the pinout changed, only what the model
called the package, and that is enough to relocate every pin under a new key.

## Omission in the dimension oracle is an ASSERTION, so a partial read cannot be a partial entry

I hand-read LIS3DH's LGA-16 and recorded the four values I was sure of, leaving
the terminal dimensions out with a comment explaining that the drawing's
`0.25 +/-0.04 (9X)` and `0.35 +/-0.04 (16X)` do not describe one terminal.

The bench immediately reported `leadContactMm read 0.31-0.39, expected the
drawing prints none`, and it was right. `dimensions.ts` treats a missing key as
the positive claim that a person looked and **the drawing is silent** - which is
the whole point of the partial-entry design, and is what makes HKJ's missing
`leadContactMm` mean something. That drawing is not silent; I just could not
resolve which callout goes with which field.

So the entry was removed rather than trimmed. **There is no way to say "I checked
these four values and not those two" in this file, and that is deliberate.** An
entry you cannot make truthfully in full does not belong in an oracle, because
the cost of a false expectation is someone sent to fix working code.

Related to the `CC-14-1` `leadSides` hole above, but not the same: there, the
drawing genuinely does not settle the value. Here it does and I could not read it.

# The vendor drawing code as a package's identity, 2026-08-20

`packageType` is a caption the model composes, and it composes a different one
each run. Measured with `bench:repeat`, the same LM358 twice:

    run 1   "D, DDF, DGK, P, PS, PW, JG (8-pin)"
    run 2   "8-pin (SOIC, SOT23-8, VSSOP, PDIP, SO, TSSOP, CDIP)"

Identical pins, identical geometry, sixty values reported as changed because the
entry moved to a new key. ADS1115 does the same (`SOT-5X3 (DYN)` against
`SOT (DYN)`). It is not a misreading, and it is the largest single source of
run-to-run difference in the record.

It is also not just a key: `buildFootprintGeometry` names the emitted footprint
`slugify(partNumber)-slugify(packageType)`, so a wobbling caption is a wobbling
FILE NAME in the delivered library.

So each entry now carries `outlineCode`, the vendor's own code for that
package's drawing, and that is its identity for the join, the merge key and the
chooser.

## Measured on the run that introduced it

    package entries carrying a code    172 of 214  (80.4%)

    D0008A     "SOIC (D)"  "SOIC (8)"  "SOIC"  "D (SOIC, 8)"
    DBV0005A   "SOT-23 (5)"  "SOT-23"  "SOT-23 (DBV)"  "DBV"  "5-Pin SOT-23"

Six captions, one drawing.

## The half that matters more: it CONTRADICTS

27 pairs that the name-based proof would have called one package are kept apart
by their codes, and every one inspected is right to be:

    ADC128S102QML-SP  NAC0016A "16-Pin CFP"   vs  NAD0016A "16-Pin CFP"
    OPA2189           D0008A   "SOIC (8)"     vs  D0014A   "SOIC"
    LT1013            N8       "8-Lead PDIP"  vs  N14      "14-Lead PDIP"

The OPA2189 pair is an eight-lead package and a fourteen-lead package whose
captions the name proof was happy to merge. That is wrong copper, and it was
reachable before this.

## It costs nothing, and that was measured rather than assumed

The temptation was to read the tuned corpus dropping from 23 fields to 19 as
this change's fault. It is not. Because the model answers were CACHED, the join
could be switched off and re-run on identical inputs:

                          outline OFF   outline ON
    tuned fields             20/53        20/53
    tuned ships               8/53         8/53
    tuned PIN NAMES          15/17        15/17
    tuned PACKAGE FAMILY     12/12        12/12
    hold-out READ            58/59        58/59
    hold-out SHIPS           55/59        55/59

Exactly neutral on every metric, on both corpora. **An A/B on cached answers is
free and isolates one variable perfectly; reach for it before attributing a
delta to the change you just made.** The remaining difference from earlier runs
is the model reading differently under a changed prompt, which is the variance
`bench:repeat` exists to measure.

## Splitting correctly created a new refusal, and the fix is to ASK

Keeping two drawings apart means a document that captions both the same way now
has two entries with one name, and the chooser refused both:

    UCC27524  "HVSSOP (DGN)"  ->  DGN0008G  and  DGN0008H
    TLV9061   "X2SON (DPW)"   ->  DPW0005A  and  DPW0005B

Two options with one label are not a choice. `packageOptions` now appends the
drawing code where, and only where, the captions collide, and `pinTableFor`
resolves the bracketed form back to the one table. Hold-out
`unsupported: gives a pinout for each package` went 2 to 1 on a free re-run.

This is RULES.md rule 3 taken literally: the document prints two drawings, which
one this part uses is specific to the part, so ask rather than merge or refuse.

## Why revisions are treated as different drawings

`sameOutlineCode` matches a code wearing decoration (`751-07` against
`CASE 751-07`, `1L` against `1L_LQFP100_ME_V3`, `DSJ` against
`DSJ (R-PVSON-N14)`) and NOT a code differing in its trailing character
(`D0008A` against `D0014A`, `DDA0008B` against `DDA0008C`).

The suffix rule is a PREFIX AT A SEPARATOR rather than a truncation, because
truncating at the first underscore would collapse ST's own codes into each
other: `7983231_13` and `7983231_14` are two drawings.

Whether `DGN0008G` and `DGN0008H` are one package redrawn or two packages is NOT
settled here, and the chooser asking is the honest answer to that.

## `bench:mutation` left a live mutation in the tree AGAIN

It is recorded above, from 2026-08-16, that this bench edits source in place and
once left a mutation behind. On 2026-08-20 it did it again, and only a habit of
reading `git status` before finishing caught it:

    src/lib/ipc7351.ts
    -    B: { toe: 0.35, heel: 0.35, side: 0.03 },
    +    B: { toe: 0.35, heel: 0.35, side: 0.35 },

That is the gull-wing side fillet at density B, ten times too large, on the path
that computes every land pattern not read from a printed footprint. Committed, it
would have widened the pads on real boards.

The cause was a TIMEOUT: the run was killed at ten minutes, part way through, so
whatever restores the file never ran. The earlier note assumed the danger was a
crash; a wall-clock kill does it just as well, and the bench takes long enough
that killing it is the normal outcome rather than an exceptional one.

**Never let `bench:mutation` be the last thing before a commit, and always
`git diff --stat` after it whatever the exit code.** The tests all passed with
the mutation in the tree, because the mutation is chosen to be one the tests
catch only when the harness asserts on it - a green suite says nothing here.

## Refusing while holding the answer, three times in one file

Anthony's bar for finished, 2026-08-20, in his words: **"if the datasheet
genuinely doesnt contain the answer then if the user inputs the answer then we're
perfect."** That makes any refusal we could have turned into a question a defect,
and the hold-out breakdown reads as a list of them:

    1  NOT A DATASHEET (retrieval fetched the wrong document)
    2  held: uncitable pins
    1  unsupported: gives a pinout for each package

Not one of those is a question the user is asked. Three were fixed and hold-out
SHIPS went 55/59 to 58/59 (93% to 98%), with READ, the dimension oracle and the
copper bench all unmoved.

### Pin tables refused for want of a page number

`citeSoleRenderedPinoutPage` required EXACTLY ONE rendered page to identify as a
pinout page. That was sound when a handful of pages were sent; once the render
budget went to 16, a multi-package datasheet sends two and a correctly-read table
was discarded.

Settled by CONTENT instead: among the candidate pages, the one whose text carries
this table's pin names, needing over half of them and strictly more than any
rival. A tie still refuses. Names are compared on letters and digits only,
because a PDF text layer reorders characters within a label but does not invent
them.

The same proof then had to be applied to the FLAT `record.pins`, which is where
the two hold-out parts were actually stuck: a pinout drawn as vector artwork has
no text to quote, and the model cites the page it saw rather than one the drawing
pass was shown, so `verifyCitation` and `citeRenderedPage` both fail on rows that
are right. **Fixing the per-package path and assuming the flat path was the same
code cost a whole measurement cycle - check which path the message comes from.**

### Every harvested name failing to match

The ordering table and the pinout section are two vocabularies, and when they
share no word the chooser told the user no pinout matched, about pinouts it was
holding. It now offers the document's own package names instead.

Narrow deliberately: only when NOT ONE harvested designator resolved, so a
working chooser cannot gain a spurious option and a sibling's package cannot
appear beside the real one.

### What is left, and it is not extraction

The last non-shipping hold-out part is retrieval fetching the wrong document - a
3-page hobby-shop breakout page instead of a datasheet. Layer 1, not Layer 2, and
under Anthony's bar it is answered by the user supplying the PDF.

# Finishing parsing and generation, 2026-08-21

Work against the plan in `PLAN.md`. Phases 1 and 2 are done, 3 is advanced and
by nature continuing, 4 is done for the part that blocked a bundle, 5 is a gate
that needs someone other than me to pick the parts.

## The generator was not a function, and nothing we had discussed would have found it

Reproducibility had been treated as a model problem for two days. It was not
only a model problem:

    exporters.ts:372    new Date()   -> the STEP header
    exporters.ts:2481   new Date()   -> the manifest
    zip.file(...)                    -> JSZip stamps EVERY entry from the clock

Three sources, and the third was found only because a test compared the raw
archive rather than its contents. Two exports of one record differed byte for
byte, so a perfect record cache would still have handed the user a different
bundle.

**The geometry was already fine.** Every file a board is fabricated from - the
KiCad footprint and symbol, both Altium libraries - is a pure function of the
record and always was. What the timestamps did was HIDE that: anyone diffing two
bundles saw a difference and could not tell whether the copper had moved.

The clock is now an input (`ExportOptions.generatedAt`), which is the
`SOURCE_DATE_EPOCH` convention. Production still gets the real time, because a
file claiming to have been made at a time it was not is worse than a file that
differs. Three tests pin it: the whole archive byte-identical when pinned, every
geometry file identical even when NOT pinned, and no geometry file containing the
timestamp at all.

## Every accuracy number before today was measured without the deadline

`bench:extraction` and `bench:holdout` called `runExtraction` bare. The routes
wrap it in `withDeadline` and DISCARD the whole pass on expiry. Both benches now
apply `modelBudgetMs` against the same 150s the routes carry, with the limiter's
sleeps added back because pacing belongs to the bench.

Re-measured under it: hold-out unchanged at READ 58/59, SHIPS 58/59.

## SHIPS and VERIFIED are two different claims

`SHIPS 98%` says a bundle came out. It says nothing about whether the numbers in
it are right, and the two were being read as one figure. ISL71001M shipped for
weeks with a body height of 1.00 mm where its drawing prints 1.20 Max, with every
check green.

`bench:extraction` now prints VERIFIED: the fraction of SHIPPING parts whose
drawing a person has actually read. It is 8 of 9.

Its first run said 7 of 9, because it looked the oracle up by exact key while
`bench:dimensions` matched with `sameOutlineCode`: NCP1200 reads `CASE 751-07`
against an oracle keyed `751-07`. **Two instruments disagreeing about one part is
how you find out one of them is wrong.**

## The mutation bench needed a write-ahead journal, not a signal handler

It left a live mutation in the tree on 2026-08-20. The first fix was signal
handlers; while TESTING that fix, a kill left `HOLE_ALLOWANCE` at 0.05 instead of
0.2 - the through-hole drill allowance. SIGKILL cannot be caught, and a harness
killing a process tree does not politely send SIGTERM first.

So the original contents are written to `.mutation-journal.json` BEFORE the file
is mutated, and recovery happens at STARTUP. That survives SIGKILL and a power
cut, because it needs this process to run no code at all.

Then a second bug in the fix: recovery was placed AFTER the baseline check, so a
leftover mutation would fail the baseline and the bench would exit reporting a
red suite with the corruption still in the tree - worse than the original.
Recovery now runs first.

Proven end to end: SIGKILL mid-mutation, then a fresh run recovered the file and
said so loudly. **All tests passed with the corruption present, both times.**

## The seven guards are alive; zero firings is about the DATA

`bench:guards` reports zero firings across three corpora, which reads as dead
code. On 2026-08-21 that nearly got three of them deleted.

A probe with deliberately absurd records trips every one of them. The three that
appeared dead were being read through the wrong field: a rejected printed pattern
does not raise, it falls back, and the fallback is visible in
`provenance.source`, not in a discards array. **That was the seventh instrument
error in two days, and the only one that would have deleted working safety
checks.**

Zero firings means no printed footprint in the corpus is bad enough to trip them.
`guards-fire.test.ts` now trips each one on purpose, because a guard that never
fires on real input is exactly the guard a refactor can disable with no bench
number moving.

## The outline code fixed the worst drift, measured

`bench:repeat`, live, after the outline-code work:

    STM32F407VG   IDENTICAL across 2 runs (28 values)   was 92+ differing
    TPS54360      2 values differ

STM32F407VG was the one uncharacterised case in the whole reproducibility
picture and it is now clean.

**The one known remaining drift**, and it is a real one:
`solderMaskDefined` and `solderMaskExpansionMm` flip between a value and null on
TPS54360. It reaches the deliverable: one run emits `solderMaskMarginMm: 0.07`
and the other omits the key, leaving the CAD tool's own default.

Not fixed, and deliberately not papered over. The document DOES print 0.07, so
defaulting it would be inventing a number to cover a reading failure, which
RULES.md rule 1 forbids. A fab-process setting would be the RULES rule 3 answer,
but adding one is a product decision about the settings gate rather than a
parsing fix. **Anthony's call.**

## "We fetched the wrong document" is not "we could not read it"

The last hold-out part that cannot ship is a three-page hobby-shop breakout page
retrieved instead of a datasheet. The user was told no pinout could be read,
which sends them to re-run a parse that will fail identically, instead of to the
one action that works: uploading the datasheet.

`looksLikeWrongDocument` now lives in `pdftext.ts` and BOTH the bench and the
lookup route use it. It was previously a heuristic inside the bench only, so the
bench could classify a case the product had no way to detect - a bench measuring
something nobody ships. The route answers 422 `NOT_A_DATASHEET`, and it is
deliberately not retryable: re-running finds the same page.

Only on the lookup path. An uploaded PDF is whatever the user meant to give us
and is never second-guessed.

## Oracle coverage

13 drawings and 163 values on 2026-08-19; **20 drawings and 228 values now**,
zero wrong. Added this pass: ON Semi's SOIC-8, TI's ceramic dual flatpack,
Renesas' 64-QFP, ADI's 14-terminal LGA, and both ST LQFPs.

LQFP was the largest family in the corpus with no hand-read entry at all. Both
sizes are in now, kept as separate entries on purpose: `1L` and `1A` are the same
FAMILY and different DRAWINGS, and having both is what proves the reader is
reading each drawing rather than recognising "an ST LQFP".

Three ST footprint figures share one convention worth knowing: they print an
OUTER extent and an INNER one and leave the centre span implied.

    LQFP100   16.7 outer, 1.2 land   -> 14.3 inner (printed, confirming), span 15.5
    LQFP144   22.60 outer, 1.35 land -> 19.90 inner (printed), span 21.25

Each figure also prints a third number (12.3, 17.85) that is the pad ROW and not
a span: N lands at 0.5 pitch plus one land width. Reading it as a span would put
copper in the wrong place.

## Oracle coverage, continued 2026-08-21: VERIFIED reached 9/9, and found another defect

20 drawings to 23, 228 values to 244. Added TSV321's SOT23-5, RHF1201's ceramic
SO48, and before them both ST LQFPs.

### Two entries are keyed on a name this file invents, and that is new

TSV321 SHIPS and could not be covered, because its drawing prints NO vendor code:
Figure 19 is headed "SOT23-5 package outline" and nothing else. Keying only on
codes would leave every such drawing permanently unverifiable, which is a gap in
this file rather than a fact about the part. `outlineFor` already falls back to
the `parts` list, so a descriptive key plus an honest `parts` entry works.

Prefixed (`ST-SOT23-5-DS4381`) so nobody hunts the page for it.

### The VERIFIED metric undercounted TWICE, both times by looking up wrong

It went 7/9, then 8/9, then 9/9 without the product changing at all:

    NCP1200   reads "CASE 751-07"   oracle keyed "751-07"    - needed sameOutlineCode
    TSV321    reads NO code         covered via `parts`      - needed the part list

`bench:dimensions` matched both correctly the whole time. **Two instruments
disagreeing about one part is how you learn one of them is lying**, and the
lesson is that a new metric must resolve coverage the same way the existing one
does rather than inventing its own lookup.

**VERIFIED is now 9/9: every shipping part in the tuned corpus has its drawing
read by a person.** First time that has been true.

### RHF1201's lead form is wrong on the record, and it sets the whole land pattern

    RHF1201  leadForm  record "gullwing"   drawing: straight

`leadForm` decides whether a land is computed from the drawing (gullwing) or the
assembler's forming die is asked for (straight). Getting it wrong does not shift
a pad, it builds the wrong KIND of footprint.

The drawing settles it, by the same evidence this file already uses to separate
HBH0014A from NAC0014A: **a gullwing drawing prints its seated foot and this one
prints none.** Table 14's `L` is the overall span, 12.28 to 12.88, not a foot -
which is the trap, because `L` is a foot length on most vendors' tables. The side
view shows the lead leaving the body flat, and P and Q dimension where it sits
rather than a bend.

Checked whether the 2026-08-20 prompt change caused it: two fresh live runs
AGREE with each other on `leadForm`, so it is not live instability. Cached
answers show pass 1 reading `gullwing` off the FRONT PAGE (p1) as far back as
2026-08-17, which is the failure `LEARNINGS` already recorded. Unattributed
beyond that, and not worth more money to attribute.

### Body height is the most error-prone field in the corpus

Three separate instances now, all the same shape - a page states the height more
than once and the wrong one is taken:

    ISL71001M   1.00 from Detail A          drawing says 1.20 Max
    RHF1201     2.47 (A typ) vs 2.72 (A max), flipping between live runs
    NAC0016A    1.778 from the side view    title block says 2.33mm max height

`statedMaxHeightMm` catches the third and the ISL71001M case, because those pages
state the envelope in words. RHF1201's does not, so nothing catches it.

**If one more deterministic rule is ever worth building, it is this field.** It
is also the field with the least consequence - it drives the STEP solid, not the
copper - which is exactly why it survived so long unnoticed.

## The dimension bench was scoring a record nobody could produce

`bench:dimensions` reported `RHF1201 leadForm gullwing` against a drawing that
says straight. Investigating it found the bench, not the product.

Its record-building was four lines: walk every cache file for a part, in
`readdirSync` order, keep the first non-null for each field. That is a
REIMPLEMENTED MERGE, and it disagreed with the real one three ways at once.

- **It mixed PROMPTS.** Answers stored days apart under different prompts were
  merged into one record. `forge-validate-the-instrument` had already recorded
  "filter cache measurements to the current prompt" and this file never did.
- **It mixed PASSES.** Pass 1 reads the text layer, pass 2 reads the rendered
  drawing, and where they disagree the drawing wins - which is the entire reason
  there are two passes. Filesystem order threw that precedence away. RHF1201's
  `gullwing` came from pass 1 reading the FRONT PAGE.
- **It skipped everything the merge does besides picking a value**: citations,
  `statedMaxHeightMm`, the per-package join.

The fix was to DELETE the reimplementation, not correct it: the bench now builds
records with `runExtraction` - the same call the routes make - against the cache
in `offline` mode, which throws on a miss and cannot reach the network. A part
whose answers are not cached under the CURRENT prompt is simply not scored,
which is the honest outcome the old code hid by falling back to stale entries.

**Any bench that re-implements product logic will drift from it.** This file had
already been caught once ("It was the bench that was wrong", in its own comment)
and the lesson had not been generalised.

Cost of honesty: CORRECT fell from 244 to 163 and 95 parts now show as
uncovered, because the old figure was counting fields assembled from runs that
never happened together. The smaller number is the real one.

### What the rebuild then exposed, and how each was resolved

Three WRONGs appeared that the old bench had masked. They are not the same kind
of thing, and treating them the same would have been the mistake:

- **TSV321 bodyHeight 1.175 against my expected 1.45.** MY ERROR. The drawing
  prints A as 0.90 MIN to 1.45 MAX, so the field is `bodyHeightMm` (a range) and
  not `bodyHeightMaxMm`; 1.175 is the midpoint and a correct reading. Fixed the
  entry.
- **TPS7A4501-SP 2.62 against expected 2.63.** A FALSE ACCUSATION. That drawing
  prints BOTH - "CFP - 2.63mm max height" in the title block and "2.62 MAX" on
  the side view - for the same envelope. Asserting one endpoint of a
  disagreement the DOCUMENT contains sends someone to fix working code. Recorded
  as the range it is. Narrow on purpose: this relaxes an expectation only where
  the document states two values, never where it states one.
- **DRV8825 leadSpan {6.6, 6.6} against {6.2, 6.6}.** A REAL wrong reading, and
  it is left RED. A degenerate range moves the toe 0.4 mm on a SHIPPING part.

### The DRV8825 one is intermittent, and it stays red

Suspecting my own 2026-08-20 prompt change, I checked two ways.

The diff is confined to `packagesInThisDocument` and touches no flat-dimension
or range guidance. Then two fresh live runs under that exact prompt both read
`{6.2, 6.6}`, correctly, for about nine cents.

**So the prompt change is cleared and the cached answer is a one-off bad read.**
It is NOT refreshed away. An intermittent wrong value is still a wrong value, and
making the bench green by re-rolling the dice is exactly the "make the number go
up" failure this project keeps writing down. It stands as the one open defect and
as a captured instance of the reading instability already tracked in
`bench:repeat`.

# A real datasheet for the WRONG PART, 2026-08-21

Hand-reading a package drawing for the oracle turned up something bigger than a
wrong number. `TPS7A4700`'s cached PDF is 48 pages of genuine, correctly
formatted TI datasheet - **for the TPS7A20**.

An audit of all 123 cached datasheets found three:

    .bench-cache/TPS7A4700    ->  TPS7A20
    .holdout-cache/TPS7A4700  ->  TPS7A84   (a DIFFERENT wrong one)
    .holdout-cache/TPS7A4901  ->  TPS7A20

## Why this is the worst output this product can make

Every one of them READS PERFECTLY. Pinout, package drawing, land pattern, a
complete bundle - all correct, for a chip nobody asked for. `looksLikeWrongDocument`
cannot help: these are not thin distributor pages, they are full datasheets.
Nothing downstream looks wrong, no guard fires, and reading accuracy is
irrelevant because the reading is accurate.

**Two of the three are in the HOLD-OUT.** Our READ and SHIPS figures have been
counting them as successes, so the published numbers are very slightly optimistic
and, worse, two of the parts we have been calling correct describe other devices.

## The rule, and why "does the part number appear" is the wrong one

An exact-match test would refuse legitimate FAMILY datasheets, which are common
and correct: L7805's document is headed "L78 Datasheet" and never writes L7805 in
its front matter; Hirose's DF13-4P-1.25DSA is documented by "DF13 Series".
Refusing those trades three broken parts for dozens.

So a family stem is accepted, but only where the document uses it as a
**standalone token**. That distinction is the entire rule:

    "L78 Datasheet"   L78 stands alone, and L7805 extends it        ACCEPT
    "DF13 Series"     DF13 stands alone                             ACCEPT
    "TPS7A20"         TPS7A is a shared PREFIX, not a token         REJECT

Measured over all 123 cached datasheets before shipping it: **120 accepted, 3
rejected, and the three rejected are exactly the three wrong documents.** No
false positives. Front matter only, because a datasheet mentions other part
numbers constantly further in.

`namesThePart` lives in `pdftext.ts` beside `looksLikeWrongDocument`, and
`/api/lookup` answers 422 `WRONG_PART_DATASHEET`. Not retryable: the resolver
finds the same document again, and the user supplying the right PDF is the fix.
Never applied to an uploaded PDF, which is whatever the user meant to give us.

## How it was found, which is the point

Not by a bench. Not by a guard. **By rendering a page and looking at it**,
because the drawing was a 4-pin X2SON on a part that is a 20-pin VQFN.

Every automated check in this repo agreed the part was fine. Three corpora, seven
guards, 719 tests, an oracle with 163 verified values - and the document was for
a different chip the whole time. That is the argument for hand-reading drawings,
stated better than any number could.

## Corpus contamination is now a thing to check for

The three bad PDFs are still in the corpora, deliberately, until they are
replaced: deleting them quietly would move the numbers with no record of why.
Whoever replaces them should re-run and expect READ and SHIPS to move slightly.

# 2026-08-21/22

## The wrong-part datasheets were a RETRIEVAL bug, not a stale cache

`bench:corpus` (new, free) runs the product's own `namesThePart` over every
cached PDF. Re-fetching the three bad documents through the real resolver
returned **the same wrong document again**, which is what turned a housekeeping
task into a defect:

TI retired the literature names `tps7a4700` and `tps7a4901`. Both now redirect to
a product-category page, so the constructed URL missed, the chain fell through to
search, and search returned a SIBLING's datasheet. It scored well: same vendor,
same family prefix, a real PDF. Every resolver checked exactly one thing about a
candidate - that the bytes begin with `%PDF`. **Nothing had ever compared the
document to the request.**

Two changes, and the order matters:

1. `retrieval/identity.ts` asks whether a downloaded PDF names the part it was
   fetched for. Called where each resolver decides a candidate is a hit, so a
   wrong document is reported as a MISS and the remaining candidates still run.
   Rejecting at the resolver boundary instead would throw away every remaining
   candidate the moment the first was wrong.
2. `buildPartVariants` offers the two-digit stem TI files these families under
   (`TPS7A4700 -> TPS7A47`, whose first line reads "TPS7A4700, TPS7A4701").

**(2) is only safe because of (1).** A broader variant that can fetch a real but
wrong document is a coverage win and a correctness loss; with the identity check
in front of it, the worst case is one wasted request. Build the check first, then
the guess.

**Unreadable means ACCEPT.** A PDF whose text layer will not parse is common and
legitimate - scanned rad-hard datasheets are why the renderer exists - so the
check passes them. It exists to catch a confident wrong answer, not to demand a
readable one.

## Correcting my own plan: one hold-out part, not two

The plan said two of the three contaminated files were in the hold-out.
`bench:corpus` reported `.holdout-cache/TPS7A4700.pdf` as an ORPHAN: TPS7A4700
was removed from `HOLDOUT_CORPUS` on 2026-08-17 and the file was never deleted.
Nothing scored it. **A file sitting in a corpus directory is not evidence that a
corpus contains it.**

The same run found nine more orphans and, in the other direction, two parts that
had been TUNED AGAINST while belonging to no corpus at all: LTC6563 (its
"RECOMMENDED SOLDER PAD" caption is in `sections.ts`) and RHFL4913A (its
"Flat-16P" is the glued-designator rule's worked example). Both had `PINOUT_ORACLE`
entries. Rules had been fitted to them and no number counted them.

## Three instruments could not see what they existed to see

Found in one afternoon, all three by reading a drawing and then asking why no
bench had said so.

**`bench:copper`** looked its oracle entry up by outline code alone. Most replay
records carry no code, so the only hand-read check in the project was silently
skipped for most of the corpus. Matching by part name as well - the two ways
`oracleCovers` already matched - immediately surfaced **ADXL345 shipping copper
0.095 mm from its own printed drawing**, a defect documented in the oracle since
2026-08-20 with the note "bench:copper reports no disagreement here and is right
to". It was not right to. It could not see.

**`bench:replay`** merged cached answers in `readdirSync` order and let the last
file seen win each field, under a comment claiming "newest per part". Directory
order is not date order and is not stable across machines, so no run was
reproducible. Restricting to one prompt version per part was tried and REJECTED:
measured, it cut the bench from 59 footprints to 24, because most parts have only
a first pass cached under the newest version. Sorting by `storedAt` fixes the
reproducibility without the cost.

**`bench:guards`** read guard names out of REFUSAL MESSAGES, so a guard that
fires and then ships anyway was invisible. It reported every plausibility guard
as "never fires" while `printed-outside-ipc-band` was firing on DRV8825 and
TPS54360 on **every single run**: the printed footprint is rejected, IPC-7351B
computes a pattern instead, the export succeeds, and the message that would have
named the discard is never thrown. `FootprintProvenance.discards` now carries
them out of the successful path.

**This overturns a finding recorded on 2026-08-16** ("no plausibility guard fires
on the tuned corpus, only the output invariant does"). It was an artifact of an
instrument that could only see fires ending in a refusal.

The same file also held a drifted COPY of replay's cache reader - missing
`jedecOutline` and the whole radiation block, so it judged guards against a record
the generator never sees - and scraped the hold-out part list out of `holdout.ts`
with a regex, which silently matched nothing the moment that list moved into its
own module, reclassifying all 50 hold-out parts as "neither corpus". Both now use
the shared modules. `holdout-corpus.ts` exists because importing `holdout.ts`
starts a measurement run; the answer to that is a data module, not a regex over
another file's source.

## An unread variant is not a default variant

`solderMaskExpansionMm` was written as a mask EXPANSION whenever it was read,
including when `solderMaskDefined` was null. Hand-read from LM139AQML-SP page 31:

    NON SOLDER MASK DEFINED    .003 MAX [0.07] ALL AROUND
    SOLDER MASK DEFINED        .003 MIN [0.07] ALL AROUND

**The same number, meaning opposite things.** One opens the mask wider than the
copper; the other holds it back inside it. The figure cannot tell you which.

The test asserting the old behaviour carried its premise in a comment - "most
drawings print one detail and do not label it" - and the premise was backwards.
Measured over the 57 tuned datasheets: **24 of the 25 that carry a mask detail
label BOTH variants**. Exactly one does not. An unread variant is a missed
reading, not an unlabelled drawing.

Omitting is not a refusal to answer. It is what every footprint without a per-pad
override already does: the board's own mask rule applies. It also removed a
run-to-run difference in the emitted file, which is what put this on the list.

**A comment stating a frequency is a claim. Measure it before building on it.**

## A degenerate range is a legitimate answer

DRV8825 reads its lead span as `{6.6, 6.6}` where the drawing prints "6.6 / 6.2
TYP" stacked - the top line only. The obvious fix is to refuse a degenerate
range. **Do not.** Across every current-prompt cached answer, 7 spans come back
with `min === max` and 6 of them are RIGHT: ST prints the LQFP span as a single
basic value, and `DIMENSION_ORACLE` records `{16.0, 16.0}` for STM32F407VG and
`{22.0, 22.0}` for STM32H743ZI, both hand-read. The guard would fix one part and
break four.

The defect is in which line of a stacked pair gets read, and nothing downstream
can see the pair. Recorded beside the entry as a measured negative.

## Three examples is a pattern you matched, not a class you measured

The sharpest lesson of 2026-08-22, and it came from Anthony asking one question:
**"is that tailoring?"**

I had found three parts misreading a land span, all by the same arithmetic - the
printed centre distance minus one pad length, which is exactly the inner gap
between opposing lands:

    DRV8825     read 4.30   printed 5.80    5.80 - 1.50 = 4.30
    TPS54360    read 3.85   printed 5.40    5.40 - 1.55 = 3.85
    TPS7A4700   read 3.90   printed 4.65    4.65 - 0.75 = 3.90

I called it systematic, said the prompt's question was ambiguous, and put a
prompt change at the top of the plan. Then I counted the denominator.

**Fourteen land spans are checked against a hand-read drawing. Eleven are
RIGHT** - the same TI convention, read correctly, including three validated by
drawings read the same afternoon. If the question were ambiguous they would not
be. The "systematic" claim was three examples and no denominator.

### The line between fixing a question and tailoring

    tailoring       changing the question until THESE parts pass
    not tailoring   the question is genuinely ambiguous, so you fix the question

Both look identical in the diff. What separates them is whether the ambiguity
shows up in parts you did NOT pick, and the only honest test is the hold-out:
change the question ONCE, re-run, accept the number. Change it repeatedly until
the number improves and you have tailored, however the wording is justified.

The 2026-08-17 `leadForm` case is what a genuinely broken question looks like:
the prompt offered 2 of 3 valid values, so EVERY ceramic flat pack answered null.
It failed everywhere, not on three documents out of fourteen.

### And the fourth "instance" was my own instrument

I had also reported ADXL345 shipping a wrong land span. **It reads correctly.**
`bench:copper` was comparing a replay record STITCHED from two prompt versions:
three cached answers read that part right, one stale one read 2.29, the stale one
was newest so it won the field. `bench:dimensions`, which runs the real pipeline
against the current prompt, said 2.195 all along.

That is the fourth instrument to lie this week, and it lied in the direction that
supported the change I already wanted to make. `bench:copper` now skips the
oracle comparison on any stitched record and reports how many it skipped.

**Before arguing from a rate, count the denominator. Before arguing from a
defect, check which instrument produced it.**

### What is left of the finding, after testing it

Read five more drawings on 2026-08-22 specifically to attack my own hypothesis.

**"The exposed thermal pad crowds the figure": FALSIFIED.** LTC6563 is an
exposed-pad QFN whose land figure is HARDER than any of the three failures - ADI
prints an outer extent and an inner gap and never states the centre distance, so
it has to be derived ((5.50 + 4.10) / 2 = 4.80). The reader gets it right, and
its cross axis too. ISL71001M, ADS8688 and MSP430F5529 all carry thermal pads and
all read correctly.

**"The figure draws THERMAL VIAS": 3 of 3 wrong have them, 12 of 12 right do
not.** A perfect split on 15 cases. Still only 3 positives, so it is a lead and
not a finding. 19 tuned land pages draw vias and 15 are unread; a via-drawing
figure that reads CORRECTLY would kill this the way LTC6563 killed the last one,
and that is worth more than another confirmation.

**Attack your own hypothesis with the next drawing, not confirm it.** The first
guess died on the first part read to test it, which is the cheapest possible
outcome and only happens if the part is picked to break the rule rather than to
support it.

Two gull-wing cases are contained: `printed-outside-ipc-band` fires on DRV8825
and TPS54360 and IPC-7351B takes over, 0.08 mm and 0.67 mm from the vendor
pattern. TPS7A4700 is no-lead, where the band check cannot run by design, and it
ships 0.75 mm narrow. ONE live wrong footprint.
