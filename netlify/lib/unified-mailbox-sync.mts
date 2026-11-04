import { sqlOne,sqlQuery } from "./db.mts";
import { gmailThreadState,syncMailboxDraft } from "./mailbox-gmail.mts";
import { fetchMailboxDelta } from "./imap.mts";
import { recordMailboxMessages } from "./mailbox-sync.mts";

interface ThreadContext {
 id:string;account_id:string;email:string;credential_id:string;correspondent:string;subject:string;
 thread_id:string|null;identifiers:string[];draft_body:string;draft_version:number;draft_synced_version:number;
 gmail_draft_message_id:string|null;gmail_draft_hash:string|null;
 parent_id:string|null;parent_references:string[];history_uid:number;history_uidvalidity:string|null;
}
async function context(id:string):Promise<ThreadContext|null>{
 return sqlOne<ThreadContext>(`select t.*,t.id::text,t.account_id::text,a.email,a.credential_id::text,
  t.draft_version::int,t.draft_synced_version::int,
  (select e.gmail_thread_id from app.email_messages e where e.mailbox_thread_id=t.id
    and e.mailbox_account_id=t.account_id and e.gmail_thread_id is not null order by e.created_at desc limit 1) as thread_id,
  array(select distinct internet_message_id from app.email_messages where mailbox_thread_id=t.id and internet_message_id is not null limit 100) as identifiers,
  parent.internet_message_id as parent_id,parent.references_header as parent_references
  from app.mailbox_threads t join app.gmail_accounts a on a.id=t.account_id
  left join app.email_messages parent on parent.id=t.last_message_id
  where t.id=$1::uuid and a.deleted_at is null and a.credential_id is not null`,[id]);
}
export async function refreshUnifiedConversation(id:string):Promise<void>{
 const t=await context(id);if(!t)throw new Error("gmail_account_unavailable");
 const state=await gmailThreadState({email:t.email,credentialId:t.credential_id,threadId:t.thread_id,identifiers:t.identifiers});
 const delta=await fetchMailboxDelta({email:t.email,credentialId:t.credential_id,cursor:{mailbox:"__UNIFIED_ALL__",lastUid:0},
  maxMessages:100,...(state.threadId?{threadId:state.threadId}:{correspondent:t.correspondent})});
 await recordMailboxMessages({id:t.account_id,email:t.email,credentialId:t.credential_id},delta.messages);
 if(delta.hasMore!==false)throw new Error("gmail_thread_check_incomplete");
}
export async function syncThreadDraft(t:ThreadContext):Promise<void>{
 // Don't recreate a draft whose send has already been explicitly queued.
 const sending=await sqlOne(`select j.id from app.outbox_jobs j join app.email_messages m on m.id=j.message_id
  where m.mailbox_thread_id=$1::uuid and j.job_kind='mailbox_reply' and j.status not in ('completed','failed','cancelled') limit 1`,[t.id]);
 if(sending)return;
 const result=await syncMailboxDraft({fromEmail:t.email,credentialId:t.credential_id,recipient:t.correspondent,subject:/^re:/i.test(t.subject)?t.subject:`Re: ${t.subject}`,
  text:t.draft_body,messageId:"",inReplyTo:t.parent_id,references:t.parent_id?[...(t.parent_references??[]),t.parent_id]:t.parent_references??[],
  version:t.draft_version,threadId:t.id,previousId:t.gmail_draft_message_id,previousHash:t.gmail_draft_hash});
 await sqlQuery(`update app.mailbox_threads set gmail_draft_message_id=$3,gmail_draft_hash=$4,
   draft_remote_body=case when draft_version=$2 then $5 else draft_remote_body end,
   draft_synced_version=case when $5::text is null then $2 else draft_synced_version end,
   last_error_code=case when $5::text is null then null else 'gmail_draft_changed' end
  where id=$1::uuid`,[t.id,t.draft_version,result.messageId,result.hash,result.remoteBody??null]);
}

