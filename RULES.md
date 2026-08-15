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
