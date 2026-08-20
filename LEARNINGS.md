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
