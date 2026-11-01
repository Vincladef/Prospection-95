import type { Context } from "@netlify/functions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(), randomInt: vi.fn(), delay: vi.fn(), sqlOne: vi.fn(),
  sqlQuery: vi.fn(), send: vi.fn(), refresh: vi.fn(),prepare:vi.fn(),
}));
vi.mock("node:crypto", () => ({ randomUUID: () => "test-worker", randomInt: mocks.randomInt }));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));
vi.mock("../auth.mts", () => ({ isProductionOutboundEnabled: mocks.enabled }));
vi.mock("../db.mts", () => ({ sqlOne: mocks.sqlOne, sqlQuery: mocks.sqlQuery }));
vi.mock("../gmail.mts", () => ({ sendGmailMessage: mocks.send }));
vi.mock("../tracking.mts", () => ({ prepareTrackedMessage: mocks.prepare, trackingBaseUrl: vi.fn() }));
vi.mock("../mailbox-sync.mts", () => ({refreshConversation:mocks.refresh}));

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
    expect(mocks.sqlOne.mock.calls[1][0]).toContain("app.lease_outbox_jobs($1, 1, 180)");
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

const leased = { id:"job",lease_token:"lease",job_kind:"prospection",step:"R1",conversation_id:"conversation",
  attempt_count:1,max_attempts:5,message_id:"message",from_address:"sender@example.test",to_addresses:["contact@example.test"],
  subject:"Re: proposition",body_text:"Relance",body_html:null,credential_id:"credential",references_header:[],
  tracking_opens_enabled:false,tracking_clicks_enabled:false };

it("defers an unverified follow-up without exhausting retries or calling SMTP", async () => {
  mocks.randomInt.mockReturnValue(0);
  mocks.sqlOne.mockResolvedValueOnce({count:0}).mockResolvedValueOnce(leased);
  mocks.refresh.mockRejectedValue(new Error("Gmail unavailable"));
  expect(await (await run()).json()).toMatchObject({state:"deferred",code:"mailbox_check_failed"});
  expect(mocks.refresh).toHaveBeenCalledWith("conversation");
  expect(mocks.sqlQuery.mock.calls[0][0]).toContain("attempt_count=greatest(0,attempt_count-1)");
  expect(mocks.sqlOne.mock.calls.some(([s])=>s.includes("app.start_outbox_attempt"))).toBe(false);
  expect(mocks.send).not.toHaveBeenCalled();
});
it("never starts SMTP when a late reply cancels the lease during Gmail refresh", async () => {
  mocks.randomInt.mockReturnValue(0);
  mocks.sqlOne.mockResolvedValueOnce({count:0}).mockResolvedValueOnce(leased).mockResolvedValueOnce(null);
  mocks.refresh.mockResolvedValue(undefined);
  expect(await (await run()).json()).toMatchObject({state:"cancelled"});
  expect(mocks.send).not.toHaveBeenCalled();
});
it("sends only after the complete Gmail check and the final database gate", async () => {
  mocks.randomInt.mockReturnValue(0);
  mocks.refresh.mockResolvedValue(undefined);
  mocks.prepare.mockResolvedValue({text:"Relance",html:null});
  mocks.sqlOne.mockResolvedValueOnce({count:0}).mockResolvedValueOnce(leased).mockResolvedValueOnce({id:"job"})
    .mockResolvedValueOnce({id:"job",status:"running"}).mockResolvedValueOnce({internet_message_id:"<persisted@test>",in_reply_to:null,references_header:[]});
  mocks.send.mockResolvedValue({state:"accepted",response:"250 OK"});
  expect(await (await run()).json()).toMatchObject({state:"accepted"});
  expect(mocks.refresh.mock.invocationCallOrder[0]).toBeLessThan(mocks.send.mock.invocationCallOrder[0]);
  expect(mocks.sqlOne.mock.calls[3][0]).toContain("app.start_outbox_attempt");
  expect(mocks.send).toHaveBeenCalledOnce();
});
