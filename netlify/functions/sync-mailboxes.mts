import { randomUUID } from "node:crypto";
import type { Config, Context } from "@netlify/functions";
import { sqlOne, sqlQuery } from "../lib/db.mts";
import { classifyOperationalMessage, fetchMailboxDelta, type SyncedMessage } from "../lib/imap.mts";
import { workerFailure, workerResult } from "../lib/worker-response.mts";

interface ClaimedMailbox {
  account_id: string;
  email: string;
  credential_id: string;
  mailbox_name: string;
  uidvalidity: string | null;
  last_uid: number | null;
}

async function claimMailbox(): Promise<ClaimedMailbox | null> {
  return sqlOne<ClaimedMailbox>(`
    with candidate as (
      select a.id as account_id, a.email, a.credential_id,
             box.mailbox_name,
             c.uidvalidity, c.last_uid
      from app.gmail_accounts a
      cross join lateral (
        select mailbox_name from (values ('INBOX'), ('__SENT__')) boxes(mailbox_name)
        where boxes.mailbox_name = 'INBOX' or a.role in ('sender','primary')
      ) box
      left join app.imap_cursors c on c.account_id = a.id and c.mailbox_name = box.mailbox_name
      where a.deleted_at is null and a.status = 'active' and a.paused_at is null
        and a.credential_id is not null
        and (c.last_attempt_at is null or c.last_attempt_at < clock_timestamp() - interval '2 minutes')
      order by c.last_success_at nulls first, a.last_sync_at nulls first, a.created_at
      for update of a skip locked limit 1
    ), claimed as (
      insert into app.imap_cursors
        (account_id, mailbox_name, uidvalidity, last_uid, last_attempt_at)
      select account_id, mailbox_name, uidvalidity, coalesce(last_uid, 0), clock_timestamp()
      from candidate
      on conflict (account_id, mailbox_name) do update
        set last_attempt_at = clock_timestamp(), version = app.imap_cursors.version + 1
        where app.imap_cursors.last_attempt_at is null
           or app.imap_cursors.last_attempt_at < clock_timestamp() - interval '2 minutes'
      returning account_id, mailbox_name, uidvalidity::text, last_uid
    )
    select claimed.account_id::text, candidate.email, candidate.credential_id::text,
           claimed.mailbox_name, claimed.uidvalidity, claimed.last_uid
    from claimed join candidate on candidate.account_id = claimed.account_id
      and candidate.mailbox_name = claimed.mailbox_name
  `);
}

