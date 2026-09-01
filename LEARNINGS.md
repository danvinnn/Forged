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

Claims in this file were last verified against the code on **2026-08-30**. Section
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
npm run lint                    # flat config; `eslint-config-next` cannot load under ESLint 9
npm run build                   # passes tsc and tests, fails to bundle
npm run bench:discards          # what the code THREW AWAY. free, one second.
npm run bench:questions         # is it asking for a number that is ON THE PAGE? free.
npm run bench:dimensions        # are the numbers we read RIGHT? free.
npm run bench:browser           # THE PRODUCTION BUILD, IN A REAL BROWSER. free.
npm run bench:joints            # does the LEAD sit on the LAND? free.
npm run bench:published         # our pads against KiCad's official ones. free.
npm start                       # then POST a real export and READ the files
```

**`bench:browser` is not optional and it is not a bench in the paid sense.** It
is on this list because on 2026-08-24 the product was found to have been serving
a page that never ran, for its whole life, with every other line above green.
The default pass makes no model call. `-- --full` uploads, answers the review
panel, exercises every offered format and exports, which is real money.

**Name which of these you actually ran.** If you only ran the suite, say only
that. Implying more is the cheapest possible way to lose the user's trust in
every number you report afterwards.

**The other benches are NOT part of this list, because they cost money.**
`bench:holdout` and `bench:extraction --model` call a paid API. `bench:replay`,
`bench:guards` and `bench:browser` (without `--full`) are free. Do not run a paid bench
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

## Omission is a claim, so never use it to mean "I could not read it"

LIS3DH's LGA-16 drawing is printed in pale grey. The default render was
illegible, 300 DPI made its OUTER DIMENSIONS table readable but not its bottom
view, and I wrote a deliberately thin oracle entry: three body numbers, and
`leadContactMm` left out because I could not tell which of two labels was which.

`DIMENSION_ORACLE` treats an absent key as a STATEMENT - a person looked and the
drawing prints none. `bench:dimensions` said so within seconds:

    WRONG  LIS3DH  leadContactMm  read 0.31-0.39  expected the drawing prints none

**The reader was right and the oracle was wrong**, and the oracle was wrong
because I used silence to mean uncertainty.

The fix was to actually read it. `sips -c <h> <w> --cropOffset <y> <x>` on the
300 DPI render, then `sips -Z 1600` to scale the crop up, and the bottom view
resolves completely: a left-column pad measures 0.35 across the page and 0.25
down it, so "0.35 +/- 0.04 (16X)" is the terminal LENGTH and "0.25 +/- 0.04
(16X)" is its width. Eight fields now check instead of three, all correct.

**Crop and zoom before giving up on a drawing.** And if it still will not read,
leave the WHOLE ENTRY out - a partial entry silently asserts that everything
missing from it is missing from the document.

## Two benches, one word, two meanings, both labelled "the product"

`bench:holdout` printed **SHIPS 58/59 (98%)**. `bench:extraction` printed
**SHIPS 10/57 (18%)**. Both lines carried the annotation "the product". They were
answering different questions:

    holdout    resolveForExport -> settings -> package chooser -> answer the
               questions -> did a bundle come out
    extraction one bare createExportZip(record) call

The tuned bench had no customer settings, no chooser and no answers. It also
broke a standing instruction on this project - *always account for user answers
and user settings when calculating a ships percentage* - which the hold-out had
honoured since the day it was written.

Fixed by moving the definition into `shipcheck.ts` and importing it in both.
Same failure shape as the two drifted cache readers earlier the same week: **a
second implementation of a rule is a second answer to the same question, and a
bench is the place that can least afford one.**

### The number that went UP is not the interesting one

    tuned SHIPS      18% -> 81%
    tuned VERIFIED  100% -> 37%

Nothing in the generator changed. SHIPS rose because the question got easier and
correct; **VERIFIED fell because the denominator got honest.** When only 10 parts
counted as shipping, all 10 happened to have hand-read drawings, so the metric
read 100%. With 46 shipping, 29 have no drawing read by anyone - and those
footprints were being produced the whole time.

**A ratio can be flattered by a wrong denominator in either direction.** The
hold-out number was fine; the tuned pair was reporting a strict SHIPS and a
flattering VERIFIED, and the two errors concealed each other.

### And it corrected me twice in one hour

I had told Anthony that hand-reading drawings "stopped paying" - measured on the
broken denominator, where every shipping part was already covered. It is in fact
the largest correctness gap in the project.

Verify the denominator before declaring a line of work finished.

### A refactor lesson, cheaply learned

Moving the block, a `str.replace` for the insertion silently matched nothing
while the corresponding delete succeeded, and `answerFor` vanished. It was
recoverable from the last commit. **Assert that an edit changed the file**
(`assert s != before`, `assert marker in result`) - a no-op replace is the one
failure mode that looks exactly like success.

---

# 2026-08-22

## An unlabelled axis is an unanswerable question, and it had three faces

`thermalPadLengthMm` was given an axis on 2026-08-16 after a pad shipped turned
ninety degrees. The same defect was sitting in `landSpanMm` the whole time and
nothing found it, because it only becomes visible on a RECTANGULAR QUAD - the
one shape where both axes carry rows and the two numbers can be swapped without
anything looking wrong.

The generator has always had a convention: `bodyLengthMm` on Y, `bodyWidthMm` on
X, and the `landSpanMm` rows at +/- half the span in X. Three other places that
should have said so said nothing:

  - the PROMPT said "measured across the SAME axis as landPadLengthMm", which
    names no axis on a package whose lands all point outward
  - the RECORD type said "centre to centre between opposing rows"
  - the ORACLE said the same, and its LTC6563 entry recorded the drawing's two
    numbers in PRINTED order, so it AGREED with a reading that cannot be built

Both rectangular quads in the tuned corpus came back the wrong way round, and
they failed differently, which is why one of them alone was not enough to see it:

    LTC6563   4.80 into landSpanMm puts the eight-terminal rows 4.80 apart
              across a 3 mm body. The lead lands land on the thermal pad and
              `validateGeometry` refuses the part. The user sees a dead end.
    TXB0104   2.80 and 2.30 swapped, and it SHIPS. The short-side lands sit at
              1.15 mm on a body 1.50 mm half-high: entirely under the package,
              clear of the terminals they solder to. Nothing overlaps, so no
              invariant fires and the file looks ordinary in CAD.

**The lesson is not "state the axis".** It is that a field whose meaning depends
on a convention held in ONE module is a defect waiting for the shape that
exposes it, and the shape can be rare. Every place that names the field has to
name the convention: prompt, type, oracle, and a test that fails when they drift
apart (`rectangular-quad.test.ts`).

## The thing you fix is the thing you look at, so look at the copper

The via grid had `nx = fit(padL)` and `ny = fit(padW)` two hundred lines below
`emitThermalPad`, whose own comment explains at length why the pad puts LENGTH on
Y. The grid put length on X. On a square pad the two agree and nothing shows; on
DRV8825's 4.83 x 2.75 PowerPAD at 1.2 mm pitch it produced four columns spanning
4.0 mm of a 2.75 mm width, two of them off the pad and through bare soldermask
beside the joint. Four shipping parts print a rectangular pad and a via grid.

A comment explaining a convention does not enforce it twenty lines away, let
alone two hundred. `exporters-geometry.test.ts` now asserts every via lies inside
the pad it heats, measured off the emitted file.

## An answer key may not settle a document's own disagreement by preference

Two entries in the oracles were recording one of two things the document prints
and failing a reader for choosing the other:

    TPS7A4501-SP  the pinout FIGURES label pin 9 SENSE/ADJ; the Pin Functions
                  table's NAME column says ADJ. The entry took the figure and
                  noted the conflict in a comment.
    DW0016B       the land page prints TWO complete footprints, an IPC-7351
                  nominal at 7.3 mm creepage and an HV option at 8.1 mm, and does
                  not say which to use.

The first was corrected to the NAME column, with the reasoning recorded rather
than the change made silently: page 3 says the device is adjustable-only, so
SENSE is a fixed-output sibling's name carried over on a shared figure. The
second got `landAlternatives`, which accepts EITHER complete pattern and neither
half of one and half of the other.

Both directions are traps. An oracle that bends to the reader is worthless; an
oracle that asserts more than the document does reports defects that are not
there. The test is whether the document settles it, not whether we have a view.

## The instrument was reading a different record from the product, again

`bench:dimensions` read `record.dimensions`. A family datasheet leaves that
entirely null - correctly - and states each package's measurements in
`packagesInThisDocument`, which is what `asPackage` builds the copper from.

So for every part that ships through the package chooser, the bench compared a
hand-read drawing against a row of nulls and printed "not read". It showed up
immediately: the first three drawings added for the shipping list produced 27
comparisons and all 27 read null. Reading the other eighteen would have bought
nothing.

Fixed by taking the package `shipOutcome` says the part shipped AS and reading
THAT entry's dimensions, blanked-then-overlaid exactly as `asPackage` does.
Comparisons went 252 -> 496 and four wrong values appeared that no instrument in
this repo could previously see.

**Third time this shape has cost a day.** The check: before trusting a bench,
ask which record it reads and whether the product builds from that one.

## The land-span class is not drawing-dependent, and it was settleable for free

Once the bench could see per-package dimensions, the count went from 3 misreads
to 7, all the same error - the inner GAP returned where the centre DISTANCE was
asked, always exactly one land length short. And the census kills the "the figure
draws thermal vias" hypothesis outright:

    D0008A      6 correct at 5.4,  1 wrong at 3.85  (OPA333)
    DBV0005A    4 correct at 2.6,  1 wrong at 1.5   (TLV9061)
    DGK0008A    4 correct at 4.4,  1 wrong at 3.0   (INA333)

The SAME drawing, in different datasheets, read right six times and wrong once.
The drawing cannot be the variable. The plan said this class could not be settled
without the blind set; it could, from data already on disk, as soon as the
instrument stopped being blind.

Where it lands in copper, measured part by part: four of the seven are caught by
the IPC band check and fall back to a computed pattern, one refuses for an
unrelated reason, one refuses outright, and TPS7A4700 - no-lead, where the band
check cannot run - ships 0.75 mm narrow. **Count where the error ENDS UP, not
how often it happens.**

## 1b, continued: three more drawings, one more live defect

Eleven drawings read now. The rate has not moved: about one real defect per four.

**LTC3105 ships pads computed from the lead THICKNESS.** Its MSOP drawing prints
`0.406 +/- 0.076 REF` as the lead width on the top view and `0.22 - 0.38 TYP` as
the lead thickness on the side view. The reader took the thickness. The printed
solder-pad layout was discarded by the band check, so the pads come from
IPC-7351B computed off that number, and they are about 0.1 mm narrow.

Same shape as the axis defects: `b` and `c` are adjacent dimensions on every
gull-wing drawing and the prompt asks for "lead width" without excluding the
thickness. NOT fixed by another prompt edit - see below.

**A drawing can be less precise than the answer key.** LTC3105's pad layout gives
a pad `0.889 +/- 0.127` long, an inner gap of `3.20 - 3.45` and an outer extent
of `5.10 MIN`, and never prints a centre distance. The two routes to one
disagree by more than the 0.005 mm this file compares at:

    outer minus one pad     5.10  - 0.889 = 4.211
    mid-gap plus one pad    3.325 + 0.889 = 4.214

So the entry records no `land` block and says why. Recording either number would
manufacture precision the document does not have, which is the one thing an
answer key must never do.

**The oracle's body axes were inverted for single-row packages.** `bodyLengthMm`
was documented as "along the axis the pin rows run", which matches the generator
for dual and quad and is BACKWARDS for a single row: a TO-220's three pins step
along X, and the generator reads the X extent from `bodyWidthMm`. Recorded as the
length it would draw a 4.5 mm silkscreen body around a 10.4 mm package. Third
instance of an axis convention held in one module; silkscreen only, since the
courtyard is bounded by the lands.

## Why the next prompt edit is not being made now

Three reading defects are open that a prompt clarification might fix: the lead
width against the thickness, and the two pin-name failures. All three are left
for the blind run to confirm, and that is a deliberate call rather than an
oversight.

The paid re-run on 2026-08-22 cost $2.99 against a $1.28 projection and moved two
parts to a DIFFERENT PACKAGE with nothing in the prompt touching them - AD8628 to
a TSOT, NCP1200 to a DIP. The run-to-run variance is larger than any of these
effects. Iterating costs $3 a turn, strands the whole cache each time, and cannot
attribute the result.

The axis fix was worth paying for because it had 2 of 2 positives, a mechanism
that was legible in the code, and a test that fails without it. None of these
three has that yet.

## 1b, drawings 12 to 14: a fourth live defect, and the worst of them

**TSV911 ships a land that barely touches its terminal.** ST's DFN8 2x2
recommended footprint prints four numbers around one small figure: the lead
land's length (0.75), its width (0.30), the pitch (0.50), and the THERMAL land's
height (0.45) on the far left. The reader took 0.45 as the lead land's length,
then derived the span from it consistently - 2.80 outer minus 0.45 = 2.35 - so
the record is internally coherent and every plausibility check passes.

What comes out has the toe in the right place and the heel 0.30 mm short:

    emitted   land 0.45 long at 1.175 centres, spanning 0.95 to 1.40 mm
    drawing   land 0.75 long at 1.025 centres, spanning 0.65 to 1.40 mm
    terminal  0.425 long, ending at the 1.00 mm body edge

The terminal and the emitted land overlap by 0.05 mm where they should overlap
by 0.35. About a seventh of the intended solder contact, on a part that ships.

**The shape to take from it:** one misread dimension propagated into a second
through a derivation the model performed correctly. Nothing downstream can
catch that, because the arithmetic is right and the inputs are individually
plausible. The only instrument that sees it is a person reading the drawing.

Running total for 1b: fourteen drawings, four live defects. The rate has not
moved from one per four all week.

## Two more things a drawing can do that the record cannot hold

**A terminal length printed as a MAX and nothing else.** ST's DFN tables give L a
Max column and leave Min and Typ empty. Recording it as a degenerate range
asserts a minimum the document does not state; omitting it asserts the drawing
prints no seated foot, which is the stronger and more wrong claim, because that
absence is what catches an invented one. Added `leadContactMaxMm`, mirroring
`bodyHeightMaxMm`, which exists for exactly this reason.

**A thermal LAND that is not the package's pad.** TSV911's exposed pad is
1.60 x 0.90 and the land drawn for it is 1.60 x 0.45 - deliberate, since the note
says the pad is not internally connected and may float. The schema has no field
for a thermal land distinct from the package pad, so it is recorded in the
entry's prose instead of being silently dropped.

## The thermal-land misread is a CLASS, not a one-off: 2 of 2

TSZ121 was read after TSV911 and made the identical error, to the digit:

    TSV911   landPadLengthMm 0.45, landSpanMm 2.35   drawing says 0.75 and 2.05
    TSZ121   landPadLengthMm 0.45, landSpanMm 2.35   drawing says 0.75 and 2.05

ST's DFN recommended-footprint figure prints four numbers around one small
drawing, and one of them - the 0.45 on the far left - dimensions the THERMAL
land's height rather than a lead land's length. Both readers took it, and both
then derived the span from it correctly (2.80 outer minus 0.45), so both records
are internally consistent and no downstream check can see anything wrong.

Both parts ship. TSV911's pads overlap their terminals by 0.05 mm where the
drawing wants 0.35.

**This has now crossed the same evidential bar the axis fix cleared** - two of
two, a mechanism legible in the document, and a clause that can only remove a
wrong candidate rather than change which right one is chosen. `landPadLengthMm`
asks for "the length of ONE land" and never excludes the large central land under
an exposed pad.

Not fixed today, and deliberately so: a prompt edit strands the entire model
cache, so making one without paying for a re-run leaves every free bench dark and
the repo less measurable than it was. It is queued as the FIRST thing to go into
the next paid run.

## Two ST datasheets, one package, different completeness

TSZ121's DFN8 2x2 table matches TSV911's on every reference except the seated
foot: DS9216 prints L as 0.225 / 0.325 / 0.425 and DS4899 prints only the 0.425
maximum. They stay two oracle entries for that reason. Merging them would make
this file assert a minimum that TSV911's drawing does not print - the same
overreach the TPS7A4501-SP pin entry was corrected for.

The opposite case is in the same file and resolved the opposite way: TS922's SO8
table matches LD1117's on all fourteen references exactly, so TS922 is listed
under that entry rather than given its own. The test is whether the documents
actually agree, checked value by value, not whether the packages share a name.

## Drawings 18 and 19: two more things the schema could not hold, and one it could

**RUG0010A states more than the record has fields for, twice over.** ADS1115's
X2QFN-10 has ten terminals in THREE geometries - eight side terminals 0.3-0.4
long, four of those 0.2-0.3 wide and four 0.15-0.25, and two end terminals
0.35-0.45 long and 0.25-0.35 wide - and its footprint draws two land sizes,
0.55 x 0.25 and 0.30 x 0.60. The record carries one `leadWidthMm`, one
`leadContactMm`, one `landPadLengthMm` and one `landPadWidthMm`.

That needed a new kind of entry, because absence in this file is a CLAIM that the
drawing is silent and here the drawing is the opposite of silent. Added
`notRecordable`, which names the fields a drawing states several times over and
disables their check with the reason attached. It is the honest middle between
asserting something false and pretending the page says nothing. Keep it rare: it
is a statement about the SCHEMA, and a field that lands there repeatedly is a
schema gap rather than a documentation problem.

**UT54LVDS217's flatpack is dimensioned entirely in inches**, with no millimetre
column anywhere - the only drawing in the file that is. The reader converted all
six recordable values correctly. Worth knowing that the conversion is not a
failure mode, because it looked like an obvious one.

It is also PARTIAL for an honest reason: the page prints D, E, E1, E2, E3 and L
across three views and none of them is decidably the tip-to-tip extent, so
`leadSpanMm` is left unchecked. Leaving a field unchecked is cheap; recording a
guess into an answer key is not.

## 1b is done: twenty-four drawings, five live defects

The rate held to the end - about one real defect per four drawings, and one
genuinely new failure shape per five. What the last five added:

**A drawing can print TWO codes for itself.** ISL71001M's page 36 is headed both
`Q64.10x10J` and `PT0064AA`, Renesas keeping Intersil's code beside its own, and
which one a run reports has moved between runs. Filing under one and letting the
other read UNCHECKED reports a hand-read drawing as unread; copying the entry
under both puts one hand read in two places to drift apart. Added `alsoKnownAs`,
which both `bench:dimensions` and the VERIFIED metric resolve. Aliases only: a
code listed there must appear on the SAME drawing.

**The `L`-is-one-lead trap is a family, not an instance.** RHFL4913A's Flat-16P
repeats RHF310A's exactly - `L` dimensioned twice, once per side, sitting right
where a tip-to-tip span would sit for a body that size. Both readers declined it
correctly. Worth knowing which traps the reader already handles, so nobody
"fixes" one that is not broken.

**Two more letters-only figures.** L7805, UT54LVDS217 and STM32G071RB all print a
figure carrying symbols and a table carrying millimetres, on different pages;
STM32G071RB's figure adds "not to scale", so nothing can be inferred from its
proportions either. Reading either page alone cannot say which symbol is which
axis. This is the normal shape of an ST or CAES drawing, not an exception.

# 2026-08-24

## The $3 run: one of three fixes worked, and that is the finding

Three prompt changes went in together and were measured on the tuned corpus.

**Worked.** Rolling back the pin-name parenthetical clause. PIN NAMES went 16/18
to 19/21, and the two failures it had introduced - RHF310A's `NC(1)` and
STM32F407VG's `PA14 (JTCK/SWCLK)` - are gone. The only remaining mismatch is
LMP7704-SP returning `IN A⁻` where the hand-typed oracle has `IN A-`, which is a
character-encoding difference and not a misreading.

**Did not work.** Telling the model that the large central land under an exposed
pad is not a lead land. TSV911 still reads `landPadLengthMm` 0.45 and `landSpanMm`
2.35, unchanged to the digit.

**Did not work.** Telling the model that lead WIDTH is dimension b and not the
thickness c. LTC3105 still reads 0.22-0.38, unchanged.

**And the noise was again larger than the signal.** WRONG went from 11 to 16 on
comparable matching, with five NEW misreads on parts none of the three changes
touched: ISO7741 took the caption "7.3 mm CLEARANCE/CREEPAGE" as a land span,
RHF310A took `L` as a seated foot after correctly declining it two days running,
RHFL4913 swapped B and C, UT54LVDS217 took the overall extents as the body, and
NCP1200 moved 0.2 mm on body height.

**What this says about the method, which is the part worth keeping.** Wording a
field more precisely is not reliably how a misreading gets fixed. Two of these
changes were well evidenced - one had 2 of 2 positives and a mechanism legible in
the document - and neither moved. Meanwhile the run's variance produced five new
errors for free.

So the next attempt at these two should NOT be another wording pass. The options
worth weighing are asking the user, refusing where two candidate numbers are
equally supported, or reading the figure a second time and requiring the two
reads to agree. All of them are structural, and none is a sentence in a prompt.

## Two more instruments that disagreed with each other, both mine, both same day

`bench:dimensions` looked its oracle key up with an exact string compare while
`bench:extraction` used `sameOutlineCode`. LTC3105 reports `05-08-1668` against
an entry keyed `05-08-1668 Rev A`: VERIFIED called it checked, the dimension
bench called it unmatched and scored nothing, and I nearly reported the lead-width
fix as a success on the strength of its absence from the WRONG list.

And the part list handed a reading to the wrong drawing again. TSZ121 offers seven
packages, settled on the SC70, and its SC70 reading was scored against the DFN8
entry listed under its name - six WRONG values, every one a correct reading of a
different package. Fixed with `designators`: an entry that declares which packages
it describes is now reachable only through them, and the part list stays as the
fallback for entries that declare none.

**Both were introduced the same day they were found.** A bench edited in a hurry
drifts from its sibling, and the drift shows up as product defects that are not
there.

---

# 2026-08-24, later: the app had never run in a browser

## The defect

`next.config.ts` set `script-src 'self'`, with the comment "scripts are NOT
given unsafe-inline, so an injected `<script>` will not run". The intent was
right. The effect was that **the product had been serving a dead page for its
entire life.**

Next's App Router boots the client from inline `<script>` elements: the runtime
bootstrap and the streamed flight payload React hydrates from. `script-src
'self'` blocks an inline script whoever wrote it. Every one was refused, React
never hydrated, and the page arrived as HTML with no JavaScript attached to it.
The status line sat on "Loading..." because the effect that clears it never ran.
Choosing a datasheet did nothing at all, because the file input had no change
handler bound to it.

That is precisely the report: "we cannot upload files and get a bunch of
errors."

## Every instrument in this repo was green

`npm test` passed, 734 of 734. `tsc` was clean. `next build` succeeded.
`bench:extraction` reported 52 of 57 parts shipping. Every route answered
correctly under `curl`, including a full upload, parse, package choice and
export that produced a valid KiCad bundle.

None of that touches the defect, because **not one instrument here had ever
loaded the page in a browser.** A route handler does not care whether a browser
ever ran the page that calls it. The failure was total, trivially reproducible,
and structurally invisible to everything we had.

This is the strongest available example of the standing rule that a green board
is not evidence. It is worth more than the earlier ones because the gap was not
narrow: it was the entire product, and every number we quote about the product
was measured through a door the customer cannot open.

## And then the fix repeated the shape

The repair is a per-request nonce issued from `src/middleware.ts`, which is
stricter than the alternative: `'unsafe-inline'` would also make the app run, by
admitting every inline script including an injected one, which is the exact
thing the original policy existed to stop.

With the nonce in place, `next dev` worked perfectly and **the production build
was still dead.** `next build` marked `/` as prerendered static content. A
statically prerendered route has its HTML written at build time, when there is
no request and therefore no nonce, so Next emitted its bootstrap unstamped and
the browser refused all of it. `'strict-dynamic'` correctly disabled the `'self'`
host allowlist, so the chunks were blocked too.

Fixed with `export const dynamic = "force-dynamic"` in `src/app/layout.tsx`.
This is the **third** time in this codebase that a production build has behaved
differently from the dev server; the other two are written up in
`next.config.ts`. Treat "it works in `next dev`" as telling you nothing about
what ships.

## What was actually done about it

`npm run bench:browser` loads the PRODUCTION build in a real browser and fails
on any console error, uncaught exception, blocked request or 4xx. The default
pass makes no model call and is free; `--full` adds an upload and an export and
costs one real call.

**It was validated by reintroducing both defects and confirming it fails**, per
the standing rule that an instrument which has never failed proves nothing. With
`script-src 'self'` restored it reports 0 of 4 stages and names the policy; with
`force-dynamic` removed it reports the page never hydrated. Restored, 6 of 6
stages and zero problems.

Run it before claiming the product works. `npm test` cannot see this class.

## Two more dead ends found the same way, both invisible to the suite

**The settings gate had no exit.** A first-time user's first action is to choose
a datasheet. The gate refuses it, correctly, and asks for the two forming-die
numbers. They answer, save, and nothing happens: the file is still named in the
drop target above "Click to replace", and choosing the same file again fires no
`change` event at all, because the input's value has not changed. The only way
forward was a page reload. The file is now held and run when the gate opens, and
the input is cleared on every change so a re-pick always fires.

**An out-of-range answer vanished in silence.** `parseSettings` bounds the
formed foot at 5 mm, matching `/api/export`, and dropped anything larger without
a word. The box still showed the 8 the user typed and the gate still said one
field was needed, with nothing joining the two. `outOfRange` now reports which
field and which limit.

Both are the same shape as the CSP defect and neither is exotic. They were found
in the first two minutes of driving the app like a person. **Nothing in this
repo drives the app like a person**, which is what `bench:browser` is for.

## A found-in-passing extraction defect, and the one under it

The package chooser displayed "TSOT, 23 leads" on a five-lead AD8628. `SOT` was
in `OUTLINE_NUMBERED`, where a trailing number is a name rather than a count,
and `TSOT` was not, so the two spellings of one JEDEC outline disagreed.

Fixing that exposed a worse one underneath. `OUTLINE_NUMBERED` was applied to
every matching form at once, so `5-Lead SOT` and `5-Lead TSOT` **declared no
lead count at all**, on a datasheet that writes "5-Lead" directly in front of
the family name. Evidence matched and then discarded by a rule written for a
different form: the same "we had it and threw it away" shape yet again. The
outline rule now applies only where the number is not anchored to the vendor's
own word for a lead.

Measured on the tuned corpus before and after: SHIPS 52/57, VERIFIED 47/52, PIN
NAMES 19/21, identical both ways, the two runs differing only in timing noise.
Neutral on coverage, correct on the screen, and it recovers a count that was
being thrown away.

## The instrument manufactured its own failure, twice, before it found anything

`bench:browser`'s first `--full` runs reported both exports refusing on a
DRV8825, with a long and entirely correct message about a 28-lead package whose
pin table had one pin. **The bench had caused that.** It exercised the review
panel's correction path by typing a plausible number, 1.27, into whatever item
happened to be first, and on that document the first item was PIN COUNT.

The second attempt typed the value already displayed back into the same box,
with units stripped, which turned a package named "14-pin CFP" into "14".

Both times the product was right and the instrument was wrong, and both times
the output looked exactly like a product defect. The correction path now runs
only against an item whose displayed value IS a number in millimetres, writing
that same number back, so there is no text to mangle and no value to invent. If
no such item is offered, the path goes unexercised and SAYS SO rather than being
forced.

Same lesson as the 454 findings that were really zero: **validate the instrument
before believing what it reports about the product.** The tell was that the
refusal message was too specific and too correct.

A related one from the same runs: the bench counted the 422 from `/api/export`
as a browser error. That 422 is a designed answer, the one carrying
`INPUT_REQUIRED`, and it is how the screen knows to ask the user for numbers. An
instrument that scores the product's honesty as a fault will push you to remove
the honesty.

## And then it found a real one

Reading `handleCorrectReview` to fix the above turned up a traceability defect.
It set `method: "user"` and patched only value, confidence and method through a
helper that MERGES, so the model's citation survived onto the hand-typed number.
`updatePin` did the same thing explicitly, passing `next.pins.citation` through
under a comment saying the provenance changes with the edit.

The record then claims a number a person invented was read off a named page of
the datasheet. An absent citation says "a person supplied this"; a wrong one
says "the vendor did", and a reviewer following it for QML sign-off finds a
different number at the other end. Both now go through `userEdited` in
`provenance.ts`, which returns a COMPLETE field so a merge cannot leave the old
citation behind. Confirming still keeps its citation, deliberately, because
there a model read it and a person checked it against the page it names.

The export gate is unaffected: `isUntraceable` refuses a MODEL value with no
citation, and a user value is not one. A test pins that, so if the rule ever
changes it fails loudly instead of parts quietly ceasing to ship.

## One headline was standing for two very different experiences

Asked on 2026-08-24, after a run of failures: "why are we failing, I thought we
were good on most datasheets?"

The benchmark printed `SHIPS A BUNDLE: 52/57 (91%)` and that is the number that
had been quoted, including by me, all evening. It counts a part that ships
**after the user picks a package from the chooser and types in the numbers the
product asks for**. `shipOutcome` also computes the zero-friction figure, a
bundle with nothing asked, and the bench threw it away.

Both are now printed:

```
SHIPS UNAIDED:    42/57 (74%)   <- upload, press export, done
SHIPS A BUNDLE:   52/57 (91%)   <- after choosing a package and answering
```

74 is what someone uploading a PDF experiences. The seventeen points between
them are real work the product does, and quoting only the higher one described a
product that does not exist yet. A figure that requires interaction has to say
so in its own label, not in a comment in the source.

## And every bench number is measured on frozen model answers

`bench:extraction --model --offline` reported `cache hits 113, live calls 0`.
The corpus numbers therefore describe ONE historical set of model responses. A
user uploading a datasheet re-rolls the dice on every call.

Measured incidentally on 2026-08-24: LMP7704-SP was read three times in one
evening and produced three different records. One with a full pinout whose names
carried en dashes; one with a full pinout whose names carried superscript
minuses; and one with **no pinout at all**, on a part the corpus counts as
shipping.

So the corpus figure is an upper bound on a good day, not a hit rate. Nothing
here measures read-to-read variance on a fixed document, which means the number
everyone steers by has an unmeasured error bar. `bench:repeat` exists and costs
live calls; it has never been pointed at this question.

Say "74% of the tuned corpus, on the cached reads" rather than "91%", and treat
a user's report of an intermittent failure as information the corpus cannot give
you.

# 2026-08-25: the screen after a read

## What the user actually said

"I don't know what I'm looking at." Then: "there's still too much information
after a parse."

A finished read produced four numbered steps at once: what was read, worth a
look, package, export, plus the record and the reader's notes. On an
LMP7704-SP that is a **7118px page**, and 5764px of it was eight outstanding
questions each rendering **its own copy of the same package outline**. Eight
identical 613px images. The screen was mostly one picture repeated.

## What replaced it

One card that answers, in order: what part is this, can it be built, and what
to do next. `verdict` in `page.tsx` ranks the states by what BLOCKS the build
and reports only the first, because offering a chooser and eight questions and a
review list at once is three next-actions, which is none.

Everything else folds. The review list is a `<details>` that opens itself only
when an item is blocking; thirteen items open was the screen. The consistency
checks fold when they all pass, because "all four passed" is a line and not a
list. Questions group under the one drawing they are all read from. A `why`
sentence shared by three consecutive fields is printed once.

**7118px to 2468px, measured.** `bench:browser` now fails over 5000px, which is
loose on purpose: a long pin table is legitimate and a repeated drawing is not.

## The defect the redesign exposed within one run

The card read **"Ready to build"** and both formats then refused with "this
datasheet is missing values the footprint needs". The verdict was computed from
the questions and the review list; it never asked whether the record could
resolve at all. `packageChoice.ok === false` is exactly that signal and it was
sitting on the parse response unused.

A verdict that contradicts the button beneath it is worse than no verdict: it
spends the user's trust and then their time. `bench:browser` now fails if the
card says "Ready to build" and an export then refuses.

## Six harness bugs, and what they cost

This is the part to remember. Chasing two bench findings through the night, the
app was RIGHT every time and the instrument was wrong six times:

1. Measured a phone viewport by forcing `documentElement.style.width`, which
   reports the content at the old layout width. Claimed "890px too wide" on a
   page that overflows by zero.
2. Then measured it mid-reflow and claimed 8px.
3. Corrected the review panel with a plausible number, into whatever field came
   first, which was PIN COUNT. Collapsed the pin table to one row and reported
   the resulting correct refusal as a defect.
4. Then wrote the displayed value back with units stripped, turning a package
   named "14-pin CFP" into "14".
5. Counted the designed 422 from `/api/export` as a browser error, scoring the
   product's honesty as a fault.
6. Clicked Build by coordinate into a layout that had just re-rendered, losing
   the race silently and reporting "PRESSING BUILD SENT NO REQUEST" on two of
   three datasheets while the same sequence driven by hand exported every time.

**Every one of those looked exactly like a product bug.** Three separate times I
formed a hypothesis about the app, fixed the app-shaped thing, and got the
identical result, which is the tell: *if your fix changes nothing, you are
looking at the wrong layer.*

What finally worked, each time, was making the instrument report the raw fact
instead of an interpretation. "PRESSING BUILD SENT NO REQUEST" versus "export
failed" is the whole difference: one names the layer, the other invites a guess.
Counting the requests took four lines and ended a hunt that had run for hours.

## And two of my own edits never landed

Twice, a `python3` heredoc ran with the shell's cwd reset out of the repo,
printed "ok", and wrote nothing. I re-ran the bench, got the same failure, and
concluded my fix had not worked when it had never been applied. **Verify the
edit landed before believing the measurement that follows it**: one `grep -c`
for a phrase from the patch is enough.

## Advice a screen will not act on is a dead end

Reported 2026-08-25, from a screenshot, in four words: **"what am I supposed to
do with this??"**

The verdict card said "Not enough was read to build anything: Pin names.
Reading the datasheet again sometimes finds them." Correct, honest, and it put
NOTHING on the screen to do it with. The only route was to scroll back up,
re-pick the same file, and press Read. The card diagnosed the problem and left
the user to solve it by hand.

Fixed by putting the action in the card that advises it: a **Read it again**
button, with the cost stated beside it ("another minute and a half, and another
model call") so it is an informed press. Verified end to end: a read with no
pinout, one press, a second read, the verdict changes and Build enables.

**This is the third instance of the same shape in two days.** The settings gate
refused a file and offered no way to run it. The export refused and would not
name the fields it had been handed. Now a card advised a re-read with no button.
Each time the product knew exactly what was wrong and what would fix it, and
made the person do the work of acting on it.

The rule this earns: **whenever the screen tells someone what to do, ask what
they have to press.** If the answer is "scroll up and repeat something", it is
not finished. `bench:browser` now fails if a card advises a re-read and offers
no way to take it.

## And the same screenshot carried two more

`PINS 14` in the facts, `0 pins` in the record disclosure, and a verdict saying
the pin names were never read: three numbers disagreeing on one screen. A
package named `CFP (14)` states a COUNT, and nothing behind it is a table. Now
reads `14, no pinout`.

And **BUILD LIBRARY was enabled directly under "Not enough was read to build
anything"** - the one big blue button on the page, inviting a press that could
only produce a refusal. Now withheld, with the reason beside it, because a
greyed primary action with no explanation reads as a broken screen rather than
an honest one.

Both were introduced by the redesign the day before and both were visible in the
first screenshot a person sent. Nothing found them but a person looking.

## Why a discarded read survived four months looking like a bad read

Asked 2026-08-25: "how did we not catch this before?" Four reasons, and they
compound.

**1. The fix was written for one spelling and tested for one spelling.**
`merge.test.ts:382` covers exactly this bug with `number: "EP"`, a STRING, and
has passed since 2026-08-10. The `null` spelling returns fatally one line
earlier in the same function and no test ever reached it. The author fixed the
shape the data had shown them; nothing prompted a look for a second shape.

**2. The corpus reads a frozen cache and never rolls the bad dice.**
LMP7704-SP has ELEVEN cached reads across SEVEN prompt versions: ten clean, one
carrying the pad rows. `bench:extraction` takes the one matching the current
prompt hash, which was clean. Re-running it a hundred times could not have found
this, because it does not call the model. "The corpus is an upper bound on a
good day" means exactly this.

**3. The symptom named the wrong layer.** The screen said "Not enough was read
to build anything: Pin names", which reads as the MODEL failing. It was our code
discarding a perfect read. So every encounter got filed as model variance,
including by me earlier the same night, when I told the user this part
"sometimes reads without a pinout". It read fine every time. We threw it away
one time in eleven.

**4. The repo already had a name for the shape.** `forge-we-had-it-and-threw-it-
away` exists as a memory. Knowing a failure pattern by name does not stop it
recurring one line above where it was last fixed.

## The instrument that would have caught it, and now does

`npm run bench:discards` runs every cached model answer through the REAL
`normalizeModelPins`, imported rather than reimplemented, and reports what was
thrown away and why. Free, no network, about a second.

It fails only on the case that is unambiguously a defect: **a table whose
numbered rows are complete and gap-free, refused over a row that was never a
pin.** A refusal is not a defect and most of these are right; losing a correct
pinout is.

**Validated by reverting the fix**, per the standing rule. With the bug present
it names AD5679R (28 pins + EPAD), AD7124-8 (32 + EP), AD8232 (20 + EP) and
LMP7704-SP (14 + PAD/LID), with the offending rows printed. With the fix it
passes.

**It deliberately scans every prompt version**, which is the opposite of the
rule for coverage measurements. Those must filter to the current prompt or they
blend incompatible runs. A discard rule is a property of the SHAPE of an answer
rather than of the question asked, so every answer ever received is fair
evidence about it. Note the distinction before copying either rule.

## The general lesson

**When a refusal looks like the model's fault, check what it actually sent.**
The whole investigation was one script over the cache, and it named four broken
parts in seconds after hours of me treating the symptom as variance.

And the design rule it earns: **a row that is not a numbered pin must not
destroy the numbered pins.** Prefer skipping the row you cannot place to
refusing the table you can read. Skipping is safe here only because
`isGapFreeSequence` catches a real pin lost from anywhere but the end, and the
lead-count check at export catches one lost from the end. Both guards are named
in the code so the next person can see why it is allowed.

## We told a user their datasheet printed no footprint, on the page that printed it

Reported 2026-08-25, with a screenshot: an LTC6563, three questions asking for
land length, land width and centre span, each captioned

> "This datasheet does not print a recommended footprint for 24-Lead QFN, and no
> land pattern is derived from anything outside it. Take these three from the
> vendor's application note or your own library."

Beside that sentence, the screen was **displaying page 33**, which is headed
`RECOMMENDED SOLDER PAD PITCH AND DIMENSIONS` and dimensions the pads 0.70 x
0.25 with 5.50/4.10 and 3.50/2.10 extents. Every number we were asking for was
in the picture we were showing them.

The model reads it correctly in four of six cached attempts, returning
`landPadLengthMm 0.70`, `landPadWidthMm 0.25`, `landSpanMm 2.80` and
`landSpanCrossMm 4.80`, all cited to page 33.

## Two separate defects, and the first is a RULES violation

**We asserted something about the DOCUMENT that we were not entitled to.**
"These values are missing from our record" and "this datasheet does not print
them" are different claims, and only the first is ours to make. The second is
false whenever the vendor did print one, and it sends the user to an application
note instead of to the page in front of them. Now both branches say what WE did:
either "this datasheet prints a recommended footprint on page N and these values
could not be read off it", or "no recommended footprint was read from this
datasheet".

The identical phrasing was in the verdict card and is fixed the same way.

**And the vocabulary was one vendor wide.** `findUnreadableFootprint` exists
precisely to prevent this sentence, and its own comment says so: "so the user is
never told a datasheet prints no footprint when it prints one on a numbered
page". It matched `/\bfootprint example\b/i`, which is ST's phrasing.

Scanned across every line of the 57 tuned datasheets: **19 lines matched, 126
did not.** The misses are TI's `LAND PATTERN EXAMPLE` (39 lines),
`RECOMMENDED LAND PATTERN`, `RECOMMENDED FOOTPRINT`, and the LTC6563's
`RECOMMENDED SOLDER PAD PITCH AND DIMENSIONS`.

Measured, on the same corpus: **4 datasheets located a printed footprint page
before, 36 after.** Three near misses are deliberately excluded because each
names a footprint without being a drawing of one: `TABLE N. FOOTPRINT DATA`, the
ordering table's `IPC FOOTPRINT TYPE PACKAGE CODE`, and revision-history lines
reading `ADDED FOOTPRINT DATA`. Pointing a user at a revision history is the
same defect as pointing them at nothing.

**And the family gate blocked the one that was left.** The function requires the
caption to name the package, which is right on a datasheet drawing several
footprints and pure loss on one drawing a single footprint: page 33 does not
repeat "24-Lead QFN" above its solder pad drawing. The gate now falls back to
the sole candidate when the document contains exactly one, because one candidate
is not a choice. Two or more and it still decides, because then picking would be
a guess.

SHIPS, VERIFIED and PIN NAMES are unchanged: this moves what the user is TOLD
and which page they are pointed at, not yet what is read off it.

## The lesson, which is the same one as the pin discard

**A sentence about the document is a claim, and it needs the same evidence as a
number.** We are entitled to say what we read and what we failed to read. We are
not entitled to say what the vendor printed, unless we looked and can say where.

Both of the last two defects were found by a user reading the page we had
rendered for them and asking "is this true?". Neither was reachable by any test,
because both were the product being confidently wrong rather than broken.

## One capital letter discarded a whole package's geometry

The LTC6563 report had a second defect behind the first, and this one moved the
product number.

A fresh parse of that datasheet reads **everything**: land length 0.70, land
width 0.25, centre span 2.80, cross span 4.80, pitch 0.50, body 5.00 x 3.00 x
0.75, lead sides 4, twenty-four pins, every one cited to page 33. And the
package chooser reported `needs-input` listing **those exact eight fields** as
missing.

`asPackage` blanks every dimension when the designator it is handed differs from
the record's. That is correct and the comment above it explains why: those
values were read off ONE package's drawings and describe the wrong pages against
another designator. It compared with `===`.

The model returned `24-lead QFN`. The chooser offered `24-Lead QFN`.

**One capital letter, and the entire geometry was thrown away**, after which the
product asked the user for eight numbers it had read minutes earlier off a page
it was showing them.

`pinTableFor` has always compared designators as letters and digits only, upper
case, so that `VQFN (RGE)` and `VQFNRGE` are one string. `asPackage` never got
the same rule, and neither did the line deciding which option is the CHOSEN one.
Both now use `sameDesignatorName`.

**Measured on the tuned corpus: SHIPS UNAIDED 42/57 to 44/57, 74% to 77%.**
SHIPS A BUNDLE is unchanged at 52, because those two parts were already shipping
once the user answered the questions. Which is the point: the questions were
never necessary.

The normalisation deliberately stops at spelling. `SOIC (D)` and `SOIC (DW)`
still differ, because a drawing code disagreeing is a real disagreement; only
the spelling of one name is normalised.

## Three defects, one report, and a pattern

The user asked one question, "is this truly accurate?", and it produced:

1. A sentence asserting the datasheet printed no footprint, shown beside the
   page that printed it.
2. A footprint-heading vocabulary one vendor wide, 19 lines matched and 126
   missed, fixed 4 datasheets located to 36.
3. An exact string comparison that discarded eight read values over letter case.

All three are the same shape as the pin discard the day before: **the product
had the information and threw it away, then reported the loss as the document's
fault.** None was reachable by a test. All three were found by a person looking
at the screen and refusing to believe it.

The habit worth keeping is the user's, not mine: **when the product says the
document does not contain something, open the document.**


# 2026-08-25: the plan, executed

Seven sections, each with a number that was wrong and a judge named. What the
run actually taught, over and above the numbers in `PLAN.md`.

## The oracles can judge FRICTION, not just correctness

`DIMENSION_ORACLE` was built to answer "is this number right". It answers a
second question for free, and it is the question a user actually asked: **is the
product asking me for something the datasheet already prints?**

A value in the oracle is a value a person confirmed the document states. So a
question about a field the oracle holds is provably wrong - no sampling, no
judgement, no spend. `bench:questions` is thirty lines of comparison on top of
machinery that already existed.

The reverse direction is worth as much and is easy to miss: **an absent key is a
positive statement too.** Twelve of the eighteen questions the corpus asks are
about fields a person looked for and did not find, which makes them legitimate,
and saying so is the difference between "we have a friction problem" and "we
have one friction problem, on one part, and here it is."

## A refusal channel that only covers one field covers nothing

`mergeModelValues` has reported `rejected` with a reason since it was written,
and `packageDimensions` - the path that builds a family datasheet's copper - had
no reason channel at all. Every discard on it was silent by construction.

Generalising `bench:discards` to ask "every value the model returned is either on
the record or refused by name" found 28 silent discards in one run, and behind
them three defects that had been shipping for weeks. The check is four lines of
set difference. **The instrument that finds this class is cheap; what is
expensive is not having asked.**

## Reading MORE made the product worse, twice, in the same afternoon

- RHFL4913A's `SMD5C` entry split in half because pass 2 read the drawing code.
  With no code both halves keyed the same and joined; with a code they keyed
  differently and nothing else could establish identity.
- LT1013 lost two whole packages because the model read ONE code for two
  drawings, and the merge joined on that key with no check at all.

Both are the same shape: a stronger-looking piece of evidence taken as a
shortcut past the proof. **A code match is evidence, not a licence to skip the
check** - and the check it skipped was the one that knows an 8-lead and a 14-lead
package are not the same package.

## The ordering table is not the list of packages

`packageVariants` is harvested from the ordering guide and the prose. That is one
of the two places a datasheet names its packages, and it is the one that goes
stale. 18 of 57 parts held a complete, located pin table for a package the
chooser never offered, covering 34 packages.

The fix carries its own guard, and the guard is the general statement: **an
option is a promise that picking it builds that package, and the pick is resolved
by looking the label up again.** So an offered label must resolve back to the
table it was made from, or it is not offered. That covers two failures at once -
two drawings the model captioned identically, and a caption that CONTAINS another
(`HVSSOP (DGN)` and `VSSOP (DGN)` are one drawing each).

## Correct the record, not the copper

The inner-gap fix could have gone in `printedLand`, where all three numbers are
in hand and the arithmetic is trivial. It went in the merge instead.

A correction applied at export leaves the record saying one thing and the board
another. `bench:copper` exists to catch exactly that split, and a fix that makes
the instrument lie is not a fix. Correcting on the record means the number a
reviewer signs off is the number that placed the copper, and every downstream
refusal still runs on the corrected value.

`statedMaxHeightMm` set this precedent and it is worth stating as a rule: **a
deterministic correction of a model reading belongs where the record is built.**

## Reading five drawings raised the WRONG count, and that was the point

`bench:dimensions` went from 16 WRONG to 21 while the product got strictly
better. Five drawings were hand-read for the first time, which made nine numbers
checkable that had never been checkable, and four of them were wrong.

**A number that goes up when the instrument improves is not a regression, and
reporting it as one teaches people to stop improving instruments.** VERIFIED
went 47/52 to 52/52 in the same run: every shipping part's copper can now be
contradicted by a page a person has looked at. Before this, five parts were
shipping copper that nothing on earth could have called wrong.

## Two of the five were shipping wrong copper

Which is the answer to "was reading them worth it".

- `STM32F103C8` emits 0.75 mm lands on a 6.55 mm span where its own printed
  footprint says 0.55 on 6.75. Both sum to the drawing's 7.30 mm outer extent,
  so the model split it in the wrong place - it took the corner clearance for a
  land length.
- `AD590` builds three collinear pads on a 2.54 mm pitch for a TO-52 whose three
  leads sit on a 0.050 inch grid around the can's centre.

Neither is caught by any plausibility check, because both are plausible. Only a
person reading the page catches them.

## An interrupted shell command still ran

A `git stash push` inside a rejected tool call had already executed. Twenty
minutes of measurements were then taken against a file that had silently reverted
to HEAD, and they disagreed with measurements taken ten minutes earlier on the
same code.

The tell was the disagreement, not an error. **When two runs of the same
measurement disagree, check the file before checking the theory** - this is the
second time this exact failure has cost a session (see the cwd-reset entry
above), and the fix is the same one: `grep -c` a phrase from the patch before
trusting anything measured after it.


# 2026-08-25, later: the pin-name check could not see most of its own oracle

## A green headline covering twenty unchecked entries

`PIN NAMES: 23/24 parts match the hand-read oracle` had been printed on every
run for weeks. The oracle had 44 entries. Twenty of them were never compared to
anything, and the check said so by saying nothing.

The cause: `checkNames` read `record.pins`. On a family datasheet that field is
empty BY DESIGN - a part sold in seven packages has no one pinout - and the pins
that build the symbol live in `packagesInThisDocument`. So for every such part it
found no pins, returned `namesChecked: false`, and was excluded from the
denominator.

**Exactly the defect `bench:dimensions` had until 2026-08-22**, on the identical
cause: the instrument reading the flat block while the product builds from the
per-package table. Same fix, through the product's own `recordForPackage`.

    PIN NAMES   23/24  ->  31/35  ->  34/38   as entries were added

## What it was hiding: a shipping part with every pin wrong

LT1013 ships as the S8 plastic SO. The product was emitting the **N8 PDIP**
assignment. All eight pins, on a part that ships, under a real part number.

The datasheet prints the warning inside the S8 box: "THIS PIN CONFIGURATION
DIFFERS FROM THE STANDARD 8-PIN DUAL-IN-LINE CONFIGURATION". Every name is a
real name for this device on the wrong terminal, so nothing about the symbol
looks odd and no geometric check can see it.

OPA2277 has pins 7 and 8 swapped, `V+` and `Out B`, and was hidden the same way.

## THE MODEL READ IT RIGHT AND THE MERGE THREW IT AWAY

The part worth remembering. Both passes answered for the SO package:

    pass 1   "8-Lead Plastic SO"              1:OUTPUT A 2:-IN A 3:+IN A 4:V- ...
    pass 2   "8-Lead Plastic Small Outline"   1:+INA 2:V- 3:+INB 4:-INB ...

Pass 2 is correct, exactly matching the hand read. Pass 1 had copied the PDIP's
assignment onto the SO entry - it gives byte-identical pin lists to
`8-Lead Plastic SO` and `8-Lead PDIP`.

`mergePackageEntries` prefers pass 1 for pin tables, on the stated ground that
pass 1 has the whole document and pass 2 "cannot know it is looking at a partial
table". That rule has three measured parts behind it for the FLAT field and it is
not obviously wrong. Here it discards a correct reading of a rendered figure in
favour of a text-layer reading that cannot tell which of three side-by-side
figures a label belongs to.

**Not fixed, deliberately.** Changing a precedence rule with measurement behind
it, on the strength of one part, is the tailoring RULES.md 4 forbids. The
discriminators considered and rejected: "two entries in one pass with identical
pin lists" fires on legitimate cases (a D and a DW package really do share a
pinout), and "prefer the pass that cited a rendered page" is the flat field's
rule, which per-package entries have no page to apply it with. It needs a
measurement over the corpus, not a guess.

## And five defects I nearly reported that were not defects

The first run after the fix showed ten failures. Five were the bench scoring a
pinout against a DIFFERENT package:

    AD590         ships a 3-pin TO-52   scored against an 8-lead SOIC
    RHFL4913      ships a 3-pin TO-257  scored against a 16-lead flatpack
    LM139AQML-SP  ships a 20-pin LCC    scored against a GDIP-14
    OPA333        ships a 5-pin SOT-23  scored against an 8-pin entry
    SN74LVC1G08   ships a 5-pin SOT-23  scored against a 6-pin entry

`PINOUT_ORACLE` is keyed by PART and its `packageType` was documentation that
nothing acted on. This is the third time this project has needed the same gate -
`DIMENSION_ORACLE` got `designators` after TSZ121's SC70 reading was reported as
six WRONG values that were all correct readings of a different package.

**A bench that scores the wrong package does not find a defect, it manufactures
one.** `entryDescribes` now gates on the stated package name and on pin-number
containment, and nine entries correctly drop out of the denominator.


# 2026-08-25: a check that had never run, on any part

`bench:copper` measures emitted pads back out and asks whether they match the
record. One of its four assertions is the exposed pad's ORIENTATION, added after
a thermal pad shipped rotated ninety degrees - it still fitted between the lead
rows, so nothing else could see it.

That assertion found the pad with:

    const ep = pads.find((pad) => pad.number === "EP");

`emitThermalPad` numbers the pad `pinCount + 1`. It never emits `"EP"`. **The
check had matched nothing since the day it was written.**

The file says so itself, ninety lines further up, in the comment explaining why
the lead-land checks exclude the pad:

    // `emitThermalPad` numbers the pad `pinCount + 1` and `geometryViolations`
    // requires exactly that, so it is the one identification that cannot drift.

One identification in one file, written correctly in one place and wrongly in the
other, and the wrong one was in the check.

## How it was found, and the rule

Not by reading it. By adding a SECOND assertion beside it - the pad must be the
size the record read - forcing its condition true, and getting **zero findings**.
A check that reports nothing when its condition is forced is not passing, it is
absent.

**Force every new check to fail before believing it passes.** It costs one
environment variable and one run. The same minute would have caught this one at
any point in the months it sat there reporting a clean sheet.

Both checks are now live, identified by number the way the emitter numbers it,
and both pass on the footprints that carry an exposed pad.


# 2026-08-25: the downstream audit, and the shape every defect had

Anthony's ask, verbatim: *"make sure our downstream code is fully correct and
doesnt throw anything away or refuse for no reason."* No model calls, no new
readings. Just: once a number is read correctly, does the code between the record
and the file get it wrong?

Five defects. **Four of the five were live on parts in the corpus, and every one
of them shipped a file rather than refusing.**

## What was wrong

**A metal can built as a straight line.** LT1013's 8-lead TO-5 came out as EIGHT
PADS IN A 35.56 MM ROW on a body 8.95 mm across. On a can drawing, 5.08 mm is the
LEAD CIRCLE diameter; this generator has no circular arrangement, so it was read
as a linear pitch and laid out as a SIP. The chooser offered it under two names
and both built. Nothing refused, nothing warned.

**Every single-row package drawn ninety degrees from its own pins.** `assemble`
maps `bodyLengthMm` onto Y, which is right for a dual and a quad and TRANSPOSED
for one line of pins, whose row runs along X. So a TO-220 was drawn 4.6 mm wide
and 10 mm tall with its 5.08 mm row of pins coming out of the 4.6 mm face.

**The symbol was built and never checked.** `buildSymbolGeometry` walks
1..`pinCount`, looks each number up in the pin table, and SKIPS a miss - one
`if (!pin) return;`, no note, no refusal. A gapped table therefore shipped N lands
beside a symbol with fewer pins. Every footprint check passed, because the pads
are numbered from `pinCount` and every pin the table DOES list has a land.
`types.ts` has carried a note saying `validateGeometry` cannot catch this since
2026-08-16. It could not: it was only ever shown the footprint.

**The chooser said "ships" without running the export's invariants.** It called
`buildFootprintGeometry` and stopped there, while `createExportZip` builds and
then VALIDATES. So an option whose lands overlap was offered as shipping and
refused on click, with a `FootprintInvalidError` that reads like a crash. The
paragraph directly above that call says the chooser exists so a click's outcome
cannot drift from the export's.

**A fifth reading of `pinCount + 1`.** The thermal pad's number was written out by
hand in four places. Now one exported `thermalPadNumber`.

## The shape

Not one was a wrong calculation. Every one was **a fact expressed on two axes, or
in two places, or checked on one half of a pair.** Length-on-Y against
length-on-X. Footprint checked, symbol not. Chooser builds, export validates.
`"EP"` against `pinCount + 1` last week, and the same shape again this week.

## What made them findable

Not reading the code. **Building every package in the corpus and looking at the
pads.** 100 footprints, offline, free, in about forty seconds. The 35 mm row is
obvious the moment the numbers are on screen and invisible in the source.

The one general rule that came out of it and now runs in `geometryViolations`:

    A row of leads spans at most the body they emerge from.

It fires on exactly two packages in the corpus and both are genuinely
contradictory. The tightest legitimate fit is PCF8574's VQFN (RGY) at **exactly
1.000**, which is why it compares on `>` and never on `>=`.

## The rule was wrong the first time, and the oracle is what said so

The first version had two halves. On a **single row**, refuse. On a **dual or
quad**, GROW the drawn body to hold its lands and record the discard - reasoning
that the copper comes off the printed land pattern, which measures the package
independently, so the body must be the outlier.

The reasoning is sound. **The premise was false.** `bench:dimensions` scores every
reading against a hand-read drawing, and it says VA10820's body reading of 12 mm
is CORRECT (11.88 to 12.12 on the page). The oracle entry goes further and states
outright that the drawing prints `12.40 +/- 0.10` as the extent of one lead row.

**A 12.40 mm lead row on a 12.00 mm ceramic body, both printed on the same page.**
A lead frame brazed to a ceramic body OVERHANGS it. So "a row of leads spans at
most the body they emerge from" is not a law, it is a description of plastic
packages, and growing the outline to 12.40 drew VA10820's body 0.4 mm larger than
its own drawing states. That was a defect introduced in the act of fixing one.

What survives:

- The **single-row refusal**, with its bound widened from `body` to
  `body + pitch`. The slack is the measured overhang from CQZ12805, not a number
  picked to make a test pass. LT1013 clears it by two and a half times: 35.56 mm
  against 8.95 + 5.08.
- The **body is drawn as read**, on both axes, on every arrangement.

## Two rules out of that

**A premise that sounds like physics still has to be checked against a drawing.**
"Leads come out of the body, so the row fits the body" is the kind of statement
that feels unfalsifiable and had a counter-example sitting in the oracle file the
whole time, written out in a comment.

**When a fix needs a tolerance, take it from a measurement that already exists.**
The gap between the counter-example (1.03x) and the defect (3.97x) is enormous.
Anything in between would have been invented; one pitch is what a real drawing
prints.

## The invariant space had a hole exactly where the defect was

`footprint-invariants.test.ts` walks hundreds of shapes and asserts what is true
of all of them. Its space was `sides: 2 | 4`. **There was no single-row shape in
it at all**, which is why the transpose survived. Every single-row part in the
corpus reads a SQUARE body - AD590 5.31 x 5.31, RHFL4913 10.54 x 10.54, LT1013
8.95 x 8.95 - and a square body is the one shape that cannot show a transposed
axis.

Two invariants were added there and both were proved by reintroducing the real
defect and watching them go red:

- the fabrication outline holds the lands its own rows run along, **on a single
  row only** - the general form is the false premise above
- the symbol draws every pin the footprint places a land for

## What was measured and found CLEAN, so nobody re-opens it

- **`run.ts:596`, `{...pass1.dimensions, ...pass2.dimensions}`.** A spread where
  pass 2 silently overwrites pass 1, with no comparison and no record - the same
  shape as the netlist defect fixed on 2026-08-24. Instrumented over the corpus:
  **89 joins, and pass 1 contributes zero dimensions in every one of them.** It is
  structurally a no-op, because pass 1 is not asked for per-package dimensions.
  Left alone.
- **Every "ships" option really exports.** 81 of 81 after the chooser fix, 81 of
  83 before it. The two were LT1013's TO-5 under both its names.
- **The refusal census is not full of needless refusals.** The two biggest classes
  are a 5-lead SOT-23 asking which grid position is empty, and a 14-lead QFN
  asking how the leads divide between four sides. Both are well-formed questions
  the pinout answers. Neither is a defect.


# 2026-08-26: reading all seventeen misreads against their drawings

Every one of the seventeen values `bench:dimensions` called WRONG, opened against
the page it came from. Four resolved. **Three of the four were the ORACLE, not the
product.**

## The oracle was wrong three more times

**ADXL345's seated foot.** The entry records `leadWidthMm` from the pair
`0.813 x 0.50` printed on the bottom view, and quotes that pair in its own
comment. It does not record the 0.813 half. An absent `leadContactMm` is
hard-coded in this file as a CLAIM that the drawing prints none, so the entry
asserted silence about a number it had just quoted. The product read 0.813 and
was marked wrong for it. A no-lead terminal IS the contact: it lies flat with no
bend.

**UT54LVDS217's body, twice.** The entry read `0.335 SQ` off the rendered figure
and recorded 8.509 mm on both axes. **Its own neighbours disprove it**: 48 leads
on two sides is 24 a side, and the pitch recorded two lines above is 0.635 mm
over "46 places", so one lead row spans `23 x 0.635 = 14.605 mm`. A body 8.509 mm
long cannot carry it. Retracted rather than replaced with the product's 16.002 x
9.652 - recording the product's answer as the oracle's would make this file agree
with the thing it exists to check.

That is now **four oracle defects in two days**, after STM32G071RB's "this
datasheet prints no footprint" beside two printed footprints. Every one of them
reported a correct reading as a defect.

**Check an oracle entry against its own neighbouring fields.** Pitch times lead
count against body length would have caught UT54LVDS217 the day it was written.

## The one product fix, and where it came from

**RHF310A read a 6.51-7.38 mm seated foot on a 6.48 mm body.** The prompt asks for
`leadContactMm` as "drawing dimension L", which is right on a gull-wing package
and wrong on a ceramic flat pack, where L is the whole lead tip to tip. The model
did exactly what it was told.

Dropped rather than corrected, because there is nothing to correct it to: a flat
pack ships untrimmed, the assembler forms the leads, and no datasheet can print
the foot their die makes. **The product already held that position twice** -
`leadFromDrawing` ignores this field entirely for a straight lead and takes
`formedLeadContactMm` from settings, and that setting is required before a first
run for exactly this reason. So the value was never in the copper; it was sitting
wrong on the record a reviewer signs.

Measured before writing it: ten corpus parts read `straight`, and **nine already
carry a null contact length**. The drawings do not print it.

## And the fix was silently discarding, on the first try

`bench:discards` went 0 to 1 on the next run. The drop pushed a NOTE, which is
what the user reads, and did not report into `rejected`, which is what every
instrument reads. Half-recorded is the same failure this file already has three
comments about, committed while fixing an instance of it.

**A drop reports into the merge's own `rejected` channel, not just into a note.**

## The thirteen that remain, by root cause

Five independent causes, not thirteen:

- **1 needs a feature.** AD590's TO-52 prints `0.100 (2.54) T.P.` and `45 deg
  T.P.` - true position on a bolt circle, and an angle. There is no pitch.
  `leadSides` admits 1, 2 or 4, so "leads on a circle" is unsayable and the model
  answers 1. Same shape as `leadForm` offering two of three values.
- **4 need the prompt, which cannot be verified without spending.** NCP1200
  returned `(1.35 + 1.75) / 2`; RHF1201 returned the Typ column of `2.18 | 2.47 |
  2.72`. The field says MAXIMUM SEATED HEIGHT and never says which column of a
  Min/Typ/Max table that is. LTC3105 took the lead THICKNESS where the prompt
  says "where the drawing letters them, take b" and Linear's drawing letters
  neither. TLV9061 took D for E on a SOT-23 where both are about 2.9 mm.
- **7 are readings of vector artwork with no text layer, and no deterministic
  arbiter exists.** STM32F103C8's Figure 44 prints 7.30, 6.20, 5.80, 5.60, 0.75
  and 0.55, and BOTH readings are self-consistent: `(0.55, 6.75)` and
  `(0.75, 6.55)` each reproduce a printed outer and inner extent. Only following
  the leaders settles it. TSV911 is the identical shape, with the model landing
  on 0.45 next to a terminal length of 0.425.
- **1 is ambiguous and silkscreen-only.** RHFL4913's TO-257 table prints A 10.54,
  B 10.54 and C 16.64; the model took A and B, the oracle says C is the body.

## Three ideas measured and rejected, so nobody rebuilds them

- **Tighten `verifyCitation` to demand more than a bare numeral.** Bare-numeral
  citations are wrong **0.6%** of the time - 171 correct against 1 wrong. It
  would destroy 171 good readings to catch one.
- **Refuse a land whose pad length is shorter than the terminal it sits on.**
  Both the right and wrong readings clear it on both parts.
- **Refuse a lead span that matches the body length.** Catches TLV9061 and gives
  no correct value to put there, so it converts a wrong number into a refusal
  rather than into a right answer.


# 2026-08-26: making more parts ship, without asking for more

Aimed at the friction rather than the defects: which parts do NOT ship on one
click, and why. Twelve of fifty-seven. Four general fixes took it to eight, and
the questions asked fell from eighteen across seven parts to twelve across three.

    SHIPS UNAIDED   45/57 (79%)  ->  49/57 (86%)
    questions       18 on 7 parts -> 12 on 3 parts
    false questions 1 -> 0

## The 3D body was withholding the footprint

`askForBody` wants three dimensions that ONLY the STEP solid consumes. The land
pattern comes off the pitch and the printed footprint; the silkscreen falls back
to the land extents. Yet its questions were pushed onto the same `needs` list as
the footprint's and thrown together, so **a part whose copper built perfectly
produced no files at all** because one of three outputs could not be made.

STM32G071RB was the live case: LQFP64 land pattern read, checked, correct, and
the whole bundle refused for an overall height.

Now the two are separated by what they BLOCK. A footprint that cannot be built
still fails the export, because the footprint is the deliverable. A solid that
cannot be built is omitted and NAMED, in the response, the manifest and the
record JSON, with the question still offered so answering adds it.

Two follow-ons that would otherwise have shipped broken:

- the KiCad footprint wrote a `${KIPRJMOD}/<part>.step` model path
  unconditionally, so a bundle without a solid would carry a reference to a file
  that is not in it, which KiCad reports on every placement
- `packageOptions` still called it `needs-input`, so the CHOOSER withheld a
  package the export would have delivered. Same drift this function exists to
  prevent, running the other way.

## A question the user had already answered

`shipOutcome`'s route one passed only the density level to `createExportZip`, so
LMP7704-SP and REF5025 were asked for a formed lead span and foot **that the user
answers once on the settings screen**, and were counted as not shipping.
`/api/export` has always read both off the parsed settings. The measurement was of
a product that does not exist, for the third time.

## A question with only one possible answer

An odd lead count leaves the short row one lead short, and where the gap sits was
always asked. On an ODD number of grid positions it is not a question: the leads
sit on the pitch grid and the package is symmetric about the centre line between
its rows, so the only arrangement that stays symmetric puts the gap in the
MIDDLE. Any other position leaves the row lopsided.

Corroborated by the drawing rather than assumed from it: TI's DBV0005A prints
`2X 0.95` down the three-lead side and `1.9` across the two-lead side, and 1.9 is
exactly two pitches. It cites JEDEC MO-178, where the arrangement is defined.

**Only where the slot count is odd.** Five leads give three positions and are
forced; seven give four, where two arrangements are equally symmetric and there
is nothing to derive. So SOT-23-5, SC70-5 and SOT-353 stop asking and a seven-lead
dual still asks. Three existing tests asserted the refusal on a five-lead part
and were moved to seven, which is the count they were actually about.

## Unblocking created a silent quality loss, and the checks caught it

The moment the body stopped blocking, `SHIPS` rose and **PACKAGE FAMILY fell 28/28
to 26/28 and VERIFIED 52/52 to 51/52.**

`ships` now covers two outcomes - everything built, or everything except the solid
- and both routes took the FIRST success. STM32F103C8 switched from its
hand-read UFQFPN48 to a QFN36 that merely came earlier in the list, and MC33063A
from `SOIC (D)` to an unnamed record bundle. A user choosing by hand would not
make either trade.

**A complete bundle beats a partial one, and this has to be said explicitly once
"ships" stops meaning one thing.** Both numbers returned to 100%.

Worth noting how it was caught: not by the SHIPS figure, which went up, but by two
checks measuring something else entirely. A headline that only moves in the good
direction is not evidence.

## And a refusal I looked at and left alone

Three of the remaining eight are no-lead packages whose datasheet prints no
footprint: AD8232, LIS3DH, LM139AQML-SP. `ipc7351.ts` refuses these, and the
refusal is right. Both published IPC tables were tried against two vendors'
hand-read printed patterns and **neither reproduces both**: TI's pad length
matches 3-18 and ADI's matches 3-15, and under 3-15 the centre span is 0.3 to
0.6 mm too far out on both. Picking the table that fits one of them is exactly
what got the previous no-lead rule retired.

QFN, DFN, SON and LGA are the largest modern family, so this is the single
biggest coverage gap in the product. It stays open until Altium's own IPC wizard
can settle it, because the alternative is one vendor's house rule applied to
everyone's parts.


# 2026-08-26: the wrong netlist that was not one

I told Anthony OPA2277 was "shipping with pins 7 and 8 swapped" and put it at the
top of the list as the most serious open defect. **It reads all four of its
pinouts correctly.**

Page 4 draws two figures side by side and states both columns outright:

    Out B    7 (SOIC/PDIP)    8 (VSON)
    V+       8 (SOIC/PDIP)    7 (VSON)

The VSON really does swap them. The product reads SOIC 7=Out B, PDIP 7=Out B,
VSON 7=V+ and the 14-pin OPA4277 as well: four packages, four correct
assignments.

`PINOUT_ORACLE` held ONE entry per part. OPA2277's recorded the SOIC assignment
and named no package, so `entryDescribes` applied it to whatever shipped - and
the part ships as the VSON. **A correct reading was reported as a wrong netlist
for as long as the entry has existed.**

Fixed by letting a part hold SEVERAL hand-read pinouts, each naming its package,
with the first that describes the shipped package being the one scored.

## The same shape, four more times

The remaining pin-name mismatches were the document printing TWO NAMES for one
pin, both its own words:

- STM32F103C8 pin 5: Table 5 prints `OSC_IN`, Figure 8 draws `PD0-OSC_IN`. The
  pin defaults to the oscillator and remaps to port D bit 0.
- STM32F407VG pin 12: Figure 13 draws `PH0`, Table 7's "Pin name (function after
  reset)" column prints `PH0/OSC_IN` with `(PH0)` on the line below.
- Same for pin 76: `PA14` in the figure, `PA14` + `(JTCK/SWCLK)` in the table.

The oracle read the figures; the reader takes the table cell. `pins` now accepts
a LIST of printed names, which records a fact about the document rather than
softening a comparison: a name matching none of them is still a mismatch, and
`VSS` against `VCAP_1` would never be listed together.

    PIN NAMES  36/39  ->  38/39

## The one I could not settle, and did not touch

STM32F407VG pin 49. The entry says VCAP_1; the product reads 48 VCAP_1, 49 VSS;
both agree 50 is VDD. I went to Table 7 to arbitrate and **its text layer is
mangled at that row** - names split across lines, six package columns run
together - and reading it gave a THIRD answer.

Left exactly as it was. The entry was taken from a deliberate hand read of the
render, with notes on which runs are rotated; a mangled text layer is weaker
evidence, not stronger. Copying the product's answer in would be how an oracle
stops being one.

## The rule

**Three of the last four "product defects" I have chased were the oracle**, and
this one I had already announced as the most serious open defect in the product.

Before reporting a reading as wrong, open the page and check that the ORACLE is
right. It is the cheaper half of the check and it has been wrong more often than
the product this week.


# 2026-08-26: the oracle audit, and the wrong netlist it found

Audited every hand-read entry after three of four "product defects" this week
turned out to be the oracle.

## Self-consistency: eight checks, all proved able to fire, zero findings

An entry that contradicts its OWN neighbouring fields is wrong before anyone
opens a PDF. Checked over 56 dimension entries and 49 pinout parts:

    ROW-EXCEEDS-BODY        pitch x leads-a-side against the body it leaves
    SPAN-INSIDE-BODY        a gullwing span must reach past its body
    LAND-PAST-LEADS         a land centre span sits inside the lead tips
    LAND-SHORTER-THAN-FOOT  a land is at least as long as the terminal on it
    LEAD-WIDER-THAN-PITCH   a lead cannot fill the gap to its neighbour
    PAD-PAST-BODY           a thermal pad fits inside its own body
    CLAIM-CONTRADICTED      "prints no footprint" beside a land block
    UNNAMED-AMONG-MANY      an unnamed pinout entry among named ones

Every one was forced to fire against injected entries before the clean sheet was
believed. UT54LVDS217 would have tripped the first the day it was written.

## The two failures that actually happened, checked over every entry

**`printsNothingFor: ["land"]` against the whole document.** One lead:
LM139AQML-SP, whose entry claims no printed footprint while the document has
footprint captions on pages 29 and 31. Both checked: page 29 is J0014A and page
31 is NAC0014A, neither of which is this entry's NAJ0020A. **The claim is
correct.**

**A pinout entry naming no package on a document whose packages DISAGREE.** Three
found, all the OPA2277 hole latent: ADG5412 (TSSOP against LFCSP, rotated by
two), OPA333 (SOT-23 against SOT, and SOIC against VSON) and SN74LVC1G08 (X2SON
swaps A and B). Each entry's own `source` line already named the figure it was
read from, so naming the package added no new evidence and closed all three.

## And then the real one

STM32F407VG's entry reported ONE wrong pin, 49, VSS against VCAP_1. I could not
settle it from Table 7 - its text layer is mangled at that row and gave a third
answer - so I rendered Figure 13 and looked at it.

The bottom row reads `26 PA3, 27 VSS, 28 VDD, 29 PA4, ...`. **The reader drops
pin 28's VDD and shifts every pin from 28 to 49 by one position.** Twenty-two
wrong pins on a part that ships, under a real part number, invisible to every
geometric check.

The entry was a partial one of about twenty spot checks, and they happened to
fall either side of the run: everything up to 27, and everything from 50 on.

**A partial oracle does not report a smaller version of a defect. It reports
whichever pins it happens to cover, and there is no way to tell a one-pin slip
from a twenty-two-pin shift without covering the run.** Where a figure can be
read completely, it is; that entry is now all 100 pins.

Eight more mismatches on the same part were ST's "pin name (function after
reset)" form - `PC14/OSC32_IN (PC14)`, `PA13 (JTMS-SWDIO)` - each verified as
printed before being recorded as an alternate. One of them was invisible to a
whitespace-stripped search because Table 7 wraps the cell around a footnote
marker.

## The four refusals I had never opened

All well-founded, and none a downstream defect: DF13-4P-1.25DSA is a connector
whose document carries no pin-function table, L7805 is an unbadged part number
with six package drawings and no pinout, RTAX2000S is an FPGA whose pinouts ship
as separate files, and VA41630's is in artwork the reader did not get. Three of
the four say so in their own words in the refusal.


# 2026-08-26: hold-out run

Full 59-part run against the corpus nothing here is ever tuned on. Reported as a
CONSEQUENCE only, per RULES.md: no decision on this page was taken from it.

    READ    56/59  (95%)
    SHIPS   55/59  (93%)   45 of them asked nothing at all
    cost    $2.92 this run, $57.43 of the $75 ceiling all-time

Against the last full run, 2026-08-18: **READ 50/54 (93%), SHIPS 31/54 (57%)**.

So READ barely moved, 93% to 95%, and it was ALREADY high. **The whole gain is in
SHIPS, 57% to 93%**, which is exactly what this session changed: the 3D body no
longer withholds a footprint, the settings reach route one, `vacantLeadSlot` is
derived where symmetry forces it, and a complete bundle beats a partial one.

(I first wrote this comparison against "61% and 15 of 56", which is the 2026-08-17
run and wrong in both halves - that run read 88% and shipped 18 of 58. Quoting a
stale baseline turned a 2-point reading gain into a 34-point one. Check the
baseline before claiming a delta.)

Three parts did not read: two carry no pin table the reader could get, and one is
NOT A DATASHEET - retrieval fetched the wrong document, which is a Layer 1 fault
and has been seen before.

Four read and produced no bundle, and every one of them is the SAME GAP the tuned
corpus already names: a no-lead package whose datasheet prints no footprint, so
the four land values are asked for. `ipc7351.ts` refuses to compute those because
neither published IPC table reproduces two vendors' printed patterns. This run is
the second, independent statement that it is the largest coverage limit in the
product.

Ten more shipped after answering a median of four questions.

## What the number is and is not

95% READ is the fraction of hold-out parts whose pinout and package resolved well
enough to build from, on documents chosen before any of this week's work and
never opened. It is the honest predictor for a stranger's datasheet, and it is
the first time it has been measured since the downstream audit, the shipping
fixes and the oracle corrections.

It is NOT a statement about correctness of the numbers read. Nothing in the
hold-out has a hand-read drawing, so a shifted netlist of the kind found on
STM32F407VG today would be invisible here. `bench:dimensions` is the instrument
for that and it only covers the tuned corpus.


# 2026-08-26: is the shifted netlist a class? Measured: no

STM32F407VG drops pin 28 and shifts pins 28-49. The mechanism looked general -
a rotated run in a four-sided figure - and a general mechanism would have made it
the most serious thing in the product and justified spending on the prompt. Rule
4 says enumerate the category before fixing the instance, so I did.

## The category

Of 25 parts shipping a quad pinout, most read it from a TEXT PIN TABLE, which has
no rotated runs and is not this shape. **Six read theirs from a FIGURE**, and
three of those are hold-out and stayed closed. That leaves three to check:

    MSP430F5529   80-pin LQFP, 20 a side    PERFECT
    LIS3DH        16-terminal LGA, 3-5 a side  PERFECT
    STM32F407VG   100-pin LQFP, 25 a side   28-49 shifted

MSP430F5529 is the strong result. Its figure has two rotated runs of twenty, one
of them numbered BACKWARDS (61 at the right, 80 at the left), and all forty pins
match the page exactly - `21:P1.0/TA0CLK/ACLK` through `40:P3.3/UCA0TXD/UCA0SIMO`
and `61:VSSU` back to `80:P6.3/CB3/A3`.

LIS3DH is a bottom view whose numbering runs counterclockwise from the top right,
and all sixteen are right.

**So rotated runs are not broken. One part in three is wrong, and it is the
largest and densest of them.**

## What this decides

**Do not spend on a general quad-figure fix.** The category has one member out of
three and the mechanism is not the one it looked like. A prompt change costs the
whole cache and would be aimed at a defect whose shape is still unknown.

What is known: the failure is on the biggest figure in the set, 25 labels to a
rotated run. Whether it scales with run length cannot be settled here - the three
hold-out parts of this shape sit between MSP430F5529 and STM32F407VG in size and
must not be opened.

## The method is the reusable part

Render the page, look at it, compare against the record. That found the defect,
sized the category, and cost nothing. It is now the third time this week the
rendered image settled something the text layer could not or actively lied about.


# 2026-08-27: the flaky test was the product being non-deterministic

CI went red on `a pinned timestamp makes the whole ARCHIVE byte-identical`,
`-1 !== 0`. It had failed twice locally the day before, passed on every re-run
and in isolation, and had been filed as "one flaky test, undiagnosed" for days.

**It was not flaky. The bundle was not reproducible.**

`createExportZip` writes every entry through a loop that pins `{ date: entryDate }`
- and wrote `manifest.json` above that loop with a bare `zip.file(name, content)`.
JSZip stamps an undated entry from the WALL CLOCK, so the manifest carried a
different modification time in each archive.

The comment three lines below the bug says exactly what the bug is:

    // THE ZIP'S OWN ENTRY DATES ARE PART OF THE BYTES.
    // JSZip stamps each entry with `new Date()` unless told otherwise, so two
    // archives of identical files still differ.

That fix was applied to the loop and missed the one entry written above it.

## Why it looked flaky, and why that mattered

**The ZIP date field has TWO-SECOND resolution.** Two builds inside one tick are
byte-identical; two straddling a tick are not. So the test passed roughly nine
runs in ten. `-1` rather than `1` every time, because the first archive is always
the earlier one.

A test that fails one run in ten reads as unreliable, and an unreliable test gets
re-run rather than read. It cost days, and CI runs the suite twice precisely to
catch this class.

## The fix, and a test that cannot pass by luck

One door: `addEntry` pins the date and every entry goes through it, so a later
entry cannot reintroduce this by forgetting an argument.

The byte comparison stays, but it is a poor DETECTOR. The new test asks the
question directly - **every entry's stored date is the pinned instant** - and was
proved by reintroducing the bare `zip.file` and watching it go red while the byte
comparison passed in the same run.

**When a test is intermittent, ask what resolution the thing it compares has.**
A property checked through a lossy encoding fails only when the input straddles a
boundary.

## And the rate-limiter singleton, fixed in the same pass

`waitForSlot` records attempts in a module-scoped array, never reset, twelve per
rolling minute. Every live call in `modelcache.test.ts` pushes into it, so
`under the ceiling nothing waits` was asserting that five requests take under a
second while carrying whatever the tests above it had spent. Crossing the ceiling
sleeps for up to fifty-eight seconds.

Order- AND timing-dependent: a fast machine finishes the earlier tests while their
attempts are still inside the window, a slow one lets them age out. This is the
"rate-limiter singleton" flake the CI workflow names as having shipped twice.

The file now STATES the limit it wants rather than inheriting one. Not a reset
between tests, because that would be production API existing only for the suite,
and the pacing behaviour itself is covered with no shared state at all by the
pure `slotDelayMs` tests.

---

# THE INVARIANT, 2026-08-27

The product's promise was: correct, or it tells you precisely what it could not
read and asks you for that, and the asking is rare enough that a user still saves
time. Every metric this project had published counted what we PRODUCED - fields
that came back non-null, parts that exported - and none of them answered the
question the promise makes, which is *how many of these numbers does the user
have to go and check?*

The answer was "all of them or none of them, and nobody knows which".

## The reframing that made it finishable

The goal forbids exactly ONE thing: **a value that is wrong and silent.** It does
not require reading perfectly. It requires classifying perfectly, which is
achievable outright.

So the whole product reduces to one invariant, now `RULES.md` rule 7 and
`src/lib/confirm.ts`:

> No value ships silently unless two INDEPENDENT sources agree on it. Everything
> else is put in front of the user.

and one number: **flagged values per part**, published by `npm run bench:confirm`.

## Independent means read by different MEANS

The load-bearing half, and the thing that makes agreement worth anything. A model
that misreads a rotated figure misreads it the same way twice, so a second model
call is not a second source. Every pairing shipped is a reading against a
different KIND of reading: a model against text-layer geometry, a printed drawing
against a standard's arithmetic, a pin table against a mechanical drawing.

## What the number did when it was turned on

```
                         first run     after the work
  average per part          1.72           1.53
  parts with nothing        0%             34%
  worst part                4              4          gate: never above 5
