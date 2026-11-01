import type { Context } from "@netlify/functions";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ sqlOne: vi.fn(), sqlQuery: vi.fn(), fetchMailboxDelta: vi.fn() }));
vi.mock("../db.mts", () => ({ sqlOne:mocks.sqlOne,sqlQuery:mocks.sqlQuery }));
vi.mock("../imap.mts", () => ({ fetchMailboxDelta:mocks.fetchMailboxDelta, classifyOperationalMessage:()=>"human_or_unknown" }));
import sync from "../../functions/sync-mailboxes.mts";
beforeEach(() => vi.clearAllMocks());
it("ingests a recent reply through the existing stop-follow-ups RPC and reconciles our sent copy without classifying it as another reply", async () => {
  const claimed = { account_id:"account",email:"sender@example.test",credential_id:"secret-id",mailbox_name:"__LIVE_ALL__",uidvalidity:"1",last_uid:0,recent_since:"2026-10-26T07:00:00Z" };
  mocks.sqlOne.mockImplementation(async (sql:string) => sql.includes("with candidate as") ? claimed : {id:"conversation"});
  mocks.sqlQuery.mockResolvedValue([]);
  const reply = { uid:42,uidValidity:"1",mailbox:"__LIVE_ALL__",from:["contact@example.test"],to:["sender@example.test"],references:["<original@example.test>"],inReplyTo:"<original@example.test>",subject:"Re: proposition",text:"Merci pour votre proposition",html:null,internetMessageId:"<reply@example.test>",date:"2026-10-30T10:00:00Z",autoSubmitted:null,precedence:null,isBounce:false,isPermanentBounce:false };
  mocks.fetchMailboxDelta.mockResolvedValue({uidValidity:"1",lastUid:43,messages:[reply,{...reply,uid:43,from:["sender@example.test"]}],resetRequired:false});
  const response = await sync(new Request("https://example.test"),{} as Context);
  expect(await response.json()).toMatchObject({ok:true,recorded:2});
  expect(mocks.fetchMailboxDelta).toHaveBeenCalledWith(expect.objectContaining({maxMessages:50,bootstrapSince:new Date(claimed.recent_since)}));
  const records = mocks.sqlOne.mock.calls.filter(([sql]) => sql.includes("app.record_inbound_message"));
  expect(records).toHaveLength(1);
  expect(records[0][1].slice(0,3)).toEqual(["account","conversation","reply"]);
});

it("leaves the batch cursor unchanged if storing a later message fails",async()=>{
  const claimed={account_id:"account",email:"sender@example.test",credential_id:"credential",mailbox_name:"INBOX",last_uid:41,uidvalidity:"1"};
  let records=0;
  mocks.sqlOne.mockImplementation(async(sql:string)=>{
    if(sql.includes("with candidate as"))return claimed;
    if(sql.includes("app.record_inbound_message") && ++records===2)throw new Error("database failure");
    return {id:"conversation"};
  });
  const reply={uid:42,uidValidity:"1",mailbox:"INBOX",from:["contact@example.test"],to:["sender@example.test"],references:[],inReplyTo:null,subject:"Re: proposition",text:"Question",html:null,internetMessageId:"<reply@test>",date:"2026-10-30T10:00:00Z",autoSubmitted:null,precedence:null,isBounce:false,isPermanentBounce:false};
  mocks.fetchMailboxDelta.mockResolvedValue({uidValidity:"1",lastUid:43,hasMore:false,messages:[reply,{...reply,uid:43}]});
  expect(await(await sync(new Request("https://example.test"),{} as Context)).json()).toMatchObject({ok:false});
  expect(mocks.sqlQuery.mock.calls.some(([sql])=>sql.includes("insert into app.imap_cursors"))).toBe(false);
});
it("advances past mail unrelated to any conversation without storing its content",async()=>{
 mocks.sqlOne.mockImplementation(async(sql:string)=>sql.includes("with candidate as")?{account_id:"account",email:"sender@example.test",credential_id:"credential",mailbox_name:"INBOX",last_uid:0,uidvalidity:"1"}:null);
 mocks.fetchMailboxDelta.mockResolvedValue({uidValidity:"1",lastUid:99,hasMore:false,messages:[{uid:99,from:["newsletter@example.test"],to:["sender@example.test"],references:[],inReplyTo:null,date:"2026-11-01T07:00:00Z"}]});
 expect(await(await sync(new Request("https://example.test"),{} as Context)).json()).toMatchObject({ok:true,recorded:0});
 expect(mocks.sqlOne.mock.calls.some(([sql])=>sql.includes("app.record_inbound_message"))).toBe(false);
 expect(mocks.sqlQuery.mock.calls.some(([sql])=>sql.includes("insert into app.imap_cursors"))).toBe(true);
});
