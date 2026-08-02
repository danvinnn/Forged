# The second Altium oracle

An independent reader for the `.PcbLib` and `.SchLib` files the Altium generator writes. It prints
what it recovered as JSON, and exits non-zero if it cannot read the file at all.

## Why a second one

pyaltiumlib is the first oracle and it lives in `src/lib/emitters/__tests__/altium-oracle.py`. It is
a good reader and it is not a complete one:

- its schematic reader stops at record 44, so it cannot see a footprint link at all;
- it does not raise on a malformed record, it logs and carries on.

Both of those were load-bearing. The footprint link is invisible to it, which means a test asserting
"the reader was happy" would have gone quiet exactly where new code lives. And this reader caught a
real defect pyaltiumlib passed clean: the footprint data stream was being written with a trailing
`0x00` terminator byte, which a strict reader takes for an unknown primitive id and then fails on.
Altium writes no such byte. That file parsed perfectly in pyaltiumlib and would very likely have
been refused by Altium, silently, which is the exact failure this whole arrangement exists to catch.

AltiumSharp reads what pyaltiumlib does not, and it round-trips a large corpus of real Altium files,
so it is the closest independent check to Altium itself. It is not a substitute for a human opening
the library in Altium. Nothing is.

## Building it

    npm run oracle:build

That clones AltiumSharp at a pinned commit into `vendor/` and builds against it. Both `vendor/` and
`bin/` are gitignored. It needs the .NET SDK; the script says how to get one if it is missing.

## Running it

    tools/altium-oracle/bin/Release/net10.0/altium-oracle <path to .PcbLib or .SchLib>

The test suite invokes it the same way. If it has not been built, the Altium cross-check test fails
with these instructions rather than skipping, because a check that quietly stops running is worse
than one that fails.

There are two more modes.

    altium-oracle --roundtrip <path>

reads the library, writes it back out through AltiumSharp's **writer**, reads the result, and reports
whether the two reads agree. Reading proves a reader could make sense of the bytes; this proves the
meaning survives a full trip through an independent implementation, which is harder to pass by
accident. A field written somewhere the reader tolerates but does not understand comes back missing on
the second read. Both libraries are checked this way in `altium-crosscheck.test.ts`. Byte identity is
reported and never asserted: AltiumSharp orders streams its own way.

    altium-oracle --write-probe <directory>

has AltiumSharp build a `.PcbLib` from scratch with a component body on each mechanical layer we care
about, then reads it back. It exists to make a second implementation commit to a byte for a layer
name, which is how the Mechanical 15 question in `ALTIUM.md` section 13 got its second source. It is
a research tool rather than a test: nothing in the suite runs it.
