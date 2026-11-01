import { randomUUID } from "node:crypto";
import type { Config, Context } from "@netlify/functions";
import { sqlOne, sqlQuery } from "../lib/db.mts";
import { fetchMailboxDelta } from "../lib/imap.mts";
import { recordMailboxMessages } from "../lib/mailbox-sync.mts";
import { workerFailure, workerResult } from "../lib/worker-response.mts";

interface ClaimedMailbox {
  account_id: string;
  email: string;
  credential_id: string;
  mailbox_name: string;
  uidvalidity: string | null;
  last_uid: number | null;
  recent_since: string;
}

async function claimMailbox(): Promise<ClaimedMailbox | null> {
  return sqlOne<ClaimedMailbox>(`
    with candidate as (
      select a.id as account_id, a.email, a.credential_id,
             box.mailbox_name,
             c.uidvalidity, c.last_uid,
             coalesce((select min(m.smtp_accepted_at) from app.email_messages m
               where m.sender_account_id = a.id and m.technical_confirmation),
               clock_timestamp() - interval '7 days') as recent_since
      from app.gmail_accounts a
      cross join lateral (
        select mailbox_name from (values ('INBOX'), ('__SENT__'), ('__LIVE_ALL__'), ('__LIVE_SENT__')) boxes(mailbox_name)
        where boxes.mailbox_name = 'INBOX' or a.role in ('sender','primary')
      ) box
      left join app.imap_cursors c on c.account_id = a.id and c.mailbox_name = box.mailbox_name
      where a.deleted_at is null and a.status = 'active'
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
           claimed.mailbox_name, claimed.uidvalidity, claimed.last_uid, candidate.recent_since
    from claimed join candidate on candidate.account_id = claimed.account_id
      and candidate.mailbox_name = claimed.mailbox_name
  `);
}

export default async function syncMailboxes(_request: Request, _context: Context): Promise<Response> {
  const worker = `netlify-imap-${randomUUID()}`;
  let claimed: ClaimedMailbox | null = null;
  try {
    // Bounded retention maintenance uses the existing worker, no extra schedule.
    await sqlQuery(`delete from app.interaction_buckets where ctid in (
      select ctid from app.interaction_buckets where bucket_hour<clock_timestamp()-interval '90 days' limit 1000)`);
    claimed = await claimMailbox();
    if (!claimed) return workerResult(worker, { ok: true, claimed: 0 });
    const delta = await fetchMailboxDelta({
      email: claimed.email,
      credentialId: claimed.credential_id,
      cursor: { mailbox: claimed.mailbox_name, uidValidity: claimed.uidvalidity, lastUid: Number(claimed.last_uid ?? 0) },
      maxMessages: claimed.mailbox_name.startsWith("__LIVE_") ? 50 : 10,
      bootstrapSince: claimed.mailbox_name.startsWith("__LIVE_") ? new Date(claimed.recent_since) : undefined,
    });
    const recorded = await recordMailboxMessages({ id: claimed.account_id, email: claimed.email,
      credentialId: claimed.credential_id }, delta.messages,
      claimed.mailbox_name === "__SENT__" || claimed.mailbox_name === "__LIVE_SENT__");
    await sqlQuery(`
      insert into app.imap_cursors
        (account_id, mailbox_name, uidvalidity, last_uid, last_success_at, last_attempt_at, consecutive_failures, caught_up_at)
      values ($1::uuid, $2, $3::bigint, $4::bigint, clock_timestamp(), clock_timestamp(), 0, case when $5 then clock_timestamp() else null end)
      on conflict (account_id, mailbox_name) do update set
        uidvalidity = excluded.uidvalidity,
        last_uid = case when app.imap_cursors.uidvalidity is distinct from excluded.uidvalidity
                        then excluded.last_uid else greatest(app.imap_cursors.last_uid, excluded.last_uid) end,
        last_success_at = clock_timestamp(), last_attempt_at = clock_timestamp(),
        last_error_code = null, consecutive_failures = 0,
        caught_up_at = case when $5 then clock_timestamp() else null end,
        version = app.imap_cursors.version + 1, updated_at = clock_timestamp()
    `, [claimed.account_id, claimed.mailbox_name, delta.uidValidity, delta.lastUid, delta.hasMore === false]);
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

export const config: Config = { schedule: "* * * * *", background: true };
