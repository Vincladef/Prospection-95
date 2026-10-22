import { randomUUID } from "node:crypto";
import type { Config, Context } from "@netlify/functions";
import { z } from "zod";
import { requireAdmin, type AdminIdentity } from "../lib/auth.mts";
import { auditEvent } from "../lib/audit.mts";
import { initializeCredentialVault, retireCredential, storeCredential } from "../lib/credentials.mts";
import { loadDashboard } from "../lib/dashboard.mts";
import { pingDatabase, sqlOne, sqlQuery } from "../lib/db.mts";
import { env } from "../lib/env.mts";
import { verifyGmail } from "../lib/gmail.mts";
import { handleError, HttpError, json, noContent, parseJson } from "../lib/http.mts";
import { commitStagedImport, stageImport } from "../lib/import-store.mts";
import { importPayloadSchema } from "../lib/importer.mts";

const uuid = z.string().uuid();
const version = z.number().int().positive();
const sequence = z.object({
  subject: z.string().max(500),
  subjectInstructions: z.string().max(100_000).default(""),
  steps: z.tuple([
    z.string().max(100_000), z.string().max(100_000), z.string().max(100_000),
    z.string().max(100_000), z.string().max(100_000), z.string().max(100_000),
  ]),
  stepInstructions: z.tuple([
    z.string().max(100_000), z.string().max(100_000), z.string().max(100_000),
    z.string().max(100_000), z.string().max(100_000), z.string().max(100_000),
  ]).default(["", "", "", "", "", ""]),
});
const campaignFields = {
  name: z.string().trim().min(1).max(180),
  status: z.enum(["inactive", "active", "archived"]),
  folderId: uuid.nullable().optional(),
  targetDescription: z.string().max(200_000).default(""),
  dailyNewContactGoal: z.number().int().min(0).max(10_000).default(0),
  validationPolicy: z.enum(["manual", "automatic"]).default("manual"),
  senderStrategy: z.enum(["fixed", "pool"]).default("fixed"),
  fixedSenderAccountId: uuid.nullable().optional(),
  senderAccountIds: z.array(uuid).max(100).default([]),
  aiInstructions: z.string().max(200_000).default(""),
  replyInstructions: z.string().max(200_000).default(""),
  trackingOpensEnabled: z.boolean().default(false),
  trackingClicksEnabled: z.boolean().default(false),
  experimentPolicy: z.enum(["continue", "stabilize"]).default("continue"),
  nextTestInstructions: z.string().max(200_000).default(""),
  sequence,
};
const createCampaignSchema = z.object(campaignFields);
const updateCampaignSchema = z.object({ ...campaignFields, version });
const editableMessageStatus = z.enum(["draft", "prepared", "pending_approval", "approved", "scheduled", "cancelled"]);
const prospectUpdateSchema = z.union([
  z.object({ status: editableMessageStatus, version }),
  z.object({ subject: z.string().trim().min(1).max(500), messages: z.array(z.string().max(100_000)).length(6), version }),
]);

function routeParts(request: Request): string[] {
  const pathname = new URL(request.url).pathname.replace(/^\/api\/?/, "");
  return pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
}

function routeUuid(value: string | undefined): string {
  const result = uuid.safeParse(value);
  if (!result.success) throw new HttpError(404, "not_found", "Ressource introuvable.");
  return result.data;
}

function requireMethod(request: Request, ...allowed: string[]): void {
  if (!allowed.includes(request.method)) {
    throw new HttpError(405, "method_not_allowed", "Méthode HTTP non autorisée.", { allowed });
  }
}

function requestIdFrom(request: Request): string {
  const value = request.headers.get("x-request-id");
  return value && /^[0-9a-f-]{36}$/i.test(value) ? value : randomUUID();
}

