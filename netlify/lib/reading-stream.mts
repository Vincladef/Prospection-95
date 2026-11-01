// A single, progressively delivered GIF. No client-side code, cookies or
// second-by-second requests. Connection duration is not proof of human reading.
export const READING_LIMIT_SECONDS = 50;
export const READING_TICK_MS = 1_000;
export const READING_PIXEL = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), c => c.charCodeAt(0));

export type ReadingEnd = "disconnected" | "capped" | "transport_error";
export interface ReadingResult { end: ReadingEnd; elapsedMs: number; seconds: number }

export function readingStream(input: {
  signal: AbortSignal;
  onFinish: (result: ReadingResult) => void;
  now?: () => number;
}): ReadableStream<Uint8Array> {
  const now = input.now ?? (() => performance.now());
  const started = now();
  let settled = false;
  let interval: ReturnType<typeof setInterval>;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const finish = (end: ReadingEnd) => {
    if (settled) return;
    settled = true;
    clearInterval(interval);
    input.signal.removeEventListener("abort", abort);
    const elapsedMs = Math.min(READING_LIMIT_SECONDS * 1_000, Math.max(0, Math.round(now() - started)));
    input.onFinish({ end, elapsedMs, seconds: Math.min(READING_LIMIT_SECONDS, Math.round(elapsedMs / 1_000)) });
  };
  const abort = () => {
    finish("disconnected");
    try { controller.close(); } catch { /* The response may already be cancelled. */ }
  };
  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      controller.enqueue(READING_PIXEL.slice(0, -1));
      interval = setInterval(() => {
        if (settled) return;
        try {
          if (now() - started >= READING_LIMIT_SECONDS * 1_000) {
            // Mark the server limit before close: Deno may also signal abort
            // when a response finishes normally.
            finish("capped");
            controller.enqueue(new Uint8Array([0x3b]));
            controller.close();
          } else {
            // A valid GIF comment keeps the same image request alive.
            controller.enqueue(new Uint8Array([0x21, 0xfe, 0x01, 0x20, 0x00]));
          }
        } catch { finish("transport_error"); }
      }, READING_TICK_MS);
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
    },
    cancel() { finish("disconnected"); },
  });
}

export type ReadingClient = "thunderbird" | "outlook_desktop" | "proxy" | "automated" | "unverified";
export function readingClient(userAgent: string | null): ReadingClient {
  if (!userAgent) return "unverified";
  if (/googleimageproxy|imageproxy|proxy/i.test(userAgent)) return "proxy";
  if (/bot|crawler|spider|preview|scanner|headless|proofpoint|barracuda|mimecast|safelinks/i.test(userAgent)) return "automated";
  if (/Thunderbird\/\d/i.test(userAgent)) return "thunderbird";
  if (/Microsoft Office\/.*Microsoft Outlook/i.test(userAgent)) return "outlook_desktop";
  // In particular, generic Safari/Mozilla UAs can belong to Apple MPP.
  // Never promote them to a direct human session from their UA alone.
  return "unverified";
}
