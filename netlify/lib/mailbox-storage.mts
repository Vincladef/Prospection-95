import { sqlOne, sqlQuery } from "./db.mts";
import { classifyOperationalMessage, type SyncedMessage } from "./imap.mts";
import {draftHash} from "./mailbox-gmail.mts";

// Standalone exchanges share the existing message store. No fake CRM prospect or
// campaign is created just to render a Gmail conversation.
export async function recordStandaloneMessage(accountId:string,accountEmail:string,m:SyncedMessage,outgoing:boolean):Promise<string|null> {
 if(!m.from[0] || !m.internetMessageId || !m.date)return null;
 const correspondent=outgoing?m.to.find(a=>a.toLowerCase()!==accountEmail.toLowerCase()):m.from[0];
 if(!correspondent)return null;
 const existing=await sqlOne<{id:string}>(`select t.id::text from app.mailbox_threads t
  where t.account_id=$1::uuid and (t.remote_key=$2 or exists(select 1 from app.email_messages e
    where e.mailbox_thread_id=t.id and e.internet_message_id=any($3::text[])))
  order by t.last_message_at desc limit 1`,[accountId,`gmail:${m.gmailThreadId??m.internetMessageId}`,[m.inReplyTo,...m.references].filter(Boolean)]);
 const operational=classifyOperationalMessage(m)!=="human_or_unknown";
 // Bulk newsletters unrelated to the CRM are never copied into the database.
 if(operational&&!existing&&!m.warmup)return null;
 const t=existing??await sqlOne<{id:string}>(`insert into app.mailbox_threads(account_id,remote_key,correspondent,prospect_id,category)
  values($1::uuid,$2,$3,(select id from app.prospects where normalized_email=app.canonical_email($3) and deleted_at is null limit 1),$4)
  on conflict(account_id,remote_key) do update set correspondent=excluded.correspondent returning id::text`,
  [accountId,`gmail:${m.gmailThreadId??m.internetMessageId}`,correspondent,m.warmup?"warmup":operational?"automatic":"normal"]);
 if(!t)return null;
 const metadata=JSON.stringify({warmup:!!m.warmup,unread:m.unread??false,archived:m.archived??false});
 const saved=outgoing?await sqlOne<{id:string}>(`select (app.record_sent_message(
  $1::uuid,null,$2,$3::text[],$4,$5,$6,$7,$8,$9::text[],$10,$11::bigint,$12::bigint,$13::timestamptz,$14::jsonb)).id::text as id`,
  [accountId,m.from[0],m.to,m.subject,m.text,m.html,m.internetMessageId,m.inReplyTo,m.references,m.mailbox,m.uidValidity,m.uid,m.date,metadata])
  :await sqlOne<{id:string}>(`select (app.record_inbound_message($1::uuid,null,$2,$3,$4::text[],$5,$6,$7,'{}'::text[],$8,$9,$10::text[],
    $11,$12,$13,$14::bigint,$15::bigint,null,$16::timestamptz,$17::jsonb)).id::text as id`,
    [accountId,operational?"automatic_reply":"unrelated",m.from[0],m.to.length?m.to:[accountEmail],m.subject,m.text,m.html,m.internetMessageId,
     m.inReplyTo,m.references,m.gmailThreadId??null,m.gmailMessageId??null,m.mailbox,m.uidValidity,m.uid,m.date,metadata]);
 if(saved){
  await sqlQuery(`update app.email_messages set mailbox_thread_id=$2::uuid,gmail_thread_id=coalesce(gmail_thread_id,$3),gmail_message_id=coalesce(gmail_message_id,$4)
   where id=$1::uuid and mailbox_thread_id is null`,[saved.id,t.id,m.gmailThreadId??null,m.gmailMessageId??null]);
  await observeMailboxMessage(accountId,m,saved.id);
 }
 return saved?.id??null;
}

export async function observeMailboxMessage(accountId:string,m:SyncedMessage,messageId:string):Promise<void> {
 await sqlQuery(`update app.email_messages set gmail_thread_id=coalesce(gmail_thread_id,$3),gmail_message_id=coalesce(gmail_message_id,$4),
  raw_headers=raw_headers||$5::jsonb where id=$1::uuid and $2::uuid is not null`,[messageId,accountId,m.gmailThreadId??null,m.gmailMessageId??null,
  JSON.stringify({warmup:!!m.warmup,unread:m.unread??false,archived:m.archived??false})]);
 await sqlQuery(`with changed as (update app.mailbox_threads t set draft_body='',draft_version=draft_version+1,
   draft_remote_body=null,version=version+1 where t.account_id=$2::uuid and t.gmail_draft_hash=$3
   and t.draft_synced_version=t.draft_version and t.draft_body<>'' and t.draft_updated_at<=$4::timestamptz
   and exists(select 1 from app.email_messages e where e.id=$1::uuid and e.mailbox_thread_id=t.id and e.direction='outbound' and e.technical_confirmation)
   returning t.id,t.draft_version)
   insert into app.mailbox_sync_jobs(thread_id,kind,payload,idempotency_key)
   select id,'draft',jsonb_build_object('version',draft_version),'gmail-sent-draft:'||$1::uuid from changed on conflict do nothing`,
  [messageId,accountId,draftHash(m.text??""),m.date]);
 // Flag reconciliation on the owning account is done by the unified worker.
 // Primary-inbox copies must not alter the sender account's read/archive state.
}
