# Architecture

The decided architecture for Forge. This is the durable "why" that outlives any single layer's
implementation notes. For Layer 1 detail see `src/lib/retrieval/LAYER1.md`; for the open backlog see
`DEFERRED.md`.

Where documents disagree, the order of precedence is: this file (top-level intent), then the decided
records (LAYER1.md), then everything else, and **the code beats every document**. That rule exists
because it has already been needed: an earlier uncommitted draft of this file carried stale vendor
details that caused real bugs, and the README described a retrieval design the code had long since
replaced. Trust a document over reality here and you will be wrong.

## What we are building

Forge is a datasheet-to-CAD intake tool for radiation-hardened (rad-hard) aerospace and defense
components. A user gives a part number or uploads a datasheet PDF. Forge extracts pinout, package
geometry, dimensions, and radiation qualification data, then generates schematic symbols,
IPC-compliant PCB footprints, and STEP 3D models, with a confidence score and a source citation on
every extracted value.

Repo: github.com/danvinnn/Forged. Stack: Next.js 15, React 19, TypeScript, pdf-parse, jszip, zod.

## Positioning

The differentiation is rad-hard focus plus air-gapped / ITAR deployment. COTS-focused tools
(PCBPartz, Trace, ProtoFlow, scheMAGIC) handle mainstream parts but break on rad-hard. Target
customers are defense primes (BAE, L3Harris, Lockheed) who use Altium and Cadence, not KiCad. The
rad-hard supply base (Cobham/CAES, Teledyne e2v, Microchip, Honeywell, VORAGO) documents
inconsistently.

Consequence that shapes the whole product: for the specialist rad-hard vendors the datasheet is
often not publicly retrievable at all (checked 2026-07-22: VORAGO publishes no datasheets on its
site, only distributor-hosted copies exist; the pure-play houses gate documents behind sales
contact). So the upload path is not a fallback for these parts, it is the primary path. Retrieval is
a convenience that works well for the major analog and MCU vendors and cannot work for the
specialists. Design accordingly and do not oversell lookup.

## The three-layer pipeline

Three layers, with "use AI or not" answered separately for each.

### 1. Retrieval (DONE, deterministic, no LLM)

Part number to datasheet PDF, or a local upload. No language model anywhere in this layer.

**Never have a model find or generate a datasheet URL.** That hallucinates dead links and poisons the
citation trail that Class 3 and QML sign-off depend on. This rule is absolute and is the reason the
retrieval layer is deterministic.

A manufacturer-direct resolver constructs the URL from the part number for vendors with a VERIFIED
derivable pattern (TI, ST, ADI, each confirmed by a real fetch). A scrape resolver with multi-backend
search is the last resort. A caching layer wraps the chain. No credentials are required anywhere.

Distributor APIs (Nexar, Mouser, DigiKey) were each evaluated and rejected; see LAYER1.md before
adding one back. A distributor-hosted PDF is public and readable by the scrape resolver without any
API.

### 2. Extraction (DONE, AI in the loop, deterministic-first)

Parse machine-readable layouts with code. Fall back to a model only for what the code could not
read. This layer is where the vertical AI actually lives, and four rules make it trustworthy:

- **Unknown is representable.** Every value is `{ value, confidence, method, citation }`. A field the
  parser cannot determine is `null`, not a guess. Before this existed the parser reported a VORAGO
  part as "NXP" with 128 fabricated pins while its own notes said no pin table was found.
- **Deterministic wins.** A model is only asked about unresolved fields and can never overwrite one
  the code read off the page. Enforced by construction in `extraction/merge.ts`.
- **Conflicting evidence resolves to unknown.** When two independent signals disagree, neither is
  trusted. This is why an ADI 2-lead part no longer exports a 3-pad footprint.
- **Model citations are verified, not believed.** A model reports the page it read a value from and
  that claim is checked against the page. An unverifiable citation is the same failure as a
  hallucinated source URL, relocated into extraction.

In air-gapped deployments the model MUST be a locally hostable open-weight model (the architecture
names Qwen3-VL), never a cloud API, because controlled datasheets cannot leave the customer network.
The commercial path may use a cloud model behind a dynamic-import gate, so the cloud module is never
loaded in air-gapped mode. The local endpoint must resolve to a private address: a public one is
refused, since a misconfigured "local" model is the one way controlled text could leave.

### 3. Generation (NEXT, deterministic templating plus IPC-7351B math, no LLM)

Never let a model write footprint or symbol geometry. Output must be exact, reproducible, and
auditable.

**Export refuses records it cannot stand behind.** If a value the geometry depends on is unknown, or
came from a model without a verified citation, generation is refused rather than approximated. Pad
pitch decides whether a part fits the board; an uncited one has no business in a footprint.

Native Altium and Cadence output are table stakes for the ICP, not a nice-to-have. Today they are
documented intermediate bundles, and KiCad is the only native path. This is the largest remaining
product gap.

IPC-7351B is a real land-pattern standard. The current math is IPC-7351B-**based**; say that, do not
claim compliance that has not been earned.

Every extracted value is escaped at the sink before being interpolated into generated files.

## Hard constraints (enforce these)

- **Air-gap / ITAR / EAR**: assume controlled data cannot leave the customer environment. Any code
  path reachable in air-gapped mode must make no network call, enforced structurally (dynamic
  import, source scan), not by convention.
- **Traceability**: every extracted value carries a confidence score and a citation. Required for
  IPC Class 3 and QML/QPL sign-off.
- **IPC-7351B**: implement the math or say "based", never claim compliance you have not earned.
- **Validation**: LMP7704-SP is the primary test part, but always sanity-check against a nastier
  rad-hard part (VORAGO or Microchip rad-hard), since easy parts hide extraction failures.

## How to work on this

- Act like a technical cofounder. Push back when something contradicts the positioning or the
  air-gap constraint, and verify claims empirically rather than asserting from memory. Every serious
  bug found in this repo was found by reading or running, not by the test suite.
- **Measure before building.** Judgment about coverage has been wrong twice here. `npm run
  bench:coverage` measures retrieval; `npm run bench:extraction` measures how much of a fetched
  datasheet is actually readable. Use the numbers.
- Prefer concrete code, schemas, and file structures over high-level advice.
- No em dashes anywhere, in prose, code, or comments. Use commas, colons, or periods.
- Work directly in the repo. Verify with `tsc --noEmit`, the full suite run more than once (files run
  in parallel and this repo has shipped flaky races), a production build, and the real app.

## Team

Anthony (Antman) and cofounder dvinn (danvinnn on GitHub).
