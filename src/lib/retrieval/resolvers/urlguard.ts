// SSRF guard for every outbound fetch in the resolver subtree.
//
// NETWORK MODULE. Only ever loaded through the commercial branch of makeResolver.
//
// The exposure this closes: the scrape resolver extracts URLs from search-result HTML and fetches
// them, and every fetch follows redirects. That means a URL we did not choose, from a page we do
// not control, decides what our server connects to. On a cloud host the classic target is the
// instance metadata endpoint (169.254.169.254 on AWS and GCP), which can hand out credentials, but
// any internal service reachable from the app is fair game. This is only a theoretical problem on a
// laptop and a real one the moment the app is publicly reachable.
//
// Defence is in two parts, because either alone is bypassable:
//   1. Reject non-http(s) schemes and hostnames that are literal private, loopback, or link-local
//      addresses. Catches the direct attempt.
//   2. Resolve the hostname and check the ADDRESSES it points at. Catches a public hostname that
//      resolves to a private address, which is how DNS rebinding and internal-CNAME tricks work.
//
// Known residual risk, stated rather than hidden: between our DNS check and the connection, the
// record could change (a TOCTOU rebinding attack). Closing that needs connection-level pinning,
// which Node's fetch does not expose. Every redirect hop is re-checked, which is the main practical
// vector, and the remaining window is narrow. Revisit if this ever handles untrusted input beyond
// search results.

import { lookup } from "node:dns/promises";

export class BlockedUrlError extends Error {
  constructor(url: string, reason: string) {
    super(`Refused to fetch ${url}: ${reason}`);
    this.name = "BlockedUrlError";
  }
}

// IPv4 ranges that must never be reachable from a datasheet fetch.
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;

  if (a === 0) return true;                          // "this" network
  if (a === 10) return true;                         // RFC1918
  if (a === 127) return true;                        // loopback
  if (a === 169 && b === 254) return true;           // link-local, includes cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;  // RFC1918
  if (a === 192 && b === 168) return true;           // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true;                         // multicast and reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1" || normalized === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true; // unique local fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true; // link-local fe80::/10
  // IPv4-mapped (::ffff:169.254.169.254) would otherwise slip past the v4 check.
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

export function isBlockedAddress(ip: string): boolean {
  return ip.includes(":") ? isPrivateIpv6(ip) : isPrivateIpv4(ip);
}

// Hostnames that never belong in a datasheet URL, checked before any DNS work.
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain"];

// Throws BlockedUrlError unless the URL is safe to fetch. Async because the DNS check is the half
// that actually stops a public hostname pointing at an internal address.
export async function assertFetchableUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError(rawUrl, "not a valid URL");
  }

  // file:, data:, gopher: and friends have no business here.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(rawUrl, `scheme ${url.protocol} is not allowed`);
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname) throw new BlockedUrlError(rawUrl, "no hostname");
  if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) {
    throw new BlockedUrlError(rawUrl, "internal hostname");
  }

  // Literal IP in the URL: check it directly, no DNS needed.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) {
    if (isBlockedAddress(hostname)) {
      throw new BlockedUrlError(rawUrl, "private or link-local address");
    }
    return url;
  }

  // Named host: resolve and check every address it points at.
  let addresses: { address: string }[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    // DNS failure is not an SSRF signal. Let the fetch fail normally so it maps to a soft
    // transport error rather than looking like an attack.
    return url;
  }

  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new BlockedUrlError(rawUrl, `hostname resolves to a private address (${address})`);
    }
  }

  return url;
}
