import { ZodError, type ZodType } from "zod";
import { env } from "./env.mts";

const API_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, max-age=0",
  pragma: "no-cache",
  vary: "Authorization",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...API_HEADERS, ...Object.fromEntries(new Headers(headers)) },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: API_HEADERS });
}

export async function parseJson<T>(
  request: Request,
  schema: ZodType<T>,
  maxBytes = 1_000_000,
): Promise<T> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpError(413, "payload_too_large", "Le corps de la requête est trop volumineux.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new HttpError(413, "payload_too_large", "Le corps de la requête est trop volumineux.");
  }
  let value: unknown;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "invalid_json", "Le corps JSON est invalide.");
  }
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new HttpError(422, "validation_error", "Les données reçues sont invalides.", error.issues);
    }
    throw error;
  }
}

export function assertMutationOrigin(request: Request): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const origin = request.headers.get("origin");
  if (!origin) return;
  const expected = (env("APP_BASE_URL") ?? new URL(request.url).origin).replace(/\/$/, "");
  const isLocal = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin);
  if (origin.replace(/\/$/, "") !== expected && !isLocal) {
    throw new HttpError(403, "origin_forbidden", "Origine de requête refusée.");
  }
}

export function handleError(error: unknown, requestId?: string): Response {
  if (error instanceof HttpError) {
    return json(
      { error: error.code, message: error.message, details: error.details, requestId },
      error.status,
    );
  }
  const pg = error as { code?: string; constraint?: string };
  if (pg?.code === "23505") {
    return json(
      { error: "conflict", message: "Cette opération existe déjà.", requestId },
      409,
    );
  }
  if (pg?.code === "23503" || pg?.code === "23514") {
    return json(
      { error: "integrity_error", message: "L’opération viole une règle d’intégrité.", requestId },
      409,
    );
  }
  console.error("api_error", { requestId, name: (error as Error)?.name });
  return json(
    { error: "internal_error", message: "Erreur interne.", requestId },
    500,
  );
}
