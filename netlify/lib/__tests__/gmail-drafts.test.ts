import { beforeEach,expect,it,vi } from "vitest";
const mocks=vi.hoisted(()=>({search:vi.fn(),append:vi.fn(),list:vi.fn(),close:vi.fn(),locks:vi.fn()}));
vi.mock("node:dns/promises",()=>({lookup:async()=>({address:"127.0.0.1"})}));
vi.mock("../credentials.mts",()=>({readCredential:async()=>({kind:"gmail_sender",secret:"fixture"})}));
vi.mock("nodemailer",()=>({default:{createTransport:()=>({sendMail:async()=>({message:Buffer.from("fixture")})})}}));
vi.mock("imapflow",()=>({ImapFlow:class {
  search=mocks.search; append=mocks.append; list=mocks.list; close=mocks.close;
  async connect(){} async getMailboxLock(path:string){mocks.locks(path);return {release(){}};}
}}));
import { createGmailDraft } from "../gmail.mts";
const input={fromEmail:"sender@example.test",credentialId:"credential",recipient:"contact@example.test",subject:"Re: proposition",text:"Réponse",messageId:"<draft-fixture@example.test>"};
beforeEach(()=>{
  vi.resetAllMocks();mocks.list.mockResolvedValue([{path:"[Gmail]/Brouillons",specialUse:"\\Drafts"},{path:"[Gmail]/Messages envoyés",specialUse:"\\Sent"}]);
  mocks.search.mockResolvedValue([]);mocks.append.mockResolvedValue({uid:42});
});
it("discovers a localized Drafts folder and appends once",async()=>{
  expect(await createGmailDraft(input)).toMatchObject({uid:42,mailbox:"[Gmail]/Brouillons"});
  expect(mocks.append).toHaveBeenCalledWith("[Gmail]/Brouillons",expect.any(Buffer),["\\Draft"]);
});
it("recovers a previously appended draft after a lost acknowledgement without overwriting manual edits",async()=>{
  mocks.append.mockRejectedValueOnce(new Error("acknowledgement lost"));
  await expect(createGmailDraft(input)).rejects.toThrow("acknowledgement lost");
  mocks.search.mockResolvedValueOnce([]).mockResolvedValueOnce([42]);
  expect(await createGmailDraft(input)).toMatchObject({uid:42});
  expect(mocks.append).toHaveBeenCalledOnce();
});
it("does not recreate an already sent draft",async()=>{
  mocks.search.mockResolvedValueOnce([88]);
  expect(await createGmailDraft(input)).toMatchObject({alreadySent:true});
  expect(mocks.append).not.toHaveBeenCalled();
});
it("refuses to append when the existence search is unconfirmed",async()=>{
  mocks.search.mockResolvedValueOnce(false);
  await expect(createGmailDraft(input)).rejects.toThrow("gmail_draft_search_unconfirmed");
  expect(mocks.append).not.toHaveBeenCalled();
});

it("respects a manually edited draft whose original ID changed but reply thread survived",async()=>{
  mocks.search.mockResolvedValueOnce([]).mockResolvedValueOnce([99]);
  expect(await createGmailDraft({...input,sourceThreadId:"thread",inReplyTo:"<source@test>"})).toMatchObject({uid:99});
  expect(mocks.search.mock.calls[1][0].or).toContainEqual({threadId:"thread",header:{"In-Reply-To":"<source@test>"}});
  expect(mocks.append).not.toHaveBeenCalled();
});
it("checks an existing draft without recreating it if it disappeared",async()=>{
  expect(await createGmailDraft({...input,checkOnly:true})).toMatchObject({missing:true});
  expect(mocks.append).not.toHaveBeenCalled();
});
