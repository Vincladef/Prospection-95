import type { Context } from "@netlify/functions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(), randomInt: vi.fn(), delay: vi.fn(), sqlOne: vi.fn(),
  sqlQuery: vi.fn(), send: vi.fn(),
}));
vi.mock("node:crypto", () => ({ randomUUID: () => "test-worker", randomInt: mocks.randomInt }));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));
vi.mock("../auth.mts", () => ({ isProductionOutboundEnabled: mocks.enabled }));
vi.mock("../db.mts", () => ({ sqlOne: mocks.sqlOne, sqlQuery: mocks.sqlQuery }));
vi.mock("../gmail.mts", () => ({ sendGmailMessage: mocks.send }));
vi.mock("../tracking.mts", () => ({ prepareTrackedMessage: vi.fn(), trackingBaseUrl: vi.fn() }));

import dispatch, { config } from "../../functions/dispatch-outbox.mts";
const run = () => dispatch(new Request("https://example.test"), {} as Context);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.delay.mockResolvedValue(undefined);
  mocks.sqlOne.mockResolvedValue(null);
});

describe("random outbound pacing", () => {
  it("checks every minute and keeps the outbound switch authoritative", async () => {
    expect(config.schedule).toBe("* * * * *");
    mocks.enabled.mockReturnValue(false);
    expect(await (await run()).json()).toMatchObject({ skipped: "outbound_disabled" });
    expect(mocks.randomInt).not.toHaveBeenCalled();
    expect(mocks.sqlOne).not.toHaveBeenCalled();
  });

  it("skips four lottery outcomes without reserving or changing any message", async () => {
    for (const outcome of [1, 2, 3, 4]) {
      mocks.randomInt.mockReturnValue(outcome);
      expect(await (await run()).json()).toMatchObject({ ok: true, skipped: "random_pacing" });
    }
    expect(mocks.randomInt).toHaveBeenCalledWith(5);
    expect(mocks.delay).not.toHaveBeenCalled();
    expect(mocks.sqlOne).not.toHaveBeenCalled();
    expect(mocks.sqlQuery).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it.each([0, 3_000])("waits %i ms before scheduling and taking a guarded lease", async (jitter) => {
    mocks.randomInt.mockReturnValueOnce(0).mockReturnValueOnce(jitter);
    let release!: () => void;
    mocks.delay.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const pending = run();
    expect(mocks.delay).toHaveBeenCalledWith(jitter);
    expect(mocks.randomInt).toHaveBeenNthCalledWith(2, 3_001);
    expect(mocks.sqlOne).not.toHaveBeenCalled();
    release();
    expect(await (await pending).json()).toMatchObject({ ok: true, leased: 0 });
    expect(mocks.sqlOne.mock.calls[0][0]).toContain("app.schedule_due_messages(50)");
    expect(mocks.sqlOne.mock.calls[1][0]).toContain("app.lease_outbox_jobs($1, 1, 40)");
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