```

The gate Anthony set is five and it was met from the first run: **no part in the
tuned corpus shows more than four things to check.** The average and the clean
share are what the work moved, and they moved less than the defect list below
suggests because two of those fixes replaced a WEAK confirmation with a stronger
one that is available less often. That trade is the right one and it costs the
average: the pitch went from 23 flags to 51 the day it stopped being confirmed by
a bound that could not fail.

## Four defects the number found, all of them ours rather than the datasheets'

**1. The land-pattern comparison was stranded behind an `else`.**
`contradictsPrintedLand` ran only when the printed pattern could NOT be read, so
on every footprint built FROM a printed pattern - the strongest source we have -
nothing checked it. Both patterns are now built on both paths and the answer is
recorded on the footprint's own provenance, so the reviewer, the export gate and
the bench all read the same one.

**2. `asPackage` dropped the printed footprint and nothing put it back.**
Relabelling a record to a sibling package correctly drops `vendorLandPattern`,
because that page draws a different package's pads. Dropping it was ALL that
happened, so every package reached through the chooser arrived with no printed
footprint: **7 of 106 shipping parts carried one**, against documents that mostly
draw one per package. It is the second source for the copper and for the pitch,
so both were flagged nearly everywhere for a reason that was ours.

Fixed by locating it PER PACKAGE at parse time, where the document is in hand,
and carrying it on `packagesInThisDocument`. Not in the chooser: the chooser would
then report a corroboration `/api/export` could not reproduce, which is the exact
drift `optionFor` exists to prevent. 7 → 29.

**3. The land-pattern reader could not read a drawing dimensioned in inches.**
TI prints `8X (.061  )` with `[1.55]` on the next line. The callout pattern
required a digit before the decimal point, so every inch-primary drawing read as
a footprint with no callouts at all - and those are exactly the drawings whose
millimetres sit in brackets a few characters later.

Which of the pair is millimetres is NOT assumed and no note is parsed for it:
1.55 is 0.061 x 25.4, and that arithmetic identifies the pair on its own. A
callout with no twin on an inch-primary drawing is dropped rather than converted,
because a bag of land dimensions silently scaled by 25.4 is the worst thing this
reader could produce.

**4. The drawing was matched by its CAPTION and the caption drifts.**
DRV8825's ordering guide says `HTSSOP` and its drawing is titled `PowerPAD TSSOP`;
LM358's `VSSOP` arrives as `TMVSSOP` because the text layer folds a superscript
trademark back in. Both rejected the right drawing. Matched on the OUTLINE CODE
first now, which is the drawing's own identity and does not drift. 29 → 47.

## A bound that cannot fail is not a confirmation

The pitch was going to be confirmed by "the lead row has to fit the body". It
sounds like arithmetic and it is not a confirmation: measured over 94 correctly
read parts the row spans between **0.44 and 1.03** of its body, so a bound wide
enough to admit them all admits almost every wrong pitch, and a bound tight enough
to mean something flagged 22 correct readings.

The bound was dropped rather than tuned. The pitch is confirmed against the
printed footprint, which states it on **29 of 29** documents that print one, or it
is not confirmed at all and the user is told.

## The second reader had to be validated before it could ship

`pinevidence.ts` reads the pinout a second time from the text layer's geometry -
number columns, and the claimed name at a constant offset from each. It is a
VERIFICATION rather than a competing reader, which is what lets it skip the
genuinely hard part: deciding where a name begins and ends.

Scored against the 36 hand-read pinouts in `PINOUT_ORACLE`:

```
  confirmed and the oracle agrees      23
  CONFIRMED AND THE ORACLE DISAGREES    0    <- the outcome that would sink it
  flagged and the oracle disagrees      1
  flagged though the oracle agrees     13    <- glances we did not have to ask for
