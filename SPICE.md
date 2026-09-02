# SPICE model generation: groundwork

For Anthony, or whoever builds the second half of the product.

**This document does not decide anything.** It separates what is already decided
for you, by `RULES.md` and by code that ships, from what is genuinely open and
has to be answered before the first line is written. Where something is open it
says what bounds the answer and what it costs to get it wrong.

It exists because `src/app/suite/HANDOFF.md` describes the SPICE half in one
bullet, seam 4, and that bullet is a contract rather than a specification. The
contract is right. It is not enough to build from.

Written 2026-09-02, against the code as it stood that day.

---

## 0. What exists today

Verified 2026-09-02 by reading the tree, not by memory.

| Thing | State |
| --- | --- |
| `Intent = "cad" \| "spice" \| "both"` | `src/lib/intent.ts`. Exists. |
| The `SPICE model` chip and the intent-aimed read | `SuiteWorkspace.tsx`. UI only. |
| A stage name that changes with the intent | `readprogress.ts:88`. Display only. |
| `/api/model` | **Does not exist.** |
| A SPICE emitter | **Does not exist.** `src/lib/emitters/` holds `kicad.ts` and `altium/`. |
| A parameter type on the record | **Does not exist.** `PartRecord` carries `dimensions`, `pins`, `radiation`. |
| A SPICE field in `extractionFields` | **None.** All 38 entries are identity, package, pin or radiation fields. |
| `exportFormats` | `["kicad", "altium", "cadence"]`. Three board tools. Nothing for LTspice. |
| The SPICE panel in the suite | A placeholder reading "Netlist panel goes here." |

Every `netlist` in `src/lib` refers to schematic connectivity, not to SPICE.
There is no SPICE code in this repository.

**One live defect, in the UI, worth fixing whoever gets there first.** For
`intent === "spice"` the format picker is not rendered, so `format` keeps its
`"kicad"` default, and the button labelled "Take the model" posts `/api/export`
with `format: "kicad"` after a status line reading "Building the KiCad bundle".
It does not refuse. It builds the wrong thing. That is the 2026-08-28 defect
shape with the silence removed and a wrong answer put in its place.

---

## 1. The first decision: generate, or find?

**This is the one that decides whether the rest of the document is relevant, and
it is not answered anywhere.**

Seam 4 says "the SPICE emitter: deterministic templating over extracted
parameters". That presumes generation. But TI, ADI, Microchip and others publish
their own SPICE models for most of these parts, written and validated by the
people who designed the silicon. So there are two products here and they share
almost no code:

- **Generate.** Read parameters off the datasheet, template a subcircuit. Every
  parameter has to be read, confirmed under RULES.md 7, and defended. The output
  is ours and so is the responsibility for it.
- **Find, fetch and verify.** Locate the vendor's published model, check it is
  the right part and revision, present it with its provenance. Almost no
  extraction. The hard parts move to retrieval and to trust.

`RULES.md` 5 says simpler is usually more, and asks what would have to be true
for a thing not to be needed. For a part whose vendor publishes a validated
model, a generated one is a worse artefact produced at higher cost, and shipping
it alongside the vendor's is the product inviting a user to trust ours over
theirs.

`RULES.md` 6 says the engineer's expectation wins. **Go and find out what a
working analogue engineer does when they need a model for a part.** That answer
decides this, and neither this document nor the code can supply it.

**A likely shape, stated as a hypothesis and not as a decision:** fetch the
vendor's model where one exists, generate only where none does, and say plainly
on screen which of the two the user is holding. That has a real cost, which is
that the product then owns two paths, and `RULES.md` 5 is the argument against
it. It is written here so it is decided rather than defaulted into.

Nothing below matters until this is settled. If the answer is "find", most of
sections 3 through 8 are about the wrong product.

---

## 2. The second decision: which device classes

**A template is per class, and the class list is not written down anywhere.**

"SPICE model" is not one artefact. The tuned corpus alone spans op-amps
(`LMP7704-SP`, `OPA333`), a PWM controller (`NCP1200`) and an RF part
(`RHF310A`). An op-amp macromodel and a switching-controller model share no
topology, no parameter set and no validation method. One template does not cover
both, and there is no general "SPICE model of an arbitrary integrated circuit".

