import { randomUUID } from "node:crypto";
import type { Config, Context } from "@netlify/functions";
import { sqlOne, sqlQuery } from "../lib/db.mts";
import { createGmailDraft } from "../lib/gmail.mts";
import { refreshConversation } from "../lib/mailbox-sync.mts";
import { workerFailure, workerResult } from "../lib/worker-response.mts";

interface DraftRequest {
  id: string;
  state: string;
  conversation_id: string;
  lease_token: string;
  proposed_subject: string;
  proposed_body: string;
  sender_email: string;
  sender_name: string | null;
  credential_email: string;
  gmail_account_id: string;
  credential_id: string;
  recipient: string;
  source_message_id_header: string | null;
  source_references: string[];
}

export default async function syncDrafts(_request: Request, _context: Context): Promise<Response> {
  const worker = `netlify-drafts-${randomUUID()}`;
  let draft: DraftRequest | null = null;
  try {
    draft = await sqlOne<DraftRequest>(`
      with candidate as (
        select r.id, primary_account.id as gmail_account_id
        from app.reply_draft_requests r
        join app.gmail_accounts alias_account on alias_account.id=r.sender_account_id
        join lateral (
          select p.id from app.gmail_accounts p
          where p.status='active' and p.paused_at is null and p.deleted_at is null and p.credential_id is not null
            and (p.id=r.gmail_account_id or r.gmail_account_id is null and (p.role='primary' or p.id=alias_account.id))
          order by case when p.role='primary' then 0 else 1 end,p.created_at limit 1
        ) primary_account on true
        where r.state in ('requested','failed','created') and app.reply_source_is_current(r.source_message_id)
          and alias_account.status='active' and alias_account.paused_at is null and alias_account.deleted_at is null
          and (r.lease_expires_at is null or r.lease_expires_at<clock_timestamp())
          and (r.last_checked_at is null or r.last_checked_at<clock_timestamp()-
            make_interval(mins=>case when r.state='created' then 15 else least(60,5*power(2,least(r.attempt_count,4))::integer) end))
        order by case when r.state='created' then 1 else 0 end,r.last_checked_at nulls first,r.created_at for update of r skip locked limit 1
      ), claimed as (
        update app.reply_draft_requests r set last_checked_at=clock_timestamp(),
          lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '4 minutes',
          gmail_account_id=candidate.gmail_account_id,attempt_count=attempt_count+1
        from candidate where r.id=candidate.id returning r.*
      )
      select claimed.id::text,claimed.state,claimed.conversation_id::text,claimed.lease_token::text,
             claimed.proposed_subject,claimed.proposed_body,
             alias_account.email as sender_email,alias_account.display_name as sender_name,
             primary_account.email as credential_email,primary_account.id::text as gmail_account_id,
             primary_account.credential_id::text,source.from_address as recipient,
             source.internet_message_id as source_message_id_header,source.references_header as source_references
      from claimed join app.gmail_accounts alias_account on alias_account.id=claimed.sender_account_id
      join app.gmail_accounts primary_account on primary_account.id=claimed.gmail_account_id
      join app.email_messages source on source.id=claimed.source_message_id
    `);
    if (!draft) return workerResult(worker, { ok: true, claimed: 0 });
    // Catch a newer inbound or a manual answer before creating an obsolete draft.
    await refreshConversation(draft.conversation_id);
    const current = await sqlOne<{ id: string; source_thread_id: string | null }>(`select d.id::text,src.gmail_thread_id as source_thread_id
      from app.reply_draft_requests d join app.email_messages src on src.id=d.source_message_id
      where d.id=$1::uuid and d.lease_token=$2::uuid and d.lease_expires_at>clock_timestamp()
        and d.state in ('requested','failed','created') and app.reply_source_is_current(d.source_message_id)`, [draft.id,draft.lease_token]);
    if (!current) {
      await sqlQuery(`update app.reply_draft_requests set state=case when state in ('requested','failed','created') then 'stale' else state end,
        lease_token=null,lease_expires_at=null where id=$1::uuid and lease_token=$2::uuid`, [draft.id,draft.lease_token]);
      return workerResult(worker,{ok:true,draftId:draft.id,state:"stale"});
    }
    const references = [...draft.source_references];
    if (draft.source_message_id_header && !references.includes(draft.source_message_id_header)) references.push(draft.source_message_id_header);
    const result = await createGmailDraft({
      fromEmail: draft.sender_email,credentialEmail: draft.credential_email,fromName: draft.sender_name,
      credentialId: draft.credential_id,recipient: draft.recipient,subject: draft.proposed_subject,text: draft.proposed_body,
      sourceThreadId:current.source_thread_id,checkOnly:draft.state==="created",
      messageId: `<draft-${draft.id}@mail.prospection95.local>`,inReplyTo: draft.source_message_id_header,references,
    });
    if (result.alreadySent) await refreshConversation(draft.conversation_id);
    await sqlQuery(`update app.reply_draft_requests set state=case
        when $3 then 'sent_manually' when $5 then 'dismissed' when not app.reply_source_is_current(source_message_id) then 'stale' else 'created' end,
        gmail_draft_id=coalesce($4,gmail_draft_id),attempt_count=0,last_error_code=null,last_checked_at=clock_timestamp(),lease_token=null,lease_expires_at=null
      where id=$1::uuid and lease_token=$2::uuid and state in ('requested','failed','created','stale')`,
    [draft.id,draft.lease_token,!!result.alreadySent,result.uid ? `imap:${result.mailbox}:${result.uid}` : null,!!result.missing]);
    if (result.missing) await sqlQuery(`update app.reply_workflows set state='cancelled',updated_at=clock_timestamp()
      where draft_request_id=$1::uuid and state='draft_requested'`,[draft.id]);
    await sqlQuery(`select audit.log_event('backend',$1,$2::uuid,'gmail_draft_reconciled','reply_draft_request',$3,null,null,
      jsonb_build_object('threadingVerified',false,'mailbox',$4::text,'alreadySent',$5::boolean))`,
    [worker,randomUUID(),draft.id,result.mailbox,!!result.alreadySent]).catch(() => {
      console.error("gmail_draft_audit_failed", { worker, draftId: draft?.id });
    });
    return workerResult(worker, { ok: true, draftId: draft.id, threadingVerified: false, alreadySent: !!result.alreadySent });
  } catch (error) {
    if (draft) {
      const code=String((error as { code?: unknown }).code ?? (error as Error).message ?? "gmail_draft_sync_failed")
        .toLowerCase().replace(/[^a-z0-9_]+/g,"_").slice(0,120);
      // A lost APPEND acknowledgement is retried through a stable-ID search.
      // Keep failed attempts visible and never overwrite a superseded/sent state.
      await sqlQuery(`update app.reply_draft_requests set state=case when state='created' then state else 'failed' end,last_error_code=$3,
        last_checked_at=clock_timestamp(),lease_token=null,lease_expires_at=null
        where id=$1::uuid and lease_token=$2::uuid and state in ('requested','failed','created')`,
      [draft.id,draft.lease_token,code]).catch(() => undefined);
    }
    return workerFailure(worker, error);
  }
}

export const config: Config = { schedule: "*/10 * * * *", background: true };