async function logMutation(identity: AdminIdentity, requestId: string, input: {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await auditEvent({ actor: identity.email, requestId, ...input });
}

async function health(): Promise<Response> {
  const configured = Boolean(env("DATABASE_URL"));
  let database = false;
  if (configured) database = await pingDatabase().catch(() => false);
  return json({
    status: database ? "ok" : "degraded",
    service: "prospection-95-api",
    database,
    configured,
    time: new Date().toISOString(),
  }, database ? 200 : 503);
}

async function updateSettings(request: Request, identity: AdminIdentity, requestId: string): Promise<Response> {
  const payload = await parseJson(request, z.object({
    timezone: z.string().min(1).max(100).optional(),
    outboundEnabled: z.boolean().optional(),
    generalWritingInstructions: z.string().max(500_000).optional(),
    defaultSendDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
    defaultSendStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    defaultSendEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    version,
  }));
  if (payload.outboundEnabled && !/^(?:1|true|yes|on)$/i.test(env("OUTBOUND_ENABLED", "false")!)) {
    throw new HttpError(409, "server_outbound_disabled", "OUTBOUND_ENABLED interdit l’activation des envois.");
  }
  const before = await sqlOne(`select * from app.settings where singleton`);
  const row = await sqlOne(
    `update app.settings set
       timezone = coalesce($1, timezone),
       outbound_enabled = coalesce($2, outbound_enabled),
       general_writing_instructions = coalesce($3, general_writing_instructions),
       default_send_days = coalesce($4::smallint[], default_send_days),
       default_send_start = coalesce($5::time, default_send_start),
       default_send_end = coalesce($6::time, default_send_end),
       version = version + 1
     where singleton and version = $7
     returning *`,
    [payload.timezone ?? null, payload.outboundEnabled ?? null, payload.generalWritingInstructions ?? null,
      payload.defaultSendDays ?? null, payload.defaultSendStart ?? null, payload.defaultSendEnd ?? null, payload.version],
  );
  if (!row) throw new HttpError(409, "version_conflict", "Les paramètres ont été modifiés ailleurs.");
  await logMutation(identity, requestId, { action: "settings_updated", entityType: "settings", entityId: "global", before, after: row });
  const dashboard = await loadDashboard();
  return json({ settings: dashboard.settings });
}

async function emergencyStop(request: Request, identity: AdminIdentity, requestId: string): Promise<Response> {
  const payload = await parseJson(request, z.object({ enabled: z.boolean(), reason: z.string().max(2_000).default("") }));
  if (!payload.enabled && !payload.reason.trim()) {
    throw new HttpError(422, "resume_reason_required", "Une raison est obligatoire pour reprendre les envois.");
  }
  const row = await sqlOne(`select to_jsonb(result) as result from app.set_emergency_stop($1, $2, $3) result`, [payload.enabled, payload.reason, identity.email]);
  if (!row) throw new HttpError(500, "emergency_stop_failed", "Le coupe-circuit n’a pas pu être modifié.");
  await logMutation(identity, requestId, { action: payload.enabled ? "emergency_stop_enabled" : "emergency_stop_disabled", entityType: "settings", entityId: "global", metadata: { reason: payload.reason } });
  const dashboard = await loadDashboard();
  return json({ settings: dashboard.settings });
}

async function createCampaign(request: Request, identity: AdminIdentity, requestId: string): Promise<Response> {
  const value = await parseJson(request, createCampaignSchema);
  if (value.trackingOpensEnabled || value.trackingClicksEnabled) {
    throw new HttpError(409, "tracking_not_configured", "Le tracking signé n’est pas encore configuré.");
  }
  const row = await sqlOne<{ id: string; version: number }>(
    `with created as (
       insert into app.campaigns
         (folder_id, name, status, target_description, daily_new_contact_goal,
          validation_policy, sender_strategy, fixed_sender_account_id, ai_instructions,
          reply_instructions, tracking_opens_enabled, tracking_clicks_enabled,
          experiment_policy, next_test_instructions)
       values ($1::uuid, $2, $3::app.campaign_status, $4, $5,
               $6::app.validation_policy, $7::app.sender_strategy, $8::uuid, $9,
               $10, $11, $12, $13, $14)
       returning id, version
     ), inserted_templates as (
       insert into app.message_templates (campaign_id, step, iteration, version, subject, body, instructions, created_by)
       select created.id, incoming.step::app.sequence_step, 1, 1, $15, incoming.body, incoming.instructions, $17
       from created
       cross join jsonb_to_recordset($16::jsonb) as incoming(step text, body text, instructions text)
       returning id
     ), inserted_senders as (
       insert into app.campaign_sender_accounts (campaign_id, account_id)
       select created.id, sender.account_id
       from created cross join unnest($18::uuid[]) sender(account_id)
       on conflict (campaign_id, account_id) do update set enabled = true
       returning account_id
     )
     select id::text, version::int from created`,
    [value.folderId ?? null, value.name, value.status, value.targetDescription, value.dailyNewContactGoal,
      value.validationPolicy, value.senderStrategy, value.fixedSenderAccountId ?? null, value.aiInstructions,
      value.replyInstructions, value.trackingOpensEnabled, value.trackingClicksEnabled,
      value.experimentPolicy, value.nextTestInstructions, value.sequence.subject,
      JSON.stringify(["J0", "R1", "R2", "R3", "R4", "R5"].map((step, index) => ({
        step,
        body: value.sequence.steps[index],
        instructions: index === 0
          ? JSON.stringify({ subject: value.sequence.subjectInstructions, body: value.sequence.stepInstructions[index] })
          : value.sequence.stepInstructions[index],
      }))), identity.email,
      value.senderStrategy === "pool" ? value.senderAccountIds : []],
  );
  if (!row) throw new HttpError(500, "campaign_create_failed", "La campagne n’a pas pu être créée.");
  await logMutation(identity, requestId, { action: "campaign_created", entityType: "campaign", entityId: row.id, after: value });
  return json({ campaign: row }, 201);
}

async function updateCampaign(request: Request, id: string, identity: AdminIdentity, requestId: string): Promise<Response> {
  const value = await parseJson(request, updateCampaignSchema);
  if (value.trackingOpensEnabled || value.trackingClicksEnabled) {
    throw new HttpError(409, "tracking_not_configured", "Le tracking signé n’est pas encore configuré.");
  }
  const before = await sqlOne(`select * from app.campaigns where id = $1::uuid`, [id]);
  if (!before) throw new HttpError(404, "campaign_not_found", "Campagne introuvable.");
  const row = await sqlOne<{ id: string; version: number }>(
    `with updated as (
       update app.campaigns set folder_id = $2::uuid, name = $3, status = $4::app.campaign_status,
         target_description = $5, daily_new_contact_goal = $6,
         validation_policy = $7::app.validation_policy, sender_strategy = $8::app.sender_strategy,
         fixed_sender_account_id = $9::uuid, ai_instructions = $10, reply_instructions = $11,
         tracking_opens_enabled = $12, tracking_clicks_enabled = $13,
         experiment_policy = $14, next_test_instructions = $15,
         imported_disabled = case when $4 = 'active' then false else imported_disabled end,
         version = version + 1
       where id = $1::uuid and version = $16 returning id, version
     ), incoming as (
       select * from jsonb_to_recordset($18::jsonb) as value(step text, body text, instructions text)
     ), inserted_templates as (
       insert into app.message_templates
         (campaign_id, step, iteration, version, subject, body, instructions, supersedes_id, created_by)
       select updated.id, incoming.step::app.sequence_step, 1,
              coalesce(previous.version, 0) + 1, $17, incoming.body, incoming.instructions, previous.id, $19
       from updated cross join incoming
       left join lateral (
         select t.id, t.version, t.subject, t.body, t.instructions from app.message_templates t
         where t.campaign_id = updated.id and t.step = incoming.step::app.sequence_step and t.iteration = 1
         order by t.version desc limit 1
       ) previous on true
       where previous.id is null
          or (previous.subject, previous.body, previous.instructions)
             is distinct from ($17, incoming.body, incoming.instructions)
       returning id
     ), updated_senders as (
       update app.campaign_sender_accounts csa
       set enabled = csa.account_id = any($20::uuid[])
       from updated where csa.campaign_id = updated.id
       returning csa.account_id
     ), inserted_senders as (
       insert into app.campaign_sender_accounts (campaign_id, account_id)
       select updated.id, sender.account_id
       from updated cross join unnest($20::uuid[]) sender(account_id)
       where not exists (
         select 1 from app.campaign_sender_accounts existing
         where existing.campaign_id = updated.id and existing.account_id = sender.account_id
       )
       returning account_id
     )
     select id::text, version::int from updated`,
    [id, value.folderId ?? null, value.name, value.status, value.targetDescription, value.dailyNewContactGoal,
      value.validationPolicy, value.senderStrategy, value.fixedSenderAccountId ?? null, value.aiInstructions,
      value.replyInstructions, value.trackingOpensEnabled, value.trackingClicksEnabled,
      value.experimentPolicy, value.nextTestInstructions, value.version, value.sequence.subject,
      JSON.stringify(["J0", "R1", "R2", "R3", "R4", "R5"].map((step, index) => ({
        step,
        body: value.sequence.steps[index],
        instructions: index === 0
          ? JSON.stringify({ subject: value.sequence.subjectInstructions, body: value.sequence.stepInstructions[index] })
          : value.sequence.stepInstructions[index],
      }))), identity.email,
      value.senderStrategy === "pool" ? value.senderAccountIds : []],
  );
  if (!row) throw new HttpError(409, "version_conflict", "La campagne a été modifiée ailleurs.");
  await logMutation(identity, requestId, { action: "campaign_updated", entityType: "campaign", entityId: id, before, after: value });
  return json({ campaign: row });
}

async function archiveCampaign(id: string, identity: AdminIdentity, requestId: string): Promise<Response> {
  const row = await sqlOne(`update app.campaigns set status = 'archived', archived_at = clock_timestamp(), version = version + 1 where id = $1::uuid returning *`, [id]);
  if (!row) throw new HttpError(404, "campaign_not_found", "Campagne introuvable.");
  await sqlQuery(`update app.outbox_jobs set status = 'cancelled', cancelled_at = clock_timestamp(), cancel_reason = 'campaign_archived' where campaign_id = $1::uuid and status in ('requested','pending','scheduled','deferred','reserved')`, [id]);
  await logMutation(identity, requestId, { action: "campaign_archived", entityType: "campaign", entityId: id, after: row });
  return noContent();
}

async function campaignFolders(request: Request, id: string | null, identity: AdminIdentity, requestId: string): Promise<Response> {
  if (!id) {
    requireMethod(request, "POST");
    const value = await parseJson(request, z.object({
      name: z.string().trim().min(1).max(120),
      position: z.number().int().min(0).max(1_000_000).default(0),
    }));
    const row = await sqlOne<{ id: string }>(
      `insert into app.campaign_folders (name, position) values ($1, $2) returning id::text`,
      [value.name, value.position],
    );
    await logMutation(identity, requestId, { action: "campaign_folder_created", entityType: "campaign_folder", entityId: row?.id, after: value });
    return json({ folder: row }, 201);
  }
  if (request.method === "DELETE") {
    const row = await sqlOne(`delete from app.campaign_folders where id = $1::uuid returning id::text, name`, [id]);
    if (!row) throw new HttpError(404, "folder_not_found", "Dossier introuvable.");
    await logMutation(identity, requestId, { action: "campaign_folder_deleted", entityType: "campaign_folder", entityId: id, before: row });
    return noContent();
  }
  requireMethod(request, "PATCH");
  const value = await parseJson(request, z.object({
    name: z.string().trim().min(1).max(120).optional(),
    position: z.number().int().min(0).max(1_000_000).optional(),
  }).refine((candidate) => candidate.name !== undefined || candidate.position !== undefined));
  const row = await sqlOne(
    `update app.campaign_folders set name = coalesce($2, name), position = coalesce($3, position),
       updated_at = clock_timestamp() where id = $1::uuid returning id::text, name, position`,
    [id, value.name ?? null, value.position ?? null],
  );
  if (!row) throw new HttpError(404, "folder_not_found", "Dossier introuvable.");
  await logMutation(identity, requestId, { action: "campaign_folder_updated", entityType: "campaign_folder", entityId: id, after: value });
  return json({ folder: row });
}

async function prospectContext(id: string): Promise<Record<string, unknown>> {
  const row = await sqlOne(`
    select p.*, selected.campaign_id, selected.sender_account_id,
           ga.email as sender_email, conv.id as conversation_id
    from app.prospects p
    left join lateral (
      select cp.campaign_id, coalesce(cp.assigned_sender_account_id, c.fixed_sender_account_id) as sender_account_id
      from app.campaign_prospects cp join app.campaigns c on c.id = cp.campaign_id
      where cp.prospect_id = p.id order by cp.updated_at desc limit 1
    ) selected on true
    left join app.gmail_accounts ga on ga.id = selected.sender_account_id and ga.deleted_at is null
    left join app.conversations conv on conv.prospect_id = p.id and conv.campaign_id = selected.campaign_id
    where p.id = $1::uuid and p.deleted_at is null`, [id]);
  if (!row) throw new HttpError(404, "prospect_not_found", "Prospect introuvable.");
  return row;
}

async function updateProspect(request: Request, id: string, identity: AdminIdentity, requestId: string): Promise<Response> {
  const value = await parseJson(request, prospectUpdateSchema);
  const context = await prospectContext(id);
  if ("messages" in value) {
    if (!context.email || context.contact_kind !== "email") throw new HttpError(409, "prospect_not_emailable", "Ce contact ne possède pas d’adresse email exploitable.");
    if (!context.campaign_id || !context.sender_account_id || !context.sender_email) {
      throw new HttpError(409, "sender_not_assigned", "Aucun compte expéditeur n’est attribué à ce prospect.");
    }
    const rows = ["J0", "R1", "R2", "R3", "R4", "R5"].map((step, index) => ({ step, body: value.messages[index] }));
    const updated = await sqlOne<{ id: string; version: number }>(
      `with updated as (
         update app.prospects set version = version + 1
         where id = $1::uuid and version = $2 returning id, version
       ), conversation_row as (
         insert into app.conversations
           (campaign_id, prospect_id, sender_account_id, state)
         select $3::uuid, updated.id, $4::uuid, 'prepared' from updated
         on conflict (campaign_id, prospect_id) do update
           set sender_account_id = excluded.sender_account_id, version = app.conversations.version + 1
         returning id
       ), incoming as (
         select * from jsonb_to_recordset($8::jsonb) as value(step text, body text)
       ), inserted as (
         insert into app.email_messages
           (conversation_id, direction, kind, step, sender_account_id, from_address,
            to_addresses, subject, body_text, content_version, status, source)
         select conversation_row.id, 'outbound', 'prospection', incoming.step::app.sequence_step,
                $4::uuid, $5, array[$6]::text[], $7, incoming.body,
                coalesce((select max(m.content_version) from app.email_messages m
                          where m.conversation_id = conversation_row.id and m.step = incoming.step::app.sequence_step), 0) + 1,
                'draft', 'application'
         from conversation_row cross join incoming returning id
       )
       select id::text, version::int from updated`,
      [id, value.version, context.campaign_id, context.sender_account_id, context.sender_email,
        context.email, value.subject, JSON.stringify(rows)],
    );
    if (!updated) throw new HttpError(409, "version_conflict", "Le prospect a été modifié ailleurs.");
    await logMutation(identity, requestId, { action: "prospect_sequence_updated", entityType: "prospect", entityId: id, metadata: { version: updated.version } });
    return json({ prospect: updated });
  }

  const updated = await setProspectStatus([id], value.status, value.version);
  if (!updated) throw new HttpError(409, "version_conflict", "Le prospect a été modifié ailleurs ou ne possède aucun message.");
  await logMutation(identity, requestId, { action: "prospect_status_updated", entityType: "prospect", entityId: id, metadata: { status: value.status } });
  return json({ updated });
}

async function setProspectStatus(ids: string[], status: z.infer<typeof editableMessageStatus>, expectedVersion?: number): Promise<number> {
  const row = await sqlOne<{ count: number }>(
    `with targets as (
       select conv.prospect_id, conv.id as conversation_id,
              conv.campaign_id, conv.sender_account_id, current_message.id as message_id,
              current_message.step, current_message.subject, current_message.body_text
       from app.conversations conv
       join app.prospects p on p.id = conv.prospect_id
       join lateral (
         select m.id, m.step, m.subject, m.body_text
         from app.email_messages m
         where m.conversation_id = conv.id and m.direction = 'outbound'
           and not m.technical_confirmation
           and m.status not in ('cancelled','failed','uncertain')
           and not exists (
             select 1 from app.email_messages newer
             where newer.conversation_id = m.conversation_id and newer.step = m.step
               and newer.direction = 'outbound' and newer.content_version > m.content_version
           )
         order by case m.step
           when 'J0' then 0 when 'R1' then 1 when 'R2' then 2
           when 'R3' then 3 when 'R4' then 4 when 'R5' then 5 else 6 end
         limit 1
       ) current_message on true
       where conv.prospect_id = any($1::uuid[])
         and ($3::bigint is null or p.version = $3)
     ), changed_messages as (
       update app.email_messages m set status = $2::app.message_status
       from targets t where m.id = t.message_id returning m.id
     ), changed_prospects as (
       update app.prospects p set version = version + 1
       from targets t where p.id = t.prospect_id returning p.id
     ), approvals as (
       insert into app.message_approvals
         (message_id, approved, actor, message_content_hash, reason)
       select t.message_id, true, 'application-user',
              encode(digest(t.subject || chr(31) || t.body_text, 'sha256'), 'hex'),
              'Validation depuis la grille'
       from targets t where $2 in ('approved','scheduled')
       returning id
     ), scheduled as (
       insert into app.outbox_jobs
         (message_id, conversation_id, campaign_id, prospect_id, account_id, step,
          status, approval_required, approved_at, due_at, idempotency_key)
       select t.message_id, t.conversation_id, t.campaign_id, t.prospect_id,
              t.sender_account_id, t.step, 'scheduled', true, clock_timestamp(),
              clock_timestamp(), 'ui-schedule:' || t.message_id::text
       from targets t
       join app.prospects p on p.id = t.prospect_id
       where $2 = 'scheduled' and p.contact_kind = 'email' and p.normalized_email is not null
         and not app.is_excluded(p.normalized_email)
       on conflict (idempotency_key) do update
         set status = case when app.outbox_jobs.status in ('completed','uncertain') then app.outbox_jobs.status else 'scheduled' end,
             due_at = case when app.outbox_jobs.status in ('completed','uncertain') then app.outbox_jobs.due_at else clock_timestamp() end,
             updated_at = clock_timestamp()
       returning id
     ), cancelled as (
       update app.outbox_jobs j set status = 'cancelled', cancelled_at = clock_timestamp(),
         cancel_reason = 'user_cancelled', updated_at = clock_timestamp()
       from targets t where $2 = 'cancelled' and j.message_id = t.message_id
         and j.status in ('requested','pending','scheduled','deferred','reserved') returning j.id
     )
     select count(*)::int as count from changed_prospects`,
    [ids, status, expectedVersion ?? null],
  );
  return Number(row?.count ?? 0);
}

async function bulkProspectStatus(request: Request, identity: AdminIdentity, requestId: string): Promise<Response> {
  const value = await parseJson(request, z.object({ ids: z.array(uuid).min(1).max(500), status: editableMessageStatus }));
  const updated = await setProspectStatus([...new Set(value.ids)], value.status);
  await logMutation(identity, requestId, { action: "prospects_bulk_status_updated", entityType: "prospect", metadata: { requested: value.ids.length, updated, status: value.status } });
  return json({ updated });
}

async function createExclusion(request: Request, identity: AdminIdentity, requestId: string): Promise<Response> {
  const value = await parseJson(request, z.object({
    matchType: z.enum(["email", "domain"]),
    matchValue: z.string().trim().min(3).max(320),
    reason: z.string().max(2_000).optional(),
    permanent: z.boolean().default(true),
  }));
  const row = await sqlOne<{ id: string }>(
    `with inserted as (
       insert into app.exclusions (match_type, match_value, reason, source, permanent, created_by)
       values ($1, $2, $3, 'manual', $4, $5)
       returning *
     ), affected as (
       update app.prospects p set contact_state = 'do_not_contact', version = version + 1
       from inserted e where (e.match_type = 'email' and p.normalized_email = e.normalized_value)
          or (e.match_type = 'domain' and split_part(p.normalized_email, '@', 2) = e.normalized_value)
       returning p.id
     ), cancelled as (
       update app.outbox_jobs j set status = 'cancelled', cancelled_at = clock_timestamp(),
         cancel_reason = 'exclusion_added', updated_at = clock_timestamp()
       where j.prospect_id in (select id from affected)
         and j.status in ('requested','pending','scheduled','deferred','reserved') returning j.id
     ) select id::text from inserted`,
    [value.matchType, value.matchValue, value.reason ?? null, value.permanent, identity.email],
  );
  if (!row) throw new HttpError(500, "exclusion_create_failed", "L’exclusion n’a pas pu être créée.");
  await logMutation(identity, requestId, { action: "exclusion_created", entityType: "exclusion", entityId: row.id, after: value });
  return json({ exclusion: row }, 201);
}

async function revokeExclusion(id: string, identity: AdminIdentity, requestId: string): Promise<Response> {
  const row = await sqlOne(`update app.exclusions set revoked_at = clock_timestamp(), revoked_by = $2 where id = $1::uuid and revoked_at is null returning *`, [id, identity.email]);
  if (!row) throw new HttpError(404, "exclusion_not_found", "Exclusion introuvable.");
  await logMutation(identity, requestId, { action: "exclusion_revoked", entityType: "exclusion", entityId: id, before: row });
  return noContent();
}

const gmailSchema = z.object({
  email: z.string().trim().email().max(320),
  displayName: z.string().trim().max(180).nullable().optional(),
  role: z.enum(["sender", "primary", "test_inbox"]),
  appPassword: z.string().min(8).max(500).optional(),
  dailyLimit: z.number().int().min(0).max(2_000).default(20),
  warmupDailyLimit: z.number().int().min(0).max(2_000).nullable().optional(),
  sendDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).default([1, 2, 3, 4, 5]),
  sendStart: z.string().regex(/^\d{2}:\d{2}$/).default("08:00"),
  sendEnd: z.string().regex(/^\d{2}:\d{2}$/).default("18:00"),
  timezone: z.string().min(1).max(100).default("Europe/Paris"),
  randomizeSendTimes: z.boolean().default(true),
  progressiveRampEnabled: z.boolean().default(true),
  version: version.optional(),
});

