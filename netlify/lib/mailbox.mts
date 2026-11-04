import { z } from "zod";
import { sqlOne, sqlQuery } from "./db.mts";
import { HttpError, json, parseJson } from "./http.mts";
import { auditEvent } from "./audit.mts";
import type { AdminIdentity } from "./auth.mts";

const summary = `t.id::text, t.account_id::text as "accountId", a.email as "accountEmail",
 t.conversation_id::text as "conversationId",t.prospect_id::text as "prospectId",
 c.campaign_id::text as "campaignId",campaign.name as "campaignName",
 coalesce(nullif(p.full_name,''),t.correspondent) as name,t.correspondent as email,
 org.name as organization,t.subject,t.category,t.archived,t.unread,t.priority,t.needs_reply as "needsReply",
 t.version::int,t.last_message_id::text as "lastMessageId",t.last_message_at as "lastMessageAt",
 left(latest.body_text,180) as snippet,latest.direction as "lastDirection",
 t.last_synced_at as "lastSyncedAt",t.last_error_code as "syncError",
 (select count(*)::int from app.mailbox_sync_jobs q where q.thread_id=t.id and q.status in ('pending','running')) as "pendingSync"`;
const joins = `from app.mailbox_threads t join app.gmail_accounts a on a.id=t.account_id
 left join app.conversations c on c.id=t.conversation_id
 left join app.campaigns campaign on campaign.id=c.campaign_id
 left join app.prospects p on p.id=t.prospect_id left join app.organizations org on org.id=p.organization_id
 left join app.email_messages latest on latest.id=t.last_message_id`;

export async function listMailbox(request: Request): Promise<Response> {
 const params = z.object({account: z.string().uuid().optional(),campaign:z.union([z.string().uuid(),z.literal("none")]).optional(),
  folder:z.enum(["inbox","action","waiting","archive","other"]).default("inbox"),q:z.string().trim().max(300).default(""),
  filter:z.enum(["all","unread","priority"]).default("all"),page:z.coerce.number().int().min(1).max(100000).default(1)
 }).safeParse(Object.fromEntries(new URL(request.url).searchParams));
 if(!params.success) throw new HttpError(400,"invalid_query","Filtres de boîte mail invalides.");
 const v=params.data;
 const scope=`a.deleted_at is null and t.last_message_id is not null
  and ($1::uuid is null or t.account_id=$1::uuid)
  and ($2::text is null or ($2='none' and c.campaign_id is null) or c.campaign_id::text=$2)
  and ($3='' or t.subject ilike '%'||$3||'%' or t.correspondent ilike '%'||$3||'%' or p.full_name ilike '%'||$3||'%'
   or org.name ilike '%'||$3||'%' or exists(select 1 from app.email_messages search
      where search.mailbox_thread_id=t.id and search.body_text ilike '%'||$3||'%'))`;
 const bindings=[v.account??null,v.campaign??null,v.q];
 const folder=`case $4 when 'other' then t.category<>'normal' when 'archive' then t.archived and t.category='normal'
  when 'action' then not t.archived and t.category='normal' and t.needs_reply
  when 'waiting' then not t.archived and t.category='normal' and not t.needs_reply and latest.direction='outbound'
  else not t.archived and t.category='normal' end
  and ($5='all' or $5='unread' and t.unread or $5='priority' and t.priority)`;
 const results=await Promise.all([
  sqlQuery(`select ${summary} ${joins} where ${scope} and ${folder} order by t.last_message_at desc,t.id desc limit 50 offset $6`,[...bindings,v.folder,v.filter,(v.page-1)*50]),
  sqlOne(`select count(*)::int as total ${joins} where ${scope} and ${folder}`,[...bindings,v.folder,v.filter]),
  sqlOne(`select count(*) filter(where t.category='normal' and not t.archived)::int as inbox,
   count(*) filter(where t.category='normal' and not t.archived and t.needs_reply)::int as action,
   count(*) filter(where t.category='normal' and not t.archived and not t.needs_reply and latest.direction='outbound')::int as waiting,
   count(*) filter(where t.category='normal' and t.archived)::int as archive,
   count(*) filter(where t.category<>'normal')::int as other,
   count(*) filter(where t.category='normal' and not t.archived and t.unread)::int as unread
   ${joins} where ${scope}`,bindings),
  sqlQuery(`select a.id::text,a.email,a.status,a.last_sync_at as "lastSyncAt",a.last_error_code as "lastErrorCode",
    coalesce(c.last_uid,0)::text as "lastUid",c.caught_up_at as "caughtUpAt"
   from app.gmail_accounts a left join app.imap_cursors c on c.account_id=a.id and c.mailbox_name='__UNIFIED_ALL__'
   where a.deleted_at is null and a.credential_id is not null order by a.email`)
 ]);
 return json({threads:results[0],total:results[1]?.total??0,counts:results[2],accounts:results[3],page:v.page});
}

