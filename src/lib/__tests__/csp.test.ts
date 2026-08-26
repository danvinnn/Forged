import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The policy that decides whether the application runs at all.
 *
 * `script-src 'self'` was served for the life of this product, and Next boots
 * the client from inline `<script>` elements, so every one of them was refused
 * and React never hydrated. The page arrived as dead HTML: the status line sat
 * on "Loading...", and choosing a datasheet did nothing because the input had
 * no handler bound to it.
 *
 * NOTHING CAUGHT IT. Every route answered correctly under `curl`, the
 * type-check was clean, the suite was green and `next build` succeeded, because
 * not one of those loads a page in a browser. These tests are the cheap half of
 * the guard; the other half is running the app in a real browser, which is the
 * only thing that actually found it.
 */

const root = join(import.meta.dirname, "..", "..", "..");
const middlewareSource = readFileSync(join(root, "src", "middleware.ts"), "utf8");
const nextConfigSource = readFileSync(join(root, "next.config.ts"), "utf8");

test("the framework's own inline scripts are admitted, by nonce and not by blanket permission", async () => {
  const { middleware } = await import("../../middleware");
  const { NextRequest } = await import("next/server");

  const response = middleware(new NextRequest(new Request("https://forge.test/")));
  const csp = response.headers.get("Content-Security-Policy");
  assert.ok(csp, "every document response carries a policy");

  const scriptSrc = csp.split(";").map((part) => part.trim()).find((part) => part.startsWith("script-src"));
  assert.ok(scriptSrc, "the policy governs scripts");

  // THE DEFECT, stated as an assertion: a script-src that admits neither a
  // nonce nor inline scripts blocks Next's bootstrap and the app is dead.
  assert.match(scriptSrc, /'nonce-[^']+'/, "the bootstrap is admitted by nonce");

  // AND NOT by the alternative that would also make it run. 'unsafe-inline'
  // admits an injected <script> too, which is the whole thing the policy exists
  // to stop, so it is not an acceptable way to fix this.
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), "an injected script still cannot run");
});

test("the nonce is fresh per response, which is the only thing that makes it worth anything", () => {
  // A nonce reused across responses is guessable from any one page's source,
  // and then it is 'unsafe-inline' with extra steps.
  assert.match(middlewareSource, /crypto\.randomUUID\(\)/, "generated per call");
  assert.ok(
    !/const\s+nonce\s*=\s*["'`]/.test(middlewareSource),
    "the nonce is never a literal"
  );
});

test("'unsafe-eval' is the dev server's, and never reaches a built bundle", async () => {
  // React Refresh compiles modules from strings, so `next dev` needs it and a
  // production bundle does not. Shipping it always would be a standing
  // weakening of the policy for a convenience nobody in production uses.
  const { policy } = await import("../../middleware");
  assert.ok(policy("n", "production").includes("script-src"));
  assert.ok(!policy("n", "production").includes("'unsafe-eval'"), "a built bundle evaluates no strings");
  assert.ok(policy("n", "development").includes("'unsafe-eval'"), "the dev server still refreshes");
});

test("only one Content-Security-Policy is issued, because two are enforced as their intersection", () => {
  // The static policy used to live in `next.config.ts`. Leaving it there beside
  // the nonce policy would restore the original defect exactly: a browser given
  // two policies satisfies BOTH, so the strict `script-src 'self'` would go on
  // blocking the bootstrap while the nonce header sat next to it looking like a
  // fix.
  assert.ok(
    !/Content-Security-Policy/.test(nextConfigSource.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")),
    "next.config.ts sets no policy of its own outside its comments"
  );
});

test("the other security headers are untouched by the move", () => {
  for (const header of [
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy"
  ]) {
    assert.ok(nextConfigSource.includes(header), `${header} still applied to every response`);
  }
});
