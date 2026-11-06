import type { Context } from "@netlify/functions";
import { beforeEach,expect,it,vi } from "vitest";
const mocks=vi.hoisted(()=>({sqlOne:vi.fn(),sqlQuery:vi.fn(),refresh:vi.fn(),create:vi.fn()}));
vi.mock("../db.mts",()=>({sqlOne:mocks.sqlOne,sqlQuery:mocks.sqlQuery}));
vi.mock("../mailbox-sync.mts",()=>({refreshConversation:mocks.refresh}));
vi.mock("../gmail.mts",()=>({createGmailDraft:mocks.create}));
vi.mock("../draft-recovery.mts",()=>({recoverFalseSentDraft:async()=>undefined}));
import sync from "../../functions/sync-drafts.mts";
const run=()=>sync(new Request("https://example.test"),{} as Context);
const draft={id:"draft",conversation_id:"conversation",lease_token:"lease",sender_email:"sender@example.test",credential_email:"sender@example.test",
  credential_id:"credential",recipient:"contact@example.test",proposed_subject:"Re: question",proposed_body:"Réponse",
  source_references:[],source_message_id_header:"<source@test>"};
beforeEach(()=>{vi.resetAllMocks();mocks.sqlQuery.mockResolvedValue([]);mocks.refresh.mockResolvedValue(undefined);});
it("creates one reply draft only after Gmail and source revalidation",async()=>{
  mocks.sqlOne.mockResolvedValueOnce(draft).mockResolvedValueOnce({id:"draft"});
  mocks.create.mockResolvedValue({uid:42,mailbox:"[Gmail]/Brouillons"});
  expect(await(await run()).json()).toMatchObject({ok:true,draftId:"draft"});
  expect(mocks.sqlOne.mock.calls[0][0]).toContain("r.state in ('requested','failed','created')");
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({messageId:"<draft-draft@mail.prospection95.local>",references:["<source@test>"]}));
  expect(mocks.sqlQuery.mock.calls[0][1]).toContain("imap:[Gmail]/Brouillons:42");
});
it("does not create an obsolete draft after a newer reply or a manual send is found",async()=>{
  mocks.sqlOne.mockResolvedValueOnce(draft).mockResolvedValueOnce(null);
  expect(await(await run()).json()).toMatchObject({state:"stale"});
  expect(mocks.create).not.toHaveBeenCalled();
});
it("leaves an uncertain append retryable and does not overwrite a sent/superseded draft",async()=>{
  mocks.sqlOne.mockResolvedValueOnce(draft).mockResolvedValueOnce({id:"draft"});
  mocks.create.mockRejectedValue(Object.assign(new Error("timeout"),{code:"ETIMEDOUT"}));
  expect(await(await run()).json()).toMatchObject({ok:false});
  expect(mocks.sqlQuery.mock.calls[0][0]).toContain("state in ('requested','failed','created')");
  expect(mocks.sqlQuery.mock.calls[0][1]).toEqual(["draft","lease","etimedout"]);
});

it("does not recreate a draft deleted in Gmail",async()=>{
  mocks.sqlOne.mockResolvedValueOnce({...draft,state:"created"}).mockResolvedValueOnce({id:"draft",source_thread_id:"thread"});
  mocks.create.mockResolvedValue({mailbox:"Drafts",missing:true});
  expect(await(await run()).json()).toMatchObject({ok:true});
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({checkOnly:true,sourceThreadId:"thread"}));
  expect(mocks.sqlQuery.mock.calls[0][1][4]).toBe(true);
});

it('keeps a confirmed Gmail draft successful while surfacing an audit failure',async()=>{
 const error=vi.spyOn(console,'error').mockImplementation(()=>undefined);
 mocks.sqlOne.mockResolvedValueOnce(draft).mockResolvedValueOnce({id:'draft'});
 mocks.create.mockResolvedValue({uid:42,mailbox:'Drafts'});
 mocks.sqlQuery.mockImplementation(async(sql:string)=>{if(sql.includes('audit.log_event'))throw new Error('audit unavailable');return []});
 expect(await(await run()).json()).toMatchObject({ok:true,draftId:'draft'});
 expect(error).toHaveBeenCalledWith('gmail_draft_audit_failed',expect.objectContaining({draftId:'draft'}));
 expect(mocks.create).toHaveBeenCalledOnce();
 error.mockRestore();
});
