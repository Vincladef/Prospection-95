import { sqlQuery } from "./db.mts";
import { env } from "./env.mts";

type DbRow = Record<string, unknown>;

const STEPS = ["J0", "R1", "R2", "R3", "R4", "R5"] as const;

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

function nullableText(value: unknown): string | null {
  return value == null ? null : String(value);
}

function isoValue(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
}

function timeValue(value: unknown): string {
  return textValue(value, "08:00").slice(0, 5);
}

export async function loadDashboard(): Promise<Record<string, unknown>> {
  const [settingsRows, folderRows, campaignRows, templateRows, prospectRows, messageRows, accountRows, providerRows, experimentRows, variantRows] = await Promise.all([
    sqlQuery(`select * from app.settings where singleton`),
    sqlQuery(`select id::text, name, position from app.campaign_folders order by position, name`),
    sqlQuery(`
      select c.*,
             coalesce((
               select array_agg(csa.account_id::text order by csa.account_id)
               from app.campaign_sender_accounts csa
               where csa.campaign_id = c.id and csa.enabled
             ), '{}'::text[]) as sender_account_ids
      from app.campaigns c order by c.created_at desc
    `),
    sqlQuery(`
      select distinct on (campaign_id, step)
        campaign_id::text, step::text, subject, body
      from app.message_templates
      order by campaign_id, step, version desc, created_at desc
    `),
    sqlQuery(`
      select p.id::text, p.full_name, p.email, p.contact_raw, p.website_url,
             p.contact_state::text, p.version, o.name as organization_name,
             selected.campaign_id::text, selected.campaign_name,
             conv.id::text as conversation_id, conv.current_step::text,
             latest.status::text as message_status,
             coalesce(latest.smtp_accepted_at, latest.sent_at) as last_sent_at,
             ga.email as sender_email,
             exists(select 1 from app.contact_history h where h.normalized_email = p.normalized_email) as already_contacted,
             coalesce(app.is_excluded(p.email), false) as excluded,
             exclusion.reason as exclusion_reason,
             ev.code as variant_label
      from app.prospects p
      left join app.organizations o on o.id = p.organization_id
      left join lateral (
        select cp.campaign_id, c.name as campaign_name, cp.updated_at
        from app.campaign_prospects cp
        join app.campaigns c on c.id = cp.campaign_id
        where cp.prospect_id = p.id
        order by cp.updated_at desc, cp.created_at desc
        limit 1
      ) selected on true
      left join app.conversations conv
        on conv.prospect_id = p.id and conv.campaign_id = selected.campaign_id
      left join app.gmail_accounts ga on ga.id = conv.sender_account_id
      left join lateral (
        select m.status, m.smtp_accepted_at, m.sent_at
        from app.email_messages m
        where m.conversation_id = conv.id and m.direction = 'outbound'
        order by
          case when not m.technical_confirmation and m.status not in ('cancelled','failed') then 0 else 1 end,
          case m.step
            when 'J0' then 0 when 'R1' then 1 when 'R2' then 2
            when 'R3' then 3 when 'R4' then 4 when 'R5' then 5 else 6
          end,
          m.content_version desc,
          coalesce(m.smtp_accepted_at, m.sent_at, m.updated_at) desc
        limit 1
      ) latest on true
      left join lateral (
        select e.reason
        from app.exclusions e
        where e.revoked_at is null and p.normalized_email is not null
          and ((e.match_type = 'email' and e.normalized_value = p.normalized_email)
            or (e.match_type = 'domain' and e.normalized_value = split_part(p.normalized_email, '@', 2)))
        order by e.created_at desc limit 1
      ) exclusion on true
      left join app.experiment_assignments ea on ea.id = conv.experiment_assignment_id
      left join app.experiment_variants ev on ev.id = ea.variant_id
      where p.deleted_at is null
      order by p.created_at desc
    `),
    sqlQuery(`
      select distinct on (conv.prospect_id, m.step)
        conv.prospect_id::text, m.step::text, m.subject, m.body_text
      from app.conversations conv
      join app.email_messages m on m.conversation_id = conv.id
      where m.direction = 'outbound' and m.step is not null
      order by conv.prospect_id, m.step, m.content_version desc, m.created_at desc
    `),
    sqlQuery(`select * from app.gmail_accounts where deleted_at is null order by created_at`),
    sqlQuery(`
      select p.*,
             limit_row.scope_type as quota_scope,
             limit_row.evidence_level as quota_confidence,
             limit_row.blocked_until as next_eligible_at,
             limit_row.observed_at as last_used_at
      from app.deliverability_providers p
      left join lateral (
        select l.scope_type, l.evidence_level, l.blocked_until, l.observed_at
        from app.provider_limits l where l.provider_id = p.id
        order by l.observed_at desc limit 1
      ) limit_row on true
      order by p.name
    `),
    sqlQuery(`select * from app.experiments order by created_at desc`),
    sqlQuery(`
      select v.*,
        count(distinct a.id)::int as assigned_count,
        count(distinct e.id) filter (where e.event_type = 'smtp_accepted')::int as sent_count,
        count(distinct e.id) filter (where e.event_type = 'human_reply')::int as human_reply_count,
        count(distinct e.id) filter (where e.event_type = 'positive_reply')::int as positive_reply_count,
        count(distinct e.id) filter (where e.event_type = 'confirmed_meeting')::int as confirmed_meeting_count
      from app.experiment_variants v
      left join app.experiment_assignments a on a.variant_id = v.id
      left join app.experiment_events e on e.variant_id = v.id and e.measured
      group by v.id
      order by v.experiment_id, v.code
    `),
  ]);

  const settingsRow = settingsRows[0] ?? {};
  const templates = new Map<string, { subject: string; body: string }>();
  for (const row of templateRows) {
    templates.set(`${row.campaign_id}:${row.step}`, {
      subject: textValue(row.subject),
      body: textValue(row.body),
    });
  }
  const messages = new Map<string, { subject: string; body: string }>();
  for (const row of messageRows) {
    messages.set(`${row.prospect_id}:${row.step}`, {
      subject: textValue(row.subject),
      body: textValue(row.body_text),
    });
  }

  const campaigns = campaignRows.map((row) => ({
    id: textValue(row.id),
    folderId: nullableText(row.folder_id),
    name: textValue(row.name),
    status: textValue(row.status),
    targetDescription: textValue(row.target_description),
    dailyNewContactGoal: numberValue(row.daily_new_contact_goal),
    validationPolicy: textValue(row.validation_policy),
    senderStrategy: textValue(row.sender_strategy),
    fixedSenderAccountId: nullableText(row.fixed_sender_account_id),
    senderAccountIds: Array.isArray(row.sender_account_ids) ? row.sender_account_ids.map((value) => textValue(value)) : [],
    aiInstructions: textValue(row.ai_instructions),
    replyInstructions: textValue(row.reply_instructions),
    trackingOpensEnabled: Boolean(row.tracking_opens_enabled),
    trackingClicksEnabled: Boolean(row.tracking_clicks_enabled),
    experimentPolicy: textValue(row.experiment_policy),
    nextTestInstructions: textValue(row.next_test_instructions),
    importedDisabled: Boolean(row.imported_disabled),
    version: numberValue(row.version),
    sequence: {
      subject: templates.get(`${row.id}:J0`)?.subject ?? "",
      steps: STEPS.map((step) => templates.get(`${row.id}:${step}`)?.body ?? ""),
    },
    updatedAt: isoValue(row.updated_at),
  }));

  const prospects = prospectRows.map((row) => {
    const campaignId = nullableText(row.campaign_id);
    const contentFor = (step: typeof STEPS[number]) =>
      messages.get(`${row.id}:${step}`) ?? (campaignId ? templates.get(`${campaignId}:${step}`) : undefined);
    return {
      id: textValue(row.id),
      campaignId,
      campaignName: nullableText(row.campaign_name),
      organizationName: nullableText(row.organization_name),
      name: textValue(row.full_name),
      email: nullableText(row.email),
      contactRaw: nullableText(row.contact_raw),
      website: nullableText(row.website_url),
      contactState: textValue(row.contact_state),
      messageStatus: nullableText(row.message_status),
      step: nullableText(row.current_step),
      lastSentAt: isoValue(row.last_sent_at),
      senderEmail: nullableText(row.sender_email),
      alreadyContacted: Boolean(row.already_contacted),
      excluded: Boolean(row.excluded),
      exclusionReason: nullableText(row.exclusion_reason),
      variantLabel: nullableText(row.variant_label),
      subject: contentFor("J0")?.subject ?? "",
      messages: STEPS.map((step) => contentFor(step)?.body ?? ""),
      version: numberValue(row.version),
    };
  });

  const gmailAccounts = accountRows.map((row) => ({
    id: textValue(row.id),
    email: textValue(row.email),
    displayName: nullableText(row.display_name),
    role: textValue(row.role),
    status: textValue(row.status),
    hasCredential: row.credential_id != null,
    dailyLimit: numberValue(row.daily_limit),
    warmupDailyLimit: row.warmup_daily_limit == null ? null : numberValue(row.warmup_daily_limit),
    sendDays: Array.isArray(row.send_days) ? row.send_days.map(numberValue) : [],
    sendStart: timeValue(row.send_start),
    sendEnd: timeValue(row.send_end),
    timezone: textValue(row.timezone, "Europe/Paris"),
    randomizeSendTimes: Boolean(row.randomize_send_times),
    progressiveRampEnabled: Boolean(row.progressive_ramp_enabled),
    pausedAt: isoValue(row.paused_at),
    pauseSource: nullableText(row.pause_source),
    pauseReason: nullableText(row.pause_reason),
    smtpVerifiedAt: isoValue(row.smtp_verified_at),
    imapVerifiedAt: isoValue(row.imap_verified_at),
    lastSyncAt: isoValue(row.last_sync_at),
    lastErrorCode: nullableText(row.last_error_code),
    version: numberValue(row.version),
  }));

  const providers = providerRows.map((row) => ({
    id: textValue(row.id),
    name: textValue(row.name),
    url: textValue(row.base_url),
    enabled: Boolean(row.enabled),
    needsTestEmail: Boolean(row.requires_test_email),
    capability: textValue((row.capabilities as DbRow | null)?.uiCapability, textValue(row.test_type)),
    quotaScope: textValue(row.quota_scope, "unknown"),
    quotaConfidence: textValue(row.quota_confidence, "unknown"),
    nextEligibleAt: isoValue(row.next_eligible_at),
    lastUsedAt: isoValue(row.last_used_at),
  }));

  const variantsByExperiment = new Map<string, Record<string, unknown>[]>();
  for (const row of variantRows) {
    const list = variantsByExperiment.get(textValue(row.experiment_id)) ?? [];
    list.push({
      id: textValue(row.id),
      label: textValue(row.code),
      allocationWeight: numberValue(row.weight),
      overrides: (row.overrides as DbRow | null) ?? {},
      assignedCount: numberValue(row.assigned_count),
      sentCount: numberValue(row.sent_count),
      humanReplyCount: numberValue(row.human_reply_count),
      positiveReplyCount: numberValue(row.positive_reply_count),
      confirmedMeetingCount: numberValue(row.confirmed_meeting_count),
    });
    variantsByExperiment.set(textValue(row.experiment_id), list);
  }
  const experiments = experimentRows.map((row) => ({
    id: textValue(row.id),
    campaignId: textValue(row.campaign_id),
    name: textValue(row.name),
    status: textValue(row.status),
    thresholdContactsPerVariant: numberValue(row.contacts_per_variant_threshold),
    thresholdReplies: numberValue(row.total_responses_threshold),
    variants: variantsByExperiment.get(textValue(row.id)) ?? [],
  }));

  return {
    settings: {
      timezone: textValue(settingsRow.timezone, "Europe/Paris"),
      outboundEnabled: Boolean(settingsRow.outbound_enabled),
      vaultConfigured: Buffer.from(env("CREDENTIALS_ENCRYPTION_KEY", "")!, "base64").byteLength === 32,
      emergencyStop: Boolean(settingsRow.emergency_stop),
      emergencyStopReason: nullableText(settingsRow.emergency_stop_reason),
      generalWritingInstructions: textValue(settingsRow.general_writing_instructions),
      defaultSendDays: Array.isArray(settingsRow.default_send_days)
        ? settingsRow.default_send_days.map(numberValue)
        : [1, 2, 3, 4, 5],
      defaultSendStart: timeValue(settingsRow.default_send_start),
      defaultSendEnd: timeValue(settingsRow.default_send_end),
      version: numberValue(settingsRow.version),
    },
    folders: folderRows.map((row) => ({
      id: textValue(row.id),
      name: textValue(row.name),
      position: numberValue(row.position),
    })),
    campaigns,
    prospects,
    gmailAccounts,
    providers,
    experiments,
    totals: {
      prospects: prospects.length,
      pendingApproval: prospects.filter((row) => ["draft", "prepared", "pending_approval"].includes(row.messageStatus ?? "")).length,
      scheduled: prospects.filter((row) => ["approved", "scheduled", "reserved", "sending"].includes(row.messageStatus ?? "")).length,
      sent: prospects.filter((row) => ["smtp_accepted", "sent_manually"].includes(row.messageStatus ?? "")).length,
      replied: prospects.filter((row) => row.contactState === "replied" || row.messageStatus === "received").length,
      excluded: prospects.filter((row) => row.excluded).length,
    },
  };
}
