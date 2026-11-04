/** SQL predicate for the mailbox_threads alias t. A CRM contact alone is not
 * proof of prospecting: require a confirmed send through the P95 outbox. */
export const prospectionMailboxScope=`t.conversation_id is not null and exists(
 select 1 from app.email_messages seed join app.outbox_jobs origin on origin.message_id=seed.id
 where seed.conversation_id=t.conversation_id and seed.mailbox_thread_id=t.id
  and seed.sender_account_id=t.account_id and seed.direction='outbound' and seed.kind='prospection'
  and seed.technical_confirmation and seed.source in ('application','agent')
  and origin.conversation_id=t.conversation_id and origin.account_id=t.account_id
  and origin.job_kind='prospection' and origin.status='completed')`;
