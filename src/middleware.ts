import { NextResponse, type NextRequest } from "next/server";

/**
 * The Content-Security-Policy, issued per request so it can carry a nonce.
 *
 * ## The failure this fixes
 *
 * The policy used to be a constant in `next.config.ts`, and it said
 * `script-src 'self'` with the comment "scripts are NOT given unsafe-inline, so
 * an injected <script> will not run". The intent was right. The effect was that
 * THE APPLICATION NEVER RAN IN A BROWSER.
 *
 * Next's App Router boots the client by inlining `<script>` elements into the
 * document: the runtime bootstrap and the streamed flight payload that React
 * hydrates from. `script-src 'self'` blocks an inline script whoever wrote it,
 * so every one of those was refused, React never hydrated, and the page was
 * served as dead HTML. The status line sat on "Loading..." because the effect
 * that clears it never ran, and the file input did nothing because it had no
 * change handler attached. Choosing a PDF looked like a broken upload; it was a
 * page with no JavaScript at all.
 *
 * Nothing caught it. Every route was exercised with `curl` and answered
 * correctly, the type-check was clean, the suite was green and `next build`
 * succeeded, because none of those load a page in a browser. This is the second
 * defect in this file's history with that shape; see the `webpack` note in
 * `next.config.ts` for the first.
 *
 * ## Why a nonce and not 'unsafe-inline'
 *
 * `'unsafe-inline'` would also make the app run, by permitting every inline
 * script including one an attacker managed to inject. That is the exact thing
 * the original policy was written to prevent, so it is not the fix.
 *
 * A nonce is unguessable and fresh per response, so it admits the scripts THIS
 * server emitted and nothing else. Next reads it off the request's own
 * `Content-Security-Policy` header, which is why the value is set on the
 * forwarded request headers as well as on the response, and stamps it onto the
 * scripts it generates.
 *
 * `'strict-dynamic'` extends that trust to the chunks the bootstrap loads,
 * which is how the bundle finishes loading without listing every chunk. In a
 * browser that honours it, `'self'` is ignored and the nonce alone governs; in
 * an older one, `'self'` still applies. Both are stricter than what we had.
 */
export function policy(nonce: string, nodeEnv = process.env.NODE_ENV): string {
  return [
    "default-src 'self'",
    // `'unsafe-eval'` is the dev server's React Refresh compiling modules from
    // strings, and is NOT present in a production response. Guarded on
    // NODE_ENV, which Next fixes to "production" in a built bundle.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${
      nodeEnv === "production" ? "" : " 'unsafe-eval'"
    }`,
    // Next's styled-jsx writes inline <style>. A nonce does not help here
    // because those are emitted by the framework's own runtime rather than by
    // the document, and an injected stylesheet cannot execute.
    "style-src 'self' 'unsafe-inline'",
    // `data:` is the datasheet page images. They are PNG bytes rendered on this
    // machine and handed to the client base64 in the parse response, so there
    // is no URL to fetch and no origin to allow.
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; ");
}

export function middleware(request: NextRequest) {
  // Web Crypto rather than node:crypto: this runs on the Edge runtime, which
  // has no Node built-ins, and the whole repo is arranged to keep `node:`
  // specifiers out of the edge compile.
  const nonce = btoa(crypto.randomUUID());
  const csp = policy(nonce);

  // ON THE REQUEST, because that is where Next looks for it. Setting the header
  // only on the response yields a valid policy that Next's own scripts do not
  // carry the nonce for, which fails in exactly the way described above while
  // looking correct in devtools.
  const forwarded = new Headers(request.headers);
  forwarded.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: forwarded } });
  // AND on the response, because the request header is Next's channel and the
  // response header is the browser's.
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  /**
   * Everything the browser treats as a document or a request from one.
   *
   * `_next/static` and `_next/image` are excluded because a policy on a script
   * chunk or an image governs nothing, and running middleware for each of them
   * costs a request. API routes are deliberately INCLUDED: the nonce is
   * meaningless on a JSON response, but keeping one source for the header means
   * there is no path that can quietly end up with no policy at all. The other
   * security headers stay in `next.config.ts`, which applies them everywhere.
   */
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" }
      ]
    }
  ]
};