function credentialKind(role: "sender" | "primary" | "test_inbox") {
  return role === "sender" ? "gmail_sender" as const : role === "primary" ? "gmail_primary" as const : "test_inbox" as const;
}

async function createGmailAccount(request: Request, identity: AdminIdentity, requestId: string): Promise<Response> {
  const value = await parseJson(request, gmailSchema.extend({ appPassword: z.string().min(8).max(500) }));
  const credential = await storeCredential({ kind: credentialKind(value.role), label: value.email, secret: value.appPassword });
  try {
    const row = await sqlOne<{ id: string }>(
      `insert into app.gmail_accounts
        (email, display_name, role, credential_id, daily_limit, warmup_daily_limit,
         send_days, send_start, send_end, timezone, randomize_send_times, progressive_ramp_enabled)
       values ($1, $2, $3, $4::uuid, $5, $6, $7::smallint[], $8::time, $9::time, $10, $11, $12)
       returning id::text`,
      [value.email, value.displayName ?? null, value.role, credential.id, value.dailyLimit,
        value.warmupDailyLimit ?? null, value.sendDays, value.sendStart, value.sendEnd,
        value.timezone, value.randomizeSendTimes, value.progressiveRampEnabled],
    );
    if (!row) throw new Error("account insert did not return a row");
    await logMutation(identity, requestId, { action: "gmail_account_created", entityType: "gmail_account", entityId: row.id, after: { ...value, appPassword: "[redacted]" } });
    return json({ account: row }, 201);
  } catch (error) {
    await retireCredential(credential.id).catch(() => undefined);
    throw error;
  }
}

