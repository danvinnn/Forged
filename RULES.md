# How decisions get made in this product

These govern every change. They are not aspirations; a change that breaks one of
them is wrong even if it makes a number go up.

## 1. Do not invent

Every value that describes a part comes from that part's datasheet. No hand-typed
family constants, no numbers recovered by reverse-engineering one vendor's
drawings, no thresholds chosen because they felt about right.

The test: **name the source.** A published standard, the document in front of us,
or a preference the user stated. If none of those, it is invented and it does not
ship.

## 2. Do not assume

This is the one that is easy to miss, because assumptions do not look like
inventions. They look like obvious arithmetic.

A drawing gives a body length of 4.90 to 5.10 mm and the silkscreen needs one
number. Taking the midpoint is not invention: the maths is sound and the inputs
are the document's. But **deciding that an engineer wants the midpoint is an
assumption.** Some draw the maximum so the outline covers the largest part that
could arrive. Nobody asked them.

So a derivation is not automatically safe for being mathematically natural. Every
derivation needs a reason from practice, not from arithmetic.

The test: **would a working engineer do this, and how do we know?**

## 3. Read, ask, or offer a setting. Nothing else.

- **The document answers it plainly.** Use it. No further thought required.
- **The document does not answer it, and there is one right answer.** Find that
  answer from practice and use it, with the source recorded.
- **The document does not answer it, and it legitimately differs between users.**
  Make it a setting, defaulting to the common practice.
- **The document does not answer it, and it is specific to this part.** Ask.

A setting is not a way to avoid deciding. It is for values that genuinely differ
between one user's process and another's: assembly density, stencil capability,
library naming. Turning a question with a right answer into a setting pushes work
onto the user and is its own failure.

### Settings are established before the first datasheet, not during it

A new account is taken through its settings before it can parse or generate
anything. The first run is gated on that screen, so the product never reaches a
datasheet with its conventions undecided.

Two kinds of setting sit on that screen, and they behave differently:

- **A published standard covers it.** The field may be left blank, and blank
  means the standard. The screen says which standard, by name, so a user leaving
  it blank knows exactly what they are accepting. IPC-7351B density level is
  this shape: an engineer with no house rule is correctly served by the
  published one.
- **No published standard covers it.** The field is required and the first run
  does not start until it is answered. There is nothing to fall back on, so a
  default here would be an invention under rule 1, and silently choosing one
  would be an assumption under rule 2.

This does not license widening the settings screen. A question with one right
answer is still answered by looking it up, not by adding a field. What the gate
changes is only the timing: the settings that genuinely differ between users are
settled once, up front, rather than interrupting a run.

## 4. General, never per-case. Never tailored.

A fix covers the category or it is a hack. Before fixing the instance in front of
you, enumerate the category and confirm what is in it.

Active-low pin names are the worked example. Adding a flag because somebody
noticed overbars is patching an instance. Asking "which conventions appear in
datasheet pin names, and which of them change the meaning" is covering the
category, and it may turn out to have one member or four. The answer decides the
shape of the fix.

**Do not tailor to specific datasheets, and do not tailor to specific problems.**
The two are the same mistake at different scales. Widening a bound until one
document passes is tailoring to a datasheet. Adding a branch because one part
failed is tailoring to a problem. Both produce code that works on what you have
seen and fails on what you have not.

The test: **can the rule be stated without naming a vendor, a part number, a
package family, or the symptom that prompted it?** If not, it is fitted to what
was in front of you rather than derived from how datasheets work.

A part that had to be examined to write a rule is no longer evidence that the
rule generalises. That is what the hold-out corpus exists to protect, and why
nothing in it is ever opened to diagnose a failure.

## 5. Do not overengineer

Simpler is usually more. A smaller product that does the job beats a larger one
that does the job with machinery around it.

Signs it has gone wrong:

- a second model call to work around a refusal, when the refusal was the thing to
  remove
