import {beforeEach,expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({one:vi.fn(),query:vi.fn()}));
vi.mock("../db.mts",()=>({sqlOne:m.one,sqlQuery:m.query}));
import {recordStandaloneMessage} from "../mailbox-storage.mts";
import type {SyncedMessage} from "../imap.mts";
const message:SyncedMessage={uid:1,uidValidity:"1",mailbox:"__UNIFIED_ALL__",internetMessageId:"<personal@example.test>",inReplyTo:"<previous@example.test>",references:["<previous@example.test>"],from:["person@example.test"],to:["sender@example.test"],subject:"Re: Conversation personnelle",text:"Message personnel",html:null,date:"2026-11-04T10:00:00Z",autoSubmitted:null,precedence:null,isBounce:false,isPermanentBounce:false,gmailThreadId:"12345"};
beforeEach(()=>{vi.resetAllMocks();m.one.mockResolvedValue(null);m.query.mockResolvedValue([]);});
it.each([false,true])("does not copy unrelated Gmail exchanges or create a thread (outgoing=%s)",async outgoing=>{
 const mail=outgoing?{...message,from:["sender@example.test"],to:["person@example.test"]}:message;
 expect(await recordStandaloneMessage("account","sender@example.test",mail,outgoing)).toBeNull();
 expect(m.one).toHaveBeenCalledOnce();expect(m.query).not.toHaveBeenCalled();
 expect(m.one.mock.calls[0][0]).not.toContain("insert into");
});
it("retains Sent reconciliation for a legacy manual reply already queued by the owner",async()=>{
 m.one.mockResolvedValueOnce({id:"legacy-thread"}).mockResolvedValueOnce({id:"owned-message"});
 expect(await recordStandaloneMessage("account","sender@example.test",{...message,from:["sender@example.test"],to:["person@example.test"]},true)).toBe("owned-message");
 expect(m.one.mock.calls[1][0]).toContain("app.record_sent_message");
 expect(m.one.mock.calls[1][1][6]).toBe(message.internetMessageId);
});
