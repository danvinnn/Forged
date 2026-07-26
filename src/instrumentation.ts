/**
 * Next.js startup hook. Runs once when the server boots.
 *
 * Used only to report the effective deployment posture and flag dangerous
 * configuration. See lib/preflight.ts for what is checked and why.
 */
export async function register(): Promise<void> {
  // Guard the runtime: the edge runtime has no DNS and does not need this.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { reportPreflight } = await import("./lib/preflight");
  await reportPreflight();
}
