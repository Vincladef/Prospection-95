import { sqlOne, sqlQuery } from "./db.mts";
import { inspectDraftEvidence } from "./draft-evidence.mts";

/** Retract only a backend-generated draft wrongly ingested from All Mail as Sent. */
export async function recoverFalseSentDraft(): Promise<void> {
  const candidate = await sqlOne<{ id: string; false_message_id: string; email: string; credential_id: string; recipient: string; source_id: string; proposed_body: string }>(`
    select d.id::text,m.id::text as false_message_id,a.email,a.credential_id::text,src.from_address as recipient,
      src.internet_message_id as source_id,d.proposed_body
    from app.reply_draft_requests d join app.reply_workflows w on w.draft_request_id=d.id
    join app.email_messages m on m.id=w.output_message_id join app.email_messages src on src.id=d.source_message_id
    join app.gmail_accounts a on a.id=coalesce(d.gmail_account_id,d.sender_account_id)
    where d.state='sent_manually' and w.state='sent' and m.kind='manual' and m.technical_confirmation
      and m.internet_message_id='<draft-'||d.id::text||'@mail.prospection95.local>'
      and m.imap_mailbox in ('__LIVE_ALL__','__UNIFIED_ALL__') and m.raw_headers->>'sentProof' is null
      and a.status='active' and a.deleted_at is null and a.credential_id is not null
      and coalesce(m.raw_headers->>'sentInspectionFinal','false')<>'true'
    order by d.created_at limit 1`);
  if (!candidate) return;
  const evidence = await inspectDraftEvidence({ email: candidate.email, credentialId: candidate.credential_id,
    messageId: `<draft-${candidate.id}@mail.prospection95.local>`, sourceId: candidate.source_id,
    recipient: candidate.recipient, body: candidate.proposed_body });
  await sqlQuery(`select audit.log_event('backend','draft-evidence-recovery',null::uuid,'gmail_draft_evidence_checked',
    'reply_draft_request',$1::text,null,null,$2::jsonb)`, [candidate.id, JSON.stringify(evidence)]);
  if (evidence.sent) {
    await sqlQuery(`update app.email_messages set raw_headers=raw_headers||'{"sentInspectionFinal":true}'::jsonb where id=$1::uuid`, [candidate.false_message_id]);
    return;
  }
  if (!evidence.draftUid && !evidence.unsentOwnCopy) return;
  const repaired = await sqlQuery(`with target as (
    select d.id,w.id as workflow_id,m.id as message_id,d.conversation_id from app.reply_draft_requests d
    join app.reply_workflows w on w.draft_request_id=d.id join app.email_messages m on m.id=w.output_message_id
    join app.email_messages src on src.id=d.source_message_id
    where d.id=$1::uuid and m.id=$2::uuid and d.state='sent_manually' and w.state='sent'
      and m.kind='manual' and m.technical_confirmation and m.imap_mailbox in ('__LIVE_ALL__','__UNIFIED_ALL__')
      and m.internet_message_id='<draft-'||d.id::text||'@mail.prospection95.local>'
      and not exists(select 1 from app.email_messages other where other.conversation_id=d.conversation_id
        and other.id<>m.id and other.direction='outbound' and other.kind='manual' and other.technical_confirmation
        and coalesce(other.sent_at,other.created_at)>=coalesce(src.received_at,src.created_at))
    for update of d,w,m
  ), retracted as (
    update app.email_messages m set technical_confirmation=false,status='cancelled',kind='unrelated',sent_at=null,smtp_accepted_at=null,
      raw_headers=m.raw_headers||jsonb_build_object('falseSentRetracted',true,'originalInternetMessageId',m.internet_message_id,
        'originalImapMailbox',m.imap_mailbox,'originalImapUid',m.imap_uid,'originalSentAt',m.sent_at,'gmailDraftEvidence',$3::jsonb),
      internet_message_id=null,imap_uid=null,imap_uidvalidity=null,imap_mailbox=null,gmail_message_id=null,gmail_thread_id=null
    from target t where m.id=t.message_id returning t.id,t.workflow_id,t.conversation_id,m.id as message_id
  ), reopened as (
    update app.reply_draft_requests d set state='requested',lease_token=null,lease_expires_at=null,last_checked_at=null,
      attempt_count=0,last_error_code=null,updated_at=clock_timestamp()
    from retracted t where d.id=t.id returning t.*
  ), workflows as (
    update app.reply_workflows w set state='draft_requested',output_message_id=null,updated_at=clock_timestamp()
    from reopened t where w.id=t.workflow_id returning w.id
  )
  update app.conversations c set state=case when c.state='active' then 'replied' else c.state end,
    last_outbound_at=(select max(coalesce(m.smtp_accepted_at,m.sent_at)) from app.email_messages m
      where m.conversation_id=c.id and m.direction='outbound' and m.technical_confirmation and m.id<>t.message_id),
    version=c.version+1,updated_at=clock_timestamp()
  from reopened t where c.id=t.conversation_id returning c.id::text`, [candidate.id, candidate.false_message_id, JSON.stringify(evidence)]);
  if (repaired.length) await sqlQuery(`select audit.log_event('backend','draft-evidence-recovery',null::uuid,
    'false_draft_send_retracted','reply_draft_request',$1::text,null,null,$2::jsonb)`, [candidate.id, JSON.stringify(evidence)]);
}
