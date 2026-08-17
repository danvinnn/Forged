# Audit: every process, workflow and feature

Plan steps 1 and 2, run 2026-08-14. Everything here is either a measurement
against a real reference library, a quote from a published convention, or a
reproduction against the actual generator. Nothing is an opinion.

How the evidence was gathered:

- **Reference footprints and symbols** pulled from the official KiCad libraries
  (`kicad-footprints`, `kicad-symbols`). These are the ecosystem's own statement
  of what a library entry looks like.
- **KLC**, the KiCad Library Convention, for the rules those files obey.
- **The real generator**, run on constructed records, so every defect below was
  reproduced rather than reasoned about.

---

## The one result worth leading with

Our SOIC-8 pads are **identical to KiCad's own** `SOIC-8_3.9x4.9mm_P1.27mm`,
to the micron, when the datasheet's printed land pattern is read:

```
reference   pad 1 (-2.475, -1.905)  1.95 x 0.6      courtyard  +/-3.7  +/-2.7
forge       pad 1 (-2.475, -1.905)  1.95 x 0.6      courtyard  +/-3.7  +/-2.7
```

The geometry core is right. Everything below is either a defect at the edges of
it, or a convention the file does not yet carry.

---

## A. Correctness defects

These produce a wrong file that looks like a right one. Highest priority.

### A1. A quad package with unequal sides emits pads that are not pins

`assemble` reads `leadsPerSide`, validates it, and then **throws the result
away**: `quadRowSides` divides the pin count by four regardless. Reproduced with
a 22-lead quad and `leadsPerSide = "6,6,5,5"`:

```
(pad "6.5"  ...)   (pad "7.5"  ...)   (pad "17.5" ...)   (pad "20.5" ...)
20 pads for 22 pins; pins 11 and 22 have no land at all
```

`Array.from({length: 5.5})` truncates to 5, and `index * 5.5 + step + 1` yields
fractional pad numbers. The footprint is emitted without complaint.

`exporters.ts:352` (`quadRowSides`), `exporters.ts:901` (validated and dropped).

### A2. Choosing a different package keeps the first package's printed land pattern

`landPadLengthMm`, `landPadWidthMm` and `landSpanMm` are read off the
recommended-footprint drawing **for the package the record resolved to**. Both
places that switch package drop some evidence and keep these:

- `optionFor` drops `packageOutlineCode`, `vendorLandPattern`, `pitchMm` and
  `leadWidthMm`, and keeps the printed land. So the chooser reports `ships` for
  a package whose footprint would be built from another package's copper.
- `/api/export` drops even less: only `packageOutlineCode`, `pitchMm`,
  `leadWidthMm`, `leadSpanMm`, `leadContactMm`.

Neither drops `leadSides`, `vacantLeadSlot`, `leadsPerSide`, `thermalPad*`,
`solderMaskExpansionMm`, `solderMaskDefined` or `thermalVia*` either, all of
which are equally per-package.

`exporters.ts:1336`, `app/api/export/route.ts:117`.

### A3. Every question the generator asks is unanswerable except one

`handleSupplyNeed` sends whatever the user types as `formedLeadSpanMm`,
whatever field was actually asked about:

```ts
setPendingNeeds([]); setNeedValue(""); await handleExport(value);
//                                                       ^ always formedLeadSpanMm
```

So a part that needs `landPadLengthMm` re-asks the same question forever. All
needs also share one input box, so a part needing three values cannot be
answered even in principle.

This is the whole "ask rather than refuse" behaviour, dead at the last step.
`app/page.tsx:632`.

### A4. `leadsPerSide` is asked for and cannot be sent

It is in `RequiredInput["field"]` and in `SuppliedDimensions`, and the export
route's accept-list does not include it. `app/api/export/route.ts:143`.

### A5. The export tells the user the wrong provenance

```ts
const exportNote = `Native ${format} library generated from the IPC-7351B land pattern.`;
```

Unconditional, including when the lands are the datasheet's own printed pattern
and IPC-7351B contributed only the courtyard. The file's own `descr` says the
right thing; the message the user reads does not. `app/api/export/route.ts:214`.

---

## B. Library conventions we do not follow

Each measured against the corresponding official KiCad file.

