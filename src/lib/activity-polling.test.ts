import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pollWhileActive } from "./activity-polling";

describe("activity-aware polling", () => {
  let stop: (() => void) | undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-19T08:00:00Z"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });
  afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); });
  it("keeps the current cadence during interaction, then stops an abandoned visible tab", () => {
    const refresh = vi.fn();
    stop = pollWhileActive(refresh, 30_000);
    vi.advanceTimersByTime(90_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    window.dispatchEvent(new Event("pointerdown"));
    vi.advanceTimersByTime(30_000);
    expect(refresh).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(180_000);
    const calls = refresh.mock.calls.length;
    vi.advanceTimersByTime(600_000);
    expect(refresh).toHaveBeenCalledTimes(calls);
  });
  it("refreshes on return and coalesces focus and visibility events", () => {
    const refresh = vi.fn();
    stop = pollWhileActive(refresh, 15_000);
    vi.advanceTimersByTime(180_000);
    refresh.mockClear();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(15_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it("does not poll a hidden tab and refreshes immediately when it becomes visible", () => {
    const refresh = vi.fn();
    stop = pollWhileActive(refresh, 30_000);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    vi.advanceTimersByTime(300_000);
    expect(refresh).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it("resumes on interaction without reloading the page and cleans up all listeners", () => {
    const refresh = vi.fn();
    stop = pollWhileActive(refresh, 30_000);
    vi.advanceTimersByTime(180_000);
    refresh.mockClear();
    window.dispatchEvent(new Event("keydown"));
    expect(refresh).toHaveBeenCalledTimes(1);
    stop(); stop = undefined;
    vi.advanceTimersByTime(300_000);
    window.dispatchEvent(new Event("focus"));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
