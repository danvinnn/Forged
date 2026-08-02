# Altium generator: the decided record

Everything a fresh session needs to build native Altium `.PcbLib` and `.SchLib` output. Written
2026-07-26 after the format reconnaissance, before any writer code existed.

Read this with `DEFERRED.md` (the P1 item on native generators) and `src/lib/geometry.ts`.

> **Status, 2026-07-27.** Built, and since extended: the symbol names its footprint, the 3D body is
> embedded in the footprint library, and a second independent reader (AltiumSharp) checks both. That
> second reader found a real defect the first one passed; see section 11. The last two open format
> questions are closed in section 13, which also records a second defect: the courtyard was on a layer
> the library never enabled, so Altium would have opened it and drawn nothing there. **Still nobody
> has opened the output in Altium.**
>
> **Status, 2026-07-26.** Built. `src/lib/emitters/altium/` writes both libraries and `altium` is
> registered in `GENERATORS`. The plan in section 6 was followed as written; section 10 at the end
> records what came out of it, including the decisions that were made along the way and the one box
> in section 8 that is still unticked. **A human has not yet opened the output in Altium, so nothing
> here is proven.**

---

## 1. What we are building and why it is not an import

**Requirement, from Anthony, explicitly:** users must not have to run an import wizard or install an
extension. Drop the library in, it works.

This rules out the route that looked easy. Altium does ship a first-party KiCad Importer that accepts
`*.kicad_sym` and `*.kicad_mod`, which we already emit, so it would have worked. It is a documented
fallback, not the plan.

**Also ruled out, permanently:** producing Altium output by converting or relabelling another format.
That is what the code used to do. `buildExchangeArtifact` took the KiCad s-expression string and
wrote it to `<part>.altium.symbol.txt` under a header admitting it was not really an Altium file. It
has been deleted, and a test now fails if any generated file is a relabelled foreign format. Formats
are peers.

---

## 2. Where it plugs in

The seam already exists. There is one format-neutral description and one generator per format.

- `src/lib/geometry.ts`: `FootprintGeometry` and `SymbolGeometry`. Pads with positions and sizes,
  body rect, courtyard rect, pin-1 marker, provenance. Symbol pins with side, anchor, name, number,
  electrical type. Millimetres, origin at package centre, +x right, +y down.
- `src/lib/emitters/kicad.ts`: the existing generator. Read it as the worked example of consuming
  the geometry. Do not read it as a source of Altium content.
- `src/lib/exporters.ts`: the `GENERATORS` registry:

```ts
const GENERATORS: Partial<Record<ExportFormat, Generator>> = {
  kicad: (baseName, symbol, footprint) => [ ... ]
};
```

Adding Altium is one entry returning `{ name, content }` files. Nothing else in the pipeline should
need to change. **If you find yourself modifying the geometry to suit Altium, stop.** The seam is in
the wrong place and that is the bug, not the workaround.

`altium` used to return `501 GENERATOR_NOT_IMPLEMENTED` from `/api/export`. That refusal went away
when the registry entry landed; `cadence` still returns it, and should keep doing so until it has a
generator of its own.

---

## 3. Tooling, already installed

- **`cfb`** (npm, Apache-2.0, in `package.json`) reads and writes the OLE Compound File Binary
  container that `.PcbLib` and `.SchLib` are packaged in.
- **`pyaltiumlib`** (pip, 0.6.2), an independent Python reader. This is the CI oracle. Its source
  lives at `$(python3 -c "import pyaltiumlib,os;print(os.path.dirname(pyaltiumlib.__file__))")` and
  **is the specification** used below.

---

## 4. The format

Container: OLE Compound File Binary. Streams:

```
/FileHeader                 [uint32 len][uint8 len][UTF-8 string]
                            The string must contain "PCB" and "Binary Library File",
                            or pyaltiumlib warns it cannot identify the file.
/Library/Data               ParameterCollection block,
                            then [uint32 componentCount],
                            then componentCount string-blocks naming each footprint
/<Footprint>/Parameters     ParameterCollection block (carries "description")
/<Footprint>/Header         [uint32 recordCount]
/<Footprint>/Data           string-block (the footprint name), then records.
                            NO terminator byte: the stream ends when the last
                            record ends. See section 11; this line used to say
                            "terminated by RecordID 0" and that was wrong.
```

**Block encoding is uniform:** `[uint32 length][length bytes]`, little-endian. A string block is that
holding UTF-8. A ParameterCollection block is that holding Altium's `KEY=VALUE|KEY=VALUE` parameter
text.

**Record stream:** one `uint8` RecordID, then the record body.

| ID | Record |
|----|--------|
| 0 | end of stream |
| 1 | Arc |
| 2 | Pad |
| 3 | Via |
| 4 | Track |
| 5 | String |
| 6 | Fill |

### Pad record (ID 2), field order

From `pcblib/records/PCBPad.py`:

1. designator, string block
2. three skipped blocks: one raw, one string, one raw
3. `first_block` = `[uint32 len][payload]`
4. `second_block` = `[uint32 len][payload]`

`first_block` payload, in order:

```
13 bytes   common record header (layer, flags) - see read_common
coord pair location
coord pair size_top
coord pair size_middle
coord pair size_bottom
4 bytes    hole_size
int8       shape_top       (PCBPadShape)
int8       shape_middle
int8       shape_bottom
double     rotation
int8       is_plated
1 byte     unknown
int8       stack_mode
1 byte     unknown
int32 x3, int16, int32 x3   unknown
4 bytes    expansion_paste_mask
4 bytes    expansion_solder_mask
7 bytes    unknown
int8       expansion_manual_paste_mask
int8       expansion_manual_solder_mask
7 bytes    unknown
```

The "unknown" runs still have to be written at the right length or every field after them shifts.
Take their values from an AltiumSharp golden file rather than zero-filling blind.

### Coordinates: the trap

`datatypes/coordinate.py::parse_bin` returns `value / 10000.0`, and the result is **mils**. So the
on-disk int32 is mils multiplied by 10000.

```
internal = round(mm / 0.0254 * 10000)
```

Worked example: a 1.55 mm pad length is 61.024 mil, so `610236` internal units.

Get this wrong and the file parses cleanly and is wrong by a factor of 25.4. It is the single most
dangerous detail in this document. Write a unit test for the conversion before anything else.

---

## 5. The rule: oracle before writer

**Altium silently refuses to open a malformed file.** No error, no diagnostic. So a subtly wrong
writer is indistinguishable from a working one until someone opens Altium, and by then you have built
a lot on top of it.

This is the same discipline as the land patterns, which are pinned to values published in datasheets
so our arithmetic cannot quietly agree with itself. Here the independent check is pyaltiumlib.

**Step 1 is not the writer. Step 1 is the loop:**

1. Emit a minimal `.PcbLib`: one footprint, one pad.
2. Assert `pyaltiumlib.PcbLib` opens it, reports one component, and gives the pad back at the
   coordinates and size that were written.
3. Only once that round-trips, add records.

Wire it into the test suite from the first commit, not afterwards.

---

## 6. Plan

1. Coordinate conversion plus its unit test.
2. CFB container with `/FileHeader` only. Assert pyaltiumlib identifies it as a PCB binary library.
3. Add `/Library/Data` with one component name. Assert the component count and name read back.
4. Add `/<Footprint>/Parameters` and `/Header`. Assert the description reads back.
5. Add `/<Footprint>/Data` with one pad. Assert position and size round-trip. **This is the milestone
   that de-risks the rest.**
6. Fill out the remaining records the geometry needs: Track for the body outline and courtyard,
   String for the designator, Arc or Fill for the pin-1 marker.
7. Register `altium` in `GENERATORS`.
8. `.SchLib` for the symbol, same method, using `pyaltiumlib.SchLib` as its oracle.

---