async function matchingConversation(accountId: string, accountEmail: string, message: SyncedMessage, sentMailbox: boolean): Promise<string | null> {
  const identifiers = [message.inReplyTo, ...message.references].filter((value): value is string => !!value);
  const correspondents = sentMailbox
    ? message.to.filter((value) => value.toLowerCase() !== accountEmail.toLowerCase())
    : message.from;
  const row = await sqlOne<{ id: string }>(`
    select candidate.id::text from (
      select conv.id, 0 as priority, m.created_at
      from app.conversations conv
      join app.email_messages m on m.conversation_id = conv.id and m.direction = 'outbound'
      where conv.sender_account_id = $1::uuid and m.internet_message_id = any($2::text[])
      union all
      select conv.id, 1 as priority, conv.updated_at as created_at
      from app.conversations conv
      join app.prospects p on p.id = conv.prospect_id
      where conv.sender_account_id = $1::uuid
        and exists (
          select 1 from unnest($3::text[]) correspondent
          where p.normalized_email = app.canonical_email(correspondent)
        )
    ) candidate order by candidate.priority, candidate.created_at desc limit 1
  `, [accountId, identifiers, correspondents]);
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

export default async function syncMailboxes(_request: Request, _context: Context): Promise<Response> {
  const worker = `netlify-imap-${randomUUID()}`;
  let claimed: ClaimedMailbox | null = null;
  try {
    claimed = await claimMailbox();
    if (!claimed) return workerResult(worker, { ok: true, claimed: 0 });
    const delta = await fetchMailboxDelta({
      email: claimed.email,
      credentialId: claimed.credential_id,
      cursor: { mailbox: claimed.mailbox_name, uidValidity: claimed.uidvalidity, lastUid: Number(claimed.last_uid ?? 0) },
      maxMessages: 10,
    });
    let recorded = 0;
    const sentMailbox = claimed.mailbox_name === "__SENT__";
    for (const message of delta.messages) {
      const conversationId = await matchingConversation(claimed.account_id, claimed.email, message, sentMailbox);
      if (sentMailbox) {
        if (!conversationId || !message.from.length || !message.to.length) continue;
        await sqlOne(`
          select (app.record_sent_message(
            $1::uuid, $2::uuid, $3, $4::text[], $5, $6, $7,
            $8, $9, $10::text[], $11, $12::bigint, $13::bigint,
            $14::timestamptz, $15::jsonb
          )).id::text as id
        `, [claimed.account_id, conversationId, message.from[0], message.to,
          message.subject, message.text, message.html, message.internetMessageId,
          message.inReplyTo, message.references, message.mailbox, message.uidValidity,
          message.uid, message.date ?? new Date().toISOString(),
          JSON.stringify({ synchronizedFrom: "sent" })]);
        recorded += 1;
        continue;
      }
      const kind = inboundKind(message, conversationId);
      const from = message.from[0];
      if (!from || !message.to.length) continue;
      await sqlOne(`
        select (app.record_inbound_message(
          $1::uuid, $2::uuid, $3, $4, $5::text[], $6, $7, $8,
          '{}'::text[], $9, $10, $11::text[], null, null, $12,
          $13::bigint, $14::bigint, null, $15::timestamptz, $16::jsonb
        )).id::text as id
      `, [claimed.account_id, conversationId, kind, from, message.to, message.subject,
        message.text, message.html, message.internetMessageId, message.inReplyTo,
        message.references, message.mailbox, message.uidValidity, message.uid,
        message.date ?? new Date().toISOString(), JSON.stringify({ autoSubmitted: message.autoSubmitted, precedence: message.precedence })]);
      recorded += 1;
    }
    await sqlQuery(`
      insert into app.imap_cursors
        (account_id, mailbox_name, uidvalidity, last_uid, last_success_at, last_attempt_at, consecutive_failures)
      values ($1::uuid, $2, $3::bigint, $4::bigint, clock_timestamp(), clock_timestamp(), 0)
      on conflict (account_id, mailbox_name) do update set
        uidvalidity = excluded.uidvalidity,
        last_uid = case when app.imap_cursors.uidvalidity is distinct from excluded.uidvalidity
                        then excluded.last_uid else greatest(app.imap_cursors.last_uid, excluded.last_uid) end,
        last_success_at = clock_timestamp(), last_attempt_at = clock_timestamp(),
        last_error_code = null, consecutive_failures = 0,
        version = app.imap_cursors.version + 1, updated_at = clock_timestamp()
    `, [claimed.account_id, claimed.mailbox_name, delta.uidValidity, delta.lastUid]);
    await sqlQuery(
      `update app.gmail_accounts set last_sync_at = clock_timestamp(), last_error_code = null
       where id = $1::uuid`,
      [claimed.account_id],
    );
    return workerResult(worker, { ok: true, accountId: claimed.account_id, fetched: delta.messages.length, recorded, resetRequired: delta.resetRequired });
  } catch (error) {
    if (claimed) {
      const code = String((error as { code?: unknown }).code ?? (error as Error).name ?? "imap_sync_failed").slice(0, 120);
      await sqlQuery(`
        update app.imap_cursors set last_error_code = $3, consecutive_failures = consecutive_failures + 1,
          last_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
        where account_id = $1::uuid and mailbox_name = $2
      `, [claimed.account_id, claimed.mailbox_name, code]).catch(() => undefined);
      await sqlQuery(
        `update app.gmail_accounts set last_error_code = $2, last_error_at = clock_timestamp()
         where id = $1::uuid`,
        [claimed.account_id, code],
      ).catch(() => undefined);
    }
    return workerFailure(worker, error);
  }
}

export const config: Config = { schedule: "*/10 * * * *", background: true };