So the scope is a list of device classes, and each one costs a template, a
parameter set, a confirmation strategy and a bench. **Decide the list before
building the first one**, because the shape of `spiceModelSchema` depends on
whether it has to hold one class or five.

`RULES.md` 4 applies with force here. A template per device class is covering a
category. A branch added because one part came out wrong is tailoring to a
problem, and the test is the one the rule already states: can the rule be
written without naming a vendor, a part number or the symptom that prompted it?

**Start with one class, all the way through to a bench that can go red.** One
class finished is evidence the shape is right. Three classes half-built is the
same evidence as none.

---

## 3. What `RULES.md` already decides, and you do not get to choose

These are not open. They are the reason the CAD half is defensible and they
apply unchanged to parameters.

**Rule 1, do not invent.** Every parameter value comes from the datasheet, a
published standard, or a setting the user stated. A default gain-bandwidth for a
family, a "typical" figure carried over from a similar part, or a number chosen
because the simulation converged with it, is invention and does not ship. The
test is unchanged: name the source.

**Rule 2, do not assume.** This one is where a parameter path will fail first,
and it will not look like a failure. A datasheet prints min, typ and max for
almost every parameter. **Taking `typ` is not invention, and it is an
assumption.** Some engineers model worst case because the point of the
simulation is the corner. Nobody asked them which they wanted. Under rule 3 this
is either one right answer found from practice, or a setting, and it is decided
once rather than per parameter.

**Rule 3, read, ask, or offer a setting.** Nothing else. If the datasheet states
it, use it. If it does not and there is one right answer, find it from practice
and record the source. If it legitimately differs between users, it is a setting
on the first-run screen and it is settled before the first datasheet, not during
it. `src/lib/settings.ts` is the shape, and `SETTINGS_FIELDS` is where a new one
goes. Note what that file already knows: a field with a published standard
behind it may be left blank and blank names the standard; a field with no
standard is never defaulted and never required, because requiring it is what
made an engineer fabricate two numbers on 2026-08-28.

**Rule 4, general, never per-case.** See section 2.

**Rule 5, do not overengineer.** See section 1. Also: no second model call to
repair the first one's answer. That machinery was removed from the CAD path once
the reason for it was fixed at the source.

**Rule 7, nothing ships silently unless two independent sources agree.** This is
the invariant the product is judged on and it is section 4, because it is the
hardest thing in this document by a wide margin.

---

## 4. The confirmation problem

**`RULES.md`'s confirmation table has a row for every value that reaches a board
and no rows at all for parameters. This is the part to solve first, before any
templating, because it may change what the product is allowed to emit.**

The rule is not "check the value twice". It is that the two readings must be by
**different means**, so that they do not share a failure mode. A model that
misreads a rotated figure misreads it identically on a second call, which is why
a second model call is not a second source. Every pairing in `src/lib/confirm.ts`
is a reading against a different kind of reading: a model against text-layer
geometry, a printed drawing against IPC-7351B arithmetic, a pin table against a
lead count.

**Ask, for each parameter you intend to emit: what is the second means?** Some
candidates, none of them established, all of them needing measurement before
they are believed:

- The specification table against a characterisation curve on another page. Two
  genuinely different readings, and plausibly the strongest pairing available.
  Whether a curve can be read accurately enough to contradict a table is an
  empirical question and nobody here has measured it.
- The specification table against the text layer, the way `pinevidence.ts`
  corroborates the pinout. Cheap, deterministic, and it checks transcription
  rather than meaning.
- Cross-parameter consistency, for parameters that constrain each other by
  physics. Attractive, and it is the trap `RULES.md` names explicitly: **a bound
  that cannot fail is not a confirmation.** The worked example is the lead pitch,
  where "the lead row has to fit the body" sounded like a check and, measured
  across 94 correctly read parts, admitted almost every wrong pitch too. The
  bound was dropped rather than tuned. Any physics bound proposed here has to be
  measured against real readings before it counts, and dropped if it cannot fire.

**Three outcomes, and two of them are acceptable.** A parameter with a real
second source is confirmed and ships silently. A parameter with no second source
is flagged and the user sees it. A parameter that is flagged and pretends to be
confirmed is the one thing that must never happen.

**`MAX_FLAGGED` is 5 and it is Anthony's number from 2026-08-27.** Here is the
arithmetic that has to be faced honestly: an op-amp macromodel needs on the
order of ten to twenty parameters. If each is its own flagged item, every part is
over budget and every part is refused, and the SPICE half ships nothing.