```

Zero false confirmations is the property worth protecting and it is why the
reader stops where it does. Three refinements were rejected for risking it.

**Its accusations were dropped entirely.** An earlier version named the pin the
page "really" said. All four conflicts it produced on the corpus were artifacts of
reading a ROTATED figure, where a label's reported width does not cover its glyphs
so neighbouring labels glue into one string - every one of them naming a pin the
datasheet agrees with. The invariant does not need them: it asks for agreement,
and a pin with no legible name is not agreed either way.

## Two defects in the browser bench, one cause

`bench:browser` is now in CI, which is where it found that it had been leaking a
production server on every run. `npx next start` is a wrapper: killing the handle
kills the wrapper and leaves the grandchild holding the port. The next run then
found the port taken, `next start` exited, and the bench measured the STALE server
from the previous run - serving an older build whose chunk hashes no longer
existed on disk. Eight browser problems, none of them about the code.

Both halves fixed: the server is spawned `detached` and killed as a group, and the
bench refuses outright to run against anything already on its port. **A bench that
silently measures a stranger cannot be trusted when it is green either.**

## And a per-package join that had been dropping readings

`bench:discards` found nine values on the record and unreachable. A document is
routinely read twice for one package - once where it tabulates the pinout, once
where it draws the outline - and the two readings arrived as two entries.
`pinTableFor` is a `find`, so every lookup took the first. LM317's `MPDS094A` is
read once with a pin table and no measurements and once with nine measurements,
and the nine were invisible.

Joined on the OUTLINE CODE, because a caption is recomposed on every run and one
document can print two drawings under one caption. Joining on the caption would
have merged two packages into a package that does not exist.

The first attempt then folded LT1013's 14-lead PDIP into its 8-lead one, which
share a code in the reading. Guarded on STATED lead counts - the caption's own
words and the drawing's `leadCount` - and deliberately not on the number of rows
read, because that re-split LM317's SOT-223, whose two readings returned four rows
and three for a three-lead package with a tab. **A reading disagreeing with itself
is not evidence of two packages.**

## What is still flagged, and why

Both remaining classes are honest and are named as such on the screen:

- **the datasheet prints no footprint we could find** - the pads were computed by
  IPC-7351B from the outline drawing and nothing independent checked them
- **the pinout is drawn as artwork** - there is no text layer to read it from a
  second time

For no-lead packages there is a third, and it is a limit of the STANDARD rather
than of the reading: IPC-7351B publishes its fillet goals per lead form and only
the gull-wing set is transcribed here. Saying "the package outline was not read
well enough" about a QFN would send its reader to a page that is already correct.

---

# WHAT "READY TO RELEASE" COST, 2026-08-27

Three blockers were named against a release. Two were closable and closing them
found four more defects, every one of them in the half of the product no
instrument had been pointed at: **the screen**.

## 1. Only half the mechanism had been validated against ground truth

The pinout confirmations were scored against `PINOUT_ORACLE`. The COPPER
confirmations were scored against nothing, so "confirmed" on a land pattern was
an unaudited claim. `bench:confirm` now crosses the confirmation state with the
hand-read footprints in `DIMENSION_ORACLE`:

```
  PINOUT   23 confirmed and correct, 0 false confirmations
  COPPER   15 confirmed and correct, 0 false confirmations
