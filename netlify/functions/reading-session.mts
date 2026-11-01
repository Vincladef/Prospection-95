import { timingSafeEqual } from "node:crypto";
import type { Config } from "@netlify/functions";
import { sqlOne } from "../lib/db.mts";
import { env } from "../lib/env.mts";
import { readingClient, interactionContext } from "../lib/reading-stream.mts";
import { recordInteraction, verifyTrackingToken } from "../lib/tracking.mts";

// The public image never receives this secret or the session id. Only our edge
// handler can submit results; possessing an email pixel cannot forge a duration.
export default async function readingSession(request: Request): Promise<Response> {
  const expected = env("READING_EDGE_SECRET");
  const received = request.headers.get("x-reading-key") ?? "";
  if (!expected || Buffer.byteLength(received) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(received), Buffer.from(expected))) {
    return new Response(null, { status: 404 });
  }
  const raw = await request.text();
  if (raw.length > 16_000) return new Response(null, { status: 400 });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return new Response(null, { status: 400 }); }
  if (!body || typeof body !== "object") return new Response(null, { status: 400 });
  const headers = { "cache-control": "private, no-store" };
  if (body.action === "start" && typeof body.token === "string" && body.token.length <= 12_000) {
    const payload = await verifyTrackingToken(body.token).catch(() => null);
    if (payload?.k !== "open") return Response.json({ stream: false }, { headers });
    const userAgent = typeof body.userAgent === "string" ? body.userAgent.slice(0, 2_000) : null;
    await recordInteraction({ token: body.token, payload, userAgent });
    const context=interactionContext(userAgent);
    const row = await sqlOne<{ result: { stream: boolean; id?: string } }>(
      "select app.begin_reading_session_v2($1::uuid,$2,$3,$4,$5::boolean) as result", [payload.m, readingClient(userAgent),context.provider,context.transport,context.automated],
    );
    return Response.json(row?.result ?? { stream: false }, { headers });
  }
  if (body.action === "finish" && typeof body.id === "string" && /^[0-9a-f-]{36}$/i.test(body.id)
    && ["disconnected", "capped", "transport_error"].includes(String(body.end))
    && Number.isSafeInteger(body.elapsedMs) && Number(body.elapsedMs) >= 0 && Number(body.elapsedMs) <= 50_000) {
    const row = await sqlOne<{ recorded: boolean }>("select app.finish_reading_session($1::uuid,$2,$3::integer) as recorded", [body.id, body.end, body.elapsedMs]);
    return Response.json({ recorded: row?.recorded ?? false }, { headers });
  }
  return new Response(null, { status: 400 });
}

export const config: Config = { path: "/internal/reading-session", method: "POST" };