| # | Gap | Evidence |
|---|---|---|
| B1 | Footprint has no `(attr smd)` | every reference SMD footprint has it; DIP-8 has `(attr through_hole)` |
| B2 | No silkscreen body outline, only a pin-1 dot | reference SOIC-8 draws six clipped `fp_line` segments on `F.SilkS` |
| B3 | `F.Fab` outline is a plain rect with no pin-1 chamfer | reference uses a 5-point `fp_poly` with the pin-1 corner cut |
| B4 | No `(tags ...)`, no `fp_text user "${REFERENCE}"` on `F.Fab` | both present in every reference footprint |
| B5 | Symbol pins sit off the 100 mil grid (`+/-3.81`, `+/-1.27`) | KLC S4.1: "pin origin must lie on a 100mil grid node"; MCP2551-I-SN uses 5.08 / 2.54 / -2.54 / -5.08 |
| B6 | Symbol carries only Reference, Value, Footprint | reference symbols carry seven: `+ Datasheet, Description, ki_keywords, ki_fp_filters` |
| B7 | Pin name and number font 1.0 mm | reference uses 1.27 mm |
| B8 | Paste apertures reuse the thermal pad's number; no `pad_prop_heatsink`, no `zone_connect 2`; EP copper is roundrect | reference: `(pad "" smd roundrect ... (layers "F.Paste"))`, EP is `rect` with both properties |
| B9 | Thermal vias emitted on `*.Mask`, i.e. untented | an open via in a solder land wicks paste out of the joint |
| B10 | STEP body spans `-h/2 .. +h/2`, so half the package is under the board | CAD expects the body to sit on `z = 0` |
| B11 | Altium: silkscreen is a plain body rectangle that can cross pads; `Height=0` despite a computed STEP height; `ComponentDescription` is the part number and there is no datasheet parameter | Altium convention places silk on Top Overlay clipped off pads |

### The paste-coverage measurement

Worth stating separately, because it settles an open item and confirms another.

33 exposed-pad footprints were parsed out of the official KiCad QFN/DFN library
and the paste coverage solved for each:

```
coverage observed:  0.640 to 0.658   (33 of 33)
our TARGET_PASTE_COVERAGE:   0.65
```

So the 65% figure is not just inside IPC-7093's 50-80% band, it is what the
ecosystem's own library actually cuts. **Confirmed, independently.**

`MAX_APERTURE_MM = 1.5` does **not** survive the same test. Observed apertures:

```
0.24  0.28  0.35 ...  1.37  1.48  1.81  1.99  2.06
```

There is no maximum anyone honours: EP 1.6x2.56 gets a single 1.29 x 2.06
aperture, EP 7.4x7.4 gets 3x3 of 1.99. The subdivision count is chosen per
footprint by hand, and no published rule predicts it. See C1.

---

## C. Rule compliance and stale work

| # | Item | Rule |
|---|---|---|
| C1 | `MAX_APERTURE_MM = 1.5` cannot be sourced. Coverage can; the grid count cannot. | 1, do not invent |
| C2 | `NOLEAD_TOE_BEYOND_BODY_MM` and `nominal()` are dead since the no-lead rule was retired | 5, do not overengineer |
| C3 | `LeadDimensions.contact` documents itself as a per-family calibration; it now comes off the drawing | 1, name the source |
| C4 | `REVIEWABLE` reviews `leadContactMm` (whose stated consequence is now false) and reviews none of `landPad*`, `landSpan`, `leadSides`, `leadsPerSide`, `thermalPad*`, which are the values that now literally are the pads | 6, engineer's expectation |
| C5 | Courtyard half-height uses a hardcoded `+ 0.25` instead of `COURTYARD_EXCESS[densityLevel]` | 1 |
| C6 | The record has no description, temperature range, RoHS, MSL or orderable numbers, and `sourceUrl` never reaches an output file | 6 |
| C7 | Through-hole is unrepresentable: `Pad.mounting` admits only `"smd"` | 3, read or ask |

---

## What was checked and found sound

Not everything is a defect, and saying so is part of the audit.

- **Pin ordering.** Counterclockwise from the top-left on both dual and quad,
  matching the reference SOIC-8 and LQFP-48 pad coordinates exactly.
- **The vacant-slot model for odd lead counts.** The reference SOT-23-5 places
  pads at `y = -0.95, 0, +0.95` on the three-lead side and `y = +0.95, -0.95` on
  the two-lead side, leaving the middle grid position empty. That is exactly what
  `vacantLeadSlot` describes.
- **Courtyard extents.** Ours matches the reference bounding box.
- **Paste coverage of 65%.** Measured above.
- **Refusing to compute a no-lead pattern from gull-wing fillet goals.** The
  standard publishes them per lead form and only gull-wing is transcribed.

---

# Part two: what was done, and what it measured

Everything below landed on 2026-08-14. Test count went 782 → 587 and the suite is
green; the drop is 55 tests that pinned a hand-typed package table plus the whole
deterministic-parser suite, replaced by 60 that drive the real generator.

## A. The correctness defects, all closed

| # | Fix | Proof |
|---|---|---|
| A1 | `leadsPerSide` is now used, not validated and discarded | a 38-lead quad reproduces KiCad's `QFN-38-1EP_4x6mm` layout exactly: 12 leads a side at -2.2 to +2.2, 7 at -1.2 to +1.2 |
| A2 | `asPackage` is the one rule for what switching package invalidates, shared by the chooser and the route | a sibling package can no longer report `ships` off another package's printed copper |
| A3 | The UI sends each answer under the field the refusal named, accumulates them across retries, and offers the right control per kind | every ask is now answerable; multi-value asks converge |
| A4 | `leadsPerSide` and `vacantLeadSlot` accepted by `/api/export` | a contract test walks the whole `RequiredInput` union, so the next field has to be plumbed before it can pass |
| A5 | The export note states what the lands actually are | asserted against the printed-pattern case |
| A6 | The odd-row question asked for `leadSides` and meant `vacantLeadSlot` | fixed; `unit` now distinguishes mm from counts |

