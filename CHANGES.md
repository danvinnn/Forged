# Layer 1 (Retrieval) change set, merged against current main (includes dvinn's Gemini path)

This set is reconciled with the Gemini work already on main. It adds the retrieval layer,
gates the existing Gemini calls behind commercial mode, and preserves datasheet-gemini.ts.

    npm install        # picks up tsx (added) alongside @google/generative-ai (already present)
    npm test           # 46 retrieval tests via tsx + node:test
    npx tsc --noEmit   # typechecks the whole repo, Gemini included

## Added (clean, no conflicts)
- src/lib/retrieval/**            the whole layer, including __tests__ and LAYER1.md
- src/app/api/config/route.ts     GET /api/config for client mode surfacing
- test-data/ALLOWLIST.txt         corpus CI gate allowlist
- .env.example                    documents FORGE_DEPLOYMENT_MODE, Nexar, and the Gemini key

## Modified (merged, do not blind-overwrite yours if you changed them since)
- src/app/api/lookup/route.ts     mode-gated resolver retrieval; Gemini extraction preserved but
                                  gated to commercial mode via dynamic import; the forbidden
                                  "Gemini finds the datasheet URL" path is removed
- src/app/api/parse/route.ts      ingestUpload (Layer 1) + Gemini extraction gated to commercial
- package.json                    added tsx devDep and test scripts; keeps @google/generative-ai

## NOT deleted (correction from the earlier standalone set)
- src/lib/datasheet-web.ts        KEEP IT. datasheet-gemini.ts imports lookupDatasheetPdf from it.
                                  The routes no longer import it, so it is inert from the retrieval
                                  path, but deleting it breaks the Gemini build. Retire it later
                                  when Layer 2 rewires Gemini behind the ExtractionModel interface.

## Air-gap note
In air-gapped mode the routes never load datasheet-gemini.ts: it is reached only through a
dynamic import inside a `mode === "commercial" && GOOGLE_GEMINI_API_KEY` branch. Verified: no
static import of the cloud module in either route.

## Architecture flag for dvinn
The Gemini path on main called Google's cloud API whenever the key was set, in ANY mode, with no
deployment-mode gate. In air-gapped mode that ships controlled datasheets to Google, which is the
core air-gap defect. This merge gates it. Also removed lookupAndParseDatasheetWithGemini from the
route path: using a model to FIND the datasheet URL is the hallucination pattern ARCHITECTURE.md
forbids. Proper Gemini extraction belongs in Layer 2 behind ExtractionModel, commercial-only, with
a local open-weight model for air-gapped.
