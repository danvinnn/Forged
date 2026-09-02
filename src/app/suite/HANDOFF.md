# Handoff — `ui/forge-suite`

For Claude Code, or whoever picks this up. Written to be read top to bottom once.

## TL;DR

A new route, `/suite`, containing a redesigned front end for Forge as a multi-tool suite. It is
**purely additive**: three components and a stylesheet under `src/app/suite/`, no existing file
touched. `/` still serves `src/app/page.tsx` exactly as `main` does — **if you run `npm run dev`
and see the old UI, you are on `/`. Open `/suite`.**

The new shell owns navigation and state only. Every piece of extraction, review, confirmation and
export logic still lives in `src/app/page.tsx` and is meant to be moved across, not rewritten.

## Files added

```
src/app/suite/page.tsx             route; force-dynamic (CSP nonce, same reason as layout.tsx)
src/app/suite/SuiteWorkspace.tsx   the phase machine and shell
src/app/suite/Onboarding.tsx       first run, two steps: the line, then the account
src/app/suite/SettingsPanel.tsx    the gear, top right; Account and Assembly line tabs
src/app/suite/AssemblyForm.tsx     the four settings rows, shared by both of the above
src/app/suite/AccountForm.tsx      the three account fields, shared by both of the above
src/app/suite/account.ts           localStorage for the account and both settings stores
src/app/suite/suite.css            scoped to .suite / .onboard; tokens from globals.css
src/lib/intent.ts                  the Intent type, out of the component so lib can import it
src/lib/readprogress.ts            what the read bar is allowed to say
src/lib/__tests__/readprogress.test.ts
```

Nothing else changed. No dependency was added. No API route was modified.

`readprogress.ts` sits in `src/lib` rather than beside the shell because `npm test`
only globs `src/lib/**/__tests__`, and an unchecked progress bar is how the first
one came to be frozen. It is pure logic and imports nothing from React.

## The flow this implements

```
first run, until an account exists (settings, then the account; skippable in one click)
  → home: choose intent, then drop a PDF or name a part
  → identify: deterministic, ~1s, NO model call
     └ if the intent needs a footprint: choose the package, before the read
  → the read: ~90s, one model call, aimed by the intent
  → output
```

All four states render **inside one frame**. The composer is a persistent element: on submit it
settles to the top of the window and the body grows beneath it, each phase replacing the last.
One control — "Start another part" — resets. This replaced two alternatives that were built and
rejected: a chat-style append (the live content sinks below the fold and the composer asks for a
part the user does not have) and a back/forward pager (intent and package steer the read, so
after it they are not editable; "back" could only mean discard).

## Why intent is chosen BEFORE the read

This is the load-bearing decision and everything else follows from it.

1. **The reader is field-directed.** It is handed the fields and the pages to go after. A
   footprint wants the pin table and the package outline drawing; a SPICE model wants the
   specification table. Aiming after the fact means over-reading both or re-reading, and
   `src/app/page.tsx` already documents a re-read as the most expensive action on the screen.
2. **A package belongs to a footprint and to nothing else.** A macromodel describes the die, so
   an LTspice-only user should never see the package chooser. Choose-first is the only ordering
   that can skip it.
3. **A package chosen after the read arrives too late to be used** — every pin reader takes the
   package as an argument. The existing code says so; the new flow finally honours it.

Identification stays free so the choice is early without being blind: part number, manufacturer,
page count and the ordering table's designators come from a text pass with no model call.

## Seams to wire — marked `TODO(merge)` in the source

1. **`/api/identify` (new).** The model-free text pass `/api/parse` already runs first, exposed
   on its own. Returns `{partNumber, manufacturer, pageCount, packages[], specPages,
   outlinePage, sha256, fileName}`. It must stay model-free — the moment it costs a call it
   belongs behind the Read button with everything else that costs money.
2. **`intent` on `/api/parse` and `/api/lookup`.** `"cad" | "spice" | "both"`. Selects the field
   set and which pages get rendered for the second pass.
3. **`packageType` sent before the read.** `/api/lookup` already accepts it. The change is
   ordering only.
4. **`/api/model` (new).** The SPICE emitter: deterministic templating over extracted
   parameters, exactly like the footprint emitters. No model writes the netlist. A parameter the
   datasheet does not state is asked for by name, or the model is refused — the same contract as
   `422 INCOMPLETE_EXTRACTION`.
