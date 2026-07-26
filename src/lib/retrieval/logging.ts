// Structured logging.
//
// Air-gap safety: writes to stdout/stderr only. No network, no transport, no
// external URL. Every host (Vercel, CloudWatch, Datadog, journald) ingests
// stdout, so this needs no vendor SDK and stays safe in an air-gapped deploy.
//
// Why this exists: the worst bug in this codebase so far was SILENT. A blocked
// search engine returned HTTP 200 with a challenge page, which read as "this
// part has no datasheet". Nobody reports that as a bug; it looks like a
// coverage gap. Structured events make that class of failure visible as a
// metric (search_blocked rate) instead of a mystery.
//
// NEVER log: datasheet bytes or extracted text (controlled data on the ITAR
// path), API keys, or full request bodies. Part numbers are logged because they
// are the unit of work and are not themselves controlled; if a customer decides
// otherwise, set FORGE_LOG_PART_NUMBERS=false.

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  event: string;
  [key: string]: unknown;
}

function levelEnabled(level: LogLevel): boolean {
  const configured = (process.env.FORGE_LOG_LEVEL ?? "info").toLowerCase();
  const order: LogLevel[] = ["debug", "info", "warn", "error"];
  const min = order.indexOf(configured as LogLevel);
  return order.indexOf(level) >= (min === -1 ? 1 : min);
}

/**
 * Whether part numbers may be written to logs.
 *
 * The default is deployment-mode dependent rather than a single global answer,
 * because the risk genuinely differs:
 *
 * - commercial: parts are public, we operate the service, and a log without the
 *   part number cannot diagnose anything. Default ON.
 * - air-gapped: an individual part number is public, but the SET of parts a
 *   defense customer researches reveals program composition. That is the
 *   classic aggregation problem, and these are exactly the customers who bought
 *   this product for its disclosure guarantees. Default OFF.
 *
 * An explicit FORGE_LOG_PART_NUMBERS always wins, in either direction.
 */
function partNumbersAllowed(): boolean {
  const explicit = process.env.FORGE_LOG_PART_NUMBERS?.trim().toLowerCase();
  if (explicit === "false") return false;
  if (explicit === "true") return true;
  return process.env.FORGE_DEPLOYMENT_MODE?.trim().toLowerCase() === "commercial";
}

/** Values that must never appear in a log line, whatever a caller passes. */
const FORBIDDEN_KEYS = new Set(["bytes", "text", "content", "apiKey", "key", "token", "secret", "prompt", "body"]);

function scrub(fields: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (key === "partNumber" && !partNumbersAllowed()) continue;
    // Never let an Error object dump a stack into a structured field.
    safe[key] = value instanceof Error ? value.message : value;
  }
  return safe;
}

export function log(level: LogLevel, event: LogEvent): void {
  if (!levelEnabled(level)) return;

  const { event: name, ...rest } = event;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event: name,
    ...scrub(rest)
  });

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: LogEvent) => log("debug", event),
  info: (event: LogEvent) => log("info", event),
  warn: (event: LogEvent) => log("warn", event),
  error: (event: LogEvent) => log("error", event)
};

/** Times an operation and logs the outcome either way. */
export async function timed<T>(
  event: string,
  fields: Record<string, unknown>,
  run: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await run();
    logger.info({ event, outcome: "ok", durationMs: Date.now() - startedAt, ...fields });
    return result;
  } catch (error) {
    logger.error({
      event,
      outcome: "error",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      ...fields
    });
    throw error;
  }
}
