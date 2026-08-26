import type { Metadata } from "next";
import "./globals.css";

/**
 * Rendered per request, so the Content-Security-Policy nonce reaches the page.
 *
 * ## Why this is not a performance decision
 *
 * `src/middleware.ts` issues a fresh nonce per request and Next stamps it onto
 * the scripts it emits. It can only do that while it is RENDERING a request. A
 * statically prerendered route has its HTML written at build time, when no
 * request and therefore no nonce exists, so Next emits its bootstrap with no
 * nonce on it and the browser refuses every one.
 *
 * That is not hypothetical. With the nonce policy in place and this line
 * absent, `next dev` ran perfectly and the PRODUCTION build was dead: the
 * `next build` output marked `/` as prerendered static content, the served HTML
 * carried no nonce, `'strict-dynamic'` correctly disabled the `'self'` host
 * allowlist, and all five chunks plus every inline script were blocked. The
 * page loaded as HTML with no JavaScript, exactly as before the fix.
 *
 * This is the third time in this codebase that a production build has behaved
 * differently from the dev server and looked fine everywhere else. The other
 * two are written up in `next.config.ts`.
 *
 * The cost is a render per request for a page that is a client component
 * anyway: it holds no server data, and every number on it arrives from
 * `/api/parse` after the user acts. There is nothing being recomputed here that
 * a static file was saving.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // What the tab says while an engineer has six of them open. The part they are
  // working on is the useful half, and the tool name is the half they already
  // know, so the tool name goes second.
  title: "Forge",
  description: "Read a datasheet, get a schematic symbol, a footprint and a 3D body."
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}