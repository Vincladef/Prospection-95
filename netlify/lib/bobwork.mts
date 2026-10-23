import { requireEnv } from "./env.mts";
import { HttpError } from "./http.mts";

export const BOBWORK_API_BASE_URL = "https://app-emailwarmup.bobwork.ai/api/v1";
export const BOBWORK_DOCUMENTATION_URL = "https://emailwarmup.bobwork.ai/api";

function mailboxRecords(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") {
    throw new HttpError(502, "bobwork_invalid_response", "BobWork a renvoyé une réponse JSON inattendue.");
  }
  const root = body as Record<string, unknown>;
  for (const key of ["mailboxes", "accounts", "items"]) if (Array.isArray(root[key])) return root[key] as unknown[];
  if (Array.isArray(root.data)) return root.data;
  if (root.data && typeof root.data === "object") {
    const data = root.data as Record<string, unknown>;
    for (const key of ["mailboxes", "accounts", "items"]) if (Array.isArray(data[key])) return data[key] as unknown[];
  }
  throw new HttpError(502, "bobwork_invalid_response", "BobWork a renvoyé une réponse JSON sans liste de boîtes.");
}

function apiKey(): string {
  try {
    return requireEnv("BOBWORK_API");
  } catch {
    throw new HttpError(503, "bobwork_key_missing", "La variable serveur BOBWORK_API n’est pas configurée.");
  }
}

async function fetchResource(resource: "mailboxes" | "stats" | "domains"): Promise<{
  body: unknown;
  sourceUrl: string;
  observedAt: string;
}> {
  const endpoint = new URL(`${BOBWORK_API_BASE_URL}/${resource}`);
  const response = await fetch(endpoint, {
    headers: { accept: "application/json", authorization: `Bearer ${apiKey()}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new HttpError(502, "bobwork_upstream_error", `BobWork a répondu avec le statut ${response.status} pour ${resource}.`);
  }
  return { body: await response.json() as unknown, sourceUrl: endpoint.toString(), observedAt: new Date().toISOString() };
}

export async function fetchBobworkAccounts(): Promise<{
  records: unknown[];
  sourceUrl: string;
  documentationUrl: string;
  observedAt: string;
}> {
  const result = await fetchResource("mailboxes");
  const records = mailboxRecords(result.body);
  return {
    records,
    sourceUrl: result.sourceUrl,
    documentationUrl: BOBWORK_DOCUMENTATION_URL,
    observedAt: result.observedAt,
  };
}

export async function fetchBobworkResources(): Promise<Array<{
  resource: "stats" | "domains";
  payload: unknown;
  sourceUrl: string;
  observedAt: string;
}>> {
  const resources = ["stats", "domains"] as const;
  const results = await Promise.allSettled(resources.map(async (resource) => {
    const result = await fetchResource(resource);
    return { resource, payload: result.body, sourceUrl: result.sourceUrl, observedAt: result.observedAt };
  }));
  return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
}