```

Its first run reported one false confirmation, TXB0104, and **the product was
right and the check was wrong**: `oracleFor` in `bench:copper` matches by part
NAME first, and TXB0104's name is claimed by a WQFN entry while the part ships a
SOIC. 5.4 mm scored against 2.3. The gate `entryDescribes` applies in
`pinout-oracle.ts` - compare on family and stated lead count - now applies here
too, and both benches got it.

**A bench that scores the wrong package does not report a defect, it manufactures
one.** Third time this file has recorded that sentence.

## 2. The full journey had never been run against the current code

`bench:browser -- --full` is one real model call and it earns it every time. It
found three defects in three runs, none of which any offline instrument can see.

**The settings never reached the chooser.** `/api/export` has read the
installation's settings since 2026-08-19. `/api/parse` and `/api/lookup` sent
`buildReadout` nothing, so the package chooser - which decides what the screen
asks for - evaluated every package as though the user had answered nothing. Two
of those settings ARE per-part questions settled up front. Measured: RHF1201,
RHF310A and UT54LVDS217, two questions apiece for numbers sitting in the settings
store. All three are ceramic flat packs, which is this product's market.

The same defect `shipcheck.ts` records fixing in the BENCH nine days earlier. The
bench was fixed; the product was not.

**The screen asked for eight numbers and then built the part.** The chooser only
represented the package the reading settled on when some harvested variant
happened to be spelled the same way, and an ordering guide's vocabulary routinely
differs from the drawing's - a record reading `HTSSOP (28)` against variants
reading `HTSSOP`. Where it did not match, every option went through `asPackage`,
which blanks every dimension because they describe another package's drawings -
correctly - and the screen asked for all eight.

**Thirteen parts that ship with no question at all were shown eight**, under a
verdict reading "8 numbers are needed before this can be built", directly above a
button that built it. The record's own package is now always on offer, built from
the record as it stands, which is exactly what exporting without choosing does.

**Correcting a lead span broke every subsequent export.** The correction box wrote
`Number(text)` into any field ending `Mm`. Four of those fields are `{minMm,
maxMm}` pairs, so the record became one `partSchema` rejects and `/api/export`
answered "Invalid part record" until the page was reloaded. The comment directly
above the bug said "numeric fields must stay numeric or the export schema rejects
the record at the boundary, which surfaces as an unrelated-looking failure",
which is precisely what happened, for the case it did not cover.

Only reachable once the eight false questions were gone: the bench had been
answering a QUESTION on that part and started taking the CORRECTION path instead.
**Removing friction exposed a defect the friction was hiding.**

## 3. The two panels were arguing with each other

`toCheck` said "2 values worth a glance". The review panel beneath it said "17
values read but not verified". Measured across the tuned corpus: **740 review
items over 71 parts, of which exactly ONE blocks anything.**

The panel is not deleted - it is the only way to clear a value that cannot be
located on a page, and the only way to correct one - but it no longer claims to
be a to-do list. It is titled as what it is: the reading, value by value, with
the page each came from.

## The pattern in all four

Every one lived in the gap between a route handler and a browser. `tsc`, 825
tests, and eight offline benches were green through all of them, because none of
those load a page, and the two that could have - the settings gap and the
chooser drift - were measurable offline and nobody had thought to ask.

**When an instrument finds nothing for a while, the question is not whether the
product is clean. It is what the instrument cannot see.**

---

# THE FOURTH ARRANGEMENT, 2026-08-27

Anthony's challenge, in his words: *"why is this not possible for us to read if we
are just having an LLM read it? why are we forcing ourselves to only read in a
certain way and refuse for everything else."*

He was right and the framing I gave him was wrong. **Reading was never the
blocker.** The refusal message said so in its own words - "the pinout was read
correctly, but every terminal is addressed by grid position" - and I described it
to him as a reading limit twice before opening the file.

## The real split, and the thing that leaked

Reading is general; generating is hand-written code that only knows the shapes
somebody wrote. That split is deliberate and stays: a model that draws copper
directly is auditable at neither end, because there is no number in the middle to
check anything against.

What was NOT deliberate is that the generator's assumptions had leaked backwards
into extraction. A pin had to be an integer at `normalizeModelPins`, before
anything geometric happened, because the placer counts pads. So a perfectly read
BGA pinout was destroyed at the door and the screen reported the datasheet as
unreadable.

**UT32M0R500 went from zero pins to 143 by deleting that assumption.** Two other
defects fell out of the same line: every grid terminal was also being flagged as
an exposed thermal pad, so a BGA would have carried a phantom pad; and the
confidence check "pin table matches the pin count" reported 0 of 143 for a pinout
that is entirely correct.

## Refuse late, on the narrowest thing

The rule this establishes, and the codebase already had one instance of it: the
exposed pad, recorded rather than fatal since 2026-08-10.

A missing capability should cost you the ONE output it affects. A grid array now
costs a footprint and nothing else - the pinout is on the record, the review panel
works, and the symbol builds. Checking that the symbol actually built is what
caught the promise being false: `buildSymbolGeometry` split pins with
`dualRowSides`, which counts 1..N, so on a BGA every lookup missed and the symbol
came out EMPTY. **The claim was written before the code was true.**

## Then it turned out to be buildable

Having said "not built" honestly, building it took an afternoon, because a BGA
footprint is the simplest geometry in this codebase: circles on a regular grid.

THE GRID IS FREE. The designators state it. `A1` through `M12` is thirteen rows
of twelve, nothing is counted and nothing is asked. The one thing needed is the
land diameter, which the datasheet prints, and where it does not this asks for
one number.

**The row letters are the part with teeth.** JEDEC's alphabet omits I, O, Q, S, X
and Z because they read as digits or as each other, and the letters are
POSITIONAL. Ordering the rows a part happens to have would place them correctly
only while none is missing - and a depopulated grid, a BGA with a row left out
under the die, is normal. Every ball after the gap would be a pitch out of place,
on a board that looks correct.

`LP5907 ships as a DSBGA`, the first ball-grid array this product has built.

## Two arrangements measured and NOT built, with the numbers

**Radial cans (TO-5, TO-18, TO-99).** Four corpus parts offer one and all four
ship as another package, so nothing is blocked. Building it needs a lead-circle
diameter, which is not a record field, which means a prompt change, which
invalidates 2400 cached model answers and costs a full corpus and hold-out
re-read. Not free, and not blocking anything.

**AD590 ships as a can and its footprint is wrong**: three plated holes in a
straight line at 2.54 mm for a package whose leads are on a circle. The pitch is a
misread - `bench:dimensions` has been reporting `WRONG AD590 pitchMm read 2.54,
expected the drawing states none` - and `DIMENSION_ORACLE` records why: the
drawing prints `0.100 T.P.`, a true-position note, and reading it as a lead pitch
builds three collinear pads for a triangular package.

The invariant already puts that pitch in front of the user, which is what it is
for. Fixing it properly is a READING problem, not a generating one.

**No-lead computed land patterns. NOT A GAP, and putting it on the list was the
mistake.**

It went on the list of things to build when the five arrangements were first
sketched, which was before anything was measured. Measured afterwards:
**not one refusal in either corpus names it.** Thirteen tuned parts carry
`land-pattern/no-ipc-model-for-lead-form` and all thirteen SHIP, from their
datasheet's own printed footprint. It costs a corroboration, not a footprint.

Having measured zero, I then wrote two messages explaining how to obtain
IPC-7351B. Anthony's reply: *"i just dont understand why you need this so
badly."* He was right. **An item that has failed its own test gets dropped, not
defended.** It comes back if a design partner hits it and not before.

The reason it is still worth a paragraph: the reasoning that would be needed IF
it came back is real and easy to get wrong. Its fillet goals are published per
lead form, only the gull-wing set is transcribed here, and the previous attempt
reverse-engineered the no-lead set from four TI drawings and shipped one vendor's
house rule to everybody. Writing those numbers from recall would be worse: it
would look authoritative and nothing could check it.

## What "generate everything" actually means

There are five arrangements in the world and this now builds four.

```
  leads on 2 sides   SOIC, TSSOP, flatpack, DIP    yes
  leads on 4 sides   QFP, QFN, LQFP                yes
  leads on 1 side    SOT-223, TO-220               yes
  grid underneath    BGA, LGA, CSP                 yes, 2026-08-27
  leads on a circle  TO-5, TO-18 cans              measured, not blocking
