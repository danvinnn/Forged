# Live session: what to put in front of him

Eight files, already in the repo. Roughly forty minutes. Order matters: the first
one should work, so what comes after reads as a limit rather than a fault.

Have it running before he joins (`npm run build && npm start`). A parse takes
65 to 90 seconds. Say so before the first one, or the silence reads as a hang.

---

### 1. `DRV8825` — it works
`.bench-cache/DRV8825.pdf` · 28-pin HTSSOP, exposed pad

Ships both formats. Card says **Ready to build**, two values worth a glance.

**Watch:** does he open the two flagged values, or trust the card? That answers
whether "worth a glance" is the right framing, which is question 3 below.
**Then:** get the KiCad zip open in KiCad, and the Altium one open in Altium.
**This is the single most valuable minute of the call.** Two independent readers
agree on every pad and pin of 86 parts and neither is the program he uses.

### 2. `AD8628` — it asks which package
`.bench-cache/AD8628.pdf` · a family datasheet, six packages read

**Watch:** does he know which one he wants from the card alone? The cards carry
the designator, family and lead count, and nothing else.

### 3. `RHF1201` — it asks him a question
`.bench-cache/RHF1201.pdf` · ceramic SO48, straight leads

Refuses, and asks for a formed lead span. **This is your market.** No manufacturer
prints this number: the leads are straight until his line forms them.

**Watch:** can he answer it at his desk, or does he need to ask someone?
**Ask here, while it's on screen:** does your line form to a constant toe-to-toe
span, or a constant extension past the body? If it's an extension, a question we
ask per package becomes one number for everything.

### 4. `RTAX2000S` — it says no, and means it
`.bench-cache/RTAX2000S.pdf` · three CQFP packages, none buildable

Card reads **No package in this datasheet can be built yet**, and the Build
button is withheld. Until this week the card said "which package?" over three
that could not be built, with the button live.

**Watch:** is the refusal enough for him to know what to do next?

### 5. `scanned-no-text-layer` — a photocopy
`test-data/scanned-no-text-layer.pdf` · three pages, zero text characters

Reads 8 pins off the image. Worth showing because he will assume it cannot.

### 6. If there's time
- `DF13-4P-1.25DSA` — read, and honest that it has no pinout
- `L7805` — TO-220, the through-hole path, ships after answering
- `LMP7704-SP` — rad-hard ceramic flat pack

---

## The four questions

1. **Does the Altium library land correctly?** (during part 1)
2. **Constant span or constant extension?** (during part 3)
3. **Is 1.73 values to check per part right?** The hard limit is 5 and is never
   exceeded. Is that a tool that saves time, or one that nags?
4. **Should thermal vias carry the pad's net?** Currently geometry only.

## Known weak, so you can tell a known miss from a new one

- **Body height can be silently wrong** (2 of 66 measured, 3D solid only). If he
  checks enclosure clearance, this is the one to own up to first.
- **Pin electrical type is checked by nothing.** Reaches the schematic rule
  check, not the board.
- 8 of 731 hand-checked dimensions are wrong. Six are flagged; none reaches
  copper silently.
- Two packages (ADG1211, ADG5412) can have their pin numbering rotated by one
  with nothing objecting.

Everything else he hits is new, and worth writing down verbatim.

## Do not defend it

The purpose is the list of things he hits that we did not predict. Anything on
the weak list above, say "known" and move on. Anything else, write down his exact
words rather than the diagnosis, and let him keep going.