export async function mailboxDetail(id:string,request:Request):Promise<Response> {
 const thread=await sqlOne(`select ${summary},t.draft_body as "draftBody",t.draft_version::int as "draftVersion",
  t.draft_synced_version::int as "draftSyncedVersion",t.draft_remote_body as "draftRemoteBody",
  a.status='active' and a.paused_at is null and a.credential_id is not null and not app.is_excluded(t.correspondent)
   and exists(select 1 from app.settings where singleton and outbound_enabled and not emergency_stop) as "canReply",
  c.followups_stopped_at as "followupsStoppedAt",c.next_step_due_at as "nextFollowupAt"
  ${joins} where t.id=$1::uuid and a.deleted_at is null`,[id]);
 if(!thread)throw new HttpError(404,"mailbox_thread_not_found","Conversation introuvable.");
 const before=z.string().uuid().optional().safeParse(new URL(request.url).searchParams.get("before")??undefined);
 if(!before.success)throw new HttpError(400,"invalid_query","Date de pagination invalide.");
 const messages=await sqlQuery(`select * from (
  select distinct on (coalesce(internet_message_id,id::text)) id::text,direction,kind,subject,body_text as body,
    from_address as "from",to_addresses as "to",cc_addresses as cc,status,
    coalesce(received_at,smtp_accepted_at,sent_at,created_at) as at
  from app.email_messages where mailbox_thread_id=$1::uuid
    and (technical_confirmation or status='received')
  order by coalesce(internet_message_id,id::text),technical_confirmation desc,created_at
 ) history where ($2::uuid is null or (at,id)<(select coalesce(received_at,smtp_accepted_at,sent_at,created_at),id::text
   from app.email_messages where id=$2::uuid and mailbox_thread_id=$1::uuid)) order by at desc,id desc limit 51`,[id,before.data??null]);
 const send=await sqlOne(`select j.id::text,j.status::text,j.last_error_code as "errorCode",m.body_text as body
  from app.outbox_jobs j join app.email_messages m on m.id=j.message_id
  where m.mailbox_thread_id=$1::uuid and j.job_kind='mailbox_reply' order by j.created_at desc limit 1`,[id]);
 return json({thread,messages:messages.slice(0,50).reverse(),hasOlder:messages.length>50,send});
}

export async function mailboxMutation(id:string,action:string,request:Request,identity:AdminIdentity,requestId:string):Promise<Response> {
 let result:unknown;
 if(action==="draft") {
  const v=await parseJson(request,z.object({version:z.number().int().positive(),body:z.string().max(100000)}));
  const row=await sqlOne(`with changed as (update app.mailbox_threads set draft_body=$3,draft_version=draft_version+1,version=version+1,draft_updated_at=clock_timestamp(),
     draft_remote_body=case when draft_remote_body=$3 then null else draft_remote_body end
    where id=$1::uuid and draft_version=$2 returning id,draft_version),queued as (
    insert into app.mailbox_sync_jobs(thread_id,kind,payload,idempotency_key)
     select id,'draft',jsonb_build_object('version',draft_version),'draft:'||id||':'||draft_version from changed on conflict do nothing)
    select draft_version::int as version from changed`,[id,v.version,v.body]);
  if(!row)throw new HttpError(409,"mailbox_version_conflict","Le brouillon a changé ailleurs. Votre texte reste dans l’éditeur ; rechargez la version enregistrée avant de réessayer.");
  return json(row);
 } else if(action==="send") {
  const v=await parseJson(request,z.object({version:z.number().int().positive(),lastMessageId:z.string().uuid(),key:z.string().uuid()}));
  try { result=await sqlOne(`select j.id::text,j.status::text from app.mailbox_queue_reply($1::uuid,$2,$3::uuid,$4) j`,[id,v.version,v.lastMessageId,v.key]); }
  catch(error) {
   if(/mailbox_|invalid_idempotency/.test((error as Error).message))throw new HttpError(409,"mailbox_reply_blocked","Envoi non engagé : la conversation a changé, un envoi est déjà en cours ou une protection bloque ce compte. Actualisez le fil ; le brouillon est conservé.");
   throw error;
  }
 } else if(action==="state") {
  const v=await parseJson(request,z.object({version:z.number().int().positive(),unread:z.boolean().optional(),archived:z.boolean().optional(),priority:z.boolean().optional(),needsReply:z.boolean().optional()}));
  const row=await sqlOne(`with changed as (update app.mailbox_threads set unread=coalesce($3,unread),archived=coalesce($4,archived),
    priority=coalesce($5,priority),needs_reply=coalesce($6,needs_reply),version=version+1
    where id=$1::uuid and version=$2 returning id,version),queued as (
     insert into app.mailbox_sync_jobs(thread_id,kind,payload,idempotency_key)
     select changed.id,action.kind,jsonb_build_object('value',action.value),'state:'||changed.id||':'||changed.version||':'||action.kind
     from changed cross join (values('read',$3::boolean),('archive',$4::boolean)) action(kind,value)
     where action.value is not null on conflict do nothing) select version::int from changed`,
      [id,v.version,v.unread??null,v.archived??null,v.priority??null,v.needsReply??null]);
  if(!row)throw new HttpError(409,"mailbox_version_conflict","La conversation a changé. Actualisez-la pour appliquer cette action.");
  result=row;
 } else if(action==="refresh") {
  result=await sqlOne(`update app.mailbox_threads set refresh_requested_at=clock_timestamp() where id=$1::uuid returning id::text`,[id]);
  if(!result)throw new HttpError(404,"mailbox_thread_not_found","Conversation introuvable.");
 } else throw new HttpError(404,"not_found","Action inconnue.");
 await auditEvent({actor:identity.email,requestId,action:`mailbox_${action}`,entityType:"mailbox_thread",entityId:id});
 return json(result,action==="send"||action==="refresh"?202:200);
}
