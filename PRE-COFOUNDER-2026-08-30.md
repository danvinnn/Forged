# Before the cofounder sees it — 2026-08-30

A pass over everything that could be checked without him. The method mattered
more than the list: every previous "comprehensive" pass here brainstormed items,
which finds what somebody happened to remember. Each phase below runs a procedure
that produces its own findings, so the list is derived rather than recalled.

**Sixteen defects found. Thirteen fixed, three recorded with reasons.** Every
number below was measured after the fixes.

---

## Phase A — validate every instrument

Nothing else in this report means anything until this is done. Four instruments
were found on 2026-08-29 that could not fire; all four had been green for weeks.
That is a shape, not bad luck.

`npm run bench:instruments` now runs each bench twice — once as it is, once with
a deliberate defect injected where a real one would enter — and **refuses the run
if the output does not change**. The seam is `src/lib/__bench__/inject.ts`, inert
without `FORGE_INJECT`. Placement is the whole claim, so every call site says
which real failure it stands for.

### A1. `bench:copper` was blind to a displaced land on 66 of 80 footprints

The instrument the entire copper claim rests on. Move one land 0.9 mm along x,
leave the record untouched:

| | reported |
|---|---|
| before | 14 of 80 |
| after | **80 of 80**, and 0 on the clean corpus |

Its PITCH and SPAN checks examine only rows whose membership equals the widest
row. A land that moves *out* of its row shrinks that row below the threshold, so
both checks skipped the row containing the defect and the displaced land was
examined by nothing. A single land out of position is the likeliest emitter
defect there is.

Fixed with a ROW check: full-row membership on the dominant axis, and an
extreme-line rule for quads, which tie.

### A2. Three of `bench:unchecked`'s eight mutations measured nothing

They printed `0 confirmed, 0 caught, 0 silent`, which reads as a clean sheet.
`replayRecords` hardcoded `vendorLandPattern: null`, so no replayed part could
ever confirm its pitch — the same hardcoded-field shape as the `electricalType`
bug found in that same file the day before, and the failure `readout.ts` already
describes in its own header for a different bench.

Fixed: `packageOutlineCode` filled from the cache, new
`replayRecordsWithDocuments()`. `pitchMm x2` is now live at 27 confirmed / 26
caught / 1 silent. **A zero row now prints NO DATA** instead of reading as a pass.

### A3. All seven land-pattern guards proven live

Six fired on nothing in any corpus, which is indistinguishable from dead. Each
was given a record built to trip it. All six fire; the conditions are just rare.

### A4. The two most important zeros in the repo can move

`bench:confirm`'s **CONFIRMED AND THE ORACLE DISAGREES** and **CONFIRMED AND THE
DRAWING DISAGREES** are the claims THE INVARIANT rests on, and neither counter
had ever been shown able to move. Corrupting a pinout and a land pattern *after*
the product had vouched for them takes them to 20 and 15.

Also validated with no defect found: courtyard, joints, published, corpus,
discards, questions, dimensions, repeatable.

---

## Phase B — enumerate mechanically

### B1. Coverage had never been run

Node's own `--experimental-test-coverage` crashes on tsx source maps; `c8` works.
84% of statements, and the gaps were not where memory said:

| file | coverage | |
|---|---|---|
| `vertex.ts` | **0%** of 188 lines | the provider the product bills |
| `api/config/route.ts` | **0%** of 24 lines | a live route |
| `api/parse/route.ts` | 51% | lines 282–453: the whole model section |
| `resolver.ts` | 0% | types only — correct |
| `page.tsx` | 0% | covered by `bench:browser`, not the suite |

**Untested and untestable are different, and only coverage tells you which.**

### B1a. A broken reader was reported as a bad datasheet

Writing tests for the parse route's uncovered failure branches found a live
defect. A local model that answers in **prose** instead of JSON produced HTTP
200, an empty record, and a note nobody surfaces — so an operator with a
misconfigured reader was told their *datasheet* was the problem.

The route's own comment three lines up says "A PARSE THAT LOST THE MODEL PASS IS
A FAILED PARSE, NOT A THINNER ONE". `parseModelResponse` discards the answer and
returns an empty result, raising no error, so the catch enforcing that rule never
ran.

Fixed: `ExtractionResult.unreadable`, carried through as `readerUnreadable`, acted
on by both routes when the reader also filled nothing. A prose first pass followed
by a good drawing pass is still a successful read and is untouched.

### B2. Every user-facing string, read as a stranger

One leak: the legacy-record refusal showed the user `{ value, confidence, method,
citation }`. Reachable by leaving a tab open across a deploy — exactly when
somebody is least interested in our data model. Rewritten to say what to do.

### B3. Only 3 of the verdict card's 7 screens had ever been opened

