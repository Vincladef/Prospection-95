import { randomUUID } from "node:crypto";
import type { Config, Context } from "@netlify/functions";
import { sqlOne, sqlQuery } from "../lib/db.mts";
import { createGmailDraft } from "../lib/gmail.mts";
import { workerFailure, workerResult } from "../lib/worker-response.mts";

interface DraftRequest {
  id: string;
  proposed_subject: string;
  proposed_body: string;
  sender_email: string;
  sender_name: string | null;
  credential_email: string;
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
        select r.id from app.reply_draft_requests r
        where r.state = 'requested'
          and (r.last_checked_at is null or r.last_checked_at < clock_timestamp() - interval '5 minutes')
        order by r.created_at for update skip locked limit 1
      ), claimed as (
        update app.reply_draft_requests r set last_checked_at = clock_timestamp()
        from candidate where r.id = candidate.id returning r.*
      )
      select claimed.id::text, claimed.proposed_subject, claimed.proposed_body,
             alias_account.email as sender_email, alias_account.display_name as sender_name,
             primary_account.email as credential_email,
             primary_account.credential_id::text, source.from_address as recipient,
             source.internet_message_id as source_message_id_header,
             source.references_header as source_references
      from claimed
      join app.gmail_accounts alias_account on alias_account.id = claimed.sender_account_id
      join lateral (
        select primary_candidate.email, primary_candidate.credential_id
        from app.gmail_accounts primary_candidate
        where primary_candidate.role = 'primary'
          and primary_candidate.status = 'active'
          and primary_candidate.paused_at is null
          and primary_candidate.deleted_at is null
          and primary_candidate.credential_id is not null
        order by primary_candidate.created_at
        limit 1
      ) primary_account on true
      join app.email_messages source on source.id = claimed.source_message_id
      where alias_account.deleted_at is null
    `);
    if (!draft) return workerResult(worker, { ok: true, claimed: 0 });
    const references = [...draft.source_references];
    if (draft.source_message_id_header && !references.includes(draft.source_message_id_header)) references.push(draft.source_message_id_header);
    const result = await createGmailDraft({
      fromEmail: draft.sender_email,
      credentialEmail: draft.credential_email,
      fromName: draft.sender_name,
      credentialId: draft.credential_id,
      recipient: draft.recipient,
      subject: draft.proposed_subject,
      text: draft.proposed_body,
      messageId: `<draft-${draft.id}@mail.prospection95.local>`,
      inReplyTo: draft.source_message_id_header,
      references,
    });
    await sqlQuery(
      `update app.reply_draft_requests set state = 'created',
         gmail_draft_id = $2, gmail_thread_id = null, last_checked_at = clock_timestamp()
       where id = $1::uuid and state = 'requested'`,
      [draft.id, `imap:${result.mailbox}:${result.uid ?? "unknown"}`],
    );
    await sqlQuery(
      `select audit.log_event('backend', $1, $2::uuid, 'gmail_draft_created',
         'reply_draft_request', $3, null, null,
         jsonb_build_object('threadingVerified', false, 'mailbox', $4))`,
      [worker, randomUUID(), draft.id, result.mailbox],
    ).catch(() => undefined);
    return workerResult(worker, { ok: true, draftId: draft.id, threadingVerified: false });
  } catch (error) {
    if (draft) {
      await sqlQuery(`update app.reply_draft_requests set state = 'failed', last_checked_at = clock_timestamp() where id = $1::uuid`, [draft.id]).catch(() => undefined);
    }
    return workerFailure(worker, error);
  }
}

export const config: Config = { schedule: "*/10 * * * *" };
