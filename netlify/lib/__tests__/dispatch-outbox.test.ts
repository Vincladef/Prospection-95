import type { Context } from "@netlify/functions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(), randomInt: vi.fn(), delay: vi.fn(), sqlOne: vi.fn(),
  sqlQuery: vi.fn(), send: vi.fn(), refresh: vi.fn(),prepare:vi.fn(),refreshUnified:vi.fn(),
}));
vi.mock("node:crypto", () => ({ randomUUID: () => "test-worker", randomInt: mocks.randomInt }));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));
vi.mock("../auth.mts", () => ({ isProductionOutboundEnabled: mocks.enabled }));
vi.mock("../db.mts", () => ({ sqlOne: mocks.sqlOne, sqlQuery: mocks.sqlQuery }));
vi.mock("../gmail.mts", () => ({ sendGmailMessage: mocks.send }));
vi.mock("../tracking.mts", () => ({ prepareTrackedMessage: mocks.prepare, trackingBaseUrl: vi.fn() }));
vi.mock("../mailbox-sync.mts", () => ({refreshConversation:mocks.refresh}));
vi.mock("../unified-mailbox-sync.mts",()=>({refreshUnifiedConversation:mocks.refreshUnified}));

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
    expect(mocks.sqlOne.mock.calls[1][0]).toContain("app.lease_outbox_jobs($1, 1, 300)");
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

const leased = { id:"job",lease_token:"lease",job_kind:"prospection",step:"R1",conversation_id:"conversation",
  attempt_count:1,max_attempts:5,message_id:"message",from_address:"sender@example.test",to_addresses:["contact@example.test"],
  subject:"Re: proposition",body_text:"Relance",body_html:null,credential_id:"credential",references_header:[],
  tracking_opens_enabled:false,tracking_clicks_enabled:false };

it("checks the standalone Gmail thread again at SMTP commit for a manual reply",async()=>{
 mocks.randomInt.mockReturnValue(0);mocks.refreshUnified.mockResolvedValue(undefined);
 mocks.prepare.mockResolvedValue({text:"Réponse",html:null});
 mocks.sqlOne.mockResolvedValueOnce({count:0}).mockResolvedValueOnce({...leased,job_kind:"mailbox_reply",step:"reply",conversation_id:null,mailbox_thread_id:"thread"})
  .mockResolvedValueOnce({id:"job"}).mockResolvedValueOnce({id:"job",status:"running"})
  .mockResolvedValueOnce({internet_message_id:"<stable@test>",in_reply_to:"<parent@test>",references_header:[]})
  .mockResolvedValueOnce({ready:true,eligible:true});
 mocks.send.mockImplementation(async(mail,gate)=>{expect(mail.fromEmail).toBe("sender@example.test");expect(mail.inReplyTo).toBe("<parent@test>");expect(await gate()).toBe(true);return{state:"accepted",response:"250 OK"};});
 expect(await(await run()).json()).toMatchObject({state:"accepted"});expect(mocks.refreshUnified).toHaveBeenCalledTimes(2);
 expect(mocks.refreshUnified).toHaveBeenCalledWith("thread");expect(mocks.refresh).not.toHaveBeenCalled();
});

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

it("withdraws a follow-up when a reply is detected by the final SMTP commit gate",async()=>{
 mocks.randomInt.mockReturnValue(0);mocks.refresh.mockResolvedValue(undefined);
 mocks.prepare.mockResolvedValue({text:"Relance",html:null});
 mocks.sqlOne.mockResolvedValueOnce({count:0}).mockResolvedValueOnce(leased).mockResolvedValueOnce({id:"job"})
  .mockResolvedValueOnce({id:"job",status:"running"}).mockResolvedValueOnce({internet_message_id:"<persisted@test>",in_reply_to:null,references_header:[]})
  .mockResolvedValueOnce({ready:false,eligible:false});
 mocks.send.mockImplementation(async(_mail,gate)=>{expect(await gate()).toBe(false);return {state:"blocked",code:"smtp_commit_blocked"};});
 expect(await(await run()).json()).toMatchObject({state:"blocked"});
 expect(mocks.refresh).toHaveBeenCalledTimes(2);
 const abort=mocks.sqlQuery.mock.calls.find(([sql])=>sql.includes("conversation_changed_before_smtp_commit"));
 expect(abort?.[1]).toEqual(["job","lease",false]);
});
it("defers an SMTP commit when its final Gmail read fails, preserving the retry budget",async()=>{
 mocks.randomInt.mockReturnValue(0);mocks.refresh.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("temporary IMAP failure"));
 mocks.prepare.mockResolvedValue({text:"Relance",html:null});
 mocks.sqlOne.mockResolvedValueOnce({count:0}).mockResolvedValueOnce(leased).mockResolvedValueOnce({id:"job"})
  .mockResolvedValueOnce({id:"job",status:"running"}).mockResolvedValueOnce({internet_message_id:"<persisted@test>",in_reply_to:null,references_header:[]});
 mocks.send.mockImplementation(async(_mail,gate)=>{expect(await gate()).toBe(false);return {state:"blocked",code:"smtp_commit_blocked"};});
 await run();
 const abort=mocks.sqlQuery.mock.calls.find(([sql])=>sql.includes("precommit_abort_count=precommit_abort_count"));
 expect(abort?.[1]).toEqual(["job","lease",true]);
});

it.each([[true,true],[true,false],[false,true],[false,false]])("derives automatic analyses from source tracking (%s, %s)",async(opens,clicks)=>{
 mocks.randomInt.mockReturnValue(0);mocks.refresh.mockResolvedValue(undefined);
 mocks.prepare.mockResolvedValue({text:"Relance",html:null});
 mocks.sqlOne.mockResolvedValueOnce({count:0}).mockResolvedValueOnce({...leased,tracking_opens_enabled:opens,tracking_clicks_enabled:clicks,advanced_interactions_enabled:false,read_delay_enabled:false})
  .mockResolvedValueOnce({id:"job"}).mockResolvedValueOnce({id:"job",status:"running"})
  .mockResolvedValueOnce({internet_message_id:"<persisted@test>",in_reply_to:null,references_header:[]});
 mocks.send.mockResolvedValue({state:"accepted",response:"250 OK"});
 await run();
 const snapshot=mocks.sqlQuery.mock.calls.find(([sql])=>sql.includes("set tracking_opens_enabled="));
 expect(snapshot?.[1]).toEqual(["message",opens,clicks,opens,opens&&clicks,false]);
});