So the unit of a flag has to be settled, and `confirm.ts` already shows how.
**The unit is a glance, not a field.** The pinout is one item whether the part
has 8 pins or 144, because a person checks a pinout against a figure in one
look. A parameter block read off one specification table is plausibly one glance
at that table. If that holds, the budget works. **If it does not hold, the honest
outcome is that this product refuses more parts than it serves, and that is
worth knowing before the emitter is written rather than after.**

Whatever is decided, `confirm.ts` is where it lives, `bench:confirm` is what
reports it, and the pairing table in `RULES.md` gains rows. A pairing that cannot
name two different means is not a confirmation, and `RULES.md` says to say so
rather than invent one.

---

## 5. The shape, by analogy

This part is low risk. The CAD path is a working answer to the same problem and
the SPICE path is the same pipeline with different fields. Follow it rather than
inventing a second architecture.

| CAD | SPICE counterpart | Note |
| --- | --- | --- |
| `extractionFields` in `extraction/contracts.ts` | the parameter field list | Field-directed. The reader is handed the fields and the pages. |
| `PackageDimensions` in `types.ts` | `SpiceParameters` | Every value an `Extracted<T>`, carrying value, confidence, method and citation. |
| `mergeModelValues` in `extraction/merge.ts` | same, unchanged | Where a model answer enters the record and is validated. |
| `confirm.ts` | new pairings, section 4 | The invariant. |
| `review.ts` | same, unchanged | The parameter and citation correction loop. `ReviewItem` is field-path based and already generic. |
| `geometry.ts` | no counterpart | A macromodel has no geometry. This is the one stage that drops out. |
| `emitters/kicad.ts` | `emitters/ltspice.ts` | Deterministic templating. No model writes the netlist. |
| `/api/export` | `/api/model`, or a format on `/api/export` | See below. |

**Every parameter is an `Extracted<T>`, with no exceptions.** That is what makes
`resolveForExport` able to refuse an untraceable value, what makes `review.ts`
able to show the page it came from, and what makes the record signable. A
parameter stored as a bare `number` is outside every guarantee the product
makes.

**`/api/model` or a format on `/api/export`?** Open, and lower stakes than it
looks. `exportFormats` is `["kicad", "altium", "cadence"]`, all board tools, and
a fourth member of a different kind may or may not belong there. The thing that
matters is that whichever route serves it applies `resolveForExport` and the same
refusal codes, because that gate is where traceability is actually enforced.

**The `both` bundle is unspecified.** One zip with a library and a model in it,
or two downloads. Decide it, then the button label follows.

---

## 6. The refusal contract, which is already decided

Reuse it verbatim. `/api/export` answers with the fields it could not stand
behind rather than a sentence, and the suite already renders three of the four:

| Code | Means |
| --- | --- |
| `INPUT_REQUIRED` | Your line has to answer this. Named fields, answered once in settings. |
| `UNTRACEABLE_EXTRACTION` | Read, but not locatable on any page. Refused for sign-off. |
| `INCOMPLETE_EXTRACTION` | The datasheet does not state it. |
| `FORMAT_CANNOT_ENCODE` | This format cannot carry this name. Suggests one that can. |

Seam 4 already states the contract correctly: a parameter the datasheet does not
state is asked for by name, or the model is refused. **Do not add a fifth code
for parameters until one of these genuinely does not fit.**

---

## 7. What LTspice actually consumes

**`HANDOFF.md` says "the `.asc` symbol" and that is wrong.** In LTspice `.asy` is
the symbol file and `.asc` is a schematic. The error is corrected in this
document and should be corrected there.

Settle the file set before the emitter, because it determines the bundle:

- The model text itself, as a `.subckt` block. Whether it ships as `.lib`,
  `.sub` or `.mod`, and whether that choice affects how LTspice resolves it.
- The `.asy` symbol, so the part can be placed rather than only referenced.
- **Whether the `.asy` pin order must agree with the CAD symbol this product
  emits for the same part.** If a user takes both, two artefacts from one tool
  that disagree about pin order is the worst failure available here, and it is
  silent.
- Whether anything has to be written into a library index for LTspice to find
  the model, or whether a file in the right folder is enough.

