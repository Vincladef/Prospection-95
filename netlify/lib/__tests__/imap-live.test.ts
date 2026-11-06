import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ search: vi.fn(), list: vi.fn(), status: vi.fn(), fetch: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: async () => ({ address: "127.0.0.1" }) }));
vi.mock("../credentials.mts", () => ({ readCredential: async () => ({ kind: "gmail_sender", secret: "test" }) }));
vi.mock("imapflow", () => ({ ImapFlow: class {
  mailbox = {};
  search = mocks.search; list = mocks.list; status = mocks.status;
  fetch = mocks.fetch;
  async connect() {} close() {} async getMailboxLock() { return { release() {} }; }
} }));
import { fetchMailboxDelta } from "../imap.mts";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue([{ path: "All", specialUse: "\\All" },{ path: "Sent", specialUse: "\\Sent" }]);
  mocks.status.mockResolvedValue({ uidNext: 121, uidValidity: 1 });
  mocks.search.mockResolvedValue([]);
});
describe("live reply cursor independent from historical backlog", () => {
  it("distinguishes an incomplete batch from a fully synchronized Sent pass", async () => {
    mocks.search.mockResolvedValueOnce(Array.from({length:51},(_,i)=>i+1));
    mocks.fetch.mockImplementationOnce(async function* () {
      for(let uid=1;uid<=50;uid++) yield {uid,source:Buffer.from("From: sender@example.test\r\nTo: contact@example.test\r\nSubject: Fixture\r\nMessage-ID: <fixture@example.test>\r\n\r\nMessage de test")};
    });
    const partial=await fetchMailboxDelta({email:"sender@example.test",credentialId:"fixture",
      cursor:{mailbox:"__LIVE_SENT__",lastUid:0},maxMessages:50});
    expect(mocks.status).toHaveBeenCalledWith("Sent",expect.anything());
    expect(partial.hasMore).toBe(true);
    expect(partial.lastUid).toBe(50);
    mocks.search.mockResolvedValueOnce([]);
    const caughtUp=await fetchMailboxDelta({email:"sender@example.test",credentialId:"fixture",
      cursor:{mailbox:"__LIVE_SENT__",lastUid:50},maxMessages:50});
    expect(caughtUp.hasMore).toBe(false);
    expect(caughtUp.lastUid).toBe(120);
  });
  it.each([0, 100])("uses the recent bootstrap only on initial cursor %i, and advances empty deltas", async (lastUid) => {
    const since = new Date("2026-10-29T07:00:00Z");
    const result = await fetchMailboxDelta({ email:"sender@example.test", credentialId:"test",
      cursor:{mailbox:"__LIVE_ALL__",lastUid,uidValidity:"1"},bootstrapSince:since });
    expect(mocks.status).toHaveBeenCalledWith("All", expect.anything());
    expect(mocks.search).toHaveBeenCalledWith({ draft:false,deleted:false,uid:`${lastUid+1}:120`, ...(lastUid ? {} : {since}) },{uid:true});
    expect(result.lastUid).toBe(120);
  });
});

it("refuses a partial FETCH rather than advancing past an unread message", async () => {
  mocks.search.mockResolvedValue([1,2]);
  mocks.fetch.mockImplementationOnce(async function* () { yield {uid:2,source:Buffer.from("From: contact@example.test\r\nTo: sender@example.test\r\n\r\nReply")}; });
  await expect(fetchMailboxDelta({email:"sender@example.test",credentialId:"test",cursor:{mailbox:"INBOX",lastUid:0}}))
    .rejects.toThrow("imap_batch_incomplete");
});
it("targets correspondents and thread references and never ingests a draft as Sent", async () => {
  mocks.search.mockResolvedValue([1,2]);
  mocks.fetch.mockImplementationOnce(async function* () {
    const source=Buffer.from("From: sender@example.test\r\nTo: contact@example.test\r\nMessage-ID: <sent@example.test>\r\n\r\nReply");
    yield {uid:2,source,flags:new Set(["\\Draft"])};
    yield {uid:1,source,labels:new Set(["\\Sent"]),threadId:"thread-1"};
  });
  const result=await fetchMailboxDelta({email:"sender@example.test",credentialId:"test",cursor:{mailbox:"__LIVE_ALL__",lastUid:0},
    correspondent:"contact@example.test",identifiers:["<source@example.test>"]});
  expect(mocks.search.mock.calls[0][0].or).toContainEqual({header:{"In-Reply-To":"<source@example.test>"}});
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]).toMatchObject({uid:1,sent:true,gmailThreadId:"thread-1"});
  expect(result.lastUid).toBe(120);
});
it.each(['\\Draft','\\Drafts'])('excludes a Gmail %s label even when the IMAP Draft flag is absent',async(label)=>{
 mocks.search.mockResolvedValue([1]);mocks.fetch.mockImplementationOnce(async function*(){yield {uid:1,source:Buffer.from('From: sender@example.test\r\nTo: contact@example.test\r\n\r\nDraft'),flags:new Set(),labels:new Set([label])}});
 const result=await fetchMailboxDelta({email:'sender@example.test',credentialId:'test',cursor:{mailbox:'__UNIFIED_ALL__',lastUid:0}});
 expect(result.messages).toHaveLength(0);
});