```

It is a closed list, which is worth saying out loud: "we support a subset of an
infinite space" was never true, and believing it is what made the gap feel
unfixable.

---

# THE RULES APPLY TO THE CODE I WRITE, 2026-08-27

Anthony: *"so when i ask you to follow the rules, you just ignore me?"*

Not ignored. Applied to the code being REVIEWED and not to the code being
WRITTEN, which is worse, because it looks like compliance.

## What was actually broken

**Rule 1, do not invent.** `pinevidence.ts` shipped with nine constants -
`COLLINEAR_TOLERANCE_PT`, `OFFSET_TOLERANCE_X_PT`, `MIN_PAGE_AGREEMENTS`,
`SAME_PINOUT_THRESHOLD`, `WORD_SPACE_RATIO`, `MAX_RUNS_PER_NAME` and others -
every one chosen because it worked on the corpus in front of me and then defended
in a paragraph of prose. Rule 1 says name the source. A well-argued comment is
not a source; it is the argument you make when you do not have one.

That is tailoring, spread thin enough across a file to look like design.

**Rule 2, do not assume.** Told Anthony the footprint refuses a grid array "but
the symbol can be built", while `buildSymbolGeometry` was splitting pins with
`dualRowSides` and returning an EMPTY symbol for one. Told him twice that BGAs
were a reading limit without opening the file whose refusal message says "the
pinout was read correctly, but".

## The fix is a sweep, not an argument

Every constant was made overridable, and each swept across its plausible range on
all 107 cached parts, scoring two things: how many pinouts come back fully
corroborated, and how many of those the hand-read oracle DISAGREES with.

```
                     value         confirmed     FALSE CONFIRMATIONS
  COLLINEAR_PT       2 / 4 / 8     71 / 72 / 66      0 / 0 / 0
  OFFSET_X_PT        6 / 12 / 24   66 / 72 / 75      0 / 0 / 0
  OFFSET_Y_PT        2 / 3 / 5     70 / 72 / 72      0 / 0 / 0
  SAME_PINOUT_THRESH 0.5/0.75/1.0  73 / 72 / 71      0 / 0 / 0
  MIN_PAGE_AGREE     3 / 4 / 6     72 / 72 / 72      0 / 0 / 0
  WORD_SPACE_RATIO   0.4/1.2/2.5   70 / 72 / 72      0 / 0 / 0
  MAX_RUNS_PER_NAME  3 / 6 / 10    71 / 72 / 72      0 / 0 / 0
