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

export async function fetchBobworkAccounts(): Promise<{
  records: unknown[];
  sourceUrl: string;
  documentationUrl: string;
  observedAt: string;
}> {
  let apiKey: string;
  try {
    apiKey = requireEnv("BOBWORK_API");
  } catch {
    throw new HttpError(503, "bobwork_key_missing", "La variable serveur BOBWORK_API n’est pas configurée.");
  }
  const endpoint = new URL(`${BOBWORK_API_BASE_URL}/mailboxes`);
  const response = await fetch(endpoint, {
    headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new HttpError(502, "bobwork_upstream_error", `BobWork a répondu avec le statut ${response.status}.`);
  }
  const body = (await response.json()) as unknown;
  const records = mailboxRecords(body);
  return {
    records,
    sourceUrl: endpoint.toString(),
    documentationUrl: BOBWORK_DOCUMENTATION_URL,
    observedAt: new Date().toISOString(),
  };
}