async function updateGmailAccount(request: Request, id: string, identity: AdminIdentity, requestId: string): Promise<Response> {
  const value = await parseJson(request, gmailSchema.partial().extend({ version: version.optional() }));
  const before = await sqlOne<{ credential_id: string | null; role: "sender" | "primary" | "test_inbox"; email: string }>(`select * from app.gmail_accounts where id = $1::uuid and deleted_at is null`, [id]);
  if (!before) throw new HttpError(404, "gmail_account_not_found", "Compte Gmail introuvable.");
  let credentialId: string | null = null;
  if (value.appPassword) {
    const role = value.role ?? before.role;
    credentialId = (await storeCredential({ kind: credentialKind(role), label: value.email ?? before.email, secret: value.appPassword })).id;
  }
  try {
    const row = await sqlOne<{ id: string; version: number }>(
      `update app.gmail_accounts set
         email = coalesce($2, email), display_name = coalesce($3, display_name),
         role = coalesce($4, role), credential_id = coalesce($5::uuid, credential_id),
         daily_limit = coalesce($6, daily_limit), warmup_daily_limit = coalesce($7, warmup_daily_limit),
         send_days = coalesce($8::smallint[], send_days), send_start = coalesce($9::time, send_start),
         send_end = coalesce($10::time, send_end), timezone = coalesce($11, timezone),
         randomize_send_times = coalesce($12, randomize_send_times),
         progressive_ramp_enabled = coalesce($13, progressive_ramp_enabled), version = version + 1
       where id = $1::uuid and deleted_at is null and ($14::bigint is null or version = $14)
       returning id::text, version::int`,
      [id, value.email ?? null, value.displayName ?? null, value.role ?? null, credentialId,
        value.dailyLimit ?? null, value.warmupDailyLimit ?? null, value.sendDays ?? null,
        value.sendStart ?? null, value.sendEnd ?? null, value.timezone ?? null,
        value.randomizeSendTimes ?? null, value.progressiveRampEnabled ?? null, value.version ?? null],
    );
    if (!row) throw new HttpError(409, "version_conflict", "Le compte Gmail a été modifié ailleurs.");
    if (credentialId && before.credential_id) await retireCredential(before.credential_id);
    await logMutation(identity, requestId, { action: "gmail_account_updated", entityType: "gmail_account", entityId: id, before, after: { ...value, appPassword: value.appPassword ? "[redacted]" : undefined } });
    return json({ account: row });
  } catch (error) {
    if (credentialId) await retireCredential(credentialId).catch(() => undefined);
    throw error;
  }
}