```

**Not one setting of any constant produces a false confirmation.** They trade
coverage and nothing else. That is now the answer to "name the source" for each
of them, and every comment states its own band: not "this felt right" but
"measured over 107 parts, flat from here to here, and it cannot make a
confirmation wrong."

## Two of them were worse than unsourced

`SAME_PINOUT_THRESHOLD` moved the result by ONE part across its entire range,
0.5 to 1.0. A constant that spans its whole range for one part is not carrying
the check, it is decorating it. **Deleted, and the strict end kept as a rule with
no number in it:** a page that draws a name this record does not have, for a pin
it does have, is not the pinout we are holding.

`MIN_PAGE_AGREEMENTS` changes nothing at all - 3, 4 and 6 all give exactly 72.
Kept, and the comment now says so outright: it is a floor against coincidence
that has never fired on any real part, which is the same thing `bench:guards`
reports about plausibility guards and is worth knowing rather than hiding.

## And one measurement that must NOT be acted on

Widening `OFFSET_TOLERANCE_X_PT` from 12 to 24 buys three more corroborated parts
with zero false confirmations. It stays at 12.

Coverage measured on the tuned corpus is exactly the evidence the hold-out rule
exists to distrust: a window twice as wide is twice as likely to reach a name
belonging to something else on a document nobody has seen. **A sweep that says
"looser is free" on the set you tuned against is the most persuasive form of the
mistake, not an exemption from it.**

## Then Anthony asked whether ALL of it was general, and the audit found three more

Two tests, run over every module touched this session.

**Does a part number or a vendor reach executable code?** No. Scanned with block
comments stripped: zero hits across eleven files. Every part named in this
codebase is in a comment explaining WHY a rule exists, which is the right place
for evidence and the wrong place for a rule.

**Are the bounds fitted?** Three were, and one of them was worse than anything in
the sweep above.

`TWIN_WINDOW = 48` decided how far past an inch callout to look for its
millimetre twin on a dual-dimensioned drawing. Swept over all 57 cached
documents, **8, 16, 48 and 200 characters each produced a DIFFERENT set of land
dimensions.** A tuned number moving emitted copper is the worst version of this
mistake, and it survived the first pass because I listed it as invented and then
never swept it.

Replaced with structure and no number at all: a callout's twin is the bracketed
value that appears before the NEXT parenthesised callout. That is what "this
dimension's twin" means, and it holds at any distance. Verified against the
hand-read footprints - `bench:copper` clean, `bench:dimensions` clean, the
flagged-per-part number unchanged.

The trademark strip carried a `>= 4` length guard, fitted to the one title that
prompted it, and it was a real hazard: a package code beginning with those two
letters would have been truncated into a different token. Replaced by trying the
token AS PRINTED first and the stripped form only as a fallback, which needs no
bound and cannot truncate anything.

**One that is still partly fitted, and is left that way deliberately.** The
hyphen rule in `pinNameAlternatives` splits `PC14-OSC32_IN` into alternatives and
refuses to split `V-`, because a trailing hyphen is a SIGN and splitting it would
free a bare `V` to agree with `V+`. The principle is general typography; the
character counts in the regex came from the examples. It is covered by fourteen
named cases in `pinevidence.test.ts`, including every sign case, and tightening it
further would be tuning against the same corpus. Recorded rather than polished.

## The rule this leaves

Before shipping a constant: sweep it, publish the band, and say what it trades.
If the outcome is flat across the range, say that - it is a real answer. If the
constant changes nothing, say that too, or delete it. If it changes the OUTPUT,
it is not a constant, it is a decision, and it needs structure instead. What is
not allowed is a number with a paragraph.

And the audit is two greps, so it is cheap enough to run every time: no part
number in a code path, and every bound swept.

---

# 2026-08-28: the overlay, and three instruments that could not see each other

## Nothing had ever laid the lead on the land

Every check in this repo compared a number to another number. The pinout against
a second reading of the pinout, the printed land against IPC-7351B's arithmetic,
the emitted copper against the record it came from. Not one of them took the
physical lead and the physical pad and asked whether there was metal underneath.

`leadWidthMm` was read on 39 corpus parts and used in exactly two places, both of
them band arithmetic on the toe-to-toe extent. **Nothing in the project had ever
compared a lead's width to the width of the copper it lands on.**

`src/lib/solderjoint.ts` does that now. It found ADXL345 emitting 0.25 mm lands
under 0.50 mm terminals: less than half the width, on a part shipping four files.

## And the reading was already known to be wrong

This is the part worth remembering. `bench:dimensions` had

```
WRONG ADXL345  CC-14-1  landPadWidthMm  read 0.25  expected 0.55
```

on every run, against a hand-read entry whose own comment quotes the correct
0.55. The part shipped that copper anyway, because `bench:copper` compares the
emitted pads against the RECORD, and the record was consistently wrong. One
instrument knew and the instrument next to it could not hear it.

Same shape as `forge-we-had-it-and-threw-it-away`. **When two instruments measure
adjacent halves of one question, check what happens when one of them says no.**

## The bar was measured, and the first formulation was wrong

The first version compared fillets against zero and reported 22 of 60 correct
footprints as defective, including eleven SOIC-8s: JEDEC MS-012 tolerances the
seated foot from 0.40 to 1.27 mm, and a fillet computed from the LONGEST span and
the LONGEST foot at once describes a lead that cannot exist.

The fix was to evaluate at each CONSISTENT corner of the tolerance box and ask
what FRACTION of the foot lands on copper. Then the sweep, which `bench:joints`
now re-runs on every invocation rather than trusting a number in a comment:

```
bar    as built   land span x0.1   axes swapped   sibling land   inches   lead span x0.1
0.95     24/62         0/50            2/52          14/63        8/57       51/51
0.80     17/62         0/50            2/52          14/63        8/57       45/51
0.70      3/62         0/50            2/52          14/63        8/57       44/51
0.60      3/62         0/50            2/52          14/63        8/57       44/51
```

The correct population falls off a cliff between 0.80 and 0.70 while every
injected-defect column stays flat. That is what a real separation looks like, and
it is why the bar is 0.6 and not a number anybody argued for.

## It flags. It does not confirm. `bench:confirm` proved why

Wiring the overlay in as a second source for the copper looked obviously right:
it needs no fillet table, so it covers every QFN, DFN, SON and LGA, which are
exactly the packages whose land pattern carries a permanent unfixable flag. The
flagged average went 1.57 to 1.17 and parts with nothing to check went 33% to
38%.

And `bench:confirm` reported the project's **first false confirmation on the
copper**: STM32F103C8's UFQFPN48 emits a 6.55 mm centre span where the datasheet
prints 6.75. Every terminal still sits entirely on its land, so the overlay was
perfectly happy about a footprint 0.1 mm out of position on every pad.

**Proving the joint will form is not proving the pattern was read.** They are
different claims and only one of them is what the confirmation is labelled. The
overlay is consulted for disagreement only, and the 1.57 came back.

Worth stating plainly because the improvement was real, the reasoning was
plausible, and it was still wrong. The measurement is what caught it.

## An independent third source exists and is free

KiCad's official footprint library is generated by their own IPC-7351 tooling
from JEDEC and vendor data, by other people, with no knowledge of this project.
`bench:published` matches our footprints to theirs on pin count, pitch and body
size (never on package NAME, which is a coin toss) and compares pad for pad.

48 of 64 matched. Ours minus theirs:

```
span    median  +0.100   range -0.250 to +0.550
length  median  -0.100   range -0.430 to +0.450
width   median   0.000   range -0.350 to +0.070
```

Zero gross outliers, and the worst width disagreement in the whole set is
ADXL345 at -0.350: a third, fully independent source landing on the same defect
the overlay found.

**Its first run reported a defect that was the instrument.** A 20-pin TSSOP has
ten lands a side at 0.65 mm, so its row is 5.85 mm long and its centre span is
5.85 to 5.90. Deciding the lead axis by which one is WIDER is a coin flip there,
and it picked x for our file and y for the published one, reporting LM5117 with
its land length and width almost exactly exchanged. That is precisely what a real
rotated land looks like. Deciding by pad SHAPE instead is not degenerate, because
a land is long in the direction its lead runs on every footprint either generator
produces.

Fourth time an instrument has manufactured a finding. Validate the instrument.

## One definition of READ, in one file

`classify` lived in `holdout.ts`. A second blind corpus needed the same question
answered and copying it would have given the project two definitions of "read",
which is exactly how `SHIPS` came to have two and how one of them quietly
measured something the product does not do. It is now `readclassify.ts` and both
benches import it.

## The hold-out rule held, and it cost something

Three parts flagged by the new check are hold-out parts. ADXL345 could be settled
without opening anything, because a hand-read entry for it already exists in the
repo. The other two could not, and they are reported as flags with no diagnosis
rather than opened.

That is the rule working as intended. **A finding you cannot chase is still worth
having.** The product's job is to put it in front of the user, and it does that
without anyone knowing which side is right.

---

# 2026-08-28, later: what a stranger found in thirty seconds

A subagent with no context, told only that it was an engineer who needed a KiCad
library for an OPA333, drove the running app with Playwright and looked at the
screenshots. It got a correct library out. Everything below is what it found on
the way, and every item was verified against the code before being acted on.

## The verification panel was blind, and it is the whole product

"Show the full record" reported **every dimension as "not read" and PINS 0** for
a part whose exported JSON carried all of them, under a green banner reading
"Ready to build. Every value was agreed by two independent readings."

Confirmed in one command: OPA333's flat dimension block is null in every field
while its five per-package entries carry seventeen cited dimensions each. The
panel rendered `part.dimensions`; the product builds from
`packagesInThisDocument`.

**`bench:dimensions` had this exact bug and was fixed on 2026-08-22.** It scored
27 of 27 hand-read comparisons as "not read" for the same reason. The bench was
fixed and the SCREEN was not, for six days, while being the one surface a user
is asked to trust. See `shownRecord` in `review.ts`.

Their words, which are the reason this is the top entry: *"the panel is the
entire reason an engineer would use an AI tool for this, and it is blind"*, and
*"I only trust this footprint because I unzipped the archive and checked it
against the datasheet myself, which is the work the tool was supposed to save
me."*

## Two lists of packages, and the screen read the weaker one

The chooser said "2 were read from this datasheet" and offered two. The record
held **five** located package tables, and `packageOptions` builds a complete,
shipping bundle from every one.

`packageVariants` is a scan of the ordering table's text. `packagesInThisDocument`
is one entry per package the reader located, with its own pin table, outline
drawing and printed land pattern. Three OPA333 packages a user could have had -
SC70, VSON, VSSOP - were never offered, and the heading stated a falsehood about
the document while doing it. Same shape as
`forge-false-claims-about-documents`.

## The screen that enforces RULES.md 1 caused the invention it forbids

Two forming-die numbers had to be answered before ANY datasheet could be read.
The engineer hit it on a plastic SOT-23, could not answer either, and **made two
numbers up** to get past it.

Measured with both fields blank: all five OPA333 packages still ship, and
RHF310A - a ceramic flat pack - comes back `needs-input` naming those two fields
precisely. The product already asks when a part needs them. The gate was pure
friction and is gone.

**The button that enforced it looked enabled and did nothing**, with the reason
in grey text at the foot of the window. A primary action that silently refuses is
worse than a disabled one.

## The benches measured a record the product does not build

`withPrintedFootprint` locates the page a datasheet prints its own footprint on.
`buildReadout` calls it, so `/api/parse` and `/api/lookup` both hand downstream a
record that knows. `bench:blind` and `bench:holdout` called `shipOutcome` on the
raw record and therefore scored a different record from the one a user gets:

```
                              before        after