## B. Library conventions: measured against KiCad's own files

Our SOIC-8 now reproduces `SOIC-8_3.9x4.9mm_P1.27mm` **segment for segment**:
eight pads to the micron, six silkscreen lines at identical coordinates, and a
fabrication polygon whose pin-1 chamfer matches point for point. That diff is
pinned in `library-diff.test.ts` against numbers transcribed from the reference
file, so it can fail for the right reason.

Also closed: `(attr smd)` / `(attr through_hole)`, `(tags ...)`, the `F.Fab`
designator, the four missing symbol properties (`Datasheet`, `Description`,
`ki_keywords`, `ki_fp_filters`), pin font 1.27, paste apertures with an empty pad
number plus `pad_prop_heatsink` and `zone_connect 2`, thermal vias tented rather
than open, the STEP body seated on `z = 0` instead of half-buried, and the Altium
silkscreen clipped clear of the pads with a real component height.

**Symbol pins are now on the 100 mil grid** (KLC S4.1). An even number of rows
cannot be both centred on the origin and on grid, so the pins hold the grid and
the body carries a `bodyCentreYMm` offset.

## C. Rules

`MAX_APERTURE_MM` could not be sourced, and the way that was established is worth
keeping. Six reference footprints were consistent with a 1.35 mm maximum, which
read like a recovered constant. Solving the same bound across all 33 gives "at
least 2.0639 and less than 0.4837": **no maximum exists that the library obeys.**
It is now an explicit setting with the default stated as ours. Paste *coverage*
went the other way and is now better sourced than before: 33 of 33 reference
footprints land between 0.640 and 0.658 against our 0.65.

Also: dead no-lead constant and `nominal()` removed, the stale
`LeadDimensions.contact` doc corrected, the courtyard's hardcoded `0.25` replaced
by `COURTYARD_EXCESS[densityLevel]`, and the review panel extended to the fields
that now *are* the pads.

## The parser: deleted, on a measurement

`datasheet.ts` (1,850 lines), `pintable.ts` (3,404), `pinfigure.ts` (1,735) and
`drawingdimensions.ts` (355) are gone. `datasheet.ts` is now 228 lines.

Measured over the 25 cached datasheets that have both a parser run and a real
model answer on file:

```
field                        parser only   model only
body length / width / height      0         19 / 19 / 18
lead span                         0         15
lead contact                      0         16
printed land pattern              0          8  (x3 fields)
lead sides                        0         10
pitch                             4         15
lead width                        2         16
```

The parser contributed **nothing** to eighteen of the twenty-one dimensional
fields. Three readers survive because none of them reads a dimension: the
ordering-table package list (25 of 25, better than anything else here), the
printed land-pattern callouts (a *check*, not a source), and text extraction.

**What this cost, stated plainly.** One security test asserted that a
deterministic reader's own value survived an injected instruction. That reader is
gone. The control that actually stops the attack is unchanged and is now what the
test asserts: the injected region is stripped before citation matching, so the
value carries no citation, and untraceable geometry is refused at the export
boundary. A second cost: an outline code and a prose designator (`D (SOIC)` vs
`SOIC (8)`) now read as a disagreement, because nothing left knows they are the
same package. It flags rather than blocks, and the alternative was a hand-typed
synonym table.

## Replay: the whole downstream, on real model answers, for nothing

`npm run bench:replay` feeds 79 cached model answers straight into the generator.

```
SHIPS 38/79 (48%)   ASKS 28   REFUSED 0   NO RECORD 13

what is asked for:  22 landSpanMm, 20 landPadLengthMm, 20 landPadWidthMm,
                    15 leadSides, 2 vacantLeadSlot
```

**Zero refusals.** Every failure is either a question the user can answer or a
document with no pin table. The questions concentrate in four fields, which is
where prompt work would pay before the next paid run.

## The confidence system, and what it caught

Eight named checks, no new model calls, each one able to fail on a real record.
`confidence.test.ts` drives every check to `pass` and to `fail`, so a check that
becomes unreachable fails the suite.

Run across the 66 replayable records it flagged **11**, and inspecting those
found two defects in the checks themselves rather than in the data:

- comparing the span's *minimum* against a nominal body failed four correct
  readings, because a drawing prints the span as a range and the body as a
  nominal;
- applying the IPC band to a no-lead package failed six, two of them by 0.01 mm,
  which is the exact mistake `ipc7351.ts` refuses to make in the generator.

After both fixes: **4 flags on 66 records**, and each survivor looks like a real
find (a 9-pin table on an 8-pin part; three printed patterns well outside the
band). A 6% flag rate is actionable; 17% would have trained the reviewer to click
past it.

