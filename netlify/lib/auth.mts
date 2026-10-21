import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { env, requireEnv } from "./env.mts";
import { HttpError, assertMutationOrigin } from "./http.mts";

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksUrl: string | undefined;

export interface AdminIdentity {
  subject: string;
  email: string;
  name?: string;
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) throw new HttpError(401, "unauthorized", "Authentification requise.");
  return match[1];
}

function emailFromPayload(payload: JWTPayload): string | null {
  if (typeof payload.email === "string") return payload.email;
  if (typeof payload.email_address === "string") return payload.email_address;
  if (payload.user && typeof payload.user === "object" && "email" in payload.user) {
    const candidate = (payload.user as { email?: unknown }).email;
    if (typeof candidate === "string") return candidate;
  }
  return null;
}

function allowedEmails(): Set<string> {
  return new Set(
    requireEnv("ADMIN_EMAIL")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function requireAdmin(request: Request): Promise<AdminIdentity> {
  assertMutationOrigin(request);
  const token = bearer(request);
  const url = requireEnv("NEON_AUTH_JWKS_URL");
  if (new URL(url).protocol !== "https:" && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\//i.test(url)) {
    throw new Error("NEON_AUTH_JWKS_URL must use HTTPS");
  }
  if (!jwks || jwksUrl !== url) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksUrl = url;
  }
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, jwks, {
      algorithms: ["EdDSA"],
      clockTolerance: 10,
      issuer: env("NEON_AUTH_ISSUER") || undefined,
      audience: env("NEON_AUTH_AUDIENCE") || undefined,
    });
    payload = verified.payload;
  } catch {
    throw new HttpError(401, "invalid_token", "Session invalide ou expirée.");
  }
  const email = emailFromPayload(payload)?.trim().toLowerCase();
  if (!email || !allowedEmails().has(email)) {
    throw new HttpError(403, "forbidden", "Ce compte n’est pas autorisé.");
  }
  if (!payload.sub) throw new HttpError(401, "invalid_token", "Jeton sans identité.");
  return {
    subject: payload.sub,
    email,
    name: typeof payload.name === "string" ? payload.name : undefined,
  };
}

export function isProductionOutboundEnabled(): boolean {
  return /^(?:1|true|yes|on)$/i.test(env("OUTBOUND_ENABLED", "false")!);
}
