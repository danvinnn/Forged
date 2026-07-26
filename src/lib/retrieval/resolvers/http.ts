// The single choke point for every network call in the resolver subtree. Timeouts, SSRF checks,
// redirect validation, and download size limits all live here, so no resolver can accidentally skip
// one by calling fetch directly. The air-gap source scan enforces that only this subtree fetches.
//
// NETWORK MODULE. Only ever loaded through the commercial branch of makeResolver. Never imported
// in air-gapped mode.

import type { Agent } from "undici";
import { assertFetchableUrl, pinnedAgent, BlockedUrlError } from "./urlguard";
import { MAX_PDF_BYTES } from "../pdf";

// Search and API calls should return quickly; a slow one is usually a dead host.
export const SEARCH_TIMEOUT_MS = 8_000;
// Datasheet downloads are larger and can legitimately take longer.
export const DOWNLOAD_TIMEOUT_MS = 30_000;
// Redirect chains longer than this are either broken or hostile.
const MAX_REDIRECTS = 5;

export class TimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export class ResponseTooLargeError extends Error {
  constructor(url: string, limit: number) {
    super(`Response from ${url} exceeded the ${limit} byte limit`);
    this.name = "ResponseTooLargeError";
  }
}

// Node's global fetch has no default timeout, so a hung vendor host would otherwise stall the whole
// request forever. Every call gets an AbortController.
//
// Redirects are followed MANUALLY rather than by passing redirect:"follow", because the SSRF guard
// has to run on every hop. A public URL redirecting to 169.254.169.254 is the obvious bypass, and
// letting fetch follow redirects internally would check only the first URL.
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // One pinned agent per hop. undici's close() drains in-flight requests before
  // tearing down, so these can all be closed as soon as the exchange is set up
  // and the response body still streams to completion. Leaving them open would
  // leak a connection pool per lookup on a long-running server.
  const agents: Agent[] = [];

  try {
    let currentUrl = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const checked = await assertFetchableUrl(currentUrl);

      // Pin the connection to the address the guard just cleared, so a DNS
      // record that changes between the check and the connect cannot redirect
      // the socket to an internal host.
      const agent = pinnedAgent(checked);
      if (agent) agents.push(agent);

      const response = await fetch(currentUrl, {
        ...init,
        signal: controller.signal,
        redirect: "manual",
        ...(agent ? { dispatcher: agent } : {})
      } as RequestInit);

      const location = response.headers.get("location");
      const isRedirect = response.status >= 300 && response.status < 400 && location;
      if (!isRedirect) return response;

      // Resolve relative Location headers against the current URL, then re-check the target.
      currentUrl = new URL(location, currentUrl).href;
    }

    throw new Error(`Too many redirects for ${url}`);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new TimeoutError(url, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    // Safe on every path: close() drains before tearing down, so a response
    // body the caller has not read yet still completes.
    for (const agent of agents) void agent.close();
  }
}

// Buffers a response body with a hard ceiling.
//
// Why this is not just response.arrayBuffer(): that buffers the ENTIRE body into memory before
// anything checks its size, so assertPdfBytes rejecting a 5GB response happens far too late to
// matter. A hostile or misconfigured host could OOM the process. Here the declared Content-Length
// is rejected up front, and the stream is aborted mid-flight the moment the accumulated bytes cross
// the limit, so a lying or absent Content-Length cannot get past it either.
export async function readBodyWithLimit(
  response: Response,
  url: string,
  limit: number = MAX_PDF_BYTES
): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    throw new ResponseTooLargeError(url, limit);
  }

  if (!response.body) return new ArrayBuffer(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new ResponseTooLargeError(url, limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

export { BlockedUrlError };
