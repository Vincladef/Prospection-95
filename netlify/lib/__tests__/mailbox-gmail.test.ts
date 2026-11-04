import {beforeEach,it,expect,vi} from "vitest";
const m=vi.hoisted(()=>({connect:vi.fn(),close:vi.fn(),list:vi.fn(),lock:vi.fn(),release:vi.fn(),search:vi.fn(),fetchOne:vi.fn(),fetch:vi.fn(),append:vi.fn(),remove:vi.fn(),add:vi.fn(),del:vi.fn(),parse:vi.fn(),compile:vi.fn()}));
vi.mock("node:dns/promises",()=>({lookup:async()=>({address:"127.0.0.1"})}));
vi.mock("../credentials.mts",()=>({readCredential:async()=>({kind:"gmail_sender",secret:"fixture-password"})}));
vi.mock("imapflow",()=>({ImapFlow:class{connect=m.connect;close=m.close;list=m.list;getMailboxLock=m.lock;search=m.search;fetchOne=m.fetchOne;fetch=m.fetch;append=m.append;messageFlagsRemove=m.remove;messageFlagsAdd=m.add;messageDelete=m.del;}}));
vi.mock("mailparser",()=>({simpleParser:m.parse}));
vi.mock("nodemailer",()=>({default:{createTransport:()=>({sendMail:m.compile})}}));
import {draftHash,gmailThreadState,syncMailboxDraft} from "../mailbox-gmail.mts";
const input={fromEmail:"sender@example.test",credentialId:"secret-id",recipient:"prospect@example.test",subject:"Re: Sujet",text:"Bonjour",messageId:"",inReplyTo:"<parent@test>",references:[],version:2,threadId:"thread",previousId:null,previousHash:null};
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
