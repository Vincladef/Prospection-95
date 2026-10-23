import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { env } from "./env.mts";
import { sqlOne } from "./db.mts";

const TOKEN_VERSION = 1 as const;
const TOKEN_TTL_SECONDS = 400 * 24 * 60 * 60;
const TRACKING_KEY_STORE = "prospection95-tracking-keys";
const TRACKING_KEY_NAME = "signed-interactions-v1";
const TRACKING_KEY_REGION = "eu-central-1";

export type TrackingKind = "open" | "click";

export interface TrackingTokenPayload {
  v: typeof TOKEN_VERSION;
  k: TrackingKind;
  m: string;
  e: number;
  u?: string;
}

interface PreparedMessage {
  text: string;
  html: string | null;
}

type TokenSigner = (payload: TrackingTokenPayload) => Promise<string>;

let signingKeyPromise: Promise<Buffer> | undefined;

function trackingKeyStore() {
  return getStore({
    name: TRACKING_KEY_STORE,
    consistency: "strong",
    region: TRACKING_KEY_REGION,
  });
}

async function loadOrCreateSigningKey(): Promise<Buffer> {
  const configured = env("TRACKING_SIGNING_KEY")?.trim();
  if (configured) {
    const decoded = Buffer.from(configured, "base64");
    if (decoded.byteLength !== 32) throw new Error("TRACKING_SIGNING_KEY must decode to exactly 32 bytes");
    return decoded;
  }

  const store = trackingKeyStore();
  let encoded = await store.get(TRACKING_KEY_NAME, { consistency: "strong", type: "text" });
  if (!encoded) {
    const generated = randomBytes(32).toString("base64");
    await store.set(TRACKING_KEY_NAME, generated, {
      onlyIfNew: true,
      metadata: {
        algorithm: "HMAC-SHA-256",
        createdAt: new Date().toISOString(),
        purpose: "prospection95-signed-interaction-tracking",
      },
    });
    encoded = await store.get(TRACKING_KEY_NAME, { consistency: "strong", type: "text" });
  }
  if (!encoded) throw new Error("Tracking signing key initialization failed");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.byteLength !== 32) throw new Error("Tracking signing key must decode to exactly 32 bytes");
  return decoded;
}

async function signingKey(): Promise<Buffer> {
  signingKeyPromise ??= loadOrCreateSigningKey();
  return signingKeyPromise;
}

function base64urlJson(payload: TrackingTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function tokenSignature(body: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(body, "utf8").digest();
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 8_000) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function encodeTrackingToken(payload: TrackingTokenPayload, key: Buffer): string {
  const body = base64urlJson(payload);
  return `${body}.${tokenSignature(body, key).toString("base64url")}`;
}

export function decodeTrackingToken(token: string, key: Buffer, nowSeconds = Math.floor(Date.now() / 1_000)): TrackingTokenPayload | null {
  const [body, encodedSignature, extra] = token.split(".");
  if (!body || !encodedSignature || extra || token.length > 12_000) return null;
  let received: Buffer;
  try {
    received = Buffer.from(encodedSignature, "base64url");
  } catch {
    return null;
  }
  const expected = tokenSignature(body, key);
  if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) return null;
  try {
    const candidate = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<TrackingTokenPayload>;
    if (candidate.v !== TOKEN_VERSION || !["open", "click"].includes(candidate.k ?? "") || !isUuid(candidate.m)) return null;
    if (!Number.isSafeInteger(candidate.e) || Number(candidate.e) < nowSeconds) return null;
    if (candidate.k === "click" && !safeHttpUrl(candidate.u)) return null;
    if (candidate.k === "open" && candidate.u !== undefined) return null;
    return candidate as TrackingTokenPayload;
  } catch {
    return null;
  }
}

export async function signTrackingToken(payload: TrackingTokenPayload): Promise<string> {
  return encodeTrackingToken(payload, await signingKey());
}