5. **Panels to move from `src/app/page.tsx`, unchanged:** the verdict card, "worth a glance",
   **"Show the full record"**, the review list with page images and corrections, the
   export-refusal panel (`missing` vs `untraceable`), install-scoped answers, and the reader's
   notes. They drop into the `done` body. Do not rewrite them; their comments record defects that
   took weeks to find.

   **The full record was missing from this list until 2026-09-02, and it is the one entry that
   would not have been noticed missing.** Every other panel is absent from `/suite` in a way you
   can see. The record is a disclosure that is closed by default, so a `done` body without it
   looks finished. `/suite` currently renders five things after a read: the footprint preview, the
   SPICE placeholder, the format picker, the refusal panel and the export button. That is the
   whole of it.

   What has to move is `page.tsx` §6, "THE RECORD" (around line 2231): the `disclose` button,
   the 26 dimension rows across `Package` and `Printed footprint`, and the pin table with its
   editable number and name cells.

   **The data is already there.** `SuiteWorkspace` holds `part` as a `PartRecord` from the moment
   the read returns, which is the same object `page.tsx` holds, citations included. Nothing new
   has to be fetched or plumbed; this is a rendering job.

   **The catch, and why this branch did not do it.** `Row`, `Provenance` and `showValue`
   (`page.tsx:175-227`) are module-local and not exported. Porting the record means extracting
   them, which edits `page.tsx` — a file `main` also has. Every change on `ui/forge-suite` lives
   in untracked `src/app/suite/`, so the merge surface with `main` is currently exactly zero, and
   this was left alone to keep it that way. Extract those three into `src/lib` when `page.tsx` is
   open for the functionality merge anyway. **Do not copy them into `src/app/suite/` instead:**
   two `Provenance` implementations means two screens that can disagree about where a value came
   from, and that disagreement is the one thing this product cannot ship.

## The copy pass, 2026-09-02

Anthony read the shell and said there was too much text on it for no reason. There
was. Nothing about the flow changed and no behaviour was added or removed; what
changed is how much of the reasoning is printed rather than kept in the source.

The rule applied: **the screen states the decision, the source states the reason.**
Every sentence cut is still written down, in the file that owns the behaviour.

- **The identify table is gone.** Five rows: three were already in the composer
  line two inches above it, one was a count of the list directly below it, and
  one was eight characters of a sha256 nothing on the screen used. The composer
  line carries part, manufacturer and page count now.
- **The read screen.** Four stage rows each carried a sentence explaining
  themselves, under a four-line paragraph. The sentences moved to `title` on the
  row and **the paragraph is gone** — Anthony's call, 2026-09-02, on the last
  line of it. What is left is the bar, four named stages and the clock.
- **The elapsed clock is in one place**, the composer. It was also inside the
  `aria-live` region, so a screen reader announced the seconds every 250ms and
  the one worthwhile announcement, the run going long, landed in the middle of
  that.

**One thing to know, since the estimate no longer says it is one.** The
timestamps in the stage list are the SCHEDULE's boundaries from
`src/lib/readprogress.ts`, not observed times: the routes do not report when a
stage begins, so `0:10` means "this is where stage two starts on a typical run"
rather than "stage two started at ten seconds". Nothing else on the screen reads
as a measurement, and the bar still cannot fill until the response lands. When
`/api/parse` streams real stage boundaries, the column becomes true as written
and this note goes away.
- **The named standard prints only while its row is blank.** That is the whole
  window in which "blank means IPC-7351B, nominal density level B" decides
  anything; it used to print under a row that had been set to C.
- **The `Forge` eyebrow over the hero heading is gone**, and the heat rule moved
  to the wordmark in the bar. One wordmark, one heat rule.
- **`.pkg-active` was still blue** inside a shell whose accent is the ember, so
  the selected package card and the chip beside it disagreed about which colour
  means "picked". Overridden under `.suite`, in `suite.css`.
- **The refusal panel's second paragraph is gone.** One of its three variants
  told the user what to do next; the other two argued that the refusal was
  correct, to somebody who is blocked on an export.

`RULES.md` is untouched by this and so is every claim the product makes. What a
value is, whether it was confirmed, and what could not be confirmed are all still
on screen and still named.

## Design decisions baked in

- **Ember (`oklch(.62 .17 47)`) replaces the blue accent, inside `.suite` only.** Blue survives
  as the cold/locked note: hot means unfinished, cold means signed off. `globals.css` is
  untouched, so `/` keeps its blue.
- **The heat bar is driven, and it is an estimate that says so.** *Changed 2026-09-01.* It used
  to report position only, and it did not even do that: the fill was pinned at a constant width
  and the active stage was hardcoded to index 2, so it said the same thing at one second and at
  two minutes. It now advances from the clock against a per-stage schedule in
  `src/lib/readprogress.ts`. Three properties are load-bearing and are under test: it only ever
  increases, it never reaches full while the request is open, and **the last stage is closed by
  the response landing, never by a timer**. No numeric percentage is printed, because the split
  between the stages is a display estimate rather than a reading of the run. *Changed 2026-09-02:*
  the copy that said so on screen is gone; the properties above are unchanged and still under
  test, and the caveat that outlived the sentence is in the copy-pass section above.
