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
  /**
   * Node libraries that must be REQUIRED at runtime rather than bundled.
   *
   * Without this, `next dev` fails to start and every page 500s. The chain is:
   *
   *   instrumentation -> preflight -> extraction/models/local
   *     -> undici -> undici/lib/mock/pending-interceptors-formatter -> node:console
   *
   * Webpack pulls in the whole of undici, including its mock subsystem, which is
   * test-only code that imports `node:console`. Webpack does not handle the
   * `node:` scheme, so the module build fails.
   *
   * `next build` happened to survive it, which is why this went unnoticed: the
   * production compile tree-shakes the mock path and the dev compile does not.
   * That made the dev server unusable while every check we ran stayed green.
   *
   * Both entries here are server-only native or Node-facing libraries that were
   * never meant to be bundled. `undici` is the SSRF-guarded fetch agent;
   * `mupdf` is the WASM page renderer and is already loaded by dynamic import.
   */
  serverExternalPackages: ["undici", "mupdf"],
  /**
   * Keep Node built-ins out of the bundler, on every server compilation.
   *
   * ## The failure this fixes
   *
   * `next dev` would not serve a page. Every request 500'd with:
   *
   *   UnhandledSchemeError: Reading from "node:dns/promises" is not handled
   *   Import trace: ./src/lib/extraction/models/local.ts -> ./src/lib/preflight.ts
   *
   * `instrumentation.ts` already guards this at RUNTIME
   * (`if (process.env.NEXT_RUNTIME !== "nodejs") return`), and `preflight.ts`
   * already imports the model subtree dynamically to keep it out of the startup
   * graph. Both are correct and neither helps: webpack still COMPILES what it
   * can statically see, for every runtime it targets, and the edge target cannot
   * resolve the `node:` scheme at all.
   *
   * So the guard has to be at the bundler rather than at the call. A `node:`
   * specifier is a built-in by definition: it is never something to bundle, and
   * on the runtime that has them it resolves at require time. On the runtime
   * that does not, the code is unreachable behind the guard above.
   *
   * ## Why nobody noticed
   *
   * `next build` tree-shakes the offending path and passed throughout. So the
   * type-check was clean, the whole suite was green, the production build
   * succeeded, and the dev server had been unusable the entire time. Worth
   * remembering the next time a green board is taken as evidence.
   */
  webpack: (config, { isServer }) => {
    if (!isServer) return config;
    const existing = Array.isArray(config.externals)
      ? config.externals
      : [config.externals].filter(Boolean);
    config.externals = [
      ...existing,
      // Native and Node-facing libraries, which were never meant to be bundled.
      // `undici` is the SSRF-guarded fetch agent and drags in its own test-only
      // mock subsystem; `mupdf` is the WASM renderer, already dynamically loaded.
      { undici: "commonjs undici", mupdf: "commonjs mupdf" },
      ({ request }: { request?: string }, callback: (error?: unknown, result?: string) => void) =>
        request?.startsWith("node:") ? callback(undefined, `commonjs ${request}`) : callback()
    ];
    return config;
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  }
};

export default nextConfig;
