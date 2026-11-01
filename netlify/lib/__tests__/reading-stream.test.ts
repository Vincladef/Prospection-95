import { afterEach, describe, expect, it, vi } from "vitest";
import { readingClient, readingStream, READING_PIXEL } from "../reading-stream.mts";

afterEach(() => vi.useRealTimers());

describe("bounded reading connection", () => {
  it("records a cancellation once, rounded to one second", async () => {
    vi.useFakeTimers();
    const ac = new AbortController(), onFinish = vi.fn();
    const stream = readingStream({ signal: ac.signal, onFinish, now: () => Date.now() });
    const reader = stream.getReader();
    expect((await reader.read()).value).toEqual(READING_PIXEL.slice(0, -1));
    await vi.advanceTimersByTimeAsync(7_400);
    await reader.cancel(); ac.abort();
    expect(onFinish).toHaveBeenCalledExactlyOnceWith({ end: "disconnected", elapsedMs: 7_400, seconds: 7 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps one small valid image at 50 seconds without confusing completion and cancellation", async () => {
    vi.useFakeTimers();
    const ac = new AbortController(), onFinish = vi.fn();
    const reader = readingStream({ signal: ac.signal, onFinish, now: () => Date.now() }).getReader();
    const chunks: Uint8Array[] = [];
    const consumed = (async () => { while (true) { const chunk = await reader.read(); if (chunk.done) break; chunks.push(chunk.value); } })();
    await vi.advanceTimersByTimeAsync(50_000); await consumed; ac.abort();
    expect(onFinish).toHaveBeenCalledExactlyOnceWith({ end: "capped", elapsedMs: 50_000, seconds: 50 });
    expect(chunks.reduce((n, chunk) => n + chunk.length, 0)).toBeLessThan(400);
    expect(chunks.at(-1)).toEqual(new Uint8Array([0x3b]));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not infer a human reader from a generic browser or privacy proxy", () => {
    expect(readingClient("Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15")).toBe("unverified");
    expect(readingClient("Mozilla/5.0 Thunderbird/128.0")).toBe("thunderbird");
    expect(readingClient("GoogleImageProxy Thunderbird/128.0")).toBe("proxy");
    expect(readingClient("Proofpoint scanner")).toBe("automated");
  });
});