## 7. Cross-references when the oracle disagrees

- **AltiumSharp** (C#, MIT): the most complete open reader/writer, with binary serialisation code
  and golden test data. The authority when pyaltiumlib is ambiguous.
- **python-altium** `format.md`: documents the compound structure, record types, property encoding.
- **pyaltiumlib** source: the oracle itself; when in doubt read what it expects.

---

## 8. Definition of done

Tests passing is necessary and not sufficient. This layer has already shipped three defects that no
test caught, all found by generating a file and looking at it.

- [x] `pyaltiumlib` parses the generated `.PcbLib` in CI and the geometry round-trips
- [x] Pad numbering is counterclockwise: pin 1 and pin N face each other. The existing
      `exporters-geometry.test.ts` asserts this for KiCad; assert it for Altium too
- [x] The land pattern matches the value the manifest claims, within 0.05 mm
- [ ] **A human opens the library in real Altium and confirms it loads and looks right.** Nothing is
      proven until this happens. Altium's silent failure means CI green and Altium refusing the file
      are entirely compatible states

---

## 9. Things not to do

- Do not derive Altium output from the KiCad output.
- Do not skip the oracle because the writer "looks right".
- Do not zero-fill the unknown byte runs without checking a golden file.
- Do not add a fallback that emits something when the writer fails. Export refuses; that is the
  product's position everywhere else and it should hold here.
- Do not change `FootprintGeometry` to make Altium easier without checking the change is
  format-neutral.

---

## 10. What was built, 2026-07-26

### Where it lives

```
src/lib/emitters/altium.ts            the public entry, a peer of kicad.ts
src/lib/emitters/altium/units.ts      mm to internal units, and the Y flip
src/lib/emitters/altium/binary.ts     blocks, string blocks, parameter blocks, Windows-1252
src/lib/emitters/altium/container.ts  the OLE compound file both libraries share
src/lib/emitters/altium/templates.ts  record bytes captured from files Altium wrote
src/lib/emitters/altium/pcblib.ts     the footprint library
src/lib/emitters/altium/schlib.ts     the symbol library
src/lib/emitters/__tests__/altium-oracle.py   pyaltiumlib, run as a subprocess
src/lib/emitters/__tests__/altium-{units,pcblib,schlib}.test.ts
```

### The oracle, and why it asserts on the log

`altium-oracle.py` prints the geometry pyaltiumlib recovered **and every warning or error it
logged**. The tests assert the log is empty, and that assertion is the one doing the work.
pyaltiumlib does not raise on a malformed record: it logs "common parameters array spacer is not as
expected", or "stream does not match the declared block length", and returns plausible numbers
anyway. A file can round-trip its coordinates perfectly and still be broken. Altium's own files pass
this check with an empty log, which is what makes it a fair bar.

The tests fail loudly if python3 or pyaltiumlib is missing rather than skipping. A suite that stops
checking the oracle when the oracle is absent produces exactly the false confidence the oracle
exists to prevent.

### The undocumented bytes

Section 4 warned not to zero-fill the unknown runs. They were not: `templates.ts` holds the exact
records Altium wrote, taken from AltiumSharp's `TestData/Generated/Individual/PCB`, and the emitter
overlays only the fields it understands. A byte-level diff of our pad against Altium's shows
differences at the location, the three sizes and the two identity GUIDs, and nowhere else.

Field offsets were cross-checked against two independent implementations that agree: pyaltiumlib's
reader and AltiumSharp's writer.

### Decisions made along the way

- **Rounded-rectangle pads.** The geometry says `roundrect`, and Altium encodes that with the base
  shape left as Round in the first block and the real shape and 50 percent corner radius in the
  per-layer stack. That is not guessable; it is what `PAD_SMD_ROUNDED.PcbLib` does. 50 percent is
  the same corner as the KiCad emitter's 0.25 ratio.
- **Layers.** Copper on Top Layer (1). Body outline, pin-1 dot and designator on Top Overlay (33).
  Courtyard on Mechanical 15 (71), which is where Altium's own IPC wizard puts one. Only the copper
  is a manufacturing instruction; the other two are conventions and are the first thing to look at
  if the library opens and looks wrong.
- **A `.Designator` special string** rather than a literal reference, so the placed component's
  designator is what appears.
- **Deterministic identity GUIDs**, derived from the part and pad rather than randomly generated, so
  two exports of the same part are byte-identical and can be diffed.
- **Symbol Y is not flipped.** `SymbolGeometry` already counts Y upward, the same as Altium's
  schematic; only `FootprintGeometry` counts down. Flipping both would have mirrored the symbol
  against its own footprint. `geometry.ts` now says so where the type is declared.
- **Off-grid schematic pins are refused.** Altium wires a pin only where it sits on the 10 mil grid,
  so nudging one quietly would produce a symbol that looks connected and is not.

### Verified

- Both libraries round-trip through pyaltiumlib with an empty diagnostic log, for a hand-written
  one-pad footprint and for a real 14-lead CFP exported through `/api/export`.
- Pads come back at the position, size, shape and corner radius written; tracks, the pin-1 arc and
  the designator string come back on the layers written.
- Pad numbering is counterclockwise, and the land matches the manifest within 0.05 mm.
- The symbol's pins come back once each, on the correct side and row, attached to the body edge and
  extending outward by their length, with electrical types carried through.
- `npx tsc --noEmit`, `npm test` (305 tests, run repeatedly), `npm run build`, and a real export
  from `FORGE_DEPLOYMENT_MODE=air-gapped npm start`.

### Not verified

- **Altium itself has never opened these files.** This is the whole point of section 8's last box.
- ~~The v7 layer id written for Mechanical 15 is derived from AltiumSharp's formula.~~ Closed in
  section 13. It is not derived; it is what Altium's own files say.
- ~~The library header parameters are the honest minimum.~~ Superseded by section 13. The minimum
  turned out to be missing something the courtyard needed.
- ~~The `cfb` package writes one inert marker stream of its own at the container root.~~ Removed in
  section 13.

---

## 11. The second oracle, and what it caught (2026-07-27)

### Why a second reader

pyaltiumlib is a good reader and an incomplete one. Its schematic reader stops at record 44, so the
footprint link added below is invisible to it: a suite asking only pyaltiumlib would have gone quiet
exactly where the newest code was. The fix was not to relax the assertion. It was to add a reader
that can see more.

`tools/altium-oracle` builds a small dumper against **AltiumSharp**, pinned to a commit, run from
the test suite alongside the Python one. Build it with `npm run oracle:build`. It needs the .NET SDK
and the README says how to get one without touching anything system-wide.

### What it caught immediately

**The footprint data stream was being written with a trailing `0x00` terminator byte, and Altium
writes no such byte.**

Every Altium-written footprint stream in the corpus consumes its length exactly and stops. A strict
reader takes a trailing zero for an unknown primitive id, tries to skip a block that is not there,
and rejects the whole library. AltiumSharp did exactly that. pyaltiumlib had passed the same file
with an empty diagnostic log for the entire life of the generator, because it happens to break its
read loop on a zero record id, which is also where section 4's incorrect "terminated by RecordID 0"
came from: a reader's tolerance mistaken for the format.

This is the failure mode this document was written about, caught one layer earlier than a human
opening Altium. Locked by a regression test in `altium-crosscheck.test.ts`.

### Diagnostics are now classified, not silenced

`altium-oracle.py` reports two lists. `diagnostics` is pyaltiumlib finding the FILE wrong, and must
be empty. `unsupportedRecords` is pyaltiumlib saying the READER does not implement a record, which
says nothing about the file. Records 45, 46 and 48 land in the second list and are checked by
AltiumSharp, which implements them. Nothing is unchecked, and no message is suppressed.

### The footprint link

The symbol now names its footprint, so a placed part arrives with copper attached instead of the
user browsing for a model once per part:

```
RECORD=44                                          implementation list container
RECORD=45|MODELNAME=<footprint>|MODELTYPE=PCBLIB|DATAFILECOUNT=0|ISCURRENT=T
RECORD=46                                          pin-map container, empty
RECORD=48                                          parameters container
```

`DATAFILECOUNT=0` with no `MODELDATAFILEENTITY` is load-bearing. Altium can pin the link to a named
library file, and then it dangles as soon as the file is renamed or moved. Leaving it out makes
Altium resolve the name against any loaded library. This is not a guess: every one of the 23
components in AltiumSharp's reference dump of a production library (`TestData/DAC.json`) names a
model and no file.

`RECORD=46` stays empty because our schematic pin designators and pad designators are the same
strings, which is the trivial case.

### The embedded 3D body

The STEP solid now lives inside the `.PcbLib` rather than beside it:

```
/Library/Models/Header    count
/Library/Models/Data      EMBED=TRUE|MODELSOURCE=..|ID={GUID}|ROT*|DZ|CHECKSUM|NAME
/Library/Models/0         zlib-compressed STEP text
```

plus a record 12 component body on Mechanical 1 that references the model by `MODELID` and repeats
its `MODEL.CHECKSUM`. Both have to agree or the body points at nothing.

The checksum is a position-weighted byte sum over the uncompressed STEP, weight 1 for byte 0 and i
for byte i. That is reverse-engineered rather than documented, so it is checked rather than trusted:
run over the STEP inside Altium's own `BODY_3D_STEP.PcbLib` it reproduces the value that file
stores. The body height is parsed back out of the STEP we generated rather than passed separately,
so the declared height and the solid cannot disagree.

### KiCad got the same treatment

Formats are peers, so the same friction was removed there. The symbol carries a `Footprint` property,
the footprint ships in a `<part>.pretty/` folder so the library nickname the user gets by default is
the one the property names, and the footprint references the STEP through `${KIPRJMOD}`.

### Still not verified

Unchanged and still the only thing that matters: **nobody has opened any of this in real Altium.**
Two independent readers agreeing is the strongest statement available short of that, and it is not
the same statement.

---

## 12. The KiCad output has an oracle too (2026-07-27)

Once Altium had two independent readers, KiCad had none, and its files were checked only by our own
regexes matching text our own code had produced. That is a restatement, not a check, and it was the
least verified thing we shipped. `src/lib/emitters/__tests__/kicad-oracle.py` reads the output back
with **kiutils**, an independent parser, and `kicad.test.ts` asserts on what it recovers.

It found something on the first run: our symbol emitted its pins and body outline directly inside
`(symbol "NAME" ...)` with no `NAME_1_1` unit sub-symbol, and kiutils reported **zero units**.

The interesting part is what that turned out to be. Reading KiCad's own parser settles it:
`sch_io_kicad_sexpr_parser.cpp` accepts `T_pin`, `T_rectangle` and the rest as direct children of a
symbol, `m_unit` is initialised to 1, and `parseLibSymbol` calls `SetUnitCount(1, true)` on entry. So
KiCad files those pins under unit 1 and the symbol was never broken.

It was non-canonical, though, and non-canonical showed up immediately as an empty symbol to a
reader that was not KiCad. A library that only one program understands is a library with a footgun
in it, so the emitter now writes the unit the way KiCad does.

Worth noting for next time: the cheap authoritative answer here was the parser source, not a 1.5 GB
install of the application. Reading what the real program does beat both guessing and downloading.

---

## 13. The last two unknowns, closed (2026-07-27)

Section 10 left three things unverified besides the one that matters. Using AltiumSharp as a **writer**
rather than a reader was supposed to settle two of them cheaply. It settled both, and turned up a
defect on the way.

### Mechanical 15 is 71, and Altium says so itself

Section 10 recorded this as derived from AltiumSharp's formula with no golden file to confirm it. That
was true of the primitives and false of the header. **Every Altium-written `.PcbLib` carries a
`LAYERnNAME` table in `/Library/Data` indexed by exactly the byte a primitive stores**, and it reads:

```
LAYER1NAME=Top Layer       LAYER33NAME=Top Overlay    LAYER57NAME=Mechanical 1
LAYER56NAME=Keep-Out Layer                            LAYER71NAME=Mechanical 15
```

Identical in all 89 `.PcbLib` files in AltiumSharp's corpus, including eleven authored by
manufacturers (STMicro, Analog Devices, Qorvo, Xilinx, pSemi, Diodes) rather than by the test
harness. This is not a formula restated, it is Altium's own statement of the mapping.

The writer probe was run anyway, because two sources beat one:
`tools/altium-oracle --write-probe` has AltiumSharp write component bodies named `MECHANICAL15` and
so on, then reads the file back and reports the byte the reader recovered from the record. It comes
back 71, through a name-to-byte-to-name path we did not touch.

A better corroboration fell out of the same dump. All eleven manufacturer libraries enable exactly
**Mechanical 1, 13 and 15**, and put their courtyards on 15. Our courtyard layer is not merely
allowed, it is the industry's.

### The minimal header was missing the thing that made the courtyard visible

Section 10 argued the header was the honest minimum and that Altium's 90 kB V9 stack was another
project's board. Both halves of that were right and the conclusion was still wrong, because the
header contains a second, older, smaller table that is not a stackup at all.

**A mechanical layer that the document does not enable is not drawn.** Alongside `LAYERnNAME` sits
`LAYERnMECHENABLED`, and Altium's default enables Mechanical 1 and nothing else. Compare:

| library | mechanical layers enabled |
| --- | --- |
| the eleven manufacturer libraries | 57, 69, 71 |
| the 73 test-harness libraries with nothing on 15 | 57 |
| ours, before this | none, no table at all |

So the courtyard was in the file, on the right layer, and would have opened into an editor with that
layer switched off. Nothing would have looked broken; there would simply have been no courtyard. That
is precisely the failure mode section 10 called "the first thing to look at if the library opens and
looks wrong", sitting in our own output the whole time.

`layers.ts` now emits the v6 layer table, and enables the two mechanical layers we actually draw on.

**It is a constant, and it is checked as one.** Across all 89 corpus files the 738 keys differ in
exactly two things: which mechanical layers are on, and the copper `PREV`/`NEXT` chain. Names,
dielectric constants, copper thickness are byte-identical everywhere, which is what makes them
Altium's defaults rather than somebody's board. `altium-layer-stack.test.ts` regenerates the block and
compares it to `altium-layer-stack.golden.txt`, lifted verbatim out of a Qorvo library. While the
generator was being written it was run against all 89: **84 byte-identical, 5 differing only in the
copper chain** because they are 3- and 4-layer boards and we emit the 2-layer chain every manufacturer
footprint library carries. Nothing else varied.

Two details had to be measured rather than reasoned about, and both would have been wrong if guessed:
Altium restarts the sub-record every **five layers exactly**, not at a byte threshold, and it
terminates the outgoing one with a **carriage return** before the `|RECORD=Board` marker. The first
generated block was 16 bytes short, one per marker, which is how the second detail was found.

The V9 stack is still not emitted, and the reasoning there is unchanged: it describes a board, and a
footprint library has none.

### The rest of the header, audited, and deliberately left out

Having found one thing by diffing our header against Altium's, the obvious question was whether there
was a second. The audit ran the same comparison over every key universal to all 89 corpus files. Four
things came back, and the answer is no to all four, for reasons worth writing down so nobody has to
re-derive them:

- **`LAYERV7_0..15`, Mechanical 17 to 32.** Present in all 89 files, 16 groups of 10 keys, and
  `MECHENABLED=FALSE` in every group of every file. We never draw above Mechanical 16, so emitting
  3 kB of always-disabled layer definitions would change nothing except the file size. Absent and
  all-disabled are the same state.
- **The v6 scalar prologue** (`LAYERSTACKSTYLE`, `SHOW{TOP,BOTTOM}DIELECTRIC`, `TOP*`/`BOTTOM*`).
  A constant across the corpus, and it describes the solder-mask dielectric: 3.500 dielectric
  constant, 0.4 mil of Solder Resist. That is a board, and the rule that kept the V9 stack out keeps
  this out too.
- **The v8 and V9 cache tables.** These are not constants. `LAYER_V8_0ID={77F4A815-...}` and
  `V9_CACHE_LAYER0_ID={580A6AEF-...}` are per-file GUIDs identifying that project's stackup layers.
  Fabricating them is the thing this emitter refuses to do.
- **`DATE`, `TIME`, `FILENAME`, and the Vault GUIDs.** Provenance and managed-content identity.
  `DATE`/`TIME` would also break the deterministic-export property on purpose, which is worth more.

`DISPLAYUNIT` was the one real decision in the list rather than an exclusion. It is `1` (millimetres)
in the 78 harness files and `0` (mils) in the 11 manufacturer ones; the enum is `0=mil, 1=mm, 2=µm,
3=in`. We do not write it, and if we ever do it should be `1`, because the geometry, IPC-7351B and the
`PADVIALIBRARY.DISPLAYUNITS` we already emit are all metric.

**The residual risk this audit did surface, and could not settle.** Altium keeps the same layer state
in three representations, and in all 89 files they agree exactly: Mechanical 15 is enabled in the v6
table, the v8 table and the V9 cache together, or in none of them. So the corpus cannot say which one
Altium actually reads, and it is possible that a modern Altium prefers V9 and the table we now write
is the one it ignores. The argument that it does not: Altium still opens libraries written before V9
existed, which carry the v6 table and nothing else, so the v6 path cannot be dead — and we emit no V9
block at all, so there is nothing for it to prefer. That is reasoning, not evidence. If dvinn opens
the library and the courtyard is still missing, this paragraph is where to start.

### The marker stream is gone

The `cfb` package seeds every container with a four-byte stream at the root whose name begins with a
0x01 byte, and re-adds it on every write, so it could not be deleted before writing. Section 10 called
it cosmetic. It probably was, but of 198 Altium-written libraries in the corpus, **not one carries any
stream with a control character in its name**, which made it the single thing in our containers that
Altium would never have produced, in a format that refuses files it dislikes without a word.

`container.ts` now unlinks it after the write. `cfb` builds the directory as a degenerate
right-leaning chain rather than a balanced tree, so removal is a pointer splice and needs none of the
rebalancing a real red-black deletion would. The shape is checked rather than assumed: if the marker
ever appears with a left sibling or a child, the buffer is returned untouched, because an inert extra
stream beats a directory with a bad pointer in it.

### The libraries survive being rewritten by somebody else

New, and the strongest check in the suite. `tools/altium-oracle --roundtrip` reads our library, writes
it back out through **AltiumSharp's writer**, reads the result, and compares. Both libraries come back
identical at every field the reader can see.

Reading proves a reader could make sense of the bytes. This proves the meaning survives a full trip
through an independent implementation, which is harder to pass by accident: a field written somewhere
the reader tolerates but does not understand comes back missing on the second read, and a length or
offset that only works for our own byte layout falls apart once a different writer re-lays it out.

### Still not verified

Unchanged, and now the only item on the list: **nobody has opened any of this in real Altium.** The
first human to do so should look at the courtyard on Mechanical 15 first, because that is what changed.

### Worth carrying forward

The two unknowns were framed as "ask AltiumSharp to write one and see what it does". AltiumSharp
answered the first question and had nothing to say about the second: its own from-scratch header is
`HEADER` plus `WEIGHT`, 45 bytes long, more minimal than ours and just as silent about layers. The
answer came from reading what Altium wrote, not from what another writer chose. Second time this file
records that lesson; see the end of section 12.
