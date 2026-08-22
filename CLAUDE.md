# Forge

Read these two before doing anything, every session:

- **[RULES.md](RULES.md)** governs what the product may emit. A change that breaks
  one of the six rules is wrong even if it makes a number go up.
- **[LEARNINGS.md](LEARNINGS.md)** governs how to work here: the verification that
  actually catches things, the failure shapes that recur, the traps in this
  environment, and what has already been measured and settled.

Deeper references, read when the work touches them: `ARCHITECTURE.md`,
`src/lib/retrieval/LAYER1.md`, `src/lib/emitters/ALTIUM.md`.

## Precedence when docs disagree

`RULES.md` and `LEARNINGS.md`, then the decided records, then current-state notes,
then prose. **The code wins over every doc for "what actually is."**

`README.md` is stale in two specific ways, both checked 2026-08-17. **Anthony's
decision, 2026-08-17, in his words: "we dont need to fix the readme til after the
product is done."** Do not fix it, and do not raise it again until then. The two
items are recorded here only so nobody mistakes the README for current.

- It says **"the text parser always runs first and always wins"** and that the
  model is asked only about what the parser could not resolve. The parser was
  switched off on 2026-08-12 because measurement showed it was SUBTRACTING, and
  the pipeline is model-first. The "tuned toward TI phrasing" limitation is stale
  for the same reason.
- It says **native Altium emitters "are not built yet"** and that Altium is a
  documented intermediate bundle. Native `.PcbLib` and `.SchLib` are built and
  oracle-checked (`src/lib/emitters/altium/`).

## The two things that are non-negotiable

- **Nothing in the hold-out corpus is ever tuned against, opened to diagnose a
  failure, or run as a subset.** A hold-out part that must be examined gets
  promoted into the tuned corpus and replaced. The list lives in
  `src/lib/__bench__/holdout-corpus.ts`; `holdout.ts` is the runner and starts a
  measurement the moment it is imported.
- **Do not commit without explicit permission, each time.** Straight to main when
  asked, no feature branches, no push unless asked.