async function deleteGmailAccount(id: string, identity: AdminIdentity, requestId: string): Promise<Response> {
  const row = await sqlOne<{ credential_id: string | null }>(
    `update app.gmail_accounts set status = 'deleted', deleted_at = clock_timestamp(),
       paused_at = coalesce(paused_at, clock_timestamp()), pause_source = coalesce(pause_source, 'manual'),
       pause_reason = coalesce(pause_reason, 'Compte supprimé'), version = version + 1
     where id = $1::uuid and deleted_at is null returning credential_id::text`, [id]);
  if (!row) throw new HttpError(404, "gmail_account_not_found", "Compte Gmail introuvable.");
  await sqlQuery(`update app.outbox_jobs set status = 'cancelled', cancelled_at = clock_timestamp(), cancel_reason = 'account_deleted' where account_id = $1::uuid and status in ('requested','pending','scheduled','deferred','reserved')`, [id]);
  if (row.credential_id) await retireCredential(row.credential_id);
  await logMutation(identity, requestId, { action: "gmail_account_deleted", entityType: "gmail_account", entityId: id });
  return noContent();
}

async function testGmailAccount(id: string, identity: AdminIdentity, requestId: string): Promise<Response> {
  const account = await sqlOne<{ email: string; credential_id: string }>(`select email, credential_id::text from app.gmail_accounts where id = $1::uuid and deleted_at is null`, [id]);
  if (!account?.credential_id) throw new HttpError(409, "credential_missing", "Aucun mot de passe d’application n’est configuré.");
  const result = await verifyGmail({ email: account.email, credentialId: account.credential_id });
  await sqlQuery(
    `update app.gmail_accounts set
       smtp_verified_at = case when $2 then clock_timestamp() else smtp_verified_at end,
       imap_verified_at = case when $3 then clock_timestamp() else imap_verified_at end,
       status = case
         when $3 and ($2 or $4 = 'outbound_disabled') then 'active'::app.account_status
         else 'error'::app.account_status
       end,
       last_error_code = $4, last_error_at = case when $4 is null then last_error_at else clock_timestamp() end,
       version = version + 1 where id = $1::uuid`,
    [id, result.smtp, result.imap, result.errorCode ?? null],
  );
  await logMutation(identity, requestId, { action: "gmail_account_tested", entityType: "gmail_account", entityId: id, metadata: { ...result } });
  return json(result);
}

