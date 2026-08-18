# AUDIT HANDOFF, 2026-08-18 (read this first, then AUDIT-FINDINGS.md)

## What Anthony asked for, in this session, verbatim in substance

Manually read EVERY SINGLE LINE of the codebase (no scripts to find defects;
`cat`/`sed` to READ is fine). Find every instance of the recurring stupid
problems: assuming everything is square and storing one value where the document
gives two, collecting information and throwing it away, guards that cannot fire,
questions the product cannot express, allowlists broken by the next case,
comments asserting behaviour the code lacks. Record every defect in a file so
none are lost. Then FIX them all, the way he would want them fixed, following
RULES.md at all times.

**Do not stop until every line is read, every problem recorded, and every problem
fixed.** He has been interrupted-and-abandoned before and hated it. After the
fixes, one hold-out run is allowed, MAXIMUM FOUR this session, so make each count.

**DO NOT COMMIT ANYTHING during this whole effort.** Local edits only.

## His principles for every fix

1. General, never per-case. If it cannot be stated without naming a part or a
   vendor it is tailoring. The proof of generality is a fix that also corrects
   something it was not aimed at.
2. Do not invent. Name the source: a page, a standard, or the user.
3. Read correctly, then use correctly. Not workarounds. If information is
   missing, first ask whether we asked for it properly.
4. Measure, do not reason. Record rejected approaches so nobody retries them.
5. Refusing is a safety net, not an achievement. A refusal that loses a correct
   part is a defect, not a fix.
6. Plus every rule in RULES.md, and the working style in LEARNINGS.md section 7
   (no em dashes, short answers, work directly in the repo).

## How he wants each defect SHAPE solved (stated by him 2026-08-18)

1. We had it and threw it away -> CONSUME it, do not re-read it. Never add a call
   to recover something already on the record. Where two readings conflict, name
   the CONFLICT rather than ranking readers.
2. Fixed in one place, not the other -> ONE function, both callers. Delete the
   second copy, do not patch it. Check the BENCHES too.
3. Allowlist broken by the next case -> INVERT so the unknown case lands on the
   safe side, and say in the comment which side that is and why.
4. The unanswerable question -> check the QUESTION before blaming the reader.
   Every enum the record accepts must be offered everywhere it is asked.
5. Null treated as a default -> refuse or ask, never default. If the user can
   answer it, make it both ASKABLE and SUPPLIABLE, and keep the lists in step.
6. A guard that cannot fire -> test the VALUE not the sentinel, and add a test
   proving the guard fires.
7. A comment asserting behaviour the code lacks -> make the code true or delete
   the claim. Never leave an aspirational comment.

## Non-negotiables

- Nothing in `holdout.ts` is ever tuned against, opened to diagnose a failure, or
  run as a subset. A hold-out part that must be examined is PROMOTED into
  `BENCH_CORPUS` and replaced with a blind pick.
- Do not commit. Not this session.
- Typecheck every change (`./node_modules/.bin/tsc --noEmit`), affected tests
  while iterating, full suite before declaring done.
- `nvm use 22`. `./node_modules/.bin/tsc`, not `npx tsc`.
- Model key: `set -a && . ./.env.local && set +a && npm run bench:holdout`
- Spend was $14.08 cumulative at the start of this session. Ceiling defaults to
  $10, so a paid run needs `FORGE_SPEND_LIMIT_USD=` set higher, deliberately.

## READING PROGRESS

Findings live in `AUDIT-FINDINGS.md` (F1..F58 so far). Read that file.

DONE (read line by line this session):
  types.ts 898, confidence.ts 545, geometry.ts 192, vendorland.ts 226,
  packagedrawing.ts 242, extraction/merge.ts 852, extraction/contracts.ts 355,
  extraction/models/prompt.ts 533, extraction/run.ts 223,
  extraction/request.ts 224, extraction/untrusted.ts 136, budget.ts 89,
  sections.ts 50, factory.ts 76, index.ts 21,
  models/{transport 157, gemini 117, vertex 188, local 277, local-focused 264},
  provenance.ts 40, readout.ts 187, datasheet.ts 230, review.ts 299,
  packagevariants.ts 565, pdftext.ts 416, fontdecode.ts 202, pagerender.ts 184,
  preflight.ts 127, emitters/kicad.ts 491, emitters/altium/* (all 8 files),
  app/api/{config,parse,export,lookup}/route.ts 815, app/page.tsx 1216,
  app/layout.tsx 17, instrumentation.ts 13,
  retrieval/** except __bench__ (2,591), retrieval/__bench__/{corpus,coverage}.

DONE in the PREVIOUS session (findings F1-F17 carried over, trust them but
re-read while fixing): exporters.ts 2436, ipc7351.ts 496.

REMAINING TO READ:
  src/lib/__bench__/modelcache.ts       978
  src/lib/__bench__/extraction.ts       829
  src/lib/__bench__/pinout-oracle.ts    691
  src/lib/__bench__/holdout.ts          541
  src/lib/__bench__/dimension-oracle.ts 292
  src/lib/__bench__/mutation.ts         323
  src/lib/__bench__/guards.ts           276
  src/lib/__bench__/replay.ts           255
  src/lib/__bench__/dimensions.ts       177
  src/lib/__bench__/packagehint.ts       91
  src/lib/__bench__/env.ts               38
  src/types/pdf-parse.d.ts               56
  (then re-read exporters.ts + ipc7351.ts while fixing F1-F17)

## FIXING PROGRESS

READING COMPLETE. FIXING COMPLETE. See `AUDIT-FINDINGS.md` for F1..F69, the
fixes and the measurements.

[x] A. Rectangular quads end to end (F1 F2 F11 F12 F17 F19 F22 F23 F25 F51 F55
       F65 F67 F68) plus F9, the band check that could never run on a
       straight-lead package.
[x] B. F54 asPackage now runs on the export path; F16 examined and shown not to
       be live once F54 is fixed.
[x] C. F7 drawnPackages refuses only what it can prove; F18 drawnPackages on the
       zod schema.
[x] D. F33/F34 combine carries declined and attempts.
[x] E. F29 fence order; F30 designators escaped not stripped.
[x] F. F8/F50/F52/F57 the unanswerable questions.
[x] G. F49 lookup budget; F48 no double render.
[x] H. F35 pass 2 is told the package.
[x] I. F3 F4 F5 F6 F10 F14 F15 F20 F21 F26 F27 F28 F31 F32 F36 F37 F38 F39 F41
       F42 F43 F44 F45 F47 F53 F56 F58 F59 F60 F61 F63 F64 F66 F69.

Verification run: `./node_modules/.bin/tsc --noEmit` clean; `npm test` green
twice at 648, and again after the later exporters work; all 20 mutations still
match their target line exactly once; `bench:replay` (free) measured the
cross-span ask as costing zero shipping parts.

DONE: two hold-out runs of the four allowed. READ 50/54 (93%), SHIPS 14/54
(26%), both a floor because one call failed on an unrecoverable Vertex 429.
Cumulative spend across every run ever is now ~$16.39. See the HOLD-OUT RESULT
section of AUDIT-FINDINGS.md, including what the numbers do NOT establish.
