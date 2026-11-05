/** SQL predicate for the mailbox_threads alias t. A CRM contact alone is not
 * proof of prospecting: require a confirmed send through the P95 outbox. */
const confirmedSeed=`seed.conversation_id=t.conversation_id and seed.mailbox_thread_id=t.id
  and seed.sender_account_id=t.account_id and seed.direction='outbound' and seed.kind='prospection'
  and seed.technical_confirmation and seed.source in ('application','agent')
  and origin.conversation_id=t.conversation_id and origin.account_id=t.account_id
  and origin.job_kind='prospection' and origin.status='completed'`;
export const prospectionMailboxScope=`t.conversation_id is not null and exists(
 select 1 from app.email_messages seed join app.outbox_jobs origin on origin.message_id=seed.id
 where ${confirmedSeed})`;

/** Follow actual message/thread identities, never a matching contact address.
 * UNION deduplicates each message and terminates even for malformed RFC cycles. */
export const prospectionLinkedMessageIds=`with recursive verified(id,internet_id,gmail_thread,mailbox_account) as (
 select seed.id,seed.internet_message_id,seed.gmail_thread_id,seed.mailbox_account_id
 from app.email_messages seed join app.outbox_jobs origin on origin.message_id=seed.id where ${confirmedSeed}
 union
 select child.id,child.internet_message_id,child.gmail_thread_id,child.mailbox_account_id
 from app.email_messages child join verified parent on (
  child.in_reply_to=parent.internet_id or parent.internet_id=any(child.references_header)
  or child.internet_message_id=parent.internet_id
  or (child.gmail_thread_id=parent.gmail_thread and child.mailbox_account_id=parent.mailbox_account))
 where child.mailbox_thread_id=t.id and (child.technical_confirmation or child.status='received')
) select id from verified`;

export const mailboxLatestCategory=`case when latest.raw_headers->>'warmup'='true' then 'warmup'
 when latest.kind in ('automatic_reply','out_of_office','bounce') then 'automatic' else 'normal' end`;
export const mailboxNeedsReply=`case when latest.id=t.last_message_id then t.needs_reply
 else latest.direction='inbound' and latest.kind in ('reply','unrelated') end`;
