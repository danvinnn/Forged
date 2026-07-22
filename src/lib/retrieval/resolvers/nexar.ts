// Primary commercial-path resolver: Nexar (Octopart) GraphQL.
//
// NETWORK MODULE. Only ever loaded through the commercial branch of makeResolver. Never imported
// in air-gapped mode.
//
// Adapted from the reference implementation in ARCHITECTURE.md. Additions over the reference:
// isConfigured() (so a deployment with no credentials skips this resolver cleanly), timeouts on
// every call, typed ResolverError so the composite can tell a hard misconfig from a soft blip,
// and finalizeRef so the downloaded bytes are validated and hashed before leaving the layer.

import type { DatasheetRef, DatasheetResolver, ResolveOptions } from "../resolver";
import { finalizeRef } from "../ref";
import { PdfValidationError } from "../pdf";
import { ResolverError } from "./errors";
import { fetchWithTimeout, SEARCH_TIMEOUT_MS, DOWNLOAD_TIMEOUT_MS, TimeoutError } from "./http";

const IDENTITY_URL = "https://identity.nexar.com/connect/token";
const GRAPHQL_URL = "https://api.nexar.com/graphql/";

// supSearchMpn does MPN matching and exposes bestDatasheet.url, the field we want. Isolated as a
// constant so a schema/field rename after we confirm access in the Nitro IDE is a one-line change.
const SEARCH_QUERY = `
  query ResolveDatasheet($q: String!, $limit: Int!, $country: String!) {
    supSearchMpn(q: $q, limit: $limit, country: $country) {
      results {
        part {
          mpn
          manufacturer { name }
          octopartUrl
          bestDatasheet { url }
        }
      }
    }
  }
`;

interface NexarPart {
  mpn: string;
  manufacturer: { name: string } | null;
  octopartUrl: string | null;
  bestDatasheet: { url: string } | null;
}

const RESOLVER_NAME = "nexar";

function readCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.NEXAR_CLIENT_ID?.trim();
  const clientSecret = process.env.NEXAR_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// Maps a failed HTTP status to a typed resolver error. 401/403 are hard auth problems; 429 is a
// soft rate limit; everything else is treated as a soft transport issue.
function httpError(context: string, status: number): ResolverError {
  if (status === 401 || status === 403) {
    return new ResolverError("auth", RESOLVER_NAME, `Nexar ${context} auth failed: ${status}`);
  }
  if (status === 429) {
    return new ResolverError("rate_limit", RESOLVER_NAME, `Nexar ${context} rate limited: ${status}`);
  }
  return new ResolverError("transport", RESOLVER_NAME, `Nexar ${context} failed: ${status}`);
}

// Normalizes a thrown value into a typed ResolverError. Timeouts and generic network throws are
// soft transport failures.
function transportError(context: string, error: unknown): ResolverError {
  if (error instanceof ResolverError) return error;
  if (error instanceof TimeoutError) {
    return new ResolverError("transport", RESOLVER_NAME, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ResolverError("transport", RESOLVER_NAME, `Nexar ${context} error: ${message}`);
}

// Prefer a manufacturer-matched hit when a hint is given, else the first hit with a datasheet.
function pickPart(parts: NexarPart[], manufacturer?: string): NexarPart | null {
  const withDatasheet = parts.filter((p) => p.bestDatasheet?.url);
  if (withDatasheet.length === 0) return null;

  if (manufacturer) {
    const hint = manufacturer.trim().toLowerCase();
    const matched = withDatasheet.find((p) =>
      p.manufacturer?.name.toLowerCase().includes(hint)
    );
    if (matched) return matched;
  }
  return withDatasheet[0];
}

export class NexarResolver implements DatasheetResolver {
  readonly name = RESOLVER_NAME;

  private cachedToken: { value: string; expiresAt: number } | null = null;

  // Credentials-driven readiness. When these are unset the composite skips this resolver rather
  // than surfacing an error, so the commercial path still works via the fallback while Nexar sits
  // ready for the day the credentials land.
  isConfigured(): boolean {
    return readCredentials() !== null;
  }

  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAt > now + 60_000) {
      return this.cachedToken.value;
    }

    const creds = readCredentials();
    if (!creds) {
      throw new ResolverError("auth", RESOLVER_NAME, "NEXAR_CLIENT_ID and NEXAR_CLIENT_SECRET must be set");
    }

    let res: Response;
    try {
      res = await fetchWithTimeout(
        IDENTITY_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            scope: "supply"
          })
        },
        SEARCH_TIMEOUT_MS
      );
    } catch (error) {
      throw transportError("token", error);
    }
    if (!res.ok) throw httpError("token", res.status);

    let json: { access_token?: string; expires_in?: number };
    try {
      json = (await res.json()) as { access_token?: string; expires_in?: number };
    } catch {
      throw new ResolverError("bad_response", RESOLVER_NAME, "Nexar token response was not JSON");
    }
    if (!json.access_token || !json.expires_in) {
      throw new ResolverError("bad_response", RESOLVER_NAME, "Nexar token response was missing fields");
    }

    this.cachedToken = { value: json.access_token, expiresAt: now + json.expires_in * 1000 };
    return this.cachedToken.value;
  }

  private async runSearch(partNumber: string): Promise<NexarPart[]> {
    const token = await this.getToken();

    let res: Response;
    try {
      res = await fetchWithTimeout(
        GRAPHQL_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            query: SEARCH_QUERY,
            variables: { q: partNumber, limit: 5, country: "US" }
          })
        },
        SEARCH_TIMEOUT_MS
      );
    } catch (error) {
      throw transportError("query", error);
    }
    if (!res.ok) throw httpError("query", res.status);

    let json: {
      data?: { supSearchMpn?: { results?: { part: NexarPart }[] } };
      errors?: { message: string }[];
    };
    try {
      json = await res.json();
    } catch {
      throw new ResolverError("bad_response", RESOLVER_NAME, "Nexar query response was not JSON");
    }
    if (json.errors?.length) {
      throw new ResolverError("bad_response", RESOLVER_NAME, `Nexar GraphQL error: ${json.errors[0].message}`);
    }

    return (json.data?.supSearchMpn?.results ?? []).map((r) => r.part);
  }

  async resolve(partNumber: string, opts?: ResolveOptions): Promise<DatasheetRef | null> {
    const parts = await this.runSearch(partNumber);
    const part = pickPart(parts, opts?.manufacturer);
    if (!part?.bestDatasheet?.url) return null;

    const pdfUrl = part.bestDatasheet.url;

    let pdfRes: Response;
    try {
      pdfRes = await fetchWithTimeout(pdfUrl, { redirect: "follow" }, DOWNLOAD_TIMEOUT_MS);
    } catch (error) {
      throw transportError("download", error);
    }
    // A missing datasheet at the resolved URL is "not found", so the caller falls through.
    if (!pdfRes.ok) return null;

    const bytes = await pdfRes.arrayBuffer();
    try {
      return finalizeRef({
        fileName: `${part.mpn || partNumber}.pdf`,
        pdfUrl,
        sourcePageUrl: part.octopartUrl ?? undefined,
        bytes
      });
    } catch (error) {
      // The URL resolved but did not serve a real PDF (HTML interstitial, error page). Treat as
      // not found so the user can still upload, rather than as a hard failure.
      if (error instanceof PdfValidationError) return null;
      throw error;
    }
  }
}