blind corpus, flagged/part     2.33         1.73
blind corpus, nothing to check 0/30         6/30
hold-out, flagged/part         1.82         1.40
```

Nothing about the product changed. `oracle-match.ts` had it right and the other
two did not, which is `forge-ships-two-definitions` in the instruments.

## A bus range is not a pin name

UT7R995, a Frontgrade 48-lead ceramic flat pack read blind. Its Figure 1 prints
`4F0` at pin 1, `3Q1` at pin 8, `DS0` at pin 22. Eighteen of forty-eight names
came back as three range templates - `nF[1:0]`, `nQ[1:0]`, `DS[1:0]` - copied out
of the pin-description table, where one row legitimately covers several pins.
Eight outputs shared one name. A schematic built from that symbol shorts them.

Cannot be repaired by expanding the range: the template is `nQ[1:0]` where `n` is
the bank, so `3Q1` is not recoverable from it. The information is not in the
string. So the NAME is dropped and the number kept, which leaves thirty correct
names and eighteen honest blanks.

Measured on the live pipeline across both corpora before shipping: **1 of 89
records with a pinout carries one.** Zero correct records are touched.

The pinout was already FLAGGED, so the invariant held and no wrong netlist was
ever confirmed. That is the safety net working, and
`forge-refusal-bar` applies: refusing is not an achievement, so the names are now
read correctly or not at all.

## An outside footprint library catches what our own instruments cannot

`bench:published` compares our pads against KiCad's official library, matched on
pin count, pitch, body and LEAD FORM. On the last sweep it flagged `tps7a8300`:
a VQFN-20, 5x5 mm, 0.65 mm pitch, emitting a 3.90 mm centre span where the
tuned corpus's TPS7A4700 - the same package, same body, same lead span, same
0.75 x 0.31 land - emits 4.65.

The lead-on-land overlay scored it 0.61 against a bar of 0.60 and let it through.
Two instruments, different sensitivities, and the second one caught it. The
product flags that land pattern twice and cites page 41, so nothing shipped
silently.

## The rule that keeps paying

Five instruments manufactured a finding today: the joints check twice (mixed
tolerance extremes, then a cross-axis fallback), the published comparison twice
(a degenerate axis test, then a QFN matched to a QFP), and the confirmation
wiring once. **Every one was caught by looking at the finding instead of acting
on it.**

And one check could not fail: the first blank-settings browser stage asserted the
moment a file is CHOSEN, while the gate fires when Read is CLICKED. It passed
with the defect deliberately put back. It now presses the button with a file that
is not a PDF, so the route refuses on the bytes and no model call is spent.

---

# 2026-08-28, third pass: two values read correctly and thrown away

A blind reader was given rendered pages from six blind-corpus parts and told
nothing. 161 of 177 pin names matched what we emit. Chasing the sixteen that did
not, and one aside in its report, found two defects that had nothing to do with
reading.

## Five of five QFNs shipped with no thermal land

The reader mentioned in passing that four of its six parts have a centre pad.
Checking that against what we emit:

```
dac81404    thermalPad 3.45 x 3.45   exposedPad false   land emitted NONE
di-AP7361C  thermalPad 2.25 x 1.50   exposedPad false   land emitted NONE
ti-lp5890   thermalPad 6.30 x 6.30   exposedPad false   land emitted NONE
ti-tps1663  thermalPad 2.70 x 2.70   exposedPad false   land emitted NONE
lmk04828    thermalPad 7.20 x 7.20   exposedPad false   land emitted NONE
```

**The dimensions were read correctly, cited, and sitting on the record.** The
boolean that decides whether to emit the land was set from ONE source: a row in
the pin table naming itself a pad. Most no-lead drawings do not give the pad a
numbered row - they dimension it D2 x E2 on the bottom view - so the flag stayed
false beside its own measurements.

On a QFN the exposed pad is the heat path and usually a required ground. Every
one of those footprints was unsolderable as the part intends.

The implication is not an inference, it is one fact stated twice, and this file
already enforced the converse: `thermalPadLengthMm`'s doc comment says
"`exposedPad` without these is still a refusal". A boolean contradicting two
cited dimensions off the same drawing is simply wrong.

**It had to be fixed in TWO places.** `merge.ts` fixed the flat record and moved
two of the five. `asPackage` overrides the flag per package, so the other three
still shipped bare until the same rule was added there. A per-package override
that drops a fact the record established is the third instance of that shape
today; see `shownRecord` and the package chooser.

## Every pin ever emitted was `unspecified`, and the model was answering

Two independent reviewers reported within an hour of each other that KiCad ERC
has nothing to work with. The cause was one line:

```ts
// coercePinRows destructured row.electricalType, then:
electricalType: "unspecified",
```

The answer was read and discarded unconditionally, at the parse boundary.

**And the model had been answering all along**, in the datasheet's own
vocabulary, because that is what a faithful reader does:

```
TPS23881   I, I/O, O          UCC21750   I, O, P
TPS548B22  G, I, I/O, O, P    and Ground, Input, Power on another page
UT7R995    Power, LVTTL, 3-Level, N/A
```

None of those are in `pinElectricalTypes`. The prompt asked for the field and
never named the values it would accept - `forge-unanswerable-question` again,
the same shape as `leadForm` coming back null for 37 of 81 parts because the
prompt offered two of its three legal answers.

**Mapping the vocabulary is free; tightening the prompt would cost a re-read of
the whole corpus**, because the cache key is the prompt. So the industry's
spellings are mapped onto the enum and the ~2,400 cached answers are read as
they stand. `LVTTL` and `3-Level` stay `unspecified`: a logic family describes
the standard a pin speaks, not whether it drives.

**Fixing the parser alone changed nothing.** `normalizeModelPins` had its own
strict enum check and dropped the value at the next gate. Two gates asking one
question in two vocabularies, and only fixing both moved a single pin. The
mapping now lives in `types.ts` beside the enum, with one caller each side.

## And the lint caught what the tests could not

`case "oc":` twice in one switch. Harmless, and `no-duplicate-case` is the only
thing in the toolchain that would ever have said so. Run the linter.

---

# 2026-08-28, fourth pass: the second pass was overwriting the better read

## Two readings of one pinout, and the worse one won

`combine` merged the two extraction passes with `{...first.values, ...second.values}`,
so pass 2 won every field. One guard existed for the pinout: keep pass 1 where
the two cite DIFFERENT pages. Where they cite the SAME page and disagree about
the names, pass 2 won silently.

UT54LVDS032, a Frontgrade rad-hard flat pack:

```
pass A   RIN1-  RIN1+  ROUT1  EN  ROUT2 ... EN̅      16 distinct, 0 collisions
pass B   RIN-   RIN+   ROUT   EN  ROUT  ... EN       6 distinct, 10 collisions
```

We shipped B. Four outputs shared one name, and **enable and enable-bar were the
same net.** A blind reader shown only the rendered page confirmed the document
prints the specific names.

## The obvious rule was the wrong rule

"Prefer pass 1, it saw the whole document" is what the existing guard's comment
argues and what I was about to write. `bench:passes` says it is wrong: of the 27
parts whose two passes disagree, five differ on how many nets they collapse, and
**pass 2 is the better read on two of them** - UT54LVDS031 reads `DIN/DOUT+` on
one pass and `DIN1/DOUT1+` on the other, the right way round.

The rule that survives measurement is about the READING, not about which pass
produced it: **between two readings of the same part, prefer the one with fewer
NAME COLLISIONS.** A collision is two pins sharing a name. On its own it means
nothing, because a part really does have four pins called GND. Between two
readings of the SAME pinout it means everything: the one with more has merged
nets the other kept apart.

```
fg-ut54lvds032    0 collisions vs 10      RIN1-/ROUT1   over  RIN-/ROUT
ut54lvds031      10 collisions vs  0      DIN1/DOUT1+   over  DIN/DOUT+
ut7r995_3        16 collisions vs 31      4F0/3Q1       over  nF[1:0]
ti-tps25990       0 of 4 pins vs 6 of 26  the fuller table
lmk04828          2 of 65 vs 2 of 64      the one carrying DAP
```

The other 22 disagreements are level on the measure - typography, or fuller
alternate-function names - and keep the previous behaviour exactly.

**This also dissolved the bus-range defect at its source.** UT7R995 now reads
`4F0, 4F1, sOE, PD/DIV...` straight off the figure. The `nF[1:0]` template names
came from the pass that lost, so the rule added earlier that morning to blank
them never fires on this part. It stays, because it is about what a pin name IS
rather than about which pass wrote it.

## And the scan that found nothing real

A sweep for non-ASCII pin names reported 15 of 128 records carrying `V–`,
`−IN A`, `IN A⁻`. Every one was an artifact: the sweep read REPLAY records, which
are reassembled from the cache and never run `normalizeModelPins`, so
`asciiSigns` had not been applied. On the live path all of them are already
`V-`, `-IN A`, `IN A-`.

Sixth instrument today to manufacture a finding. The tell each time was the same:
the finding was too tidy, and one live check dissolved it.

One real residue: UT54LVDS031 emits pin 12 as `ÈÀǸ`, an overbar mangled into
grave accents. One pin, one part, 128 records. Recorded, not built for - a rule
fitted to a single instance is what RULES.md 4 forbids.

---

# 2026-08-28, fifth pass: the citation that belonged to another package

A rad-hard engineer drove the product on two ceramic parts. RHF310A came out
correct in five steps and they said so. LM139AQML-SP could not be completed at
all, and on the way they found the worst defect of the day.

## One page cited by three different packages

`printedFootprintFor` asks `findUnreadableFootprint` for the page a package's
footprint is drawn on. That function ends:

```ts
return drawings.length === 1 ? drawings[0]! : null;
```

with a comment defending it: "One candidate is not a choice, so there is nothing
to guess between." True of a document that sells one package. **False of one
that sells four**, where attributing the single drawing found to all of them is a
guess and wrong for at least three.

Measured on LM139AQML-SP:

```
LCC      NAJ0020A   20 terminals, four sides    ->  page 31
CFP      NAD0014B   14 leads                    ->  page 31
CERPACK  NAC0014A   14 leads                    ->  page 31
```

Page 31 is NAC0014A. The screen rendered it beside four questions about the
twenty-terminal LCC and told the user to read the numbers off it.

Their verdict, and the reason this outranked everything else in their report:

> "A wrong-copper defect delivered through the guided path, wearing a page
> citation that looks like traceability... everywhere else its honesty is its
> selling point. That makes the one bad citation far more dangerous than a plain
> error, because the whole product trains me to trust the page next to the
> number."

**A citation is a claim, and a wrong one is worse than none** on a product whose
entire pitch is that you can check it.

Fixed two ways. The lone-drawing fallback now requires the document to describe
ONE package. And a package's own outline code is matched against the text of the
candidate PAGE - not a sixty-character window before the heading, which found the
code on none of these four sheets, because a drawing prints its code in a title
block below itself. Result: LCC and CFP now correctly say they have no page, and
CERPACK correctly recovers 31.

Coverage unchanged either side: READ 95%/84%, SHIPS 93%/70%, 0 false
confirmations.

## Three smaller ones, all of them the screen lying quietly

- **Every millimetre answer box was pre-seeded `1.55`** - the same hint for a
  seated foot (plausible) and a toe-to-toe span (impossible on an 8-lead flat
  pack). "An invitation to type a wrong number." Now the unit, never an example.
- **A refusal told the user to open a section called "Worth a look".** No section
  on the page is headed that; the list is "The reading" and a different one is
  "Worth a glance". For their part the list was not rendered at all, so the
  sentence was a dead end twice over. A refusal that tells someone to do
  something they cannot do is a refusal with no way out.
- **"All 2 runnable consistency checks passed"** on a record where the manifest in
  the same bundle said "2 of 8 checks passed, 6 could not run" - and the six
  included the two they cared about. The screen counted passes and called them
  all. What could not run is part of the answer.

## Still open from that report, deliberately

Named here rather than fixed, because each needs measuring first: the package
cards' "cannot build" badge appearing on packages that build; `OUTLINE` blank on
the record while the card displays the code; a pin shipping as `NC(1)` with a
footnote marker in its name; the formed-lead numbers living only in one browser's
`localStorage` and appearing nowhere in the export, which makes them
un-auditable; and non-determinism across identical reads of one PDF.

---

# 2026-08-28, sixth pass: the same document, two different answers

## It was not the model, and it was not sampling

A rad-hard engineer read one PDF three times and got a package list of 2 cards,
then 4, then 5, with the real flat pack missing from one run, and one part's
mounting reading `smd` and then blank.

The obvious causes were both wrong. Temperature is already 0 in every model
adapter. And `bench:repeatable`, written for this, runs the same document three
times with every model answer replayed off disk: **100 documents, 3 passes, every
record and every emitted footprint byte-identical.** Our half does not drift.

## The route was silently degrading, and timing decided when

`/api/parse` treats a drawing-pass FAILURE as a retryable 503 - the record is not
handed back half-built. A TIMEOUT did the opposite: it kept the deterministic
record, appended a note saying nothing was read, and returned 200. The screen
then said "Ready to build".

Two measured facts make that untenable together:

    the parser ALONE scores READ 0 of 59      `bench:holdout` without --model
    which branch runs is decided by the clock  a slow call, a loaded model

So the preserved record is not a thinner answer. It is very nearly an empty one
wearing a success, and whether the user gets it depends on how busy the model was.
That is the whole of the non-determinism.

The rule was already written in that same file, one branch up - Anthony's call,
2026-08-20: *"a caveat on the deliverable is worse than useless, because it makes
the user check everything and that is the job they came here to avoid. Either
files nobody has to second-guess, or 'we could not read it, try again'."* It was
applied to the error that prompted it and not to the timeout, which reaches the
identical state. Both now return a retryable 503, as does the branch where
retrieval ate the budget before the model was ever called.

**A rule written for one branch is worth checking against every branch that
reaches the same place.**

## The provenance named the wrong source

A straight-lead package has no seated span or foot on any drawing; both come from
the settings screen. The bundle said "computed from this datasheet's own package
drawing" - false for exactly the packages that are most of this product's market,
and it was the only provenance in the file. The engineer's two numbers, 9.40 and
0.90, appeared nowhere in the zip, the JSON or the manifest. "Un-auditable."

Now the source line names them and says whose they are. Two defects in one
sentence: a false claim about where the copper came from, and the absence of the
inputs a reviewer needs to reproduce it.

## The badges were honest; the banner was not

Reported as "the package cards are inverted - every card badged 'cannot build'
selects fine and reports Ready to build". Half right, and the half matters.

`resolveForExport` refuses LM139AQML-SP's whole record, so all four "cannot
build" badges are correct. The lie was the headline above them: the verdict
consulted the review list, which was empty for that part, and fell through to
"Ready to build." over four unbuildable cards.

It now reads the same outcomes the cards are drawn from, so the headline and the
cards cannot disagree - the rule `optionFor` keeps between the chooser and the
export, applied one layer up.

**Check the claim before fixing it.** Fixing the badges would have been fixing
the one thing that was already right.

---

# 2026-08-28, seventh pass: a short that passed its own check

A PCB librarian unpacked a TPS7A4700 bundle and measured it against TI drawing
4219039/A. The land pattern is dimensioned `(4.65)`; they rendered page 30 at 8x
and confirmed the extension line runs down the centreline through pad 1, so 4.65
is centre to centre. `DIMENSION_ORACLE` agrees: `RGW0020A land spanMm 4.65`.

Three of their four builds emitted **3.9**, which is `4.65 - 0.75`: one land
length subtracted from a dimension that was already a centre span.

At 3.9 the twenty lead lands have an inner edge at 1.575 mm. The exposed pad is
3.15 mm square, half extent 1.575 mm. **Every signal pin abuts the ground pad.**

## Two safety nets, both blind, for the same reason

```ts
/** Floating-point slack. Two lands that share an edge exactly are not overlapping. */
const TOUCHING_MM = 1e-6;
```

The export gate required a strict overlap wider than a micron. That sentence is
true about rectangles and false about copper: two features sharing an edge are
one region, and a fabricator etches them as one. Twenty exact abutments, no
violation.

And the confidence check measured the distance between opposing rows and called
all of it clear:

    "3.150 mm of clear board between the opposing rows"

which is the exact width of the pad filling it. It compared signal rows to each
other and never asked what sits in the middle.

Both now account for it. The gate treats meeting copper as joined copper - no
minimum clearance is invented, only the arithmetic that copper which meets is
one piece. The check subtracts the exposed pad per axis and reports the board
that is actually left: at the correct 4.65 span it reads **0.375 mm**, which is
what the librarian measured off the drawing.

**Measured cost of tightening the gate: zero.** 865 tests, `bench:copper` clean,
hold-out unchanged at READ 95% / SHIPS 93% / 1.49 to check. No correct footprint
in either corpus has abutting pads.

## The shape, again

The value was flagged. The panel said "Land pattern (the pads), page 30 - nothing
independent could check this", because IPC-7351B has no no-lead model. That was
the one uncorroborated value in the bundle and it was the one that was wrong; on
the same run OPA333's SOIC agreed with IPC and was correct. **The mechanism
works.**

What failed was everything downstream of the flag: a gate that would not call
touching copper a short, a check that reported the short as clearance, and a
green "Ready to build" over all of it. Their sentence is the one to keep:

> "A wrong footprint that announces itself is a nuisance. A wrong footprint that
> passes its own checks and varies run to run is a recall."

## Still open from that report

- **`landSpanMm` has no stated convention.** Centre-to-centre or tip-to-tip is
  not written down anywhere, and the same record produced 4.65 on one run and 3.9
  on another. Until the field says which it is, the subtraction that made 3.9 can
  come back.
- **No Cadence generator**, disabled in the UI and discovered only after a
  90-second read.
- **No `.IntLib` and no component parameters** in the Altium SchLib: designator
  and comment only, so ~14 mandatory library fields are hand entry, and the
  per-pin descriptions on the record never reach the symbol.
- **The symbol has no pin for the exposed pad** while the footprint has pad 21,
  so Altium reports an unmatched pad and the thermal land floats.
- **Nine thermal vias with empty designators**, netless, sitting on the pad.
- **The courtyard is inside the silkscreen** on the QFN path (±2.575 against
  ±2.625). Not present on the SOIC path.
- **`test-data/lmp7704-sp.PcbLib` is a Forge export, not an Altium artifact.** It
  is named as the reference in `ipc7351.ts` and used as one. Comparing our output
  to it proves only that we agree with ourselves. Nothing in this project has
  ever been opened in Altium.

---

# 2026-08-28, the audit: can a value be wrong and still say "confirmed"?

Anthony asked whether the design was solid or whether more assumptions were
hiding. Three instruments were written to answer it rather than reason about it.

## `bench:courtyard` — 7 of 91 courtyards do not contain the part

IPC-7351B's courtyard is the greater of the land extent and the BODY, plus an
excess. `assemble` takes the land extent on both axes of a quad and never
compares it to the body. Seven footprints have a courtyard inside their own
outline, five of them ceramic flat packs. A courtyard inside the body lets the
placement checker put another component on top of the physical part.

I had repeated a reviewer's claim that the defect was "courtyard inside the
silkscreen, wrong by IPC-7351". It is not that; silkscreen is a drawing layer.
Reading the code first found the real one.

## The formed lead span is not a property of their line

`formedLeadSpanMm` is one global setting applied to every part. A toe-to-toe span
depends on the package body, so it cannot be.

    LX7730 CQFP 132L   body 24.125 mm   formed span 7.62 mm
    RHF1201 SO48       body  9.650 mm   formed span 7.62 mm

**Six of twelve straight-lead parts get a span inside their own body**, which no
flat pack can have: its leads extend outward. This is what produces five of the
seven courtyard failures.

The rad-hard engineer said it outright - *"my die gives a repeatable foot and
bend; it does not give one toe-to-toe span across a CFP-8 and a CQFP-128"* - and
it was written into this file that morning and not acted on. **A finding recorded
is not a finding fixed.**

The check that would catch it, `span-covers-body`, reads `dimensions.leadSpanMm`,
the DRAWING's span, which is null on exactly these packages. So it reports
"unavailable" and the impossible number ships. Same shape as every other defect
this week: a check that exists and does not look at the value that ships.

## `bench:unchecked` — corrupt each value, see whether anything notices

Written after the map-based version over-reported twice. The first carried a
hand-written table of which check covers which value and knew nothing of the
export gate. The second compared flag COUNTS, so a value already flagged looked
"silent" when the user had been told.

The third asks the product's own question. THE INVARIANT defines shipping
silently as being CONFIRMED, so: corrupt a value wherever its confirmation
currently says confirmed, and see whether it still does.

```
mutation                      confirmed  caught  STILL CONFIRMED
landSpanMm x0.5                      40      40                0
landPadLengthMm x3                   40      40                0
landPadWidthMm x3                    40      40                0
pitchMm x2                            0       0                0
thermalPad x2                         0       0                0
formed span x0.4                      0       0                0
bodyWidthMm x0.4                     74      17               57   <- HOLE
leadSides 2<->4                      86      27               59   <- see below
```

**The copper is well guarded.** All three land-pattern values are caught 40 out
of 40, and pitch, thermal pad and formed span are never confirmed in the first
place - always flagged, so they cannot ship silently wrong. That is the invariant
working.

**The body confirmation is a one-sided bound.** `confirmBody` confirms when
`span.maxMm >= min(length, width)`. Shrink the body and that stays true, so a
body at 40% of its real size keeps saying "confirmed" on 57 parts. Worse, it is
not two sources: the span and the body come off the SAME drawing, and a one-sided
sanity check is not a second reading. Calling that "confirmed" misuses the word
the whole product rests on.

**Nothing vouches for `leadSides` at all.** The 59 above is really measuring my
own mapping - I attached it to `pin-count`, which is about something else. The
correct statement is that no confirmation covers the arrangement, and getting 2
against 4 wrong rebuilds the entire footprint. `bench:copper` checks the
arrangement against the RECORD, which is consistency, not correctness.

## What the audit is worth

Three instruments, two real holes, and two confirmations that the parts I was
most worried about are sound. The method that produced it: **write the instrument
that finds the class, not the fix for the instance** - and validate the
instrument, because two of its three versions reported nonsense before this one
reported something.

## An oracle cannot see a reading you got wrong (2026-08-29)

`pinevidence.ts`'s two floors were swept on 2026-08-27 and the sweep scored one
thing: how many pinouts came back corroborated, with a hand-read oracle checking
that none of them was wrong. That is half a measurement, and the missing half is
the important one.

Every record in the corpus the oracle covers is one the model read CORRECTLY. So
the sweep could tell you a right answer was confirmed. It could not tell you what
the check would do with a wrong one, and the answer turned out to be: confirm it.
Swapping two pin names left the pinout CONFIRMED on 46 of 107 parts.

A mutation sees what an oracle cannot. `bench:symbol` corrupts the record and
asks whether anything objects, and it found in one run what two sweeps and a
hand-read oracle had missed. **When a check is scored only against correct data,
it has been scored on half its job.**

## A fix that reads well and buys nothing is the expensive kind of wrong (2026-08-29)

The first diagnosis of the above was the page-level union: a pinout was
"confirmed" when no single page agreed with it and the pages between them added
up. AD8221 proves it - two pages that draw the pinout both decline to agree about
pin 1 after a swap, and a third supplies it.

The argument is good. "A second source that can be assembled out of pages that
individually disagree is not a second source" is true, and it fixes that part.

Measured across the corpus it cost SEVEN corroborated pinouts, three of them
oracle-verified, and changed the number of corrupted pinouts still confirmed by
**zero** once the real defect was closed. It was reverted.

The real defect was one line away: an offset supported by a single pin is
circular, because the offset is derived from the match it then confirms. Stray
pairs of collinear numbers picked an offset two hundred points across the page
and agreed with themselves.

**Measure the fix, not the argument for it.** A plausible fix next to a real one
looks identical until you score them.

## Three instrument bugs, each of which read as a product defect (2026-08-29)

`bench:emitters` compares the KiCad and Altium output of the same record. Its
first three runs reported, in order: 200 pad disagreements, 1623 pin
disagreements, and 3 footprints with paste in the wrong place. All three were the
bench.

- paste apertures carry no designator in either format, so keying on the empty
  string collapsed fourteen of them onto one entry
- Altium stores the pin end that touches the BODY and KiCad stores the far end -
  `schlib.ts` says so in a comment, and the bench did not convert
- Altium stores coordinates on an integer 1/10000 mil grid, so 0.9125 mm comes
  back as 0.913 and a string comparison called it a disagreement

The bench now moves a land, renames a pin and inflates a solid on the first part
it sees, and refuses to print anything if all three are not reported. **A clean
sheet from an instrument that has never been shown to fail is not evidence.**

## A stage that reports "not exercised" may mean "cannot fire" (2026-08-29)

`bench:browser --full` lists which optional user paths a run exercised.
`question-answered` had been in the NOT-exercised list every run since it was
written, and it was read as "these datasheets happened not to ask anything".

The selector was `.ask input`. No element has the class `ask` - the markup is
`.ask-group > .ask-list > .ask-row-full > .ask-row > input`. The stage had never
fired, on any run, ever. It was also placed BEFORE the export it depends on: the
question boxes only appear once the export has refused and named what it needs.

Two defects were behind it, and one of them would have reached a customer: the
screen was overwriting a user's part-specific answer with the install-wide value
that had just been rejected, so a question could be answered correctly and asked
again in the same words forever.

**"Not exercised" is a claim about the instrument as much as about the data.**
When a path is never reached, check that it CAN be, before concluding anything
about the corpus. Same shape as the check that matched a pad number the emitter
never emits.

## Guards travel in pairs, because the routes do (2026-08-29)

`/api/parse` and `/api/lookup` are the same operation past the point where the
bytes are in hand - `buildReadout` says so and is shared. They still hold their
own copies of every guard.

The no-reader-configured refusal went onto parse alone, and the parity test
between the two routes failed within the minute. That is the third time: the
per-package table door, the relabel door, and now this. When adding a guard to
one of these two routes, add it to both in the same change, or expect the parity
test to tell you off.

## Break the check before you trust it (2026-08-30)

Four instruments were found on 2026-08-29 that could not fire. That looked like
bad luck. A systematic pass the next day - run every bench twice, once with a
deliberate defect injected where a real one would enter - found more, and one of
them was in the instrument the whole copper claim rests on.

**`bench:copper` was blind to a land moved 0.9 mm on 66 of 80 footprints.** Its
PITCH and SPAN checks examine only the rows whose membership equals the widest
row, and a land that moves OUT of its row shrinks that row below the threshold.
So both checks skipped the row containing the defect, and the displaced land was
examined by nothing at all. A single land out of position is the likeliest
emitter defect there is, and the instrument written to catch it looked away from
exactly that case.

**Three of `bench:unchecked`'s eight mutations had nothing to corrupt.** The row
read `0 confirmed, 0 caught, 0 still confirmed` and was taken for a clean sheet.
The cause was one line: `replayRecords` hardcoded `vendorLandPattern: null`, so
no replayed part could ever confirm its pitch. `readout.ts` names that exact
failure - a bench measuring a product where no footprint has a second source -
in its own header, for a different bench, one level up.

So: `bench:instruments` now runs each bench clean and injected and refuses the
run if the output does not change. `inject.ts` holds the seam and is inert
without `FORGE_INJECT`. Placement is the whole claim, so every call site says
which real failure it stands for.

Three habits fall out of it, all in `RULES.md`:

- A row of zeros is not a pass. Where a bench had nothing to measure, say NO DATA.
- "Never fires" and "is dead" look identical from outside. Six of seven
  land-pattern guards fired on nothing in any corpus; all six work, and that
  could not be known until each was given a record built to trip it.
- **A mutation that changes nothing is not a finding.** This bench committed the
  sin it exists to catch: "a plated hole with no drill" reported 86 of 86
  shipping wrong, because all 86 corpus parts are surface mount and the mutation
  returned the footprint unchanged.

## An independent reader is not the customer's tool (2026-08-30)

`bench:emitters` reads every emitted file back with `kiutils` and cross-checks it
against AltiumSharp. Both are real, independent implementations, and neither is
KiCad.

`kicad-cli` plotted all 80 emitted footprints and **refused 2 of 80 symbol
libraries.** Both carried a pin typed `nc`, and the emitter wrote
`not_connected`; KiCad's token is `no_connect`. KiCad does not skip the pin or
warn - it refuses the whole library with "Unable to load library", so every part
in the file is lost over one pin. kiutils parsed it happily and 890 tests passed.

The electrical type had only started being emitted two days earlier, so for two
days every part with an unused pin shipped a symbol library that would not open.
The same look found `open_collector` and `open_emitter` falling through to
`unspecified` in KiCad and to Passive in Altium, which both formats have and
neither was being told.

**Run the customer's tool where it can be run at all.** `brew install --cask
kicad` wants an administrator password for a directory the CLI does not use; the
binary runs straight from the mounted disk image with nothing installed:

    hdiutil attach -nobrowse -readonly -mountpoint /tmp/kicadmnt <the .dmg>
    FORGE_KICAD_CLI=/tmp/kicadmnt/KiCad/KiCad.app/Contents/MacOS/kicad-cli npm run bench:kicad

## Coverage finds what you would not think to look for (2026-08-30)

Coverage had never been run on this repository. Node's own
`--experimental-test-coverage` crashes on tsx source maps; `c8` works.

84% of statements, and the gaps were not where memory said they were:

    vertex.ts              188 lines, 0%   the provider the product BILLS
    api/config/route.ts     24 lines, 0%   a live route
    api/parse/route.ts      51%             the model section, lines 282-453

Writing tests for the parse route's uncovered failure branches found a live
defect: a reader that answers in prose instead of JSON produced HTTP 200 and an
empty record, so an operator with a misconfigured local model was told their
DATASHEET was the problem. The route's own comment three lines up says "A PARSE
THAT LOST THE MODEL PASS IS A FAILED PARSE, NOT A THINNER ONE" - the discard
raised no error, so the catch enforcing that rule never ran.

**Untested and untestable are different, and only coverage tells you which.**
`resolver.ts` is 0% and correct - it is types only. `page.tsx` is 0% and covered
by `bench:browser`. `vertex.ts` was 0% and covered by nothing.

## Writing down what you deliberately do NOT check finds what nobody checked (2026-08-31)

`bench:outputs` breaks every value that reaches an emitted file. Its rule is that
each field an emitter reads ends up in one of three buckets: caught by the export
gate, flagged to the user, or **listed with a reason for being neither**.

The first two buckets found two real holes. The third found the worst one. Writing
out the "deliberately not mutated" list meant giving a reason for each field, and
one field had no reason available: `thermalVias` appears nowhere in
`confidence.ts`, so the export gate had never looked at a thermal via array. A via
is copper *and* a hole. One drifting off the pad drills through the board where no
land is; one drifting further reaches a lead land and shorts the pad to a signal.

Exactly one part in the corpus emits any (TPS54360, six of them), so no amount of
running the corpus would have surfaced it, and the check needed a fixture as well.

**The forcing function is the requirement to give a reason.** "We do not check X"
is a sentence nobody writes until something makes them, and the moment it is
written the ones with no defensible reason stand out. A list of what you check is
easy to feel good about; a list of what you have decided not to check is the one
that finds things.

The same pass had the bench commit the sin it exists to catch: "a plated hole with
no drill" reported 86 of 86 shipping wrong, because all 86 corpus footprints are
surface mount and the mutation returned the footprint unchanged. **A mutation that
changes nothing is not a finding.** It reports NO DATA now, which is the same rule
as "a row of zeros is not a pass".