**Confirm every one of these against the real tool, not against documentation
and not against a parser.** `LEARNINGS.md` records why: `kiutils` and AltiumSharp
both accepted a symbol library that KiCad refuses to open, and `bench:kicad`
exists because of it. The SPICE equivalent is running LTspice, or ngspice where
LTspice cannot be driven headlessly, over the emitted netlist and confirming it
simulates. **An independent reader is not the customer's tool.**

---

## 8. The instruments

`RULES.md` is explicit that an instrument that cannot fail is not a check, and
`LEARNINGS.md` records four green checks that could never have gone red plus a
copper bench blind to a land moved 0.9 mm on 66 of 80 footprints. Build the
benches with the feature, and prove each one can go red.

At minimum:

- **`bench:model`.** Does the emitted netlist simulate in the real tool? This is
  `bench:kicad`'s counterpart and it is the one that decides whether any of this
  works.
- **A parameter accuracy bench**, the counterpart of `bench:dimensions`. Are the
  numbers read the right numbers? Needs hand-read ground truth on the tuned
  corpus, and that work is the real cost.
- **A behavioural bench.** A netlist can be syntactically valid, simulate
  cleanly, and be wrong. Does the model exhibit the gain-bandwidth the datasheet
  states? This is the SPICE-specific instrument with no CAD counterpart, and it
  is the only one that checks the artefact against what it claims to be.
- **`bench:instruments` must cover every one of them.** It refuses the run if an
  injected defect changes nothing, and that is what stops a new bench joining the
  four that were green for weeks.
- **A row of zeros is not a pass.** Where a bench had nothing to measure it says
  `NO DATA`.

---

## 9. What not to do

Each of these has already cost this project something, on the CAD side.

- **Do not let a model compute.** It reads; generation stays deterministic. A
  model asked to write a netlist will write a plausible one, and plausible is the
  failure mode this whole product exists to refuse.
- **Do not carry a parameter across parts in a family.** That is the hand-typed
  family table that `packages.ts` used to be, and deleting it is what let SOT-23
  and LFCSP work at all.
- **Do not widen a bound until a document passes.** Tailoring to a datasheet.
- **Do not add a second model call to work around a refusal.** Remove the reason
  for the refusal instead. The CAD pipeline made three calls per part until the
  third one's reason was fixed and the call was simply deleted.
- **Do not open the hold-out corpus.** Not to diagnose a SPICE failure, not as a
  subset, not once. A hold-out part that must be examined is promoted into the
  tuned corpus and replaced. `holdout.ts` starts a measurement the moment it is
  imported.
- **Do not ship a generated model beside a vendor's without saying which is
  which.** See section 1.

---

## 10. Suggested order

1. Answer section 1. Generate, or find. Everything else depends on it.
2. Answer section 2. One device class, named.
3. Answer section 4 on paper, for that class. What is the second means for each
   parameter, and does the flag budget survive? **If it does not, stop here and
   say so.** That is a real and reportable outcome, and it is far cheaper found
   now than after an emitter exists.
4. Settle section 7 against the real tool, with a throwaway netlist written by
   hand. No extraction involved. This proves the target before anything aims at
   it.
5. Build `bench:model` against that hand-written netlist, and prove it goes red.
6. Then, and only then, the field list, the record type, the emitter and the
   route.
7. The suite's SPICE panel and its review screen last. `HANDOFF.md` lists it as
   still open, and it should stay open until there is something real to review.

---

## 11. The open questions, collected

For whoever wants the list without the argument.

1. Generate models, retrieve the vendor's, or both? (§1)
2. Which device classes, and which one first? (§2)
3. `min`, `typ` or `max`? One right answer, or a setting? (§3, rule 2)
4. What is the second independent means for each parameter? (§4)
5. Is a parameter block one flagged item or many, and does the budget survive? (§4)
6. `/api/model`, or a fourth `exportFormat`? (§5)
7. What is in the `both` bundle? (§5)
8. Which files, and must the `.asy` pin order match the CAD symbol? (§7)

Questions 1, 2 and 4 are decisions about the product. The rest follow from them.

---

**When any of these is answered, record it here with its date and its reason, the
way `RULES.md` and `LEARNINGS.md` do.** A decision without its reason gets
re-litigated by the next person, and this document exists so that does not
happen twice.