- **The first run opens itself, and still cannot gate a read.** *Changed 2026-09-01.* RULES.md 3
  wants the settings settled before the first datasheet, so the window opens on its own until an
  account exists. What it must not do is force an answer: the 2026-08-28 finding is that
  requiring the two forming-die numbers made an engineer invent two of them. So the two rows no
  standard answers stay blank and optional, every button on the window leaves it, and a part
  that genuinely needs the die is still refused by name later with the drawing beside the
  question.
- **An account is a local record that the first run happened.** No server, no request, no
  credential. The standing constraint is that controlled datasheets never leave the customer
  environment and that it is enforced structurally; an account that phoned home would be the
  first crack in that. Signing out forgets the account and **keeps the settings**, which belong
  to the installation rather than to whoever typed them.
- **Intent and package lock once the read runs**, because they are what aimed it. Changing them
  afterwards would describe a read that did not happen.
- **The take button is disabled when `packageChoice.ok === false`**, with the missing fields
  named — the same rule `page.tsx` applies to *Build library*.

## Preset values — proposals, not decisions

| Preset | densityLevel | footprintSource | forming die |
| --- | --- | --- | --- |
| Hobbyist / bench | `A` | `datasheet-first` | untouched |
| Production | `B` | `datasheet-first` | untouched |
| Rad-hard / flight | `C` | `standard-always` | untouched |

Blank is a real answer: no published standard specifies one shop's forming die, so there is no
default and the value is asked per part when needed.

**No preset writes the forming die**, and the flight preset used to. *Changed 2026-09-01.* It
carried `9.4` and `0.51`, which are one shop's numbers dressed as a recommendation: a preset that
fills them in is the product inventing manufacturing data on the user's behalf, which is the whole
of RULES.md 1. Both rows are typed into directly, by whoever knows their own die.

## Still open

- **`Both` as a first-class intent** vs a checkbox on the other two. Currently a third chip.
- **Failure states are not designed** in the new shell: scanned/no-text PDF, part not found,
  `422` on export, and "no package can be built".
- **No SPICE review screen yet** — the parameter/citation correction loop that is the product's
  whole argument exists for CAD only.
- **The `.asc` symbol is not drawn** anywhere; only the `.lib` netlist is shown.
- **Dark theme** exists in the mockups but `suite.css` inherits `globals.css`'s dark tokens
  without a dedicated pass.

## Flipping `/` over

When the flow is signed off, in one commit: make `src/app/page.tsx` a redirect to `/suite`, or
move `src/app/suite/*` up to `src/app/`. Keep the old file in history rather than deleting its
comments wholesale — several of them are the only record of why a rule exists.

## Verify

```powershell
./node_modules/.bin/tsc --noEmit
npm run lint
npm run dev          # then open /suite, not /
```

**`npm test` reports a green ZERO on Windows.** The script is
`tsx --test 'src/lib/**/__tests__/*.test.ts'` and the single quotes survive into `cmd`, which
does not strip them, so tsx matches nothing and prints `tests 0 / pass 0 / fail 0`. That reads
exactly like a pass. Expand the paths instead:

```bash
npx tsx --test $(ls src/lib/__tests__/*.test.ts src/lib/*/__tests__/*.test.ts | tr '\n' ' ')
```

Measured 2026-09-01 that way: 922 tests, 888 pass, 34 fail, and **all 34 are the environment**,
not the product. Two want `.bench-cache/NCP1200.pdf`, which is not in the tree; the other 32 are
the Altium oracles, which fail rather than skip on purpose and need `npm run oracle:build` plus
the .NET SDK at `~/.dotnet`, which is not on `PATH`.

`npm run build` fails to bundle on Next 16 (Turbopack against a webpack config). Pre-existing and
already recorded in `LEARNINGS.md` section 1.

**Nothing in this repo drives `/suite` like a person.** `bench:browser` is hardwired to `/` and
keyed to `page.tsx` selectors, so it says nothing about this route. The first run and the read bar
were checked on 2026-09-01 by a throwaway Playwright script against a real Chrome
(`chromium.launch({ channel: "chrome" })`, because the Playwright browsers are not downloaded on
this machine): the window opens for a fresh visitor, closes on account creation, does not reopen
after a reload, the gear opens both tabs, sign-out keeps the settings, and the bar advances
between two samples starting from stage one. **That script was not kept.** Extending
`bench:browser` to cover this route is the thing to do before `/` flips over.
