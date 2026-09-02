# Running Forge

Everything here was walked on 2026-09-01 by removing the configuration and
starting from nothing, so the steps are what actually happens rather than what
should.

## What you need

- Node 21 or later
- A Google Cloud service account with Vertex AI enabled, or a Gemini API key

A parse takes **65 to 90 seconds**, almost all of it the model. About a second of
that is Forge. Any host you run this on must allow a request to last ~150
seconds; Vercel's Hobby tier caps at 60 and will not work.

## First run

```bash
npm install
npm run build
npm start          # http://localhost:3000
```

With no configuration at all it builds, boots, and serves the page. It will
refuse to read anything, and say so:

```
{"level":"warn","event":"preflight","code":"MODE_DEFAULTED",
 "message":"FORGE_DEPLOYMENT_MODE is not set. In production this defaults to
            air-gapped (fail-closed) ..."}
```

and a parse answers **503 MODEL_UNAVAILABLE**, "No local reader is configured for
this air-gapped deployment, so the datasheet was never read." That is the
intended behaviour: it fails closed and tells you which knob is missing.

## Configuring the reader

Copy `.env.example` to `.env.local`. The three lines that matter:

```
FORGE_DEPLOYMENT_MODE=commercial          # or air-gapped
GOOGLE_APPLICATION_CREDENTIALS=./gcp-key.json
FORGE_VERTEX_PROJECT=your-project-id      # the ID, not the display name
```

Vertex needs BOTH the credential and the project; either alone is treated as not
configured, because guessing the project means guessing who gets billed.

A Gemini API key works instead:

```
GOOGLE_GEMINI_API_KEY=...
```

An air-gapped install uses neither and points at a local model on a private
address (`FORGE_LOCAL_MODEL_URL`). Controlled datasheets never leave that
network, and the guarantee is structural: the cloud providers are reachable only
through a dynamic import on the commercial branch, enforced by a test.

## What it will cost

Every billed call is metered and capped.

```
FORGE_SPEND_LIMIT_USD=25     # cumulative across every parse. 0 disables.
```

Over the limit, both routes answer 402 and nothing is sent. The running total
lives in `.forge/spend.json`. A local model is never counted and never capped.

A parse costs roughly $0.03. Sixty-three calls during testing came to $2.13.

## What to expect from a read

- The card at the top says one of seven things and the button under it agrees
  with it. If it says nothing can be built, the button is withheld.
- Values that two independent readings agreed on ship silently. Everything else
  is listed as "worth a glance", with the page it came from. On the tuned corpus
  that is **1.73 values per part**, and never more than 5.
- Questions are asked only where the datasheet does not answer them. Ceramic flat
  packs will ask for a formed lead span, because no manufacturer prints one: the
  leads are straight until your line forms them.

## If something looks wrong

- `npm run bench:kicad` opens every emitted file with KiCad itself.
- `npm run bench:altium` opens every emitted file with an independent reader.
- `npm run bench:instruments` breaks each check on purpose and confirms it
  complains. If that one is red, distrust every other number.
