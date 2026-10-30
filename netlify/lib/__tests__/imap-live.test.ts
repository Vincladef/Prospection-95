import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ search: vi.fn(), list: vi.fn(), status: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: async () => ({ address: "127.0.0.1" }) }));
vi.mock("../credentials.mts", () => ({ readCredential: async () => ({ kind: "gmail_sender", secret: "test" }) }));
vi.mock("imapflow", () => ({ ImapFlow: class {
  mailbox = {};
  search = mocks.search; list = mocks.list; status = mocks.status;
  async connect() {} close() {} async getMailboxLock() { return { release() {} }; }
} }));
import { fetchMailboxDelta } from "../imap.mts";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([{ path: "All", specialUse: "\\All" }]);
  mocks.status.mockResolvedValue({ uidNext: 121, uidValidity: 1 });
  mocks.search.mockResolvedValue([]);
});
describe("live reply cursor independent from historical backlog", () => {
  it.each([0, 100])("uses the recent bootstrap only on initial cursor %i, and advances empty deltas", async (lastUid) => {
    const since = new Date("2026-10-29T07:00:00Z");
    const result = await fetchMailboxDelta({ email:"sender@example.test", credentialId:"test",
      cursor:{mailbox:"__LIVE_ALL__",lastUid,uidValidity:"1"},bootstrapSince:since });
    expect(mocks.status).toHaveBeenCalledWith("All", expect.anything());
    expect(mocks.search).toHaveBeenCalledWith({ uid:`${lastUid+1}:120`, ...(lastUid ? {} : {since}) },{uid:true});
    expect(result.lastUid).toBe(120);
  });
});