const providerSchema = z.object({
  name: z.string().trim().min(1).max(180),
  url: z.string().url().max(2_000),
  enabled: z.boolean().default(true),
  needsTestEmail: z.boolean().default(false),
  capability: z.string().trim().min(1).max(100),
  quotaScope: z.string().max(100).default("unknown"),
  quotaConfidence: z.enum(["documented", "observed", "estimated", "unknown"]).default("unknown"),
  documentationUrl: z.string().url().max(2_000).optional(),
  quotaDescription: z.string().max(5_000).optional(),
});

function providerTestType(capability: string): string {
  return ["authentication", "content", "placement", "blacklist", "headers", "other"].includes(capability) ? capability : "other";
}

async function saveProvider(request: Request, id: string | null, identity: AdminIdentity, requestId: string): Promise<Response> {
  const value = await parseJson(request, id ? providerSchema.partial() : providerSchema);
  const row = id
    ? await sqlOne<{ id: string }>(
        `update app.deliverability_providers set name = coalesce($2, name), base_url = coalesce($3, base_url),
           enabled = coalesce($4, enabled), requires_test_email = coalesce($5, requires_test_email),
           test_type = coalesce($6, test_type),
           capabilities = case when $7::text is null then capabilities else capabilities || jsonb_build_object('uiCapability', $7::text) end,
           documentation_url = coalesce($8, documentation_url), quota_description = coalesce($9, quota_description)
         where id = $1::uuid returning id::text`,
        [id, value.name ?? null, value.url ?? null, value.enabled ?? null, value.needsTestEmail ?? null,
          value.capability ? providerTestType(value.capability) : null, value.capability ?? null,
          value.documentationUrl ?? null, value.quotaDescription ?? null],
      )
    : await sqlOne<{ id: string }>(
        `insert into app.deliverability_providers
           (name, base_url, enabled, requires_test_email, test_type, capabilities, documentation_url, quota_description)
         values ($1, $2, $3, $4, $5, jsonb_build_object('uiCapability', $6::text), $7, $8)
         returning id::text`,
        [value.name, value.url, value.enabled, value.needsTestEmail, providerTestType(value.capability!),
          value.capability, value.documentationUrl ?? null, value.quotaDescription ?? null],
      );
  if (!row) throw new HttpError(404, "provider_not_found", "Vérificateur introuvable.");
  if (value.quotaScope || value.quotaConfidence) {
    await sqlQuery(
      `insert into app.provider_limits (provider_id, scope_type, evidence_level)
       values ($1::uuid, $2, $3)`,
      [row.id, value.quotaScope ?? "unknown", value.quotaConfidence ?? "unknown"],
    );
  }
  await logMutation(identity, requestId, { action: id ? "provider_updated" : "provider_created", entityType: "deliverability_provider", entityId: row.id, after: value });
  return json({ provider: row }, id ? 200 : 201);
}

async function deleteProvider(id: string, identity: AdminIdentity, requestId: string): Promise<Response> {
  const row = await sqlOne(`update app.deliverability_providers set enabled = false where id = $1::uuid returning id`, [id]);
  if (!row) throw new HttpError(404, "provider_not_found", "Vérificateur introuvable.");
  await logMutation(identity, requestId, { action: "provider_disabled", entityType: "deliverability_provider", entityId: id });
  return noContent();
}

