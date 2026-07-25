import type { NextConfig } from "next";

// Security headers applied to every response. These are defense in depth: they do not fix a
// specific bug, they contain the blast radius if one exists elsewhere, which is exactly what you
// want on a publicly reachable app handling untrusted input.
const securityHeaders = [
  // Stop the browser from MIME-sniffing a response into something executable. Pairs with the fact
  // that we already magic-byte-check PDFs server side.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Disallow being framed, so the UI cannot be used in a clickjacking overlay.
  { key: "X-Frame-Options", value: "DENY" },
  // Modern equivalent of X-Frame-Options plus a default-deny for everything, then re-allow only
  // what the app needs. 'unsafe-inline' for styles is Next's styled-jsx requirement; scripts are
  // NOT given unsafe-inline, so an injected <script> will not run. connect-src is self only, which
  // also means a compromised bundle cannot exfiltrate to an arbitrary origin.
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join("; ")
  },
  // Do not leak full URLs (which can carry part numbers) to third parties via the Referer header.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // We use no browser sensors; deny them so a future dependency cannot quietly turn them on.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" }
];

const nextConfig: NextConfig = {
  typedRoutes: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  }
};

export default nextConfig;
