import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { ImapFlow, type SearchObject } from "imapflow";
import nodemailer from "nodemailer";
import { simpleParser } from "mailparser";
import { readCredential } from "./credentials.mts";
import type { OutboundEmail } from "./gmail.mts";

export function draftHash(body:string):string {return createHash("sha256").update(body.replace(/\r\n/g,"\n").trimEnd()).digest("hex");}
export async function withMailboxClient<T>(email:string,credentialId:string,run:(client:ImapFlow)=>Promise<T>):Promise<T> {
 const credential=await readCredential(credentialId);
 if(!["gmail_sender","gmail_primary","test_inbox"].includes(credential.kind))throw new Error("gmail_credential_kind");
 const address=await lookup("imap.gmail.com",{family:4});
 const client=new ImapFlow({host:address.address,servername:"imap.gmail.com",port:993,secure:true,
  auth:{user:email,pass:credential.secret.replace(/\s+/g,"")},logger:false,disableAutoIdle:true,
  connectionTimeout:20000,greetingTimeout:15000,socketTimeout:30000});
 const timeout=setTimeout(()=>client.close(),45000);
 try {await client.connect();return await run(client);}finally{clearTimeout(timeout);client.close();}
}
export async function gmailThreadState(input:{email:string;credentialId:string;threadId:string|null;identifiers:string[];action?:"read"|"archive";value?:boolean}):Promise<{unread:boolean;archived:boolean;threadId:string|null}> {
 return withMailboxClient(input.email,input.credentialId,async client=>{
  const all=(await client.list()).find(b=>b.specialUse==="\\All");
  if(!all)throw new Error("gmail_all_mailbox_not_found");
  const lock=await client.getMailboxLock(all.path,{readOnly:!input.action});
  try {
   let query:SearchObject=input.threadId?{threadId:input.threadId}:{or:input.identifiers.map(id=>({header:{"Message-ID":id}}))};
   if(!input.threadId&&!input.identifiers.length)throw new Error("gmail_thread_identity_missing");
   let ids=await client.search({...query,draft:false,deleted:false},{uid:true});
   if(!Array.isArray(ids)||!ids.length)throw new Error("gmail_thread_not_found");
   let threadId=input.threadId;
   if(!threadId){const first=await client.fetchOne(String(ids[0]),{threadId:true},{uid:true});
    if(first&&first.threadId){threadId=first.threadId;query={threadId};ids=await client.search({...query,draft:false,deleted:false},{uid:true});}}
   if(!Array.isArray(ids)||!ids.length)throw new Error("gmail_thread_not_found");
   const range=ids.join(",");
   if(input.action){
    const flags=input.action==="read"?["\\Seen"]:["\\Inbox"];
    const remove=input.value===true;
    const ok=remove?await client.messageFlagsRemove(range,flags,{uid:true,useLabels:input.action==="archive"})
      :await client.messageFlagsAdd(range,flags,{uid:true,useLabels:input.action==="archive"});
    if(!ok)throw new Error("gmail_state_change_unconfirmed");
   }
   let unread=false,inbox=false,count=0;
   for await(const m of client.fetch(range,{flags:true,labels:true},{uid:true})){
    if(!m.flags||!m.labels)throw new Error("gmail_thread_flags_missing");
    count++;unread ||= !m.flags.has("\\Seen");inbox ||= m.labels.has("\\Inbox");
   }
   if(count!==ids.length)throw new Error("gmail_thread_snapshot_incomplete");
   return {unread,archived:!inbox,threadId};
  }finally{lock.release();}
 });
}

