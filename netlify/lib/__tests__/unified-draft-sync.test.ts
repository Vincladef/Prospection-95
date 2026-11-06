import {beforeEach,expect,it,vi} from "vitest";
const m=vi.hoisted(()=>({one:vi.fn(),query:vi.fn(),sync:vi.fn(),state:vi.fn(),delta:vi.fn()}));
vi.mock("../db.mts",()=>({sqlOne:m.one,sqlQuery:m.query}));
vi.mock("../mailbox-gmail.mts",()=>({gmailThreadState:m.state,syncMailboxDraft:m.sync}));
vi.mock("../imap.mts",()=>({fetchMailboxDelta:m.delta}));
vi.mock("../mailbox-sync.mts",()=>({recordMailboxMessages:async()=>undefined}));
import {syncThreadDraft,refreshMailboxThread,processMailboxJob} from "../unified-mailbox-sync.mts";
const thread={id:"thread",account_id:"account",email:"sender@example.test",credential_id:"credential",correspondent:"recipient@example.test",subject:"Sujet",
 thread_id:"gmail-thread",identifiers:["<parent@test>"],draft_body:"",draft_version:1,draft_synced_version:1,
 gmail_draft_message_id:"<ai-draft@test>",gmail_draft_hash:"hash",draft_remote_body:null,
 parent_id:"<parent@test>",parent_references:[],history_uid:0,history_uidvalidity:null};
beforeEach(()=>{vi.resetAllMocks();m.one.mockResolvedValue(null);m.query.mockResolvedValue([]);
 m.sync.mockResolvedValue({messageId:"<ai-draft@test>",hash:"hash",remoteBody:"Réponse IA"});
 m.state.mockResolvedValue({threadId:"gmail-thread",unread:false,archived:false});
 m.delta.mockResolvedValue({messages:[],lastUid:1,uidValidity:"1",hasMore:false});});
it("routes scheduled refreshes through read-only draft observation",async()=>{
 m.one.mockResolvedValueOnce({id:"thread",token:"lease"}).mockResolvedValueOnce(thread).mockResolvedValueOnce(null);
 await refreshMailboxThread();expect(m.sync).toHaveBeenCalledWith(expect.objectContaining({mode:"observe",text:""}));
});
it("only passes save intent for a current versioned editor job",async()=>{
 m.one.mockResolvedValueOnce({id:"job",thread_id:"thread",kind:"draft",payload:{version:1},lease_token:"lease"})
  .mockResolvedValueOnce(thread).mockResolvedValueOnce(null);
 await processMailboxJob();expect(m.sync).toHaveBeenCalledWith(expect.objectContaining({mode:"save"}));
});
it("blocks even an editor job from overwriting an unresolved imported Gmail draft",async()=>{
 await syncThreadDraft({...thread,draft_remote_body:"Réponse IA"},"save");
 expect(m.sync).not.toHaveBeenCalled();
});
it("does not save an obsolete editor version",async()=>{
 m.one.mockResolvedValueOnce({id:"job",thread_id:"thread",kind:"draft",payload:{version:1},lease_token:"lease"})
  .mockResolvedValueOnce({...thread,draft_version:2});
 await processMailboxJob();expect(m.sync).not.toHaveBeenCalled();
});