async function saveCredential(request: Request, identity: AdminIdentity, requestId: string): Promise<Response> {
  const value = await parseJson(request, z.object({
    kind: z.enum(["gmail_sender", "gmail_primary", "test_inbox", "bobwork"]),
    label: z.string().trim().min(1).max(180),
    secret: z.string().min(1).max(20_000),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }));
  const saved = await storeCredential(value);
  if (value.kind === "bobwork") {
    await sqlQuery(`update app.bobwork_connections set credential_id = $1::uuid, status = 'configured', last_error_code = null`, [saved.id]);
  }
  await logMutation(identity, requestId, { action: "credential_saved", entityType: "credential", entityId: saved.id, metadata: { kind: value.kind, label: value.label } });
  return json({ configured: saved.configured, verificationStatus: saved.verificationStatus }, 201);
}

async function initializeVault(identity: AdminIdentity, requestId: string): Promise<Response> {
  const result = await initializeCredentialVault();
  await logMutation(identity, requestId, {
    action: result.created ? "credential_vault_initialized" : "credential_vault_checked",
    entityType: "credential_vault",
    entityId: "global",
    metadata: { source: result.source },
  });
  return json(result, result.created ? 201 : 200);
}

async function importPreview(request: Request, identity: AdminIdentity, requestId: string): Promise<Response> {
  const payload = await parseJson(request, importPayloadSchema, 16_000_000);
  const normalized = await stageImport(payload, identity.email);
  await logMutation(identity, requestId, { action: "import_previewed", entityType: "import_batch", entityId: normalized.importId, metadata: normalized.summary });
  return json({ importId: normalized.importId, ...normalized.summary });
}

async function importCommit(request: Request, identity: AdminIdentity, requestId: string): Promise<Response> {
  const payload = await parseJson(request, importPayloadSchema, 16_000_000);
  const result = await commitStagedImport(payload, identity.email);
  await logMutation(identity, requestId, { action: "import_committed", entityType: "import_batch", metadata: result.report });
  return json(result);
}

async function exportData(): Promise<Response> {
  const [dashboard, exclusions, contactHistory, diagnostics] = await Promise.all([
    loadDashboard(),
    sqlQuery(`select id::text, match_type, match_value, reason, source, permanent, created_at, revoked_at from app.exclusions order by created_at`),
    sqlQuery(`select normalized_email, first_contact_at, confirmation_source, technically_confirmed, source_reference from app.contact_history order by created_at`),
    sqlQuery(`select id::text, provider_id::text, sender_account_id::text, status::text, destination_address, created_at, updated_at from app.diagnostic_requests order by created_at`),
  ]);
  return json({ format: "prospection95-backup-v1", exportedAt: new Date().toISOString(), dashboard, exclusions, contactHistory, diagnostics });
}

async function diagnostics(request: Request): Promise<Response> {
  if (request.method === "GET") {
    return json({ diagnostics: await sqlQuery(`
      select d.id::text, d.provider_id::text, p.name as provider_name,
             d.sender_account_id::text, a.email as sender_email, d.status::text,
             d.destination_address, d.requires_email, d.next_eligible_at,
             d.failure_code, d.created_at, r.overall_state, r.report_url
      from app.diagnostic_requests d
      join app.deliverability_providers p on p.id = d.provider_id
      join app.gmail_accounts a on a.id = d.sender_account_id
      left join app.diagnostic_reports r on r.request_id = d.id
      order by d.created_at desc limit 500`)});
  }
  requireMethod(request, "POST");
  const value = await parseJson(request, z.object({
    providerId: uuid, senderAccountId: uuid, testInboxId: uuid.nullable().optional(),
    destinationAddress: z.string().email().nullable().optional(),
    priority: z.number().int().min(0).max(10_000).default(100),
    idempotencyKey: z.string().min(8).max(240),
  }));
  const row = await sqlOne<{ id: string }>(
    `select agent_api.request_diagnostic(
       $1::uuid, $2::uuid, $3::uuid, $4, null, $6, $5
     )::text as id`,
    [value.providerId, value.senderAccountId, value.testInboxId ?? null,
      value.destinationAddress ?? null, value.priority, value.idempotencyKey],
  );
  if (!row) throw new HttpError(409, "provider_unavailable", "Le vérificateur est indisponible.");
  return json({ diagnostic: row }, 201);
}

async function experiments(request: Request, id?: string): Promise<Response> {
  if (!id && request.method === "GET") {
    const dashboard = await loadDashboard();
    return json({ experiments: dashboard.experiments });
  }
  if (!id) {
    requireMethod(request, "POST");
    const value = await parseJson(request, z.object({
      campaignId: uuid, name: z.string().trim().min(1).max(180),
      scope: z.enum(["population", "subject", "step", "sequence", "instructions", "combined"]).default("sequence"),
      targetStep: z.enum(["J0", "R1", "R2", "R3", "R4", "R5"]).nullable().optional(),
      thresholdContactsPerVariant: z.number().int().positive().default(40),
      thresholdReplies: z.number().int().positive().default(20),
      idempotencyKey: z.string().min(8).max(240),
      variants: z.array(z.object({ label: z.string().regex(/^[A-Z]{1,3}$/), name: z.string().max(180).optional(), allocationWeight: z.number().positive().default(1), overrides: z.record(z.string(), z.unknown()).default({}) })).min(2).max(12),
    }));
    const row = await sqlOne<{ id: string }>(
      `with created as (
         insert into app.experiments
           (campaign_id, name, scope, target_step, contacts_per_variant_threshold,
            total_responses_threshold, idempotency_key)
         values ($1::uuid, $2, $3, $4::app.sequence_step, $5, $6, $7)
         on conflict (campaign_id, idempotency_key) do update set idempotency_key = excluded.idempotency_key
         returning id
       ), variants as (
         insert into app.experiment_variants (experiment_id, code, name, weight, overrides)
         select created.id, value.label, value.name, value.weight, value.overrides
         from created cross join jsonb_to_recordset($8::jsonb)
           as value(label text, name text, weight numeric, overrides jsonb)
         on conflict (experiment_id, code) do nothing returning id
       ) select id::text from created`,
      [value.campaignId, value.name, value.scope, value.targetStep ?? null,
        value.thresholdContactsPerVariant, value.thresholdReplies, value.idempotencyKey,
        JSON.stringify(value.variants.map((variant) => ({ label: variant.label, name: variant.name ?? null, weight: variant.allocationWeight, overrides: variant.overrides })))],
    );
    return json({ experiment: row }, 201);
  }
  requireMethod(request, "PATCH", "DELETE");
  if (request.method === "DELETE") {
    const row = await sqlOne(`update app.experiments set status = 'cancelled', closed_at = clock_timestamp() where id = $1::uuid returning id`, [id]);
    if (!row) throw new HttpError(404, "experiment_not_found", "Expérience introuvable.");
    return noContent();
  }
  const value = await parseJson(request, z.object({ status: z.enum(["draft", "recruiting", "threshold_reached", "awaiting_observations", "mature", "analyzed", "closed", "cancelled"]), decision: z.string().max(10_000).optional(), limitations: z.string().max(10_000).optional() }));
  const row = await sqlOne(`update app.experiments set status = $2::app.experiment_status, decision = coalesce($3, decision), limitations = coalesce($4, limitations), closed_at = case when $2 in ('closed','cancelled') then clock_timestamp() else closed_at end where id = $1::uuid returning id::text`, [id, value.status, value.decision ?? null, value.limitations ?? null]);
  if (!row) throw new HttpError(404, "experiment_not_found", "Expérience introuvable.");
  return json({ experiment: row });
}