export async function processMailboxJob():Promise<boolean>{
 const job=await sqlOne<{id:string;thread_id:string;kind:"read"|"archive"|"draft"|"refresh";payload:{value?:boolean;version?:number};lease_token:string}>(`
  with candidate as (select j.id from app.mailbox_sync_jobs j join app.mailbox_threads t on t.id=j.thread_id
   where ((j.status='pending' and j.due_at<=clock_timestamp()) or (j.status='running' and j.lease_expires_at<clock_timestamp()))
    and (t.sync_lease_expires_at is null or t.sync_lease_expires_at<clock_timestamp())
    and not exists(select 1 from app.mailbox_sync_jobs older where older.thread_id=j.thread_id
      and (older.created_at,older.id)<(j.created_at,j.id) and older.status in ('pending','running'))
   order by j.created_at,j.id for update of j,t skip locked limit 1),claimed as (
  update app.mailbox_sync_jobs j set status='running',lease_token=gen_random_uuid(),
   lease_expires_at=clock_timestamp()+interval '3 minutes',attempts=attempts+1 from candidate where j.id=candidate.id
  returning j.*),held as (update app.mailbox_threads t set sync_lease_token=c.lease_token,sync_lease_expires_at=c.lease_expires_at
   from claimed c where t.id=c.thread_id returning t.id)
  select c.id::text,c.thread_id::text,c.kind,c.payload,c.lease_token::text from claimed c join held h on h.id=c.thread_id`);
 if(!job)return false;
 try {
  const t=await context(job.thread_id);if(!t)throw new Error("gmail_account_unavailable");
  if(job.kind==="draft"){
   if(Number(job.payload.version)===t.draft_version)await syncThreadDraft(t);
  }else if(job.kind==="read"||job.kind==="archive"){
   await gmailThreadState({email:t.email,credentialId:t.credential_id,threadId:t.thread_id,identifiers:t.identifiers,action:job.kind,value:job.payload.value});
  }
  await sqlQuery(`update app.mailbox_sync_jobs set status='completed',completed_at=clock_timestamp(),lease_expires_at=null,error_code=null
    where id=$1::uuid and lease_token=$2::uuid`,[job.id,job.lease_token]);
  await sqlQuery(`update app.mailbox_sync_jobs older set status='completed',completed_at=clock_timestamp()
   where older.thread_id=$1::uuid and older.kind=$2 and older.status='failed'
    and older.created_at<(select created_at from app.mailbox_sync_jobs where id=$3::uuid)`,[job.thread_id,job.kind,job.id]);
  await sqlQuery(`update app.mailbox_threads set last_error_code=case when draft_remote_body is not null then 'gmail_draft_changed'
    when exists(select 1 from app.mailbox_sync_jobs where thread_id=$1::uuid and status='failed') then 'gmail_sync_failed' else null end,
   refresh_requested_at=clock_timestamp() where id=$1::uuid`,[job.thread_id]);
 }catch(error){
  const code=(error as Error).message.match(/^[a-z_]{3,80}$/)?.[0]??"gmail_sync_failed";
  await sqlQuery(`update app.mailbox_sync_jobs set status=case when attempts>=8 then 'failed' else 'pending' end,
    due_at=clock_timestamp()+make_interval(secs=>least(3600,30*power(2,least(attempts,7)))::int),
    lease_expires_at=null,error_code=$3 where id=$1::uuid and lease_token=$2::uuid`,[job.id,job.lease_token,code]);
  await sqlQuery(`update app.mailbox_threads set last_error_code=$2 where id=$1::uuid`,[job.thread_id,code]);
 }finally{
  await sqlQuery(`update app.mailbox_threads set sync_lease_token=null,sync_lease_expires_at=null where id=$1::uuid and sync_lease_token=$2::uuid`,[job.thread_id,job.lease_token]);
 }
 return true;
}

export async function refreshMailboxThread():Promise<boolean>{
 const selected=await sqlOne<{id:string;token:string}>(`with candidate as (
  select t.id from app.mailbox_threads t join app.gmail_accounts a on a.id=t.account_id
  where a.deleted_at is null and a.credential_id is not null and a.status in ('active','suspended')
   and (t.refresh_attempt_at is null or t.refresh_attempt_at<clock_timestamp()-interval '2 minutes')
   and (t.sync_lease_expires_at is null or t.sync_lease_expires_at<clock_timestamp())
   and (t.last_synced_at is null or t.last_synced_at<clock_timestamp()-interval '5 minutes'
    or t.refresh_requested_at>t.refresh_attempt_at or not t.history_complete)
   and not exists(select 1 from app.mailbox_sync_jobs j where j.thread_id=t.id and j.status in ('pending','running'))
  order by (t.refresh_requested_at>coalesce(t.refresh_attempt_at,'epoch')) desc nulls last,t.last_synced_at nulls first,t.last_message_at desc
  for update of t skip locked limit 1)
  update app.mailbox_threads t set refresh_attempt_at=clock_timestamp(),sync_lease_token=gen_random_uuid(),sync_lease_expires_at=clock_timestamp()+interval '4 minutes'
  from candidate where t.id=candidate.id returning t.id::text,t.sync_lease_token::text as token`);
 if(!selected)return false;
 try{
  const t=await context(selected.id);if(!t)return true;
  const state=await gmailThreadState({email:t.email,credentialId:t.credential_id,threadId:t.thread_id,identifiers:t.identifiers});
  const delta=await fetchMailboxDelta({email:t.email,credentialId:t.credential_id,cursor:{mailbox:"__UNIFIED_ALL__",lastUid:Number(t.history_uid),uidValidity:t.history_uidvalidity},
   maxMessages:25,...(state.threadId?{threadId:state.threadId}:{correspondent:t.correspondent})});
  await recordMailboxMessages({id:t.account_id,email:t.email,credentialId:t.credential_id},delta.messages);
  await sqlQuery(`update app.mailbox_threads set unread=$2,archived=$3,last_synced_at=clock_timestamp(),
   last_error_code=case when draft_remote_body is not null then 'gmail_draft_changed'
    when exists(select 1 from app.mailbox_sync_jobs where thread_id=$1::uuid and status='failed') then 'gmail_sync_failed' else null end,
   history_uid=$4::bigint,history_uidvalidity=$5,history_complete=$6,version=version+1
   where id=$1::uuid and not exists(select 1 from app.mailbox_sync_jobs j where j.thread_id=$1::uuid and j.status in ('pending','running'))`,
    [t.id,state.unread,state.archived,delta.lastUid,delta.uidValidity,!delta.hasMore]);
  // Discover/import edits made in Gmail, preserving the app editor on conflict.
  if(t.draft_synced_version===t.draft_version||t.draft_synced_version===0)await syncThreadDraft(t);
 }catch(error){
  const code=(error as Error).message.match(/^[a-z_]{3,80}$/)?.[0]??"gmail_refresh_failed";
  await sqlQuery(`update app.mailbox_threads set last_error_code=$2,last_synced_at=clock_timestamp() where id=$1::uuid`,[selected.id,code]);
 }finally{
  await sqlQuery(`update app.mailbox_threads set sync_lease_token=null,sync_lease_expires_at=null where id=$1::uuid and sync_lease_token=$2::uuid`,[selected.id,selected.token]);
 }
 return true;
}
