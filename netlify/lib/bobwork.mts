import { readCredential } from "./credentials.mts";
import { HttpError } from "./http.mts";

interface BobworkMetadata {
  baseUrl?: string;
  accountsPath?: string;
  authHeader?: string;
  authScheme?: string;
  documentationUrl?: string;
}

export async function fetchBobworkAccounts(credentialId: string): Promise<{
  records: unknown[];
  sourceUrl: string;
  documentationUrl: string;
  observedAt: string;
}> {
  const credential = await readCredential(credentialId);
  if (credential.kind !== "bobwork") {
    throw new HttpError(409, "wrong_credential_kind", "La clé n’est pas une clé BobWork.");
  }
  const metadata = credential.metadata as BobworkMetadata;
  if (!metadata.baseUrl || !metadata.accountsPath || !metadata.documentationUrl) {
    throw new HttpError(
      409,
      "bobwork_contract_unconfigured",
      "Le contrat API BobWork doit être documenté dans la configuration avant toute synchronisation.",
    );
  }
  const baseUrl = new URL(metadata.baseUrl);
  if (baseUrl.protocol !== "https:") {
    throw new HttpError(422, "bobwork_insecure_url", "L’API BobWork doit utiliser HTTPS.");
  }
  const endpoint = new URL(metadata.accountsPath, baseUrl);
  if (endpoint.origin !== baseUrl.origin) {
    throw new HttpError(422, "bobwork_cross_origin_path", "Le chemin BobWork doit rester sur l’origine documentée.");
  }
  const header = metadata.authHeader ?? "authorization";
  const scheme = metadata.authScheme ?? "Bearer";
  const response = await fetch(endpoint, {
    headers: { accept: "application/json", [header]: `${scheme} ${credential.secret}`.trim() },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new HttpError(502, "bobwork_upstream_error", `BobWork a répondu avec le statut ${response.status}.`);
  }
  const body = (await response.json()) as unknown;
  const records = Array.isArray(body)
    ? body
    : body && typeof body === "object" && "data" in body && Array.isArray((body as { data: unknown }).data)
      ? (body as { data: unknown[] }).data
      : [];
  return {
    records,
    sourceUrl: endpoint.toString(),
    documentationUrl: metadata.documentationUrl,
    observedAt: new Date().toISOString(),
  };
}