async function privateRoute(request: Request, parts: string[], identity: AdminIdentity, requestId: string): Promise<Response> {
  if (parts[0] === "dashboard" && parts.length === 1) { requireMethod(request, "GET"); return json(await loadDashboard()); }
  if (parts[0] === "settings" && parts.length === 1) { requireMethod(request, "PATCH"); return updateSettings(request, identity, requestId); }
  if (parts[0] === "emergency-stop" && parts.length === 1) { requireMethod(request, "POST"); return emergencyStop(request, identity, requestId); }
  if (parts[0] === "campaigns" && parts.length === 1) { requireMethod(request, "POST"); return createCampaign(request, identity, requestId); }
  if (parts[0] === "campaigns" && parts.length === 2) {
    const id = routeUuid(parts[1]);
    if (request.method === "PATCH") return updateCampaign(request, id, identity, requestId);
    if (request.method === "DELETE") return archiveCampaign(id, identity, requestId);
    requireMethod(request, "PATCH", "DELETE");
  }
  if (parts[0] === "campaign-folders" && parts.length === 1) return campaignFolders(request, null, identity, requestId);
  if (parts[0] === "campaign-folders" && parts.length === 2) return campaignFolders(request, routeUuid(parts[1]), identity, requestId);
  if (parts[0] === "prospects" && parts[1] === "bulk-status" && parts.length === 2) { requireMethod(request, "POST"); return bulkProspectStatus(request, identity, requestId); }
  if (parts[0] === "prospects" && parts.length === 2) { requireMethod(request, "PATCH"); return updateProspect(request, routeUuid(parts[1]), identity, requestId); }
  if (parts[0] === "exclusions" && parts.length === 1) { requireMethod(request, "POST"); return createExclusion(request, identity, requestId); }
  if (parts[0] === "exclusions" && parts.length === 2) { requireMethod(request, "DELETE"); return revokeExclusion(routeUuid(parts[1]), identity, requestId); }
  if (parts[0] === "gmail-accounts" && parts.length === 1) { requireMethod(request, "POST"); return createGmailAccount(request, identity, requestId); }
  if (parts[0] === "gmail-accounts" && parts.length === 3 && parts[2] === "test") { requireMethod(request, "POST"); return testGmailAccount(routeUuid(parts[1]), identity, requestId); }
  if (parts[0] === "gmail-accounts" && parts.length === 2) {
    const id = routeUuid(parts[1]);
    if (request.method === "PATCH") return updateGmailAccount(request, id, identity, requestId);
    if (request.method === "DELETE") return deleteGmailAccount(id, identity, requestId);
    requireMethod(request, "PATCH", "DELETE");
  }
  if (parts[0] === "providers" && parts.length === 1) { requireMethod(request, "POST"); return saveProvider(request, null, identity, requestId); }
  if (parts[0] === "providers" && parts.length === 2) {
    const id = routeUuid(parts[1]);
    if (request.method === "PATCH") return saveProvider(request, id, identity, requestId);
    if (request.method === "DELETE") return deleteProvider(id, identity, requestId);
    requireMethod(request, "PATCH", "DELETE");
  }
  if (parts[0] === "credentials" && parts.length === 1) { requireMethod(request, "POST"); return saveCredential(request, identity, requestId); }
  if (parts[0] === "vault" && parts[1] === "initialize" && parts.length === 2) { requireMethod(request, "POST"); return initializeVault(identity, requestId); }
  if (parts[0] === "import" && parts[1] === "preview" && parts.length === 2) { requireMethod(request, "POST"); return importPreview(request, identity, requestId); }
  if (parts[0] === "import" && parts[1] === "commit" && parts.length === 2) { requireMethod(request, "POST"); return importCommit(request, identity, requestId); }
  if (parts[0] === "export" && parts.length === 1) { requireMethod(request, "GET"); return exportData(); }
  if (parts[0] === "diagnostics" && parts.length === 1) return diagnostics(request);
  if (parts[0] === "experiments" && parts.length <= 2) return experiments(request, parts[1] ? routeUuid(parts[1]) : undefined);
  throw new HttpError(404, "not_found", "Route API introuvable.");
}

export default async function handler(request: Request, _context: Context): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    const parts = routeParts(request);
    if (parts.length === 1 && parts[0] === "health") {
      requireMethod(request, "GET");
      return await health();
    }
    const identity = await requireAdmin(request);
    return await privateRoute(request, parts, identity, requestId);
  } catch (error) {
    return handleError(error, requestId);
  }
}

export const config: Config = {
  path: "/api/*",
  method: ["GET", "POST", "PATCH", "DELETE"],
};