Five of the seven have now been driven in a browser: `ready`, `which-package`,
`needs-numbers` on the default corpus, and `not-enough-read` and
`nothing-buildable` on parts picked to reach them. `refused-pinout` and
`needs-checking` still need a document that produces them.

`bench:browser` now names which of the seven outcomes it saw and lists the ones
nobody has opened. Driving the unopened ones found two defects.

**"Which package?" was shown when no package could be built.** RTAX2000S offers
three CQFP packages, all three unsupported. The card said "Which package? 3 were
read from this datasheet" and the Build button stayed live, because
`packageChoice.ok` is true in that state. Pressing it refused at the last click.
The `nothing-buildable` verdict already existed — added after a rad-hard engineer
spent eight attempts being refused — but it was tested *after* `which-package`, so
it could not win. Moved ahead of it, and one value now feeds both the card and the
button so the two cannot disagree.

**A refusal that named the arithmetic and not the answer.** The corner-lands
refusal printed the along-side length, the pitch, the land width and the span in
hand, and never said what number would satisfy it. It also called a value the user
had just typed "read". `needsMm` was already computed on that line; it now says
"it has to be more than X mm". Verified offline: the same refusal ships on the
first try when given a number just over its stated minimum.

**A rejected answer came back with no boxes to correct it in.** Every question
test asked only about a *blank*, which is right until the user has answered: a
land pattern typed in and thrown out by a guard leaves all four fields populated,
so nothing is asked and the refusal arrives with an empty `needs`. The person it
stranded is the one who typed a wrong number — the one who most needs the boxes
back. Now re-asked, but only where the caller supplied the value.

---

## Phase C — every value that reaches an output file

Field list derived from what the emitters actually dereference, not from memory.
`bench:outputs` breaks each one and asks whether the export gate objects.

**Three holes, all fixed:**

- **The silkscreen body outside its own courtyard** — 86 of 86 shipped anyway.
  IPC-7351B defines the courtyard as the maximum extent of the lands *and* the
  body; only the lands were checked.
- **A symbol pin with no length** — 86 of 86 shipped anyway. Altium's emitter
  throws on one and KiCad's does not, so the same symbol was writable in one
  format and refused in the other. A rule the two formats disagree about belongs
  in the gate they share.

**A third, found by writing down what is *not* mutated.** Phase C's rule is that
every emitted field is caught, flagged, or listed with a reason. Writing that list
turned up one with no reason: `thermalVias` appears nowhere in `confidence.ts`, so
the export gate never looked at them. A via is copper *and* a hole — one drifting
off the thermal pad drills through the board where no land is; one drifting
further reaches a lead land and shorts the pad to a signal. Exactly one corpus
part emits any (TPS54360, six), so the corpus alone could never have held this up.
Now checked against the pad's own extent, with a mutation and a fixture test
behind it.

The bench also committed the sin it exists to catch: "a plated hole with no
drill" reported 86 of 86 shipping wrong, because all 86 corpus footprints are
surface mount and the mutation returned the footprint unchanged. **A mutation
that changes nothing is not a finding** — it now reports NO DATA. The drill check
is covered by fixtures instead.

---

## Phase D — where our proxies are not the real thing

### D1. KiCad refused 2 of 80 symbol libraries we ship

The biggest find of the pass. `kiutils` and AltiumSharp are real independent
readers and neither is KiCad.

```
80 of 80 footprints plotted
78 of 80 symbol libraries opened     TWO DID NOT
```

Both carried a pin typed `nc`, and the emitter wrote `not_connected`. KiCad's
token is `no_connect`. **KiCad does not skip the pin or warn — it refuses the
whole library**, so every part in the file is lost over one pin. kiutils parsed it
happily and 890 tests passed. The electrical type had only started being emitted
two days earlier, so for two days every part with an unused pin shipped a symbol
library that would not open.

The same look found `open_collector` and `open_emitter` falling through to
`unspecified` in KiCad and to Passive in Altium, though both formats have them.
An open-drain pin that must not be driven arrived as one that may be.

`bench:kicad` now makes this permanent. After the fix: **80 of 80 and 80 of 80.**

### D1a. Altium had two independent readers and only one saw the corpus

There is no `kicad-cli` for Altium: Designer is Windows-only, licensed, and its
scripting runs inside the running application. "Altium opens the file" stays a
question for a person with Altium.

What could be closed was an asymmetry. Two independent Altium readers live in
this repo, and only one of them ever saw the whole corpus:

