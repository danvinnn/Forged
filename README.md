# Forge

Forge is a datasheet-to-CAD intake tool for radiation-hardened aerospace and defense components. You
give it a part number or upload a datasheet PDF; it extracts the pinout, package geometry,
dimensions, and radiation qualification data, then generates schematic symbols, footprints, and STEP
3D models.

**Every extracted value carries a confidence score and a citation back to the page it was read
from.** That is the point of the product, not a feature of it: IPC Class 3 and QML/QPL sign-off
require traceability, and a value nobody can trace is not usable on a flight part.

## The two things that make this different

**Rad-hard focus.** COTS-focused tools handle mainstream parts and break on rad-hard. The rad-hard
supply base (Cobham/CAES, Teledyne e2v, Microchip, Honeywell, VORAGO) documents inconsistently, and
several of those vendors publish no public datasheets at all.

**Air-gapped / ITAR deployment.** Controlled datasheets cannot leave the customer network. In
air-gapped mode Forge makes no network call on any reachable code path, and that is enforced
structurally (dynamic imports, a source scan, and merge-blocking tests) rather than by convention.

## How it works

Three layers, with the "use AI or not" question answered separately for each.

### 1. Retrieval, deterministic, no model

A part number resolves to a datasheet PDF, or you upload one.

- **Manufacturer-direct**: builds the datasheet URL from the part number and fetches it from the
  vendor. Ships verified patterns for TI, STMicroelectronics, and Analog Devices. A pattern enters
  the registry only after someone fetched a real datasheet through it.
- **Scrape**: multi-backend search with failover and a circuit breaker, plus known distributor
  paths. Last resort, since it is the only route to parts no vendor pattern claims.

No credentials are required. Part-number lookup works on a fresh checkout with an empty `.env`.

A model is never used to find or generate a datasheet URL. That would hallucinate dead links and
poison the citation trail the whole product depends on.

Every retrieved file is validated by its `%PDF` magic bytes (Content-Type is never trusted), size
bounded, filename sanitized, hashed with sha256, and tagged with the resolver that produced it.

### 2. Extraction, deterministic-first, model optional

The text parser always runs first and always wins. A model is only ever asked about fields the
parser could not resolve, and it can never overwrite a value that was read off the page by code.

- **Unknown is representable.** A field the parser cannot determine is recorded as `null` with a null
  confidence and no citation, so honest gaps are visible in the data instead of being filled with a
  guess.
- **Conflicting evidence resolves to unknown.** When two independent signals disagree (for example a
  package designator that says 2 leads and a pin table that yields 3 rows), neither is trusted.
- **Model citations are verified, not believed.** A model reports the page it read a value from, and
  that claim is checked against the page before it becomes a citation. Values whose claim does not
  hold keep the value but carry no citation, and the record says they are not traceable.

Which model runs depends on deployment mode. Commercial may use a cloud model (Gemini). **Air-gapped
permits only a locally hosted open-weight model** over an OpenAI-compatible endpoint (vLLM, Ollama,
llama.cpp; the architecture names Qwen3-VL), and that endpoint must resolve to a private address:
a public one is refused, because a misconfigured "local" model pointing at a cloud host is exactly
the leak air-gapped mode exists to prevent.

Parsing is resource-bounded (pages, extracted characters, objects per page, wall clock), so a small
PDF crafted to expand catastrophically returns a clean `PARSE_LIMIT_EXCEEDED` rather than hanging.

### 3. Generation, deterministic templating, no model

A model never writes footprint or symbol geometry. Output must be exact, reproducible, and
auditable.

**Export refuses incomplete records.** If the values the geometry depends on were never actually
extracted, the export returns `422 INCOMPLETE_EXTRACTION` listing what is missing, rather than
generating a footprint from numbers nobody read off a datasheet.

Every extracted value is escaped at the sink before being interpolated into generated files.

## Current support

- **Input**: part number with an optional manufacturer hint, or a PDF upload. Upload works in every
  deployment mode and is the primary path for controlled parts.
- **Extracted**: part number, manufacturer, package type, pin count, pin table, package dimensions,
  and radiation qualification (TID, SEE, SEL, QML class), each with confidence and citation.
- **Export formats**: KiCad is the primary path (`.kicad_sym` + `.kicad_mod` + a real STEP Part 21
  solid). Altium and Cadence/OrCAD are exposed as documented intermediate bundles, **not** native
  vendor library files.
- **Bundle contents**: symbol, footprint, STEP package body, normalized JSON, and a manifest.

## Known limitations

Stated rather than hidden.

- **Coverage is structural, not incidental.** Microchip, NXP, Vishay, and Infineon name datasheets by
  document number, so no part-number pattern can reach them. VORAGO, CAES, Teledyne e2v, and
  Honeywell publish no public datasheets at all. Connectors have no derivable pattern anywhere. Run
  `npm run bench:coverage` for the measured per-category numbers rather than trusting an estimate.
- **The text parser is tuned toward TI phrasing.** On other vendors it misses more, and those misses
  are recorded as unknown rather than guessed.
- **STEP export generates the package body enclosure only**; pin-lead geometry is still approximate.
- **Native Altium and Cadence emitters are not built yet.**
- **Footprint math is IPC-7351B-based**, not a full implementation of the standard. It is described
  that way deliberately.
- **Scanned or image-only datasheets** need the model path; the text pass will report unknowns.

## Run locally

```bash
npm install
npm run dev
```

Dev defaults to commercial mode, so lookup works with no configuration. Copy `.env.example` to
`.env.local` to change deployment mode, add a model, or tune limits. Every variable is documented
there.

```bash
npm test               # unit + integration + air-gap guard + security tests
npx tsc --noEmit       # type check
npm run bench:coverage # measured retrieval coverage (add -- --live for the real chain)
```

`npm run bench:coverage -- --live` should be run from the target deploy host: search engines block
datacenter IP ranges, so the block rate on a laptop is not the block rate in production.

## Validation

Primary target: **TI LMP7704-SP**, a 14-pin QMLV rad-hard amplifier. Ideas are also sanity-checked
against a harder rad-hard part (VORAGO or Microchip rad-hard), because easy parts hide extraction
failures.

## Documentation

- `ARCHITECTURE`-level intent and the three-layer rationale live with the team.
- `src/lib/retrieval/LAYER1.md` is the decided record for retrieval, with every decision and its
  reasoning.
- `DEFERRED.md` is the open backlog, each item with how to close it and how to prove it.

Where documents disagree, the decided records beat prose and **the code beats every document**.