## Through-hole, which was unrepresentable

`Pad.mounting` admitted only `"smd"`, so a PDIP had nowhere to go however well
its datasheet was read. Now: `mounting` and `leadDiameterMm` are read off the
drawing, IPC-7251 sizes the hole (lead + 0.25/0.20/0.15 by density) and the land
(hole + annular ring), pin 1 is rectangular and the rest round, and the pads
carry no paste. A DIP-8 with a 0.5 mm lead produces a 0.7 mm hole in a 1.5 mm
land on a 7.62 mm row spacing.

Routed on `dimensions.mounting`, which the drawing shows, never on the package
name. The Altium writer still refuses these and now says so accurately: the hole
size is known, so it is a gap in that writer rather than in the reading.

## Cost and latency: one measured negative

The plan proposed rendering pages concurrently. Measured first:

```
text extraction   630 ms over 50 pages
render 8 pages    732 ms   (92 ms/page)
```

Against model calls measured in seconds, rendering is about 2% of the wall clock,
and mupdf's rasteriser is synchronous WASM that `Promise.all` would not overlap.
**Not worth the risk**, and the plan's own constraint says so.

The thinking budget remains the real cost lever (68% of the bill, 92% of output
tokens never returned). `FORGE_THINKING_BUDGET` exists and the default is
unchanged, because moving it needs a measurement on the tuned corpus and that
measurement costs money.

## Compliance sweep

Every numeric constant in the generation path, with its source:

| constant | source |
|---|---|
| `FILLET_GOALS` | IPC-7351B, gull-wing only, stated |
| `COURTYARD_EXCESS` | IPC-7351B per density level |
| `HOLE_ALLOWANCE`, `ANNULAR_RING` | IPC-7251, cross-checked against the reference DIP-8 |
| `TARGET_PASTE_COVERAGE` | IPC-7093 band, and 33 of 33 reference footprints |
| `MAX_LEAD_WIDTH_FRACTION_OF_PITCH` | measured across four drawings; catches the ADS1115 misread |
| `BAND_TOLERANCE_MM` | measured: 8 of 8 tuned vendor patterns fit with zero slack |
| `DEFAULT_MAX_APERTURE_MM`, `MIN_APERTURE_MM` | **ours**, and declared as settings with no published source |
| silkscreen widths, offsets, `FAB_CHAMFER_*` | KLC F5.1-F5.3, confirmed against the reference file |

The remaining constants live in `pdftext`, `fontdecode`, `packagedrawing`,
`vendorland` and `packagevariants`. They are text-parsing thresholds rather than
claims about parts: a wrong one produces a failed read, not a wrong number on a
board. That is a different risk class and it is why they are not in the table.

## Still open, deliberately

- **Altium cannot write a through-hole pad.** The geometry carries the hole; the
  writer refuses and says so. KiCad output for the same part is complete.
- **The thinking-budget default is unmeasured.** Needs a paid run.
- **`packageOutlineCode` is now a model field** and has never been measured as
  one, because that also needs a paid run.

---

## Step 9: the compliance sweep, rule by rule

Run as a fresh pass over the finished code, not a recollection of what was fixed
along the way.

**Rule 1, do not invent.** Every numeric constant in the generation path is in
the table above with its source. Two are ours and say so in their own doc
comments. `MAX_APERTURE_MM` is the case worth noting, because the sweep is what
stopped a fitted constant from shipping as a recovered one.

