import { lookup } from "node:dns/promises";
import { Agent } from "undici";
import { isIP } from "node:net";
import { ExtractionModelError, type ExtractionModel, type ExtractionRequest, type ExtractionResult } from "../contracts";
import { buildPrompt, parseModelResponse } from "./prompt";

/**
 * Locally hosted open-weight model (the architecture names Qwen3-VL as the
 * candidate), spoken to over an OpenAI-compatible /chat/completions endpoint.
 * vLLM, Ollama, llama.cpp, and TGI all expose that shape, so the deployment is
 * a URL rather than a code change.
 *
 * This is the ONLY extraction model permitted in air-gapped mode.
 */

const DEFAULT_TIMEOUT_MS = 120_000;

/** A field-extraction reply is a few KB. 8MB is generous and still bounded. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/**
 * Reads a response body with a hard ceiling, cancelling mid-stream once the cap
 * is crossed rather than buffering everything first and checking afterwards.
 */
async function readTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ExtractionModelError("bad_response", "Local model response exceeds the size limit.");
  }

  const body = response.body;
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ExtractionModelError("bad_response", "Local model response exceeds the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString("utf8");
}

function endpoint(): string {
  return process.env.FORGE_LOCAL_MODEL_URL ?? "";
}

function modelName(): string {
  return process.env.FORGE_LOCAL_MODEL_NAME ?? "qwen3-vl";
}

/**
 * True for addresses inside the customer's own network.
 *
 * This is deliberately the INVERSE of the SSRF guard in the retrieval layer.
 * There, a private address is the attack and public is safe. Here, a private
 * address is the requirement and a public one means controlled datasheet text
 * would leave the network, which is the one thing an air-gapped deployment
 * exists to prevent.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    // Unique-local (fc00::/7) and link-local (fe80::/10).
    if (/^f[cd]/.test(lower)) return true;
    if (/^fe[89ab]/.test(lower)) return true;
    // IPv4-mapped: judge the embedded address.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

/** A cleared endpoint plus the address the connection must be pinned to. */
export interface CheckedEndpoint {
  url: URL;
  pinnedAddress: string | null;
  pinnedFamily: 4 | 6 | null;
}

/**
 * Refuses an endpoint that is not inside the local network. Every address the
 * hostname resolves to must be private, so a name that resolves to both a
 * private and a public address is rejected rather than raced.
 */
export async function assertLocalEndpoint(rawUrl: string): Promise<CheckedEndpoint> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ExtractionModelError("config", "FORGE_LOCAL_MODEL_URL is not a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ExtractionModelError("config", "The local model endpoint must be http or https.");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPrivateAddress(host)) {
      throw new ExtractionModelError(
        "config",
        "The local model endpoint resolves to a public address. An air-gapped deployment must not send datasheet content off the local network."
      );
    }
    // A literal address has no name to re-resolve, so there is nothing to pin.
    return { url, pinnedAddress: null, pinnedFamily: null };
  }

  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new ExtractionModelError("config", `Could not resolve the local model host "${host}".`);
  }

  if (addresses.length === 0 || !addresses.every((entry) => isPrivateAddress(entry.address))) {
    throw new ExtractionModelError(
      "config",
      `The local model host "${host}" resolves outside the local network. An air-gapped deployment must not send datasheet content off the local network.`
    );
  }

  // Pin, for the same reason the retrieval guard pins, but with the risk
  // inverted and higher stakes: there a rebind reaches an internal service,
  // here it would send controlled datasheet text to a PUBLIC one. Checking the
  // name and then letting the socket resolve it again leaves exactly that gap.
  const chosen = addresses[0];
  return {
    url,
    pinnedAddress: chosen.address,
    pinnedFamily: chosen.family === 6 ? 6 : 4
  };
}

/** Dispatcher pinned to the cleared address; null when there is nothing to pin. */
export function pinnedLocalAgent(checked: CheckedEndpoint): Agent | null {
  if (!checked.pinnedAddress) return null;
  const address = checked.pinnedAddress;
  const family = checked.pinnedFamily ?? 4;
  return new Agent({
    connect: {
      lookup(_hostname, _options, callback) {
        callback(null, [{ address, family }]);
      }
    }
  });
}

export class LocalExtractionModel implements ExtractionModel {
  readonly name = `local:${modelName()}`;

  isConfigured(): boolean {
    return endpoint().length > 0;
  }

  async extract(request: ExtractionRequest): Promise<ExtractionResult> {
    const checked = await assertLocalEndpoint(endpoint());
    const agent = pinnedLocalAgent(checked);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(checked.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: modelName(),
          temperature: 0,
          messages: [{ role: "user", content: buildPrompt(request) }]
        }),
        ...(agent ? { dispatcher: agent } : {})
      } as RequestInit);

      if (!response.ok) {
        throw new ExtractionModelError(
          "transport",
          `Local model returned HTTP ${response.status}.`
        );
      }

      // Bounded read. response.json() buffers the whole body first, so a model
      // server that is buggy, compromised, or simply looping would otherwise
      // exhaust memory here. Same failure the download path caps against.
      const raw = await readTextWithLimit(response, MAX_RESPONSE_BYTES);

      let payload: { choices?: Array<{ message?: { content?: string } }> };
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new ExtractionModelError("bad_response", "Local model returned invalid JSON.");
      }

      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        throw new ExtractionModelError("bad_response", "Local model returned no message content.");
      }

      return parseModelResponse(content);
    } catch (error) {
      if (error instanceof ExtractionModelError) throw error;
      throw new ExtractionModelError(
        "transport",
        error instanceof Error ? error.message : "Local model request failed."
      );
    } finally {
      clearTimeout(timer);
      if (agent) void agent.close();
    }
  }
}
