import { randomUUID } from "node:crypto";
import type { Config, Context } from "@netlify/functions";
import { isProductionOutboundEnabled } from "../lib/auth.mts";
import { sqlOne, sqlQuery } from "../lib/db.mts";
import { sendGmailMessage } from "../lib/gmail.mts";
import { prepareTrackedMessage, trackingBaseUrl } from "../lib/tracking.mts";
import { workerFailure, workerResult } from "../lib/worker-response.mts";

interface LeasedMessage {
  id: string;
  lease_token: string;
  attempt_count: number;
  max_attempts: number;
  message_id: string;
  from_address: string;
  to_addresses: string[];
  subject: string;
  body_text: string;
  body_html: string | null;
  internet_message_id: string | null;
  in_reply_to: string | null;
  references_header: string[];
  credential_id: string;
  display_name: string | null;
  tracking_opens_enabled: boolean;
  tracking_clicks_enabled: boolean;
}

function isEmail(value: string): boolean {
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
}

async function finishCertainFailure(job: LeasedMessage, code: string, retryable: boolean): Promise<void> {
  await sqlQuery(
    `with changed as (
       update app.outbox_jobs set
         status = case when $4 and attempt_count < max_attempts then 'deferred'::app.job_status else 'failed'::app.job_status end,
         due_at = case when $4 and attempt_count < max_attempts then clock_timestamp() + interval '15 minutes' else due_at end,
         last_error_code = $3, last_error_detail = null, lease_expires_at = null,
         lease_owner = null, lease_token = null, updated_at = clock_timestamp()
       where id = $1::uuid and lease_token = $2::uuid and status = 'running'
       returning message_id, status
     ), message_changed as (
       update app.email_messages m set
         status = case when changed.status = 'deferred' then 'scheduled'::app.message_status else 'failed'::app.message_status end,
         updated_at = clock_timestamp()
       from changed where m.id = changed.message_id returning m.id
     )
     update app.outbox_attempts set finished_at = clock_timestamp(), outcome = 'failed', error_code = $3
     where job_id = $1::uuid and attempt_number = $5`,
    [job.id, job.lease_token, code, retryable, job.attempt_count],
  );
}

export default async function dispatchOutbox(_request: Request, _context: Context): Promise<Response> {
  const worker = `netlify-dispatch-${randomUUID()}`;
  if (!isProductionOutboundEnabled()) {
    return workerResult(worker, { ok: true, skipped: "outbound_disabled" });
  }
  try {
    const scheduled = await sqlOne<{ count: number }>(
      `select app.schedule_due_messages(50) as count`,
    );
    const job = await sqlOne<LeasedMessage>(
      `select leased.id::text, leased.lease_token::text, leased.attempt_count,
              leased.max_attempts, m.id::text as message_id, m.from_address,
              m.to_addresses, m.subject, m.body_text, m.body_html,
              m.internet_message_id, m.in_reply_to, m.references_header,
              a.credential_id::text, a.display_name,
              c.tracking_opens_enabled, c.tracking_clicks_enabled
       from app.lease_outbox_jobs($1, 1, 40) leased
       join app.email_messages m on m.id = leased.message_id
       join app.gmail_accounts a on a.id = leased.account_id
       join app.campaigns c on c.id = leased.campaign_id`,
      [worker],
    );
    if (!job) return workerResult(worker, { ok: true, scheduled: Number(scheduled?.count ?? 0), leased: 0 });
    if (!job.credential_id || job.to_addresses.length !== 1 || !isEmail(job.to_addresses[0]) || !isEmail(job.from_address)) {
      await finishCertainFailure(job, "invalid_mail_envelope", false);
      return workerResult(worker, { ok: false, jobId: job.id, state: "failed", code: "invalid_mail_envelope" });
    }
    await sqlOne(`select (app.start_outbox_attempt($1::uuid, $2::uuid)).id::text as id`, [job.id, job.lease_token]);
    const messageId = job.internet_message_id || `<${job.message_id}@mail.prospection95.local>`;
    const prepared = await prepareTrackedMessage({
      messageId: job.message_id,
      text: job.body_text,
      html: job.body_html,
      opensEnabled: job.tracking_opens_enabled,
      clicksEnabled: job.tracking_clicks_enabled,
      baseUrl: job.tracking_opens_enabled || job.tracking_clicks_enabled ? trackingBaseUrl() : "",
    });
    const result = await sendGmailMessage({
      fromEmail: job.from_address,
      fromName: job.display_name,
      credentialId: job.credential_id,
      recipient: job.to_addresses[0],
      subject: job.subject,
      text: prepared.text,
      html: prepared.html,
      messageId,
      inReplyTo: job.in_reply_to,
      references: job.references_header,
    });
    if (result.state === "accepted") {
      await sqlOne(`select (app.confirm_smtp_acceptance($1::uuid, $2::uuid, $3, clock_timestamp())).id::text as id`, [job.id, job.lease_token, result.response || result.messageId]);
    } else if (result.state === "uncertain") {
      await sqlQuery(`select app.mark_smtp_uncertain($1::uuid, $2::uuid, $3, null)`, [job.id, job.lease_token, result.code]);
    } else {
      await finishCertainFailure(job, result.code, result.retryable);
    }
    return workerResult(worker, { ok: true, scheduled: Number(scheduled?.count ?? 0), jobId: job.id, state: result.state });
  } catch (error) {
    return workerFailure(worker, error);
  }
}

export const config: Config = { schedule: "*/5 * * * *" };
