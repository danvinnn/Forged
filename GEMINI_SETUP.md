# Extraction model setup

Forge can use a vision-language model to fill in fields the deterministic text parser could not read.
This file covers configuring one. `.env.example` documents every variable in full; this is the
walkthrough.

**A model is optional.** With none configured Forge runs deterministic extraction only, which is the
fully exercised path. Nothing is inert-but-broken: `makeExtractionModel` returns null and the model
code is never loaded.

## What a model is and is not used for

- **It is NOT used to find datasheets.** Retrieval is deterministic and contains no model. A model
  asked for a URL invents plausible dead links, which poisons the citation trail that IPC Class 3 and
  QML sign-off depend on. This rule is absolute; see `ARCHITECTURE.md`.
- **It does NOT replace the parser.** The deterministic pass always runs first and always wins. A
  model is only asked about fields the code could not resolve, and can never overwrite one it did.
- **Its answers are verified, not trusted.** The model reports the page it read each value from, and
  that claim is checked against the page before it becomes a citation. A value that cannot be located
  is kept but marked untraceable, and untraceable values cannot produce CAD geometry.

## Option A: cloud model (commercial deployments only)

1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey) and create an API key.
2. Put it in `.env.local`:

```env
FORGE_DEPLOYMENT_MODE=commercial
GOOGLE_GEMINI_API_KEY=your-api-key-here
```

**This is ignored in air-gapped mode**, and not merely by a runtime check: the cloud module is
reached only through a dynamic import inside a commercial-mode branch, so it is never loaded into an
air-gapped process. Controlled datasheets must not reach a third-party API.

## Option B: local open-weight model (required for air-gapped)

Serve a vision-language model behind any OpenAI-compatible `/chat/completions` endpoint. vLLM,
Ollama, llama.cpp, and TGI all expose that shape, so this is a URL rather than a code change. The
architecture names Qwen3-VL as the candidate.

```env
FORGE_LOCAL_MODEL_URL=http://127.0.0.1:8000/v1/chat/completions
FORGE_LOCAL_MODEL_NAME=qwen3-vl
```

**The endpoint must resolve to a private or loopback address.** A public one is refused at startup
and again at request time, because a "local" model pointed at a cloud host would send controlled
datasheet text off the customer network, which is the one thing air-gapped mode exists to prevent.

## Verifying

Start the app and read the first log line. The startup preflight states the effective posture and
flags dangerous configuration:

```bash
npm run build && npm start
# {"event":"startup","mode":"commercial","lookupEnabled":true,"modelConfigured":true,"findings":0}
```

`findings` above zero means something is worth reading in the lines that follow: a cloud key on an
air-gapped deploy, an unset deployment mode in production, or a local endpoint that is not private.

To see whether a model actually helped, the response's `method` field reads `deterministic` when the
text pass answered everything, and `deterministic+<model>` when the model filled a gap. Values it
supplied carry `method: "vlm"` and, if their page claim checked out, a citation.

## Caveat worth knowing

As of 2026-07-26 the model path has been built and tested against fakes but **has never made a real
call**. Treat the first live run as an experiment: check that answers come back in the expected
shape, and that citation verification behaves sensibly against a real model rather than a mock.
