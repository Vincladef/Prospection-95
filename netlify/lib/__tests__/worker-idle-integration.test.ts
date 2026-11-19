import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "@netlify/functions";

vi.mock("../worker-idle.mts", () => ({
  workerGovernor: { shouldRun: vi.fn(), shouldProbe: vi.fn(), rest: vi.fn(), keepActive: vi.fn(), quotaFailure: vi.fn(), isInteractive: vi.fn(), noteActivity: vi.fn() },
}));
vi.mock("../db.mts", () => ({ sqlOne: vi.fn(), sqlQuery: vi.fn(), sqlTransaction: vi.fn(), pingDatabase: vi.fn() }));
vi.mock("../auth.mts", () => ({ isProductionOutboundEnabled: vi.fn(() => true) }));
vi.mock("../gmail.mts", () => ({ createGmailDraft: vi.fn(), sendGmailMessage: vi.fn() }));
vi.mock("../imap.mts", () => ({ fetchMailboxDelta: vi.fn() }));
vi.mock("../mailbox-sync.mts", () => ({ recordMailboxMessages: vi.fn(), refreshConversation: vi.fn() }));
vi.mock("../unified-mailbox-sync.mts", () => ({
  processMailboxJob: vi.fn(), refreshMailboxThread: vi.fn(), refreshUnifiedConversation: vi.fn(),
}));
vi.mock("../reply-content-recovery.mts", () => ({ recoverReplyContent: vi.fn() }));
vi.mock("../draft-recovery.mts", () => ({ recoverFalseSentDraft: vi.fn() }));
vi.mock("../tracking.mts", () => ({ prepareTrackedMessage: vi.fn(), trackingBaseUrl: vi.fn() }));
vi.mock("node:crypto", () => ({ randomUUID: vi.fn(() => "worker-test"), randomInt: vi.fn(() => 0) }));
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => undefined) }));

import { randomInt } from "node:crypto";
import { sqlOne, sqlQuery } from "../db.mts";
import { isProductionOutboundEnabled } from "../auth.mts";
import { workerGovernor } from "../worker-idle.mts";
import { fetchMailboxDelta } from "../imap.mts";
import { recordMailboxMessages } from "../mailbox-sync.mts";
import { recoverReplyContent } from "../reply-content-recovery.mts";
import { recoverFalseSentDraft } from "../draft-recovery.mts";
import { processMailboxJob, refreshMailboxThread } from "../unified-mailbox-sync.mts";
import { sendGmailMessage, createGmailDraft } from "../gmail.mts";
import dispatch from "../../functions/dispatch-outbox.mts";
import mailboxes from "../../functions/sync-mailboxes.mts";
import unified from "../../functions/sync-unified-mailbox.mts";
import drafts from "../../functions/sync-drafts.mts";

const context = {} as Context;
const request = () => new Request("https://test.invalid/worker", { method: "POST" });
const box = (id: string) => ({ account_id: id, email: id + "@example.test", credential_id: "credential-" + id,
  mailbox_name: "INBOX", uidvalidity: "1", last_uid: 0, recent_since: "2026-11-01T00:00:00Z" });

