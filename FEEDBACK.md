# Cofounder feedback — session of ________

**Write what he said, not what you think it means.** The diagnosis can wait; his
words cannot be reconstructed afterwards. If he says "this is annoying", write
"this is annoying" and what was on screen, not "friction too high on the review
panel".

---

## The four questions

**1. Does the Altium library land correctly?** (open the DRV8825 zip in Altium)

> 

**2. Does your line form leads to a constant toe-to-toe span, or a constant
extension past the body?**

> 

*Why it matters: today we ask for a span once per assembler and then ask AGAIN
per package when the body is wider than that span. If it's an extension, that
collapses to one number for everything.*

**3. Is 1.73 values to check per part right?** The hard limit is 5 and is never
exceeded. A tool that saves time, or one that nags?

> 

**4. Should thermal vias carry the pad's net?** Currently geometry only.

> 

---

## Prompt changes — BATCH THESE — SPENT AND CLOSED 2026-09-02

**This list was closed on 2026-09-02.** All four edits went in together and one
paid re-read of the tuned corpus measured them: $3.06, 120 live calls.

    fields complete   47%  ->  53%
    ships unaided     68%  ->  73%
    ships a bundle    73%  ->  78%
    connector fields  25%  ->  75%
    connector ships   25%  ->  50%

No category regressed. `bench:copper` still reports only the pre-existing
`tps7a8300` finding and `bench:outputs` refused every corrupted value.

STILL UNMEASURED: the hold-out and blind corpora. Their caches were stranded by
the same prompt change, so the number that predicts unseen datasheets is
currently unknown. Extraction has a recorded 20-point tuned-vs-holdout gap, so
the figures above are the optimistic end until `bench:holdout` is re-run.

What went in, beyond item 1 below: `pins` can now report numbered contacts that
carry no names (a connector, header or socket), guarded so it can never be used
for a pin table that was merely not found; `leadSpanMm` now asks for through-hole
ROW SPACING, which `exporters.ts` had always read out of that field without the
prompt ever asking for it; and a new `dimensions.holeDiameterMm` takes the drill
from the datasheet's own recommended hole instead of computing it.

---

## Prompt changes (historical list)

**The prompt is the answer cache's key.** Changing it invalidates roughly 2,500
cached answers and forces a paid re-read of the whole corpus to re-establish
every number we quote. So these get collected and spent ONCE, together, not one
at a time.

Nothing in this section ships until the list is closed.

### 1. Ask for the overall seated height, not the body thickness — DONE 2026-09-02

*Already known, 2026-09-01. Not from him.*

**Shipped.** The prompt already said to prefer the overall height over the body
thickness; the half that was missing was which end of a min/max pair to take, and
it now says the maximum, because a clearance check has to hold for the tallest
part in the band.

- **What's wrong:** 2 of 22 hand-checked heights are wrong, both low by about
  0.2 mm. `NCP1200` reads 1.55 where its drawing states 1.75; `RHF1201` reads
  2.47 where its drawing states 2.72. In both cases the correct number is
  printed on the page we already cited.
- **Cause:** the model reports the body thickness rather than the seated height.
  `merge.ts` already documents this failure mode: *"the model answers the body
  thickness instead on roughly a fifth of the pages that state it."*
- **Fix:** state in the prompt that where a drawing gives both an overall height
  and a body thickness, the overall one is wanted; and where a min/max pair is
  given, the max is.
- **Why not a deterministic correction instead:** the drawing prints several
  height-like dimensions (A overall, A1 standoff, A2 body) and nothing mechanical
  says which row is which. The midpoint trick fires on 1 of the 2 and appears 3
  times in 49 parts with no oracle coverage — that is fitting code to one
  datasheet.
- **Reaches:** the 3D solid only. Not copper, not the netlist.

### 2.

### 3.

---

## Code changes — can ship any time

*No re-read needed. Ordinary work.*

### 1.

### 2.

---

## Things he hit that we already knew

*Say "known" on the call, move on, and tick it here. If one of these annoys him
more than we assumed, that itself is the finding — note it.*

- [ ] **Body height silently wrong** (2 of 22, 0.2 mm, 3D solid only) — fix is
      prompt change 1 above
- [ ] **Pin electrical type checked by nothing** — reaches the schematic rule
      check, not the board
- [ ] **8 of 731 hand-checked dimensions wrong** — six flagged, none reaches
      copper silently
- [ ] **Pin numbering can rotate by one on ADG1211 / ADG5412** with nothing
      objecting
- [ ] **A parse takes 65 to 90 seconds** — almost all of it the model

---

## Things we can't act on yet

*Where his answer opens a question we cannot settle between us.*

---

## After the call

1. Anything in **Prompt changes** — close the list, make every edit, then ONE
   paid re-read and re-measure `bench:holdout`. Budget the spend before starting;
   `FORGE_SPEND_LIMIT_USD` caps it.
2. Anything in **Code changes** — ordinary work, verified the usual way.
3. Re-read this file before deciding what to build. The first thing he says is
   rarely the most important thing he says.
