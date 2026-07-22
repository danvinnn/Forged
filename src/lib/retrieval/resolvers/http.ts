// Timeout wrapper for every network call in the resolver subtree.
//
// NETWORK MODULE. Only ever loaded through the commercial branch of makeResolver. Never imported
// in air-gapped mode.
//
// Node's global fetch has no default timeout, so a hung Nexar or datasheet host would otherwise
// stall the entire request forever. Every call gets an AbortController.

// Search and API calls should return quickly; a slow one is usually a dead host.
export const SEARCH_TIMEOUT_MS = 8_000;
// Datasheet downloads are larger and can legitimately take longer.
export const DOWNLOAD_TIMEOUT_MS = 30_000;

export class TimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new TimeoutError(url, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
