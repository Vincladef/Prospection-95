import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkerGovernor, IDLE_CHECK_MS } from "./worker-idle.mts";

describe("worker sleep hints", () => {
  const start = Date.parse("2026-11-19T08:00:00Z");
  afterEach(() => vi.restoreAllMocks());
  function fixture() {
    let time = start;
    const records = new Map<string, unknown>();
    const storage = {
      get: vi.fn(async (key: string) => records.get(key) ?? null),
      setJSON: vi.fn(async (key: string, value: unknown) => { records.set(key, value); }),
    };
    return { records, storage, governor: createWorkerGovernor(() => storage, () => time),
      advance: (ms: number) => { time += ms; } };
  }
  it("runs a cold worker, then avoids SQL wakeups until a shared quarter-hour boundary", async () => {
    const f = fixture();
    expect(await f.governor.shouldRun("dispatch")).toBe(true);
    await f.governor.rest("dispatch");
    for (let minute = 1; minute < 15; minute++) {
      f.advance(60_000);
      expect(await f.governor.shouldRun("dispatch")).toBe(false);
    }
    f.advance(60_000);
    expect(await f.governor.shouldRun("dispatch")).toBe(true);
  });
  it("wakes immediately on authenticated activity even if an idle hint was written afterwards", async () => {
    const f = fixture();
    await f.governor.noteActivity();
    await f.governor.rest("unified");
    expect(await f.governor.shouldRun("unified")).toBe(true);
    f.advance(180_000);
    expect(await f.governor.shouldRun("unified")).toBe(false);
  });
  it("keeps a backlog responsive without waking unrelated workers", async () => {
    const f = fixture();
    await f.governor.rest("mailboxes");
    await f.governor.keepActive("unified");
    expect(await f.governor.shouldRun("unified")).toBe(true);
    expect(await f.governor.shouldRun("mailboxes")).toBe(false);
  });
  it("fails open on missing, malformed, future or excessively long hints", async () => {
    const f = fixture();
    for (const value of [null, {}, { kind: "quiet", at: start + 1, until: start + 90_000 },
      { kind: "quiet", at: start, until: start + IDLE_CHECK_MS * 2 }]) {
      f.records.set("drafts", value);
      expect(await f.governor.shouldRun("drafts")).toBe(true);
    }
    f.storage.get.mockRejectedValueOnce(new Error("unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await f.governor.shouldRun("drafts")).toBe(true);
  });
  it("backs off a quota failure without changing business settings, then retries automatically", async () => {
    const f = fixture();
    await f.governor.quotaFailure("dispatch", new Error("Your account or project has exceeded the quota."));
    await f.governor.noteActivity();
    expect(await f.governor.shouldRun("dispatch")).toBe(false);
    f.advance(IDLE_CHECK_MS);
    expect(await f.governor.shouldRun("dispatch")).toBe(true);
  });
  it("does not treat an unrelated error as a quota suspension", async () => {
    const f = fixture();
    await f.governor.quotaFailure("dispatch", new Error("transient"));
    expect(f.storage.setJSON).not.toHaveBeenCalled();
  });
  it("groups idle probes instead of waking the database once per minute", async () => {
    const f = fixture();
    let probes = 0;
    for (let minute = 0; minute < 60; minute++) {
      for (const worker of ["dispatch", "mailboxes", "unified", "drafts"] as const) {
        if (await f.governor.shouldRun(worker)) { probes++; await f.governor.rest(worker); }
      }
      f.advance(60_000);
    }
    expect(probes).toBe(16); // Four shared wakes/hour, four worker probes at each wake.
  });
});