export async function verifyTrackingToken(token: string): Promise<TrackingTokenPayload | null> {
  return decodeTrackingToken(token, await signingKey());
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function stripTrailingPunctuation(value: string): { url: string; suffix: string } {
  const match = value.match(/[.,;:!?]+$/);
  if (!match) return { url: value, suffix: "" };
  return { url: value.slice(0, -match[0].length), suffix: match[0] };
}

async function trackedClickUrl(baseUrl: string, messageId: string, destination: string, signer: TokenSigner, expiresAt: number): Promise<string> {
  const token = await signer({ v: TOKEN_VERSION, k: "click", m: messageId, e: expiresAt, u: destination });
  return `${baseUrl}/t/c/${encodeURIComponent(token)}`;
}

async function linkifyPlainText(text: string, baseUrl: string, messageId: string, signer: TokenSigner, expiresAt: number, clicksEnabled: boolean): Promise<string> {
  const pattern = /https?:\/\/[^\s<>"']+/gi;
  let html = "";
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    html += escapeHtml(text.slice(cursor, start));
    const { url, suffix } = stripTrailingPunctuation(match[0]);
    const normalized = safeHttpUrl(url);
    if (normalized) {
      const href = clicksEnabled
        ? await trackedClickUrl(baseUrl, messageId, normalized, signer, expiresAt)
        : normalized;
      html += `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>${escapeHtml(suffix)}`;
    } else {
      html += escapeHtml(match[0]);
    }
    cursor = start + match[0].length;
  }
  html += escapeHtml(text.slice(cursor));
  return html.replace(/\r?\n/g, "<br>\n");
}

async function rewriteHtmlLinks(html: string, baseUrl: string, messageId: string, signer: TokenSigner, expiresAt: number): Promise<string> {
  const pattern = /\bhref\s*=\s*(["'])(https?:\/\/[^"'<>\s]+)\1/gi;
  let rewritten = "";
  let cursor = 0;
  for (const match of html.matchAll(pattern)) {
    const start = match.index ?? 0;
    rewritten += html.slice(cursor, start);
    const destination = safeHttpUrl(match[2]);
    if (!destination) rewritten += match[0];
    else {
      const href = await trackedClickUrl(baseUrl, messageId, destination, signer, expiresAt);
      rewritten += `href=${match[1]}${escapeHtml(href)}${match[1]}`;
    }
    cursor = start + match[0].length;
  }
  return rewritten + html.slice(cursor);
}

export async function prepareTrackedMessage(input: {
  messageId: string;
  text: string;
  html: string | null;
  opensEnabled: boolean;
  clicksEnabled: boolean;
  baseUrl: string;
  now?: Date;
  signer?: TokenSigner;
}): Promise<PreparedMessage> {
  if (!input.opensEnabled && !input.clicksEnabled) return { text: input.text, html: input.html };
  if (!isUuid(input.messageId)) throw new Error("Tracking requires a UUID message id");
  const parsedBase = safeHttpUrl(input.baseUrl);
  if (!parsedBase) throw new Error("Tracking requires an HTTP(S) application URL");
  const baseUrl = parsedBase.replace(/\/$/, "");
  const signer = input.signer ?? signTrackingToken;
  const now = input.now ?? new Date();
  const expiresAt = Math.floor(now.getTime() / 1_000) + TOKEN_TTL_SECONDS;
  let html = input.html
    ? (input.clicksEnabled ? await rewriteHtmlLinks(input.html, baseUrl, input.messageId, signer, expiresAt) : input.html)
    : await linkifyPlainText(input.text, baseUrl, input.messageId, signer, expiresAt, input.clicksEnabled);
  if (input.opensEnabled) {
    const token = await signer({ v: TOKEN_VERSION, k: "open", m: input.messageId, e: expiresAt });
    html += `<img src="${baseUrl}/t/o/${encodeURIComponent(token)}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0" referrerpolicy="no-referrer">`;
  }
  return { text: input.text, html };
}

function userAgentClass(userAgent: string | null): "automated" | "proxy" | "browser" | "unknown" {
  if (!userAgent) return "unknown";
  if (/googleimageproxy|imageproxy|proxy/i.test(userAgent)) return "proxy";
  if (/bot|crawler|spider|preview|scanner|headless|proofpoint|barracuda|mimecast|safelinks/i.test(userAgent)) return "automated";
  if (/mozilla|chrome|safari|firefox|edge/i.test(userAgent)) return "browser";
  return "unknown";
}

export async function recordInteraction(input: {
  token: string;
  payload: TrackingTokenPayload;
  userAgent: string | null;
}): Promise<boolean> {
  const tokenFingerprint = createHash("sha256").update(input.token, "utf8").digest("hex");
  const agentClass = userAgentClass(input.userAgent);
  const destination = input.payload.k === "click" ? safeHttpUrl(input.payload.u) : null;
  const linkHost = destination ? new URL(destination).hostname.toLowerCase() : null;
  const confidence = input.payload.k === "open" || agentClass === "automated" || agentClass === "proxy" ? "noisy" : agentClass === "browser" ? "probable" : "unknown";
  const source = input.payload.k === "open" ? "signed_open_pixel" : "signed_click_redirect";
  const scannerLikelihood = confidence === "noisy" ? 1 : confidence === "probable" ? 0.2 : null;
  const row = await sqlOne<{ recorded: boolean }>(
    `with message_context as (
       select m.id as message_id, conv.campaign_id, conv.prospect_id,
              a.experiment_id, a.variant_id, a.id as assignment_id,
              case when $2 = 'open' then c.tracking_opens_enabled else c.tracking_clicks_enabled end as enabled
       from app.email_messages m
       join app.conversations conv on conv.id = m.conversation_id
       join app.campaigns c on c.id = conv.campaign_id
       left join app.experiment_assignments a on a.id = conv.experiment_assignment_id
       where m.id = $1::uuid and m.direction = 'outbound'
     ), observed as (
       insert into app.tracking_events
         (message_id, event_type, observed_at, scanner_likelihood, counted,
          request_fingerprint, idempotency_key, last_observed_at, metadata)
       select message_id, $2, clock_timestamp(), $8, true, $3,
              'tracking:' || $2 || ':' || $3, clock_timestamp(),
              jsonb_build_object(
                'confidence', $4::text,
                'source', $5::text,
                'linkHost', $6::text,
                'userAgentClass', $7::text
              )
       from message_context where enabled
       on conflict (idempotency_key) do update set
         last_observed_at = clock_timestamp(),
         observation_count = app.tracking_events.observation_count + 1,
         scanner_likelihood = least(app.tracking_events.scanner_likelihood, excluded.scanner_likelihood),
         metadata = app.tracking_events.metadata || excluded.metadata
       returning message_id
     ), experiment_observation as (
       insert into app.experiment_events
         (experiment_id, variant_id, assignment_id, prospect_id, message_id,
          event_type, event_at, measured, confidence, source, idempotency_key, metadata)
       select context.experiment_id, context.variant_id, context.assignment_id, context.prospect_id,
              context.message_id, $2, clock_timestamp(), true, $4, $5,
              'tracking:' || $2 || ':' || $3,
              jsonb_build_object('userAgentClass', $7::text, 'linkHost', $6::text)
       from message_context context
       join observed on observed.message_id = context.message_id
       where context.assignment_id is not null
       on conflict (idempotency_key) do nothing
       returning id
     )
     select exists(select 1 from observed) as recorded`,
    [input.payload.m, input.payload.k, tokenFingerprint, confidence, source, linkHost, agentClass, scannerLikelihood],
  );
  return Boolean(row?.recorded);
}

export function trackingBaseUrl(): string {
  const value = env("URL") ?? env("DEPLOY_PRIME_URL");
  if (!value || !safeHttpUrl(value)) throw new Error("Netlify application URL is unavailable for tracking");
  return value.replace(/\/$/, "");
}
