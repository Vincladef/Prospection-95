import { readingStream, READING_PIXEL } from "../lib/reading-stream.mts";

declare const Netlify: { env: { get(name: string): string | undefined } };
interface ReadingContext { params: { token?: string }; waitUntil(promise: Promise<unknown>): void }

const headers = {
  "content-type": "image/gif", "cache-control": "private, no-store, max-age=0, no-transform",
  "pragma": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
};

export default async function trackReading(request: Request, context: ReadingContext): Promise<Response> {
  const secret = Netlify.env.get("READING_EDGE_SECRET");
  const token = context.params.token ?? "";
  const pixel = () => new Response(READING_PIXEL, { headers });
  if (!secret || token.length > 12_000 || request.method !== "GET") return pixel();
  const endpoint = new URL("/internal/reading-session", request.url);
  const submit = (body: object) => fetch(endpoint, {
    method: "POST", headers: { "x-reading-key": secret, "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8_000),
  });
  try {
    const response = await submit({ action: "start", token, userAgent: request.headers.get("user-agent") });
    if (!response.ok) return pixel();
    const session = await response.json() as { stream?: boolean; id?: string };
    if (!session.stream || !session.id) return pixel();
    let complete: () => void = () => {};
    const completed = new Promise<void>(resolve => { complete = resolve; });
    context.waitUntil(completed);
    const stream = readingStream({ signal: request.signal, onFinish: result => {
      // Exactly one final request, including when several abort/cancel signals
      // race. A missing final report remains unusable, never a fabricated zero.
      void submit({ action: "finish", id: session.id, end: result.end, elapsedMs: result.elapsedMs })
        .catch(() => undefined).finally(complete);
    } });
    return new Response(stream, { headers });
  } catch { return pixel(); }
}

export const config = { path: "/t/r/:token", method: "GET" };