**Rule 2, do not assume.** The remaining derivations are: the RSS tolerance
combination (the standard's own arithmetic), the paste grid (a stated setting),
the courtyard (the standard's excess per density level), and the per-side lead
placement (each side centred on itself, read off KiCad's own QFN-38 rather than
reasoned about). The one assumption that was found and removed is the
range-to-midpoint collapse in the drawing reader, which is the worked example in
`RULES.md` and was live.

**Rule 3, read, ask, or offer a setting.** Six refusal sites remain in the
generator. Five carry a `needs` list naming a field the export route accepts, and
the contract test walks the whole union so a new one cannot be added without
being plumbed. The sixth is the stencil minimum, which is a fact about the part
rather than a question: a pad too small for one aperture cannot be pasted by
anyone.

**Rule 4, general, never tailored.** No vendor name, part number or package
family appears in any rule or branch in `exporters.ts`, `ipc7351.ts` or
`confidence.ts`. Vendor names survive only in comments, naming the drawing a
measurement came from, which is the opposite of fitting. The two name-based rules
that did exist, `GULLWING_FAMILY` and `QUAD_FLAT_PACK`, went with the table. The
tests were swept too: the 55 that pinned that table are gone rather than adapted,
because a test that only holds for the constants that fitted it defends those
constants.

**Rule 5, do not overengineer.** Deleted this pass: 7,500 lines of parser, a
600-line family table, the `supportedFamilies` concept, the `PACKAGE_SUGGESTIONS`
UI, a `config` field, a dead no-lead constant, `nominal()`, and a duplicated
layout helper. Not built, on measurement: concurrent page rendering.

**Rule 6, the engineer's expectation.** Every convention added this pass is
sourced to a published library file or the KLC, and the diff against that library
is a test rather than a claim.

---

# Part three: the audit re-run, 2026-08-15

The first sweep passed everything. It was wrong, and the way it was wrong is
worth more than the defects it missed.

## What the first sweep did

It searched for `const NAME = <number>` and checked each against a source. Every
named constant in the generation path was accounted for, so the sweep reported
clean.

## What it could not see

**A value does not have to be named to reach an output.** Three of them reached
the 3D model through an inline fallback:

```ts
const lengthMm = part.dimensions.bodyLengthMm ?? Math.max(part.pinCount * 0.8, 4.0);
const widthMm  = part.dimensions.bodyWidthMm  ?? Math.max(part.pinCount * 0.55, 3.0);
const heightMm = part.dimensions.bodyHeightMm ?? 1.5;
```

For an 8-pin SOIC that shipped a **6.4 x 4.4 x 1.5 mm** solid for a part that is
**4.9 x 3.9 x 1.75 mm**. A 3D body exists to answer "does it fit"; a guessed one
answers it wrongly while looking authoritative, and nothing in the file said the
numbers were invented.

It is the same arithmetic the footprint path deleted long ago (`pitch * 0.55`).
It survived because nobody looked in the STEP builder and because the sweep was
written to find declarations rather than values.

**Fixed:** the three are read or asked for, never guessed. Measured over 66 real
records, 62 already carry all three, so this asks on four.

## What the re-run found on top of that

**A question naming the wrong field, reintroduced within a day.** The
through-hole path, written on 2026-08-15, asked for a lead diameter under
`landPadWidthMm` and a pitch under `landPadLengthMm`. Both are real accepted
fields, so nothing failed: supplying either filled a land dimension, left the
asked-for value missing, and returned the same question forever.

This is defect A6 from part one, recreated hours after being fixed. The contract
test did not catch it because its field list is hand-written, and both wrong
names were on it.

**Fixed twice over.** The asks name `leadDiameterMm` and `pitchMm`, and the test
no longer trusts a hand-written list: it drives the real generator over six
deliberately incomplete records, collects every field it actually asks for, and
asserts the route accepts each one. A new question is now tested by existing.

**A hole of zero.** `(drill ${pad.drillMm ?? 0})` in the KiCad emitter would have
turned a generator bug into unplated pads that look correct in CAD. It refuses
instead.

## Rule by rule, after the re-run

| rule | result |
|---|---|
| 1, do not invent | Clean. No value reaches an output without a source, by declaration or by fallback. What remains hardcoded is text placement and marker size: drawing conventions with no manufacturing consequence, and labelled as such. |
| 2, do not assume | Clean. The midpoint collapse was the live one and it is gone. |
| 3, read, ask, or setting | Nine refusal sites; every one either carries an answerable question or states a fact about the part. Every question names the field that receives it, now enforced by collection rather than by memory. |
| 4, general, never tailored | Clean. No package family, vendor or part number reaches a branch in `exporters.ts`, `ipc7351.ts`, `confidence.ts` or `kicad.ts`. |
| 5, do not overengineer | No dead code among what was added. `fromDatasheetLayoutOnly` removed. |
| 6, the engineer's expectation | Every convention added is sourced to a published library file or the KLC, and the diff against that library is a test. |

## The lesson worth keeping

Both defects found this round were **introduced by the work that fixed the
previous round**, and both were invisible to a sweep that looked at the shape of
the code rather than at what reaches the output.

A compliance sweep that greps for a syntax will keep passing while the same
defect walks in through a different syntax. The two checks that now hold are the
ones that ask the running system what it does: the replay bench, and the contract
test that collects the questions the generator actually asks.

## Also fixed this round

**The land-pattern question showed the wrong page.** `findVendorLandPattern` ran
in `buildPartRecord`, before the model, where the only package name available is
the one the user clicked. On the ordinary path nothing was found, so the question
"Land length, along the lead" was shown beside the package OUTLINE drawing, which
dimensions the body and the leads and carries no land length at all. It now runs
beside `findPackageDrawing`, after the model, which is where that file already
did the same thing correctly for the other page.

That also restores `contradictsPrintedLand`, which had been receiving null and
returning false for every part.

**The questions are shown before the button is pressed.** `packageOptions` runs
the real generator per package when a datasheet is read, so the missing numbers
are known immediately. The UI waited for a failed export to reveal them. Same
work, one less dead end.

# Part four: the pre-hold-out audit, 2026-08-16

Run before spending money on the hold-out, on the theory that a run measures
whatever is in the tree at the time and a wrong footprint counted as a SHIP is
worse than no number at all.

## The green board, first

607 tests, typecheck clean, `next build` clean, `next dev` serves 200, replay
38/79 SHIPS with 0 REFUSED. All of that was true and none of it caught what
follows, which is the third time in this project a green board has been mistaken
for evidence.

## What was found: through-hole assumed two rows of pins

`throughHoleFootprint` hardcoded `arrangement: "dual"` and never read
`leadSides` at all. The surface-mount path has always taken the arrangement from
the drawing, in `datasheetLayout`; the through-hole path added on 2026-08-14 did
not, and nothing compared the two.

Driven through the real generator, a 3-lead TO-220 came out as:

    (pad "1" thru_hole roundrect (at -2.500 -1.270) ...)
    (pad "2" thru_hole circle    (at -2.500  1.270) ...)
    (pad "3" thru_hole circle    (at  2.500 -1.270) ...)

Two columns 5 mm apart. The part is three pins in one straight line on a 2.54 mm
pitch. It did not refuse, and no confidence check covers it: `sides-add-up`
reads `leadsPerSide`, which is unread on almost every part.

Three things make it worth the audit on its own:

1. It is a **silently wrong footprint**, which is the worst output this product
   has. It looks entirely ordinary in CAD.
2. It **inflates SHIPS**, which is the one number the hold-out exists to keep
   honest.
3. The reference part is a TO-220 (`test-data/ul_LM7805CT-NOPB/`), supplied to
   build the Altium through-hole path. The path was built and verified against a
   DIP-8 the whole time and the reference package was never driven through it.

Underneath: **the through-hole path has never run on a single real model
answer.** No cached answer carries `mounting` at all, because the field was
added after the cache was written. Replay therefore cannot reach it, and its
only evidence is a hand-written DIP-8 fixture. The hold-out will be the first
real exercise of it.

## The fix, and the half of the finding that was wrong

`throughHoleFootprint` now requires `leadSides === 2` and asks otherwise,
which is the rule the surface-mount path already applied, written on the path
that was missing it.

The first version of the fix also refused packages read as 1 or 3 sides, on both
paths. The typecheck rejected it: `leadSides` is `2 | 4 | null` in the type AND
in the zod schema, so a model answering 1 is already coerced to null and the
guard was unreachable. It was deleted rather than kept as insurance, per rule 5.

So the reachable defect is narrower than it first looked, and its shape is worth
recording: the danger was never a strange value arriving, it was **null being
treated as a default instead of as a question.** The prompt tells the model to
answer null for a one-sided package, which means the state a TO-220 arrives in
is precisely the state that fell through to two rows.

## What is still not built, and is now said out loud

A single line of pins is not generated, in either mounting. `leadSides` cannot
represent one side, so a TO-220 is indistinguishable on the record from a DIP
nobody read, and the honest handling is to ask the row count and state the limit
in the question rather than let someone type 2 and take the wrong footprint.
The refusal text says so and a test pins that it does.

Building it is a small piece of work. What it needs first is evidence of how
often it matters, which is one of the things the hold-out will show.

## Everything else checked, and sound

- **Hold-out integrity.** `holdout.ts` is untouched by every commit in this
  session and is referenced from nothing but itself. No corpus datasheet was
  opened during this audit; the defect came from the reference file in
  `test-data/`, which is not in the corpus.
- **Money.** Cumulative spend ceiling defaults to $10 across all runs, not per
  run, and throws before the call rather than after. Estimate and offline modes
  make no network calls.
- **Crash safety of the run.** The runner catches per part on both the parse and
  the export, so one bad document cannot end a paid run partway.
- **The new fields reach the model.** `mounting`, `leadDiameterMm` and
  `packageOutlineCode` are in `extractionFields`, in the prompt, in the schema,
  and in `merge.ts`.
- **Generation constants.** Every constant in `ipc7351.ts`, `kicad.ts` and
  `pcblib.ts` names its source, including `DEFAULT_MAX_APERTURE_MM`, which names
  the absence of one.
- **No part-number branches in production code.** Every part number in `src/`
  is in a comment recording evidence, plus one UI placeholder.

# Part five: testing measured, and the defects that found

Run 2026-08-16, after the hold-out. The trigger was a fair complaint: the suite
is largely tests written alongside the code they test, by the same author, in the
same sitting, against hand-built fixtures. That guarantees shared blind spots,
and no amount of care fixes it.

## The measurement: mutation testing

`npm run bench:mutation` breaks the generator in twenty specific, hand-chosen
ways and reports which the suite notices. Every mutation is a defect somebody
could plausibly introduce and that would produce a board that does not work: a
starved toe fillet, a hole too small for its lead, a row numbered backwards, a
paste layer dropped.

**Result: 17 killed, 3 survived.**

Chosen by reading the geometry code rather than generated. A mutation nobody
could make by accident does not answer the question being asked.

## The first run reported 20/20, and it was an artifact

The harness did not check that the baseline was green, and the tree was edited
while it ran, including adding tests for a fix not yet applied. A red baseline
makes every mutation "killed" and the report reads perfect.

A tool written to stop a green board being mistaken for a working product had
exactly the defect it was built to find. The baseline is now checked and a red
one is a hard stop.

## What survived, and what each was worth

**M16, and this one mattered.** Deleting `F.Paste` from the ordinary
surface-mount pad left all 595 tests passing. No paste aperture means no solder
is printed for that land: every part placed and none of them soldered. Nothing
caught it because every paste assertion in the repo was about the THERMAL pad,
where paste deliberately does not follow copper. The ordinary case, which is
every land on every part, was covered by nothing.

**M18.** Courtyard line width changed from 0.05 to 0.2 and nothing noticed.
`library-diff.test.ts` compared WHERE the courtyard sits and never how it is
drawn, so a footprint that fails KiCad's own library checker would have shipped.

**M17 was a bad mutation, and saying so matters.** It dropped
`(roundrect_rratio 0.25)` and was described as losing the pin-1 marker. It does
not: the shape token stays `roundrect` and KiCad's default ratio is 0.25 anyway.
Reporting it as a hole would have been a false alarm dressed as a finding. It was
rewritten to be the defect the description names, every through-hole pad round,
and the suite kills that.

All three are killed now, confirmed by re-running each rather than assumed.

## The defect the read-through found, which mutation testing could not

Mutation testing only asks whether the suite notices a change. It cannot find a
rule that was never written. Reading did.

**One package's pin table was building another package's footprint.** A family
datasheet describes several packages and the record carries ONE pin table. Three
routes relabelled a part as a sibling and kept it: `asPackage` (the chooser and
`/api/export` with a package override), and the UI, which answered a package
click with "the pinout was already read, so it was kept".

Measured over the cached hold-out answers: 21 of the 56 cached documents describe
more than one package with its own pin table, and TEN differ in lead count.
ADS1256 is an SSOP-20 or an SSOP-28; SN74HC595 a 16-pin SOIC or a 20-pin FK;
LT1013 an 8, 14 or 16 lead part. Clicking the other one built a footprint with
the first package's pad count under the second's name. The chooser printed
"· 28 leads" beside the button while the record held 20.

Fixed in one place, with two things that would have silently defeated it:

- `pinTablesByPackage` was on the TypeScript type but NOT in `partSchema`, and
  zod strips unknown keys, so `/api/export` would have dropped it on exactly the
  route that relabels.
- that field had been asked for in the prompt, parsed and stored since it was
  added, and consumed by NOTHING. Its own comment said it existed so a package
  choice would not cost another model call.

## Four test fixtures were incoherent, and passing for the wrong reason

The new lead-count guard refused them: a `VQFN-16` built with 8 pins, an
`8-pin SOIC` with 9, and `TSSOP-16`/`LQFP-64`/`CFP-14` all carrying the default
8. The guard was right and the fixtures were wrong.

## Dead code, and why it survived

`tsconfig.json` had `strict` but not `noUnusedLocals`. Turning it on surfaced
fourteen dead declarations immediately, several left by this session's own
deletions. All removed.

## The benches were measuring something the product does not do

`holdout.ts` exported the single record and counted a success. The product calls
`packageOptions`, which runs the real footprint build once per package the
document offers. On a family datasheet those are different questions: a part
whose record resolved to one package can still offer a working sibling.

The tuned bench had a third copy of the package switch, blanking three fields
where `asPackage` blanks every dimension plus the outline code, the JEDEC
outline, the printed land pattern and the thermal pad. It reported packages as
one-click that the product refuses. Both now call the product's own function.

Re-measured free from cache: SHIPS 14 to 15 of 56, and the largest refusal bucket
went from seven questions to four, because the chooser path asks less than the
single-record path did.

## Still not built, stated rather than hidden

- Confidence checks run on the INPUTS. Nothing checks the generated geometry,
  which is why both the TO-220 defect and this one passed every check.
- Single-row packages (TO-220, TO-92, SIP) are not generated.
- READ 61% remains a FLOOR: eight parts have no answer because the run that
  produced these answers ran the Google account dry partway.

# Part six: checks on the OUTPUT, 2026-08-16

Every check before this ran on the RECORD. Both wrong footprints this product has
produced passed all of them, because in both cases the inputs were individually
fine and the ARRANGEMENT was wrong. A reviewer cannot see that in a record and
can see it immediately in the pads.

`validateGeometry` now runs on the built footprint before any file is written,
and it THROWS rather than warns. A footprint whose lands overlap is a short
circuit, not a footprint with a caveat.

What it checks: one land per pin and no others, no two lands overlapping, the
courtyard containing every land, paste inside its own copper, a plated hole never
pasted and never without a drill, the pin-1 marker nearest pin 1, and every
dimension finite.

What it deliberately does NOT check: whether an ordinary land carries paste at
all. That lives in the emitter's layer list, not in this geometry, and pretending
to check it here would be worse than not checking it. It is covered where it
lives, by an invariant over the emitted file.

## It found two things on its first run

**The courtyard did not have to contain the lands.** On a dual package its height
came from the BODY, so a lead row longer than its body puts the end lands outside
their own keep-out. The comment beside it said exactly why that is wrong on a
quad without noticing it was the same mistake on a dual. It is now the larger of
the body and the actual land extent, in both axes, which is also closer to what
IPC-7351B means by a courtyard. `library-diff.test.ts` guards against fixing it
by inflating every courtyard: KiCad's SOIC-8 is the case where the body is the
wider bound and its value must not move.

**Two quad packages were shipping with all four CORNER lands overlapping.**
Replay went from 43 ships to 41, and those two are a correction rather than a
regression: pins 1/24, 6/7, 12/13 and 18/19 on a 24-pin part, shorted. Neither
input check could see it. `lands-fit-pitch` compares a land width against the
pitch and `lands-clear-centre` compares opposing rows; a corner clash is between
two lands on DIFFERENT sides and is invisible to both.

Checked against KiCad's own QFN proportions there is no clash, so the likely
cause is a centre span read too small rather than anything in the placement. The
error says both possibilities rather than asserting one: overlapping lands come
from a generator bug or from a misread dimension, and the geometry cannot tell
them apart. It points at the values a user can correct.

## What the packages are actually refusing, measured

Asked because "why are we refusing on packages" deserved a number rather than an
argument. Over the 51 hold-out parts with a reading:

```
28   record blocked, no chooser at all   (no pins or no pin count)
46   package options that ASK for a land pattern
 6   package options refused
 1   package option that ships outright
```

So the dominant refusal is not about packages at all: 28 of 51 parts never reach
a chooser because the reading is incomplete. Of the options that ARE offered, 46
of 53 are questions rather than refusals. The 6 refusals are all the new
lead-count guard, and each one was previously a silently wrong footprint. In the
product they are not dead ends either: clicking one re-reads the datasheet for
that package.

# Part seven: the answer to "why does this keep happening"

Asked after the package refusal numbers in part six. The answer is not that the
model cannot read these documents. It is that we collect the answer, pay for it,
store it, and never use it.

## Measured

Of the 51 hold-out parts with a reading, 28 never reached the package chooser.
The breakdown was NOT what part six implied:

```
12   have a pinout PER PACKAGE on the record, and were reported as "no pins"
 8   have a complete pin table and are blocked on a body dimension
 4   have pins that were read but could not be cited
 4   genuinely have no pinout at all
```

Twelve of the twenty-eight were never unreadable. A family datasheet whose part
number does not name a package gets `pins` null, correctly: the model is told not
to pick among several pinouts because guessing one becomes a footprint. It
returns them all, labelled, in `pinTablesByPackage`.

`resolveForExport` refused the record for having no pins, `packageOptions`
returned `ok: false`, and the user was told the reading was missing pins for a
document whose pinouts were on the record.

## The part worth keeping

`types.ts` describes this exact deadlock in a comment, in the past tense:

> "Before this, a part whose number did not name its package produced no pins at
> all, the record was therefore unreadable, and the package chooser refused to
> offer the very choice that would have unblocked it. The product deadlocked on
> its own question."

The field was designed, the data was collected on every call, the comment says it
works, and the last connecting step was never made. Nothing measured whether it
worked, so the comment stood in for the behaviour.

That is the recurring shape, and it is the same one as the pinouts discarded for
want of a citation, the thermal-pad discard, and this field going unconsumed
until part five. Not "the model cannot read it". "We had it and threw it away."

## Fixed

Each table is LOCATED on a real page by `mergeModelValues` before it is stored,
using the same check the main pin table passes and cutting quarantined regions
first. Every table in the corpus located successfully. A table matching no page
keeps a null citation, and `resolveForExport` refuses it exactly as it refuses
any uncited value, so nothing unverifiable is smuggled through.

`packageOptions` then offers one option per package, each carrying its own
pinout, but only when the pinout is the ONLY thing missing. A record also short
of a body size has a different problem and still gets the plain refusal.

Matching a designator to its table is done on the DESIGNATOR first and the lead
count second. Both sides render the same printed string and differ only in
punctuation: a TCA9548A's variants read `VQFN (RGE)` where its tables read
`VQFNRGE`. Lead count alone was the first attempt and matched two of twelve.

```
12/12 parts now reach a chooser        (was zero)
29/41 package options usable           (was zero)
READ  61% -> 82%
SHIPS 27%, unchanged
```

SHIPS not moving is the honest signal: this unlocked the pinout, not the whole
footprint. Those parts still need a land pattern.

## What is still missing

Nothing tests that data on the record reaches the product. All four instances of
this failure were found by reading, and the only reason this one became visible
is that the bench's own diagnosis was wrong in a way worth chasing. The bench now
distinguishes "we could not read it" from "we read it and did not use it", which
is the closest thing to a guard that currently exists.