describe("idle workers and bounded catch-up", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(isProductionOutboundEnabled).mockReturnValue(true);
    vi.mocked(workerGovernor.shouldRun).mockResolvedValue(true);
    vi.mocked(workerGovernor.isInteractive).mockResolvedValue(false);
    vi.mocked(workerGovernor.shouldProbe).mockResolvedValue(false);
    vi.mocked(recoverReplyContent).mockResolvedValue(0);
    vi.mocked(recoverFalseSentDraft).mockResolvedValue(undefined as never);
    vi.mocked(sqlQuery).mockResolvedValue([]);
  });
  it.each([["dispatch", dispatch], ["mailboxes", mailboxes], ["unified", unified], ["drafts", drafts]] as const)(
    "%s performs no SQL, recovery scan or Gmail request during an idle interval", async (_name, handler) => {
      vi.mocked(workerGovernor.shouldRun).mockResolvedValue(false);
      const response = await handler(request(), context);
      expect(await response.json()).toMatchObject({ ok: true, skipped: "idle" });
      for (const action of [sqlOne, sqlQuery, recoverReplyContent, recoverFalseSentDraft,
        fetchMailboxDelta, processMailboxJob, refreshMailboxThread, sendGmailMessage, createGmailDraft]) {
        expect(action).not.toHaveBeenCalled();
      }
    });
  it("checks another account when the first mailbox is empty", async () => {
    vi.mocked(sqlOne).mockResolvedValueOnce(box("a")).mockResolvedValueOnce(box("b")).mockResolvedValueOnce(null);
    vi.mocked(fetchMailboxDelta)
      .mockResolvedValueOnce({ uidValidity: "1", lastUid: 1, messages: [], resetRequired: false, hasMore: false })
      .mockResolvedValueOnce({ uidValidity: "1", lastUid: 2, messages: [], resetRequired: false, hasMore: false });
    await mailboxes(request(), context);
    expect(fetchMailboxDelta).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchMailboxDelta).mock.calls[1][0].email).toBe("b@example.test");
    expect(recordMailboxMessages).toHaveBeenCalledTimes(2);
    expect(workerGovernor.rest).toHaveBeenCalledWith("mailboxes");
    expect(vi.mocked(sqlOne).mock.calls[1][1]).toEqual([false, ["a:INBOX"]]);
  });
  it("continues on the minute schedule while an IMAP history still has pages", async () => {
    vi.mocked(sqlOne).mockResolvedValueOnce(box("a")).mockResolvedValueOnce(null);
    vi.mocked(fetchMailboxDelta).mockResolvedValue({ uidValidity: "1", lastUid: 1, messages: [], resetRequired: false, hasMore: true });
    await mailboxes(request(), context);
    expect(workerGovernor.keepActive).toHaveBeenCalledWith("mailboxes");
    expect(workerGovernor.rest).not.toHaveBeenCalled();
  });
  it("does not put a partially imported conversation history to sleep", async () => {
    vi.mocked(processMailboxJob).mockResolvedValue(false);
    vi.mocked(refreshMailboxThread).mockImplementationOnce(async onPending => { onPending?.(); return true; }).mockResolvedValue(false);
    await unified(request(), context);
    expect(workerGovernor.keepActive).toHaveBeenCalledWith("unified");
    expect(workerGovernor.rest).not.toHaveBeenCalled();
  });
  it("does not let random SMTP pacing stagger an empty idle probe", async () => {
    vi.mocked(workerGovernor.shouldProbe).mockResolvedValue(true);
    vi.mocked(sqlOne).mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ ready: false, at: null });
    expect(await (await dispatch(request(), context)).json()).toMatchObject({ ok: true, leased: 0 });
    expect(workerGovernor.rest).toHaveBeenCalledWith("dispatch", undefined);
    expect(randomInt).not.toHaveBeenCalled();
    expect(sqlOne).toHaveBeenCalledTimes(2);
    expect(sendGmailMessage).not.toHaveBeenCalled();
  });
  it("retains the random SMTP lottery after discovering due work", async () => {
    vi.mocked(workerGovernor.shouldProbe).mockResolvedValue(true);
    vi.mocked(randomInt).mockReturnValue(4 as never);
    vi.mocked(sqlOne).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ ready: true, at: null });
    expect(await (await dispatch(request(), context)).json()).toMatchObject({ skipped: "random_pacing" });
    expect(workerGovernor.keepActive).toHaveBeenCalledWith("dispatch");
    expect(vi.mocked(sqlOne).mock.calls.some(([query]) => query.includes("app.lease_outbox_jobs"))).toBe(false);
    expect(sendGmailMessage).not.toHaveBeenCalled();
  });

});
