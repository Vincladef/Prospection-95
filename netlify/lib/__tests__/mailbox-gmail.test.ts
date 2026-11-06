import {beforeEach,it,expect,vi} from "vitest";
const m=vi.hoisted(()=>({connect:vi.fn(),close:vi.fn(),list:vi.fn(),lock:vi.fn(),release:vi.fn(),search:vi.fn(),fetchOne:vi.fn(),fetch:vi.fn(),append:vi.fn(),remove:vi.fn(),add:vi.fn(),del:vi.fn(),parse:vi.fn(),compile:vi.fn()}));
vi.mock("node:dns/promises",()=>({lookup:async()=>({address:"127.0.0.1"})}));
vi.mock("../credentials.mts",()=>({readCredential:async()=>({kind:"gmail_sender",secret:"fixture-password"})}));
vi.mock("imapflow",()=>({ImapFlow:class{connect=m.connect;close=m.close;list=m.list;getMailboxLock=m.lock;search=m.search;fetchOne=m.fetchOne;fetch=m.fetch;append=m.append;messageFlagsRemove=m.remove;messageFlagsAdd=m.add;messageDelete=m.del;}}));
vi.mock("mailparser",()=>({simpleParser:m.parse}));
vi.mock("nodemailer",()=>({default:{createTransport:()=>({sendMail:m.compile})}}));
import {draftHash,gmailThreadState,syncMailboxDraft} from "../mailbox-gmail.mts";
const input={mode:"save" as const,fromEmail:"sender@example.test",credentialId:"secret-id",recipient:"prospect@example.test",subject:"Re: Sujet",text:"Bonjour",messageId:"",inReplyTo:"<parent@test>",references:[],version:2,threadId:"thread",previousId:null,previousHash:null};
beforeEach(()=>{vi.resetAllMocks();m.list.mockResolvedValue([{path:"[Gmail]/Tous",specialUse:"\\All"},{path:"[Gmail]/Brouillons",specialUse:"\\Drafts"}]);m.lock.mockResolvedValue({release:m.release});m.search.mockResolvedValue([]);m.compile.mockResolvedValue({message:Buffer.from("MIME fixture")});m.append.mockResolvedValue({uid:8});m.del.mockResolvedValue(true);});
it("archives through Gmail labels and rechecks the whole thread",async()=>{
 m.search.mockResolvedValue([5,6]);m.remove.mockResolvedValue(true);
 m.fetch.mockImplementation(async function*(){yield {flags:new Set(["\\Seen"]),labels:new Set(["\\Sent"])};yield {flags:new Set(),labels:new Set()};});
 expect(await gmailThreadState({email:input.fromEmail,credentialId:input.credentialId,threadId:"99",identifiers:[],action:"archive",value:true})).toEqual({unread:true,archived:true,threadId:"99"});
 expect(m.remove).toHaveBeenCalledWith("5,6",["\\Inbox"],{uid:true,useLabels:true});expect(m.release).toHaveBeenCalled();expect(m.close).toHaveBeenCalled();
});
it("refuses incomplete flag snapshots",async()=>{
 m.search.mockResolvedValue([5,6]);m.fetch.mockImplementation(async function*(){yield {flags:new Set(),labels:new Set()};});
 await expect(gmailThreadState({email:input.fromEmail,credentialId:input.credentialId,threadId:"99",identifiers:[]})).rejects.toThrow("snapshot_incomplete");
});
it("appends a stable draft in the French special folder and preserves reply headers",async()=>{
 const result=await syncMailboxDraft(input);expect(result.messageId).toContain("mailbox-draft-thread-v2");
 expect(m.append).toHaveBeenCalledWith("[Gmail]/Brouillons",expect.any(Buffer),["\\Draft"]);
 expect(m.compile).toHaveBeenCalledWith(expect.objectContaining({from:input.fromEmail,inReplyTo:"<parent@test>"}));
});
it("recovers an APPEND retry without duplicating its draft",async()=>{
 m.search.mockResolvedValueOnce([8]);m.fetchOne.mockResolvedValue({source:Buffer.from("draft")});m.parse.mockResolvedValue({text:"Bonjour"});
 await syncMailboxDraft(input);expect(m.append).not.toHaveBeenCalled();expect(m.del).not.toHaveBeenCalled();
});
it("preserves an externally edited draft instead of overwriting or deleting it",async()=>{
 m.search.mockResolvedValueOnce([]).mockResolvedValueOnce([3]);m.fetchOne.mockResolvedValue({source:Buffer.from("draft")});m.parse.mockResolvedValue({text:"Texte modifié dans Gmail"});
 const result=await syncMailboxDraft({...input,previousId:"<old@test>",previousHash:draftHash("Ancien texte")});
 expect(result.remoteBody).toBe("Texte modifié dans Gmail");expect(m.append).not.toHaveBeenCalled();expect(m.del).not.toHaveBeenCalled();
});
it("does not resurrect a draft deleted in Gmail",async()=>{
 const result=await syncMailboxDraft({...input,previousId:"<old@test>",previousHash:draftHash("Bonjour")});
 expect(result.remoteBody).toBe("");expect(m.append).not.toHaveBeenCalled();
});
it("deletes only the known, unchanged draft after the replacement is confirmed",async()=>{
 m.search.mockResolvedValueOnce([]).mockResolvedValueOnce([3]);m.fetchOne.mockResolvedValue({source:Buffer.from("draft")});m.parse.mockResolvedValue({text:"Ancien texte"});
 await syncMailboxDraft({...input,previousId:"<old@test>",previousHash:draftHash("Ancien texte")});
 expect(m.del).toHaveBeenCalledWith([3],{uid:true});expect(m.append.mock.invocationCallOrder[0]).toBeLessThan(m.del.mock.invocationCallOrder[0]);
});
it("preserves an AI draft through repeated background refreshes with an empty app editor",async()=>{
 m.search.mockResolvedValueOnce([]).mockResolvedValueOnce([3]);
 m.fetchOne.mockResolvedValue({source:Buffer.from("AI draft")});
 m.parse.mockResolvedValue({messageId:"<ai-draft@test>",text:"Réponse rédigée par IA"});
 const discovered=await syncMailboxDraft({...input,mode:"observe",text:""});
 expect(discovered.remoteBody).toBe("Réponse rédigée par IA");
 // Reproduce the following refresh using the imported identity/hash while
 // retaining the empty local editor. Previously this deleted UID 3.
 for(let pass=0;pass<3;pass++){
  m.search.mockResolvedValueOnce([]).mockResolvedValueOnce([3]);
  const observed=await syncMailboxDraft({...input,mode:"observe",text:"",previousId:discovered.messageId,previousHash:discovered.hash});
  expect(observed).toEqual(discovered);
 }
 expect(m.lock).toHaveBeenCalledWith("[Gmail]/Brouillons",{readOnly:true});
 expect(m.search.mock.calls.every(([query])=>query.draft===undefined)).toBe(true);
 expect(m.append).not.toHaveBeenCalled();expect(m.del).not.toHaveBeenCalled();
});
it("does not create a Gmail draft from a local body during a background refresh",async()=>{
 await syncMailboxDraft({...input,mode:"observe"});
 expect(m.compile).not.toHaveBeenCalled();expect(m.append).not.toHaveBeenCalled();expect(m.del).not.toHaveBeenCalled();
});
it("does not replace an unchanged known draft with a different local body on observation",async()=>{
 m.search.mockResolvedValueOnce([]).mockResolvedValueOnce([3]);
 m.fetchOne.mockResolvedValue({source:Buffer.from("draft")});m.parse.mockResolvedValue({text:"Texte Gmail"});
 expect(await syncMailboxDraft({...input,mode:"observe",previousId:"<old@test>",previousHash:draftHash("Texte Gmail")}))
  .toMatchObject({remoteBody:"Texte Gmail"});
 expect(m.append).not.toHaveBeenCalled();expect(m.del).not.toHaveBeenCalled();
});
it("still permits clearing an unchanged draft through an editor save",async()=>{
 m.search.mockResolvedValueOnce([]).mockResolvedValueOnce([3]);
 m.fetchOne.mockResolvedValue({source:Buffer.from("draft")});m.parse.mockResolvedValue({text:"Texte Gmail"});
 await syncMailboxDraft({...input,text:"",previousId:"<old@test>",previousHash:draftHash("Texte Gmail")});
 expect(m.del).toHaveBeenCalledWith([3],{uid:true});expect(m.append).not.toHaveBeenCalled();
});