| reader | applied to |
|---|---|
| AltiumSharp (C#) | `bench:emitters`, every part, every PcbLib and SchLib |
| pyaltiumlib (Python) | the unit tests only, on hand-built fixtures |

KiCad had exactly that shape until this pass, and it hid a library KiCad refuses
to open. `bench:altium` now runs the second implementation across every emitted
file: **154 files across 77 parts, every one opens, holds a component, and logs
no complaint.**

It also caught me out. Its first run reported 77 findings, and all 77 were mine:
it counted `unsupportedRecords` as defects. That field is the reader saying it
does not implement a record type, not that our file is wrong — records 45, 46 and
48 are the footprint link, written deliberately, modelled on a real Altium
library, and read without complaint by AltiumSharp. Reported separately now, and
named, so a reader's gap cannot be mistaken for ours.

### D2. The answer cache describes the current build

Settled for free rather than paid: 159 of 180 cached parts have an answer under
the current prompt fingerprint. The benches are scoring the build that exists.

---

## Phase E — operational

### E2. The product path had no spend ceiling and no ledger

Both lived only in the bench cache. Every parse a real user made called a billed
model with no cap and recorded nothing. `src/lib/spend.ts`: cumulative ceiling,
ledger, asserted *before* the call, wired as a wrapper in `makeExtractionModel` —
the single door both routes go through, so a provider added later is metered
whether or not its author thought about it. That is exactly the failure behind
the Vertex billing hole.

A local model is never counted and never capped.

It is not theoretical: the live browser runs in this pass went through it and the
ledger reads **$2.13 across 63 calls**. The project's cumulative model spend is
now about **$61.70** ($59.57 on the bench cache, $2.13 on the product path).

### E4. Our own code is ~1 second of a 65–90 second parse

| | pages | parse | render 8pp | readout | our total |
|---|---|---|---|---|---|
| NCP1200 | 17 | 290 ms | 753 ms | 1 ms | 1.04 s |
| DRV8825 | 36 | 223 ms | 699 ms | 85 ms | 1.01 s |
| STM32F407VG | 206 | 410 ms | 562 ms | 91 ms | 1.06 s |

About 99% of the wall clock is the model. **This settles the deployment
decision**: the host must allow ~150 s, and no optimisation of ours changes that.

### E5. Security re-verified, and a hole closed

The air-gap guard scans `retrieval/` and `extraction/` and nothing else, so
`extraction/factory.ts` — the module the whole guarantee turns on — could reach
the network through an import one directory up. Two tests added, and the second
verified able to fail.

### E3. Concurrency, measured clean

Two different uploads in flight together each come back as themselves; the same
document twice at once gives an identical record but for the per-parse `id`,
which should differ.

### The scanned-datasheet gap is closed, and the answer was good

`bench:badinput` had said "NOT COVERED: a scanned page with no text layer". Built
one — three pages of a public datasheet rendered to JPEG, 0 text characters
confirmed. **The product reads it: 8 pins.** The model works off the rendered
page, so the missing text layer costs nothing.

---

## Where it stands

```
913 tests pass, lint clean, typecheck clean
bench:instruments     all 11 benches and all 7 guards go red when broken
bench:altium          154 files, 2nd independent reader, all open cleanly
bench:kicad           KiCad 10.0.5 opens all 80 footprints and all 80 symbols
bench:outputs         every corrupted emitted value refused by the export gate
bench:copper          0 disagreements on the clean corpus
bench:courtyard       0 of 86 fail either check
bench:joints          84 overlaid, 3 with a lead that misses its copper (known)
bench:emitters        86 parts, KiCad == Altium on every pad and pin
bench:dimensions      CORRECT 713 / WRONG 8 / NOT READ 10
bench:confirm         0 false confirmations on pinout and on copper
bench:badinput        8 of 8 bad uploads refused and said so
bench:repeatable      byte-identical across 3 passes over 100 documents
bench:mutation        KILLED 20/20
browser, live         14/14 stages, 0 problems, real KiCad and Altium exports
                      for all four datasheets plus a live part-number lookup
```

Every other free bench is byte-identical to its pre-pass baseline, so none of
today's product changes cost anything measurable.

## The claim this pass actually supports

Checked on 2026-09-01, directly, rather than inferred from the benches.

`bench:dimensions` knows of **8 wrong readings out of 731** against hand-read
drawings. The question that decides readiness is not how many are wrong, it is
whether any of them ships without the user being told. Each was traced to what it
reaches:

| part | wrong value | state | reaches |
|---|---|---|---|
| AD590 | pitchMm | flagged | copper |
| ADXL345 | landPadWidthMm | flagged | copper |
| LTC3105 | leadWidthMm | flagged | copper |
| VA10820 | leadSpanMm | flagged | copper |
| RHFL4913 | bodyLengthMm | flagged | 3D solid |
| RHF1201 | bodyHeightMm | does not ship at all | — |
| TLV9061 | leadSpanMm | confirmed | **nothing** |
| NCP1200 | bodyHeightMm | confirmed | 3D solid only |

The two marked confirmed needed checking properly. **Neither reaches copper.**
TLV9061 and NCP1200 both build their lands from the footprint the datasheet
prints, corroborated against IPC-7351B computed independently from the leads:
TLV9061 emits a 2.600 mm span from the printed pattern while the wrong
`leadSpanMm` reading (2.75 to 3.05) is never used. The wrong value is a reading
that would only matter on a document that printed no footprint.

**So: no wrong value reaches copper silently.** That is the promise, and it holds.

What it exposes is narrower and real: **`bodyHeightMm` is vouched for by nothing.**
`confirmBody` pairs length and width against the lead span; height has no second
source in the confirmation, and NCP1200 ships 1.55 mm where the drawing says 1.75.
It reaches the 3D solid and nothing that reaches a board, so it is the same class
as `electricalType`. Exposure measured: **2 of 66 heights wrong.** An engineer
checking mechanical clearance in an enclosure would care; one checking the
netlist or the copper would not.

## Which product path each number describes

Found on 2026-09-01 while checking for regressions, and it changes how precisely
these figures should be quoted. There are two real reading paths and they ask the
model a DIFFERENT question:

    /api/parse   an upload. No part number is known, so none is sent.
    /api/lookup  a part number the user typed, which the prompt states:
                 "The requested part number is X."

Both are legitimate. They cannot share an answer cache, because the prompt
differs, and that is why `bench:holdout --offline` reads 0: the cache holds
lookup-shaped answers and the hold-out asks the upload-shaped question.
Verified pre-existing by running the same command in a worktree at the
pre-session commit: identical 0%.

So:

| number | path | how |
|---|---|---|
| READ 95%, SHIPS 93% (hold-out) | **upload** | a paid run, previous session |
| dimensions 713 correct / 8 wrong | lookup | replayed free from cache |
| 0 false confirmations | lookup | replayed free from cache |
| questions, discards, symbol, sweeps | lookup | replayed free from cache |

The confirmation logic is identical on both paths; what differs is the reading it
is handed. **The hold-out figure, which is the one that predicts a stranger's
datasheet, is the upload path** - which is also what a person dragging a PDF onto
the page will use.

Worth knowing rather than worth fixing: making the two share a cache would mean
asking one of them the wrong question.

## Open, with reasons

- **`bench:confirm` average 1.73 against a stated target of 1.00.** The gate that
  matters — never above 5 — is met; 29% of parts need nothing checked against a
  target of 80%.
- **19 bodies stay confirmed when shrunk to 40%.** Their datasheets print no
  footprint, so there is no second drawing to disagree with. The alternative
  bound was swept and rejected: it flags LMP7704-SP, a correct reading.
- **`electricalType` is vouched for by nothing.** A deliberate decision: it
  reaches the schematic tool's rule check and nothing that reaches a board.
- **`tps7a8300` reads a 3.90 mm land span where its drawing prints 4.65.** A
  wrong reading, in neither corpus, and the product flags it rather than shipping
  it silently.
- **Rotating pin numbering by 1 is silent on 2 parts** (ADG1211, ADG5412).
- **`bodyHeightMm` has no second source.** 2 of 66 wrong, 3D solid only.
  MEASURED NEGATIVE, 2026-09-01, do not retry without new evidence. The document
  does carry a second reading (`statedMaxHeightMm`, the drawing's own title
  block), and it is already used to CORRECT the height at merge time. Surfacing
  it as a confirmation was swept over 105 shipping parts: 27 could be confirmed,
  49 have no stated max anywhere and would become a NEW flag, and the rest need
  the cited page rather than a document-wide scan. Roughly 74 new flags to catch
  2 wrong heights that reach the 3D solid and nothing that reaches a board. That
  takes the friction figure from 1.73 to about 2.4 and makes the product worse.
- **Two of the seven verdict screens have still never been opened**
  (`refused-pinout`, `needs-checking`). The bench now names them every run, so
  they cannot go back to being invisible.
- **An intermittent test failure I could not reproduce.** Two one-off failures
  about fifteen runs apart, in two different tests, both of which shell out to
  the Altium oracle through `python3`. Sixteen consecutive clean full-suite runs
  since. I am not calling it settled: the harness throws with the oracle's own
  stderr attached, so the next occurrence will say what happened. The likeliest
  explanation is process-spawn contention — the suite runs test files across ten
  cores and twenty of those tests spawn python3 — which would be environmental
  rather than a product defect, but that is a hypothesis and not a measurement.

## What no method here can reach

1. **Altium opening a file.** Two independent readers agree on every pad and pin
   of 86 parts; neither is Altium. KiCad is now covered by the real tool.
2. **Whether an engineer would use it.** Countable facts are settled by counting.
   Judgement is not.
