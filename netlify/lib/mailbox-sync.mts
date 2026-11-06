import { sqlOne, sqlQuery } from "./db.mts";
import { classifyOperationalMessage, fetchMailboxDelta, type SyncedMessage } from "./imap.mts";
import { observeMailboxMessage, recordStandaloneMessage } from "./mailbox-storage.mts";

export interface MailboxAccount { id: string; email: string; credentialId: string }

export async function matchingConversation(accountId: string, accountEmail: string, message: SyncedMessage, sentMailbox: boolean): Promise<string | null> {
  const identifiers = [message.internetMessageId, message.prospectionMessageId, message.inReplyTo, ...message.references].filter((value): value is string => !!value);
  const correspondents = sentMailbox
    ? message.to.filter((value) => value.toLowerCase() !== accountEmail.toLowerCase())
    : message.from;
  const row = await sqlOne<{ id: string }>(`
    select candidate.id::text from (
      select conv.id, 0 as priority, m.created_at
      from app.conversations conv
      join app.email_messages m on m.conversation_id = conv.id
      where (conv.sender_account_id = $1::uuid or exists(select 1 from app.gmail_accounts a where a.id=$1::uuid and a.role='primary'))
        and (m.internet_message_id = any($2::text[]) or ($4::text is not null and m.mailbox_account_id=$1::uuid and m.gmail_thread_id=$4))
      union all
      select conv.id, 0 as priority, d.created_at from app.reply_draft_requests d
      join app.conversations conv on conv.id=d.conversation_id
      where d.id::text=$5 and (d.gmail_account_id=$1::uuid or conv.sender_account_id=$1::uuid)
      union all
      select conv.id, 1 as priority, conv.updated_at as created_at
      from app.conversations conv
      join app.prospects p on p.id = conv.prospect_id
      where conv.sender_account_id = $1::uuid
        and ($6::timestamptz is null or $6::timestamptz>=conv.created_at)
        and exists (
          select 1 from unnest($3::text[]) correspondent
          where p.normalized_email = app.canonical_email(correspondent)
        )
    ) candidate order by candidate.priority, candidate.created_at desc limit 1
  `, [accountId, identifiers, correspondents, message.gmailThreadId ?? null, message.draftRequestId ?? null, message.date]);
  return row?.id ?? null;
}

function inboundKind(message: SyncedMessage, conversationId: string | null): string {
  const classification = classifyOperationalMessage(message);
  if (classification === "bounce") return "bounce";
  if (classification === "automatic_reply") {
    return /out of office|absence|vacation|congé/i.test(message.subject) ? "out_of_office" : "automatic_reply";
  }
  return conversationId ? "reply" : "unrelated";
}

export async function recordMailboxMessages(account: MailboxAccount, messages: SyncedMessage[], sentMailbox = false): Promise<number> {
  let recorded = 0;
  for (const message of messages) {
      // From=self and an All Mail copy are not proof of delivery: drafts have both.
      if (message.isDraft) continue;
      const outgoing = sentMailbox || message.sent === true;
      if (!outgoing && (message.draftRequestId || message.from.some(from => from.toLowerCase() === account.email.toLowerCase()))) continue;
      const conversationId = await matchingConversation(account.id, account.email, message, outgoing);
      if (!conversationId) {
        if (await recordStandaloneMessage(account.id,account.email,message,outgoing)) recorded+=1;
        continue;
      }
      if (outgoing) {
        if (!conversationId || !message.from.length || !message.to.length) continue;
        const stored = await sqlOne<{id:string}>(`
          select (app.record_sent_message(
            $1::uuid, $2::uuid, $3, $4::text[], $5, $6, $7,
            $8, $9, $10::text[], $11, $12::bigint, $13::bigint,
            $14::timestamptz, $15::jsonb
          )).id::text as id
        `, [account.id, conversationId, message.from[0], message.to,
          message.subject, message.text, message.html, message.internetMessageId,
          message.inReplyTo, message.references, message.mailbox, message.uidValidity,
          message.uid, message.date ?? new Date().toISOString(),
          JSON.stringify({ synchronizedFrom: "sent", sentProof: sentMailbox ? "sent_mailbox" : "gmail_sent_label", prospectionMessageId: message.prospectionMessageId ?? null, draftRequestId: message.draftRequestId ?? null,warmup:!!message.warmup })]);
        if(stored)await observeMailboxMessage(account.id,message,stored.id);
        recorded += 1;
        continue;
      }
      const kind = inboundKind(message, conversationId);
      const from = message.from[0];
      if (!from) continue;
      const stored = await sqlOne<{id:string}>(`
        select (app.record_inbound_message(
          $1::uuid, $2::uuid, $3, $4, $5::text[], $6, $7, $8,
          '{}'::text[], $9, $10, $11::text[], $17, null, $12,
          $13::bigint, $14::bigint, null, $15::timestamptz, $16::jsonb
        )).id::text as id
      `, [account.id, conversationId, kind, from, message.to.length ? message.to : [account.email], message.subject,
        message.text, message.html, message.internetMessageId, message.inReplyTo,
        message.references, message.mailbox, message.uidValidity, message.uid,
        message.date ?? new Date().toISOString(), JSON.stringify({
          autoSubmitted: message.autoSubmitted,
          precedence: message.precedence,
          permanentBounce: message.isBounce ? message.isPermanentBounce : false,
          warmup: !!message.warmup,
          unread: message.unread ?? true,
          archived: message.archived ?? false,
        }), message.gmailThreadId ?? null]);
      if(stored)await observeMailboxMessage(account.id,message,stored.id);
      recorded += 1;
    }
  return recorded;
}

/** Read the relevant Gmail exchanges, independently of a lagging bulk cursor.
 * Only a complete scan is proof that a follow-up or automatic answer may start.
 * This path never advances the bulk cursors.
 */
export async function refreshConversation(conversationId: string): Promise<void> {
  const context = await sqlOne<{ sender_id: string; correspondent: string; since: string; identifiers: string[] }>(`
    select conv.sender_account_id::text as sender_id, p.email as correspondent,
      array(select m.internet_message_id from app.email_messages m where m.conversation_id=conv.id
        and m.internet_message_id is not null order by m.created_at desc limit 50) as identifiers,
      coalesce((select min(coalesce(m.smtp_accepted_at,m.sent_at,m.created_at)) from app.email_messages m
        where m.conversation_id=conv.id and m.direction='outbound' and m.technical_confirmation),conv.created_at) as since
    from app.conversations conv join app.prospects p on p.id=conv.prospect_id where conv.id=$1::uuid
  `, [conversationId]);
  if (!context?.correspondent) throw new Error("conversation_mailbox_context_missing");
  const accounts = await sqlQuery<MailboxAccount>(`
    select id::text, email, credential_id::text as "credentialId" from app.gmail_accounts
    where deleted_at is null and credential_id is not null
      and (id=$1::uuid or role='primary') order by created_at
  `, [context.sender_id]);
  if (!accounts.some(a => a.id === context.sender_id)) throw new Error("conversation_mailbox_unavailable");
  for (const account of accounts) {
    const delta = await fetchMailboxDelta({ email: account.email, credentialId: account.credentialId,
      cursor: { mailbox: "__LIVE_ALL__", lastUid: 0 }, maxMessages: 100,
      bootstrapSince: new Date(context.since), correspondent: context.correspondent, identifiers: context.identifiers });
    await recordMailboxMessages(account, delta.messages);
    if (delta.hasMore !== false) throw new Error("conversation_mailbox_check_incomplete");
  }
}