export async function syncMailboxDraft(input:OutboundEmail & {mode:"observe"|"save";version:number;threadId:string;previousId:string|null;previousHash:string|null}):Promise<{messageId:string|null;hash:string|null;remoteBody?:string}> {
 return withMailboxClient(input.fromEmail,input.credentialId,async client=>{
  const boxes=await client.list();const box=boxes.find(b=>b.specialUse==="\\Drafts");
  if(!box)throw new Error("gmail_drafts_mailbox_not_found");
  const lock=await client.getMailboxLock(box.path,{readOnly:input.mode==="observe"});
  try {
   const messageId=`<mailbox-draft-${input.threadId}-v${input.version}@mail.prospection95.local>`;
   const already=await client.search({header:{"Message-ID":messageId},deleted:false},{uid:true});
   if(!Array.isArray(already))throw new Error("gmail_draft_search_unconfirmed");
   if(already.length){
    const own=await client.fetchOne(String(already[0]),{source:true},{uid:true});
    if(!own||!own.source)throw new Error("gmail_draft_source_missing");
    const parsed=await simpleParser(own.source,{skipImageLinks:true});
    if(draftHash(parsed.text??"")!==draftHash(input.text))return {messageId,hash:draftHash(parsed.text??""),remoteBody:parsed.text??""};
    if(input.mode==="observe")return {messageId,hash:draftHash(parsed.text??"")};
   }
   let oldIds:number[]=[];
   if(input.previousId){
    const found=await client.search({header:{"Message-ID":input.previousId},deleted:false},{uid:true});
    if(!Array.isArray(found))throw new Error("gmail_draft_search_unconfirmed");oldIds=found;
    if(found.length){const current=await client.fetchOne(String(found[0]),{source:true},{uid:true});
     if(!current||!current.source)throw new Error("gmail_draft_source_missing");
     const body=(await simpleParser(current.source,{skipImageLinks:true})).text??"";
     // An imported Gmail/AI draft is not permission to replace it with the
     // local editor, which may still be empty on every background refresh.
     if(input.mode==="observe")return {messageId:input.previousId,hash:draftHash(body),
      ...(draftHash(body)!==draftHash(input.text)?{remoteBody:body}:{})};
     if(input.previousHash&&draftHash(body)!==input.previousHash)return {messageId:input.previousId,hash:draftHash(body),remoteBody:body};
    }else if(input.previousHash&&!already.length){
     // Deletion (including a Gmail send) is an external edit too. Do not
     // resurrect a draft that disappeared from Gmail behind the app's back.
     return {messageId:null,hash:null,remoteBody:""};
    }
   } else if(input.inReplyTo&&!already.length){
    // A Gmail draft already being edited belongs to the user. Import it before
    // allowing an app edit to replace it; never delete an unidentified draft.
    const found=await client.search({header:{"In-Reply-To":input.inReplyTo},to:input.recipient,deleted:false},{uid:true});
    if(!Array.isArray(found))throw new Error("gmail_draft_search_unconfirmed");
    if(found.length){const current=await client.fetchOne(String(found[0]),{source:true},{uid:true});
     if(current&&current.source){const parsed=await simpleParser(current.source,{skipImageLinks:true});
      if(parsed.messageId)return {messageId:parsed.messageId,hash:draftHash(parsed.text??""),remoteBody:parsed.text??""};}}
   }
   // Observation never APPENDs, replaces or deletes a Gmail draft. Only a
   // versioned editor save job is allowed to reach the mutation below.
   if(input.mode==="observe")return {messageId:null,hash:null};
   if(input.text.trim()){
    if(!already.length){
     const transport=nodemailer.createTransport({streamTransport:true,buffer:true,newline:"unix"});
     const mail=await transport.sendMail({from:input.fromEmail,to:input.recipient,subject:input.subject,text:input.text,
      messageId,inReplyTo:input.inReplyTo??undefined,references:input.references,date:new Date()});
     const appended=await client.append(box.path,mail.message as Buffer,["\\Draft"]);
     if(!appended||!appended.uid)throw new Error("gmail_draft_append_unconfirmed");
    }
   }
   if(oldIds.length&&(!input.text.trim()||input.previousId!==messageId)){
    if(!await client.messageDelete(oldIds,{uid:true}))throw new Error("gmail_draft_replace_unconfirmed");
   }
   return {messageId:input.text.trim()?messageId:null,hash:input.text.trim()?draftHash(input.text):null};
  }finally{lock.release();}
 });
}