- a threshold, a mode and a fallback where reading the document would have done
- a setting offered because the right answer was not looked up
- abstraction added for a case nobody has met

The pipeline making three model calls per part was this. The third existed to get
around the model declining to answer, and once the reason for the refusal was
removed the call was simply deleted. That is the usual shape: the extra machinery
is a workaround for something that should have been fixed at the source.

Before adding anything, ask what would have to be true for it not to be needed,
and whether that is the cheaper fix.

## 6. The engineer's expectation wins

Where 1 through 5 conflict with what a working engineer actually wants, the
engineer wins, and the reason is recorded.

This mostly arises where a library entry needs something no datasheet contains: a
courtyard, a footprint name, a silkscreen clipped off the pads. There, "what an
engineer expects" is the only available answer.

It does not license guessing. It means: go and find out what they expect, from
published practice or from a real library, and record where the answer came from.

## 7. Nothing ships silently unless two independent sources agree on it

The invariant, and the one the product is judged on. `src/lib/confirm.ts` is
where it lives.

A value that reaches the output is either **confirmed** - two independent
readings of the datasheet agree on it, and it ships without being mentioned - or
**flagged**, and the user is shown it. There is no third state, and "we could not
confirm this" is not a caveat on the rule; it is an outcome the rule already
handles.

### Independent means read by different MEANS, not the same means twice

This is the load-bearing half. A model that misreads a rotated figure misreads it
the same way twice, so a second model call is not a second source. Every pairing
in `confirm.ts` is a reading against a DIFFERENT KIND of reading:

| value | one source | the other |
|---|---|---|
| the pinout | a model reading the document | text-layer geometry, `pinevidence.ts` |
| the copper | the vendor's printed footprint | IPC-7351B arithmetic on the outline |
| the pin count | the pin table | the drawing's lead count, or the package name |
| the pitch | the package outline drawing | the printed footprint drawing |
| the body | the body dimensions | the lead span that has to reach past them |
| the thermal pad | the outline's D2 and E2 | the printed footprint's own pad |

A pairing that cannot name two different means is not a confirmation. Say so
rather than inventing one.

### The unit is a GLANCE, and there is a hard budget

A flagged item is something a person settles by looking at one page once, so the
pinout is ONE item whether the part has 8 pins or 144.

**No part may ship with more than five.** Anthony's number, 2026-08-27: past five
the product has stopped saving anyone time. A package that would need more is
refused with the list of what could not be confirmed, never shipped with a dozen
boxes to fill in. `MAX_FLAGGED` in `confirm.ts` is the number and `optionFor` is
where the refusal happens.

### A bound that cannot fail is not a confirmation

A check that passes on every real record confirms nothing, and one that fires on
correct readings spends the user's attention and teaches them to click past it.
Both are worse than saying "nothing checked this".

The worked example is the lead pitch. "The lead row has to fit the body" sounds
like a confirmation; measured over 94 correctly read parts the row spans between
0.44 and 1.03 of its body, so a bound wide enough to admit them all admits almost
every wrong pitch too. The bound was dropped rather than tuned, and the pitch is
confirmed against the printed footprint or not at all.

## The decision register

Every value the product emits is one of three things, and which one is recorded:

| kind | rule |
|---|---|
| **read** | taken from the document as stated |
| **derived** | computed from the document by a rule, and the rule has a source |
| **convention** | no datasheet counterpart; from a standard or a setting |

Anything that cannot be placed in one of those three, with its source named, is
an assumption and is treated as a defect.

## Standing constraints

- Nothing in `holdout.ts` is ever tuned against, opened to diagnose a failure, or
  run as a subset. A hold-out part that must be examined gets promoted into the
  tuned corpus and replaced.
- Generation stays deterministic. The model reads; it does not compute geometry.
- Controlled datasheets never leave the customer environment. Enforced
  structurally, not by a runtime check.
