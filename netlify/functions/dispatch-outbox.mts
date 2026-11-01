import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Config, Context } from "@netlify/functions";
import { isProductionOutboundEnabled } from "../lib/auth.mts";
import { sqlOne, sqlQuery } from "../lib/db.mts";
import { refreshConversation } from "../lib/mailbox-sync.mts";
import { sendGmailMessage } from "../lib/gmail.mts";
import { prepareTrackedMessage, trackingBaseUrl } from "../lib/tracking.mts";
import { workerFailure, workerResult } from "../lib/worker-response.mts";

interface LeasedMessage {
  id: string;
  job_kind: string;
  step: string;
  conversation_id: string | null;
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
  reading_time_enabled: boolean;
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
         status = case when $4 and attempt_count-precommit_abort_count < max_attempts then 'deferred'::app.job_status else 'failed'::app.job_status end,
         due_at = case when $4 and attempt_count-precommit_abort_count < max_attempts then clock_timestamp() + interval '15 minutes' else due_at end,
         last_error_code = $3, last_error_detail = null, lease_expires_at = null,
         lease_owner = null, lease_token = null, updated_at = clock_timestamp()
       where id = $1::uuid and lease_token = $2::uuid and status in ('reserved','running')
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
    // One independent opportunity in five each minute keeps the previous
    // average throughput without imposing a fixed five-minute rhythm.
    // Wait BEFORE leasing: no quota slot or expiring lease is held while idle,
    // and the database checks windows, exclusions and pauses after the delay.
    if (randomInt(5) !== 0) {
      return workerResult(worker, { ok: true, skipped: "random_pacing" });
    }
    await delay(randomInt(3_001));
    const scheduled = await sqlOne<{ count: number }>(
      `select app.schedule_due_messages(50) as count`,
    );
    const job = await sqlOne<LeasedMessage>(
      `select leased.id::text, leased.job_kind, leased.step, leased.conversation_id::text, leased.lease_token::text, leased.attempt_count,
              leased.max_attempts, m.id::text as message_id, m.from_address,
              m.to_addresses, m.subject, m.body_text, m.body_html,
              m.internet_message_id, m.in_reply_to, m.references_header,
              a.credential_id::text, a.display_name,
              coalesce(c.reading_time_enabled,false) as reading_time_enabled,
              coalesce(c.tracking_opens_enabled, false) as tracking_opens_enabled,
              coalesce(c.tracking_clicks_enabled, false) as tracking_clicks_enabled
       from app.lease_outbox_jobs($1, 1, 300) leased
       join app.email_messages m on m.id = leased.message_id
       join app.gmail_accounts a on a.id = leased.account_id
       left join app.campaigns c on c.id = leased.campaign_id`,
      [worker],
    );
    if (!job) return workerResult(worker, { ok: true, scheduled: Number(scheduled?.count ?? 0), leased: 0 });
    if (!job.credential_id || job.to_addresses.length !== 1 || !isEmail(job.to_addresses[0]) || !isEmail(job.from_address)) {
      await finishCertainFailure(job, "invalid_mail_envelope", false);
      return workerResult(worker, { ok: false, jobId: job.id, state: "failed", code: "invalid_mail_envelope" });
    }
    if (job.job_kind === "reply" || (job.job_kind === "prospection" && job.step !== "J0")) {
      try {
        if (!job.conversation_id) throw new Error("conversation_missing");
        await refreshConversation(job.conversation_id);
      } catch {
        await sqlQuery(`update app.outbox_jobs set status='deferred',due_at=clock_timestamp()+interval '2 minutes',
          lease_owner=null,lease_token=null,lease_expires_at=null,attempt_count=greatest(0,attempt_count-1),
          last_error_code='mailbox_check_failed',updated_at=clock_timestamp()
          where id=$1::uuid and lease_token=$2::uuid and status='reserved'`, [job.id,job.lease_token]);
        return workerResult(worker,{ ok:true,jobId:job.id,state:"deferred",code:"mailbox_check_failed" });
      }
      const checked = await sqlOne<{ id: string }>(`update app.outbox_jobs
        set mailbox_checked_at=clock_timestamp(),mailbox_check_token=$2::uuid
        where id=$1::uuid and lease_token=$2::uuid and status='reserved' and lease_expires_at>clock_timestamp()
        returning id::text`, [job.id,job.lease_token]);
      if (!checked) return workerResult(worker,{ok:true,jobId:job.id,state:"cancelled"});
    }
    const started = await sqlOne<{ id: string; status: string }>(
      `select started.id::text, started.status::text
       from app.start_outbox_attempt($1::uuid, $2::uuid) started`,
      [job.id, job.lease_token],
    );
    if (!started || started.status !== "running") {
      return workerResult(worker, {
        ok: true,
        scheduled: Number(scheduled?.count ?? 0),
        jobId: job.id,
        state: started?.status ?? "cancelled",
      });
    }
    const deterministicMessageId = `<${job.message_id}@mail.prospection95.local>`;
    const persistedMessage = await sqlOne<{
      internet_message_id: string;
      in_reply_to: string | null;
      references_header: string[];
    }>(
      `with previous as (
         select prior.internet_message_id, prior.references_header
           from app.email_messages current
           join app.email_messages prior
             on prior.conversation_id = current.conversation_id
            and prior.direction = 'outbound'
            and prior.kind = 'prospection'
            and prior.technical_confirmation
            and prior.internet_message_id is not null
          where current.id = $1::uuid
            and current.step <> 'J0'
            and array_position(
                  array['J0','R1','R2','R3','R4','R5']::app.sequence_step[],
                  prior.step
                ) < array_position(
                  array['J0','R1','R2','R3','R4','R5']::app.sequence_step[],
                  current.step
                )
          order by array_position(
                     array['J0','R1','R2','R3','R4','R5']::app.sequence_step[],
                     prior.step
                   ) desc
          limit 1
       )
       update app.email_messages message
          set internet_message_id = coalesce(message.internet_message_id, $2),
              in_reply_to = coalesce(message.in_reply_to, previous.internet_message_id),
              references_header = case
                when message.in_reply_to is null and previous.internet_message_id is not null
                  then array_append(previous.references_header, previous.internet_message_id)
                else message.references_header
              end,
              updated_at = clock_timestamp()
         from (select null::text as internet_message_id, '{}'::text[] as references_header
               where not exists (select 1 from previous)
               union all
               select internet_message_id, references_header from previous) previous
        where message.id = $1::uuid
        returning message.internet_message_id, message.in_reply_to, message.references_header`,
      [job.message_id, deterministicMessageId],
    );
    if (!persistedMessage?.internet_message_id) throw new Error("message_id_persistence_failed");
    const messageId = persistedMessage.internet_message_id;
    const prepared = await prepareTrackedMessage({
      messageId: job.message_id,
      text: job.body_text,
      html: job.body_html,
      opensEnabled: job.tracking_opens_enabled,
      clicksEnabled: job.tracking_clicks_enabled,
      readingTimeEnabled: job.job_kind === "prospection" && job.reading_time_enabled && job.tracking_opens_enabled,
      baseUrl: job.tracking_opens_enabled || job.tracking_clicks_enabled ? trackingBaseUrl() : "",
    });
    await sqlQuery(`update app.email_messages set tracking_opens_enabled=$2,tracking_clicks_enabled=$3,advanced_interactions_enabled=$4,read_delay_enabled=$5,reading_time_enabled=$6 where id=$1::uuid`,
      [job.message_id,job.tracking_opens_enabled,job.tracking_clicks_enabled,job.tracking_opens_enabled,job.tracking_opens_enabled && job.tracking_clicks_enabled,job.job_kind === "prospection" && !!job.reading_time_enabled && job.tracking_opens_enabled]);
    let checkFailed=false;
    const guarded=job.job_kind==="reply" || job.job_kind==="prospection" && job.step!=="J0";
    const result = await sendGmailMessage({
      fromEmail: job.from_address,
      fromName: job.display_name,
      credentialId: job.credential_id,
      recipient: job.to_addresses[0],
      subject: job.subject,
      text: prepared.text,
      html: prepared.html,
      messageId,
      inReplyTo: persistedMessage.in_reply_to,
      references: persistedMessage.references_header,
    }, guarded ? async()=>{
      try {
        await refreshConversation(job.conversation_id!);
        const row=await sqlOne<{ready:boolean;eligible:boolean}>(`select app.outbox_commit_is_ready(j.id,$2::uuid) as ready,
          case when j.job_kind='reply' then app.reply_source_is_current(w.source_message_id)
            else app.prospection_message_is_eligible(j.message_id) end as eligible
          from app.outbox_jobs j left join app.reply_workflows w on w.output_message_id=j.message_id where j.id=$1::uuid`,[job.id,job.lease_token]);
        if(row?.eligible && !row.ready)checkFailed=true;
        return row?.ready===true;
      }catch{checkFailed=true;return false;}
    } : undefined);
    if (result.state === "accepted") {
      await sqlOne(`select (app.confirm_smtp_acceptance($1::uuid, $2::uuid, $3, clock_timestamp())).id::text as id`, [job.id, job.lease_token, result.response || result.messageId]);
    } else if(result.state === "blocked") {
      await sqlQuery(`with changed as (update app.outbox_jobs set
        status=case when $3 then 'deferred'::app.job_status else 'cancelled'::app.job_status end,
        due_at=case when $3 then clock_timestamp()+interval '2 minutes' else due_at end,
        precommit_abort_count=precommit_abort_count+case when $3 then 1 else 0 end,
        cancel_reason=case when $3 then null else 'conversation_changed_before_smtp_commit' end,
        cancelled_at=case when $3 then null else clock_timestamp() end,
        lease_expires_at=null,lease_owner=null,lease_token=null,last_error_code='smtp_commit_blocked',updated_at=clock_timestamp()
        where id=$1::uuid and lease_token=$2::uuid and status='running' returning message_id,status)
        update app.email_messages m set status=case when changed.status='deferred' then 'scheduled'::app.message_status else 'cancelled'::app.message_status end
        from changed where m.id=changed.message_id and not m.technical_confirmation`,[job.id,job.lease_token,checkFailed]);
      await sqlQuery(`update app.outbox_attempts set finished_at=clock_timestamp(),outcome='failed',error_code='smtp_aborted_before_commit'
        where job_id=$1::uuid and lease_token=$2::uuid`,[job.id,job.lease_token]);
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

export const config: Config = { schedule: "* * * * *", background: true };
