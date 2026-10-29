import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardData } from "../../types";
import { useAppData } from "../useAppData";
const mocks = vi.hoisted(() => ({ dashboard: vi.fn() }));
vi.mock("../../lib/api", () => ({ api: mocks }));
const data = (version: number) => ({ settings: { vaultConfigured: true }, version }) as unknown as DashboardData;
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

describe("dashboard refresh", () => {
  it("updates periodically and on focus, then stops after unmount", async () => {
    vi.useFakeTimers(); mocks.dashboard.mockResolvedValue(data(1));
    const view = renderHook(() => useAppData(true));
    await act(async () => {});
    expect(mocks.dashboard).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(mocks.dashboard).toHaveBeenCalledTimes(2);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(mocks.dashboard).toHaveBeenCalledTimes(3);
    view.unmount();
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(mocks.dashboard).toHaveBeenCalledTimes(3);
  });

  it("never lets a late request replace a newer dashboard", async () => {
    let oldResolve!: (value: DashboardData) => void;
    mocks.dashboard.mockImplementationOnce(() => new Promise<DashboardData>((resolve) => { oldResolve = resolve; }));
    const view = renderHook(() => useAppData(true));
    mocks.dashboard.mockResolvedValue(data(2));
    await act(async () => { await view.result.current.refresh(); });
    expect(view.result.current.data).toEqual(data(2));
    await act(async () => { oldResolve(data(1)); });
    expect(view.result.current.data).toEqual(data(2));
  });
});
