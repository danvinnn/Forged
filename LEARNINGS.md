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

**Ask where else this value lives.**

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
