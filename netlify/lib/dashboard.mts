import { sqlQuery } from "./db.mts";
import { credentialVaultConfigured } from "./credentials.mts";

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

function jsonObject(value: unknown): DbRow {
  return value && typeof value === "object" && !Array.isArray(value) ? value as DbRow : {};
}

function firstMetric(metrics: DbRow, ...keys: string[]): unknown {
  const sources = [metrics, jsonObject(metrics.statistics), jsonObject(metrics.stats), jsonObject(metrics.metrics)];
  for (const source of sources) {
    for (const key of keys) if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(?:true|false)$/i.test(value)) return value.toLowerCase() === "true";
  return null;
}

export async function loadDashboard(): Promise<Record<string, unknown>> {
  const [vaultConfigured, settingsRows, folderRows, campaignRows, templateRows, prospectRows, messageRows, accountRows, providerRows, experimentRows, variantRows, campaignStatsRows, attachmentRows] = await Promise.all([
    credentialVaultConfigured(),
    sqlQuery(`select * from app.settings where singleton`),
    sqlQuery(`select id::text, name, position from app.campaign_folders order by position, name`),
    sqlQuery(`
      select c.*,
             coalesce((
               select array_agg(csa.account_id::text order by csa.account_id)
               from app.campaign_sender_accounts csa
               where csa.campaign_id = c.id and csa.enabled
             ), '{}'::text[]) as sender_account_ids
      from app.campaigns c
      order by c.created_at desc
    `),
    sqlQuery(`
      select distinct on (campaign_id, step)
        campaign_id::text, step::text, subject, body, instructions
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
             coalesce(interactions.open_observed, false) as open_observed,
             coalesce(interactions.click_observed, false) as click_observed,
             interactions.first_open_at, interactions.last_open_at,
             interactions.first_click_at, interactions.last_click_at,
             interactions.open_observation_count, interactions.click_observation_count,
             coalesce(iteration_state.status, 'pending') as writing_iteration_status,
             coalesce(iteration_state.completed_iterations, 0) as writing_iterations_completed,
             coalesce(iteration_state.total_iterations, configured_iterations.total_iterations, 1) as writing_iterations_total,
             exists (
               select 1 from app.email_messages existing_message
               where existing_message.conversation_id = conv.id
                 and existing_message.direction = 'outbound'
                 and not existing_message.technical_confirmation
             ) as has_outbound_messages,
             exists(select 1 from app.contact_history h where h.normalized_email = p.normalized_email) as already_contacted,
             coalesce(app.is_excluded(p.email), false) as excluded,
             exclusion.reason as exclusion_reason,
             coalesce(ev.code, progress_variant.code) as variant_label
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
        select state.*
        from app.prospect_iteration_states state
        where state.campaign_id = selected.campaign_id
          and state.prospect_id = p.id
          and (conv.id is null
            or state.experiment_assignment_id is not distinct from conv.experiment_assignment_id)
        order by state.updated_at desc, state.created_at desc
        limit 1
      ) iteration_state on true
      left join lateral (
        select assignment.variant_id
        from app.experiment_assignments assignment
        where assignment.campaign_id = selected.campaign_id
          and assignment.prospect_id = p.id
        order by assignment.assigned_at desc
        limit 1
      ) prospective_assignment on iteration_state.id is null
      left join app.experiment_variants progress_variant
        on progress_variant.id = coalesce(iteration_state.variant_id, prospective_assignment.variant_id)
      left join lateral (
        select case
          when jsonb_typeof(progress_variant.overrides #> '{iterations,draftPasses}') = 'array' then
            case
              when jsonb_array_length(progress_variant.overrides #> '{iterations,draftPasses}') between 1 and 100
              then jsonb_array_length(progress_variant.overrides #> '{iterations,draftPasses}')
              else cardinality(campaign.writing_iteration_instructions)
            end
          else cardinality(campaign.writing_iteration_instructions)
        end::int as total_iterations
        from app.campaigns campaign
        where campaign.id = selected.campaign_id
      ) configured_iterations on true
      left join lateral (
        select m.status, m.smtp_accepted_at, m.sent_at
        from app.email_messages m
        where m.conversation_id = conv.id and m.direction = 'outbound'
          and not m.technical_confirmation
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
        select
          bool_or(observation.event_type = 'open') as open_observed,
          bool_or(observation.event_type = 'click') as click_observed,
          min(observation.observed_at) filter (where observation.event_type = 'open') as first_open_at,
          max(observation.last_observed_at) filter (where observation.event_type = 'open') as last_open_at,
          min(observation.observed_at) filter (where observation.event_type = 'click') as first_click_at,
          max(observation.last_observed_at) filter (where observation.event_type = 'click') as last_click_at,
          sum(observation.observation_count) filter (where observation.event_type = 'open')::int as open_observation_count,
          sum(observation.observation_count) filter (where observation.event_type = 'click')::int as click_observation_count
        from app.email_messages tracked_message
        join app.tracking_events observation on observation.message_id = tracked_message.id
        where tracked_message.conversation_id = conv.id
      ) interactions on true
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
    sqlQuery(`
      select ga.*,
             bw.connected as bobwork_connected,
             bw.warmup_state as bobwork_warmup_state,
             bw.metrics as bobwork_metrics,
             bw.observed_at as bobwork_observed_at,
             bc.status as bobwork_connection_status,
             bc.last_sync_at as bobwork_last_sync_at,
             bc.last_error_code as bobwork_last_error_code,
             diagnostics.results as verifier_results,
             diagnostics.observed_at as verifier_observed_at
      from app.gmail_accounts ga
      left join lateral (
        select b.connected, b.warmup_state, b.metrics, b.observed_at
        from app.bobwork_snapshots b
        where b.account_id = ga.id
        order by b.observed_at desc
        limit 1
      ) bw on true
      left join app.bobwork_connections bc on bc.singleton
      left join lateral (
        select
          coalesce(jsonb_agg(jsonb_build_object(
            'provider', latest.provider_name,
            'overallState', latest.overall_state,
            'dimension', result.dimension,
            'status', result.status,
            'value', coalesce(result.value_text, case when result.value_numeric is not null then result.value_numeric::text || coalesce(' ' || result.unit, '') end),
            'observedAt', latest.observed_at
          ) order by latest.provider_name, result.dimension) filter (where latest.report_id is not null), '[]'::jsonb) as results,
          max(latest.observed_at) as observed_at
        from (
          select distinct on (request.provider_id)
            report.id as report_id, provider.name as provider_name,
            report.overall_state, report.observed_at
          from app.diagnostic_requests request
          join app.deliverability_providers provider on provider.id = request.provider_id
          join app.diagnostic_reports report on report.request_id = request.id
          where request.sender_account_id = ga.id
          order by request.provider_id, report.observed_at desc
        ) latest
        left join app.diagnostic_results result on result.report_id = latest.report_id
      ) diagnostics on true
      where ga.deleted_at is null
      order by ga.created_at
    `),
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
      order by
        case when p.capabilities ->> 'catalogOrder' ~ '^\\d+$'
          then (p.capabilities ->> 'catalogOrder')::int else 100000 end,
        p.name
    `),
    sqlQuery(`
      select experiment.*, winner.code as winner_variant_code
      from app.experiments experiment
      left join app.experiment_variants winner on winner.id = experiment.winner_variant_id
      order by experiment.created_at desc
    `),
    sqlQuery(`
      select v.*,
             coalesce(metrics.assigned_prospects, 0)::int as assigned_count,
             coalesce(metrics.smtp_accepted, 0)::int as sent_count,
             coalesce(metrics.human_replies, 0)::int as human_reply_count,
             coalesce(metrics.positive_replies, 0)::int as positive_reply_count,
             coalesce(metrics.confirmed_meetings, 0)::int as confirmed_meeting_count,
             coalesce(metrics.measured_opens, 0)::int as open_count,
             coalesce(metrics.measured_clicks, 0)::int as click_count,
             coalesce(metrics.unclassified_responses, 0)::int as unclassified_reply_count
      from app.experiment_variants v
      left join agent_api.experiment_metrics metrics
        on metrics.experiment_id = v.experiment_id and metrics.variant_id = v.id
      order by v.experiment_id, v.code
    `),
    sqlQuery(`
      select c.id::text as campaign_id,
             coalesce(outbound.sent, 0)::int as sent,
             coalesce(outbound.contacted, 0)::int as contacted,
             coalesce(outbound.opened, 0)::int as opened,
             coalesce(outbound.clicked, 0)::int as clicked,
             coalesce(inbound.replied, 0)::int as replied,
             coalesce(inbound.unclassified_replies, 0)::int as unclassified_replies,
             outbound.first_sent_at,
             outbound.last_sent_at
      from app.campaigns c
      left join lateral (
        select
          count(*) filter (where m.technical_confirmation and m.status in ('smtp_accepted','sent_manually')) as sent,
          count(distinct conversation.prospect_id) filter (where m.technical_confirmation and m.status in ('smtp_accepted','sent_manually')) as contacted,
          count(*) filter (where m.technical_confirmation and m.status in ('smtp_accepted','sent_manually') and exists (
            select 1 from app.tracking_events event where event.message_id = m.id and event.event_type = 'open'
          )) as opened,
          count(*) filter (where m.technical_confirmation and m.status in ('smtp_accepted','sent_manually') and exists (
            select 1 from app.tracking_events event where event.message_id = m.id and event.event_type = 'click'
          )) as clicked,
          min(coalesce(m.smtp_accepted_at, m.sent_at)) filter (where m.technical_confirmation) as first_sent_at,
          max(coalesce(m.smtp_accepted_at, m.sent_at)) filter (where m.technical_confirmation) as last_sent_at
        from app.conversations conversation
        join app.email_messages m on m.conversation_id = conversation.id and m.direction = 'outbound'
        where conversation.campaign_id = c.id
      ) outbound on true
      left join lateral (
        select
          count(distinct conversation.prospect_id) filter (
            where analysis.classification in ('positive','negative','information','meeting','ambiguous','opposition')
          ) as replied,
          count(distinct reply.id) filter (where analysis.id is null) as unclassified_replies
        from app.conversations conversation
        join app.email_messages reply
          on reply.conversation_id = conversation.id
         and reply.direction = 'inbound'
         and reply.kind = 'reply'
         and reply.status = 'received'
        left join app.inbound_analyses analysis on analysis.message_id = reply.id
        where conversation.campaign_id = c.id
      ) inbound on true
    `),
    sqlQuery(`
      select id::text, scope_type, campaign_id::text, field_key, filename,
             content_type, size_bytes, (extracted_text is not null) as has_extracted_text, created_at
      from app.instruction_attachments
      where deleted_at is null
      order by created_at
    `),
  ]);

  const settingsRow = settingsRows[0] ?? {};
  const templates = new Map<string, { subject: string; body: string; instructions: string }>();
  for (const row of templateRows) {
    templates.set(`${row.campaign_id}:${row.step}`, {
      subject: textValue(row.subject),
      body: textValue(row.body),
      instructions: textValue(row.instructions),
    });
  }
  const messages = new Map<string, { subject: string; body: string }>();
  for (const row of messageRows) {
    messages.set(`${row.prospect_id}:${row.step}`, {
      subject: textValue(row.subject),
      body: textValue(row.body_text),
    });
  }

  const statsByCampaign = new Map(campaignStatsRows.map((row) => [textValue(row.campaign_id), row]));
  const campaigns = campaignRows.map((row) => {
    const initialInstructions = (() => {
      const raw = templates.get(`${row.id}:J0`)?.instructions ?? "";
      try {
        const parsed = JSON.parse(raw) as { subject?: unknown; body?: unknown };
        return { subject: textValue(parsed.subject), body: textValue(parsed.body) };
      } catch {
        return { subject: "", body: raw };
      }
    })();
    const stats = statsByCampaign.get(textValue(row.id)) ?? {};
    const sent = numberValue(stats.sent);
    return {
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
      writingIterations: Array.isArray(row.writing_iteration_instructions)
        ? row.writing_iteration_instructions.map((value) => textValue(value))
        : [textValue(row.ai_instructions)],
      replyInstructions: textValue(row.reply_instructions),
      trackingOpensEnabled: Boolean(row.tracking_opens_enabled),
      trackingClicksEnabled: Boolean(row.tracking_clicks_enabled),
      experimentPolicy: textValue(row.experiment_policy),
      nextTestInstructions: textValue(row.next_test_instructions),
      importedDisabled: Boolean(row.imported_disabled),
      version: numberValue(row.version),
      sequence: {
        subject: templates.get(`${row.id}:J0`)?.subject ?? "",
        subjectInstructions: initialInstructions.subject,
        steps: STEPS.map((step) => templates.get(`${row.id}:${step}`)?.body ?? ""),
        stepInstructions: STEPS.map((step, index) => index === 0
          ? initialInstructions.body
          : templates.get(`${row.id}:${step}`)?.instructions ?? ""),
      },
      updatedAt: isoValue(row.updated_at),
      stats: {
        sent,
        contacted: numberValue(stats.contacted),
        opened: numberValue(stats.opened),
        clicked: numberValue(stats.clicked),
        replied: numberValue(stats.replied),
        unclassifiedReplies: numberValue(stats.unclassified_replies),
        openRate: sent ? Math.round(numberValue(stats.opened) * 10_000 / sent) / 100 : 0,
        clickRate: sent ? Math.round(numberValue(stats.clicked) * 10_000 / sent) / 100 : 0,
        firstSentAt: isoValue(stats.first_sent_at),
        lastSentAt: isoValue(stats.last_sent_at),
      },
    };
  });

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
      openObserved: Boolean(row.open_observed),
      clickObserved: Boolean(row.click_observed),
      firstOpenAt: isoValue(row.first_open_at),
      lastOpenAt: isoValue(row.last_open_at),
      firstClickAt: isoValue(row.first_click_at),
      lastClickAt: isoValue(row.last_click_at),
      openObservationCount: numberValue(row.open_observation_count),
      clickObservationCount: numberValue(row.click_observation_count),
      alreadyContacted: Boolean(row.already_contacted),
      excluded: Boolean(row.excluded),
      exclusionReason: nullableText(row.exclusion_reason),
      variantLabel: nullableText(row.variant_label),
      writingIterationStatus: textValue(row.writing_iteration_status, "pending"),
      writingIterationsCompleted: Math.max(0, numberValue(row.writing_iterations_completed)),
      writingIterationsTotal: Math.max(1, Math.min(100, numberValue(row.writing_iterations_total))),
      hasOutboundMessages: Boolean(row.has_outbound_messages),
      subject: contentFor("J0")?.subject ?? "",
      messages: STEPS.map((step) => contentFor(step)?.body ?? ""),
      version: numberValue(row.version),
    };
  });

  const gmailAccounts = accountRows.map((row) => {
    const bobworkMetrics = jsonObject(row.bobwork_metrics);
    return {
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
      bobworkConnected: row.bobwork_connected == null ? null : Boolean(row.bobwork_connected),
      bobworkWarmupState: textValue(row.bobwork_warmup_state, "unknown"),
      bobworkObservedAt: isoValue(row.bobwork_observed_at),
      bobworkConnectionStatus: textValue(row.bobwork_connection_status, "unconfigured"),
      bobworkLastSyncAt: isoValue(row.bobwork_last_sync_at),
      bobworkLastErrorCode: nullableText(row.bobwork_last_error_code),
      bobworkReadyForOutbound: nullableBoolean(firstMetric(bobworkMetrics,
        "ready_for_outbound", "readyForOutbound", "is_ready_for_outbound", "isReadyForOutbound")),
      bobworkHealthScore: nullableNumber(firstMetric(bobworkMetrics,
        "health_score", "healthScore", "deliverability_score", "deliverabilityScore", "score")),
      bobworkSpamRate7d: nullableNumber(firstMetric(bobworkMetrics,
        "spam_rate_7d_pct", "spam_rate_7d", "spamRate7d", "seven_day_spam_rate", "sevenDaySpamRate")),
      verifierResults: Array.isArray(row.verifier_results) ? row.verifier_results.map((result) => {
        const value = jsonObject(result);
        return {
          provider: textValue(value.provider),
          overallState: textValue(value.overallState, "insufficient_data"),
          dimension: nullableText(value.dimension),
          status: nullableText(value.status),
          value: nullableText(value.value),
          observedAt: isoValue(value.observedAt),
        };
      }) : [],
      verifierObservedAt: isoValue(row.verifier_observed_at),
      version: numberValue(row.version),
    };
  });

  const providers = providerRows.map((row) => ({
    id: textValue(row.id),
    name: textValue(row.name),
    url: textValue(row.base_url),
    enabled: Boolean(row.enabled),
    needsTestEmail: Boolean(row.requires_test_email),
    capability: textValue((row.capabilities as DbRow | null)?.uiCapability, textValue(row.test_type)),
    builtIn: Boolean((row.capabilities as DbRow | null)?.builtIn),
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
      name: nullableText(row.name),
      allocationWeight: numberValue(row.weight),
      overrides: (row.overrides as DbRow | null) ?? {},
      assignedCount: numberValue(row.assigned_count),
      sentCount: numberValue(row.sent_count),
      humanReplyCount: numberValue(row.human_reply_count),
      unclassifiedReplyCount: numberValue(row.unclassified_reply_count),
      positiveReplyCount: numberValue(row.positive_reply_count),
      confirmedMeetingCount: numberValue(row.confirmed_meeting_count),
      openCount: numberValue(row.open_count),
      clickCount: numberValue(row.click_count),
    });
    variantsByExperiment.set(textValue(row.experiment_id), list);
  }
  const experiments = experimentRows.map((row) => ({
    id: textValue(row.id),
    campaignId: textValue(row.campaign_id),
    name: textValue(row.name),
    status: textValue(row.status),
    scope: textValue(row.scope),
    comparablePopulation: Boolean(row.comparable_population),
    allocationMethod: textValue(row.allocation_method),
    thresholdContactsPerVariant: numberValue(row.contacts_per_variant_threshold),
    thresholdReplies: numberValue(row.total_responses_threshold),
    winnerVariantId: nullableText(row.winner_variant_id),
    winnerVariantLabel: nullableText(row.winner_variant_code),
    decision: nullableText(row.decision),
    matureAt: isoValue(row.mature_at),
    variants: variantsByExperiment.get(textValue(row.id)) ?? [],
  }));

  return {
    settings: {
      timezone: textValue(settingsRow.timezone, "Europe/Paris"),
      outboundEnabled: Boolean(settingsRow.outbound_enabled),
      vaultConfigured,
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
    attachments: attachmentRows.map((row) => ({
      id: textValue(row.id),
      scope: textValue(row.scope_type),
      campaignId: nullableText(row.campaign_id),
      fieldKey: textValue(row.field_key),
      filename: textValue(row.filename),
      contentType: textValue(row.content_type, "application/octet-stream"),
      sizeBytes: numberValue(row.size_bytes),
      hasExtractedText: Boolean(row.has_extracted_text),
      createdAt: isoValue(row.created_at),
    })),
    totals: {
      prospects: prospects.length,
      pendingApproval: prospects.filter((row) =>
        !row.excluded && (
          row.writingIterationStatus !== "completed"
          || row.writingIterationsCompleted < row.writingIterationsTotal
          || !row.hasOutboundMessages
          || ["draft", "prepared", "pending_approval"].includes(row.messageStatus ?? "")
        )
      ).length,
      scheduled: prospects.filter((row) => ["approved", "scheduled", "reserved", "sending"].includes(row.messageStatus ?? "")).length,
      sent: prospects.filter((row) => ["smtp_accepted", "sent_manually"].includes(row.messageStatus ?? "")).length,
      replied: prospects.filter((row) => row.contactState === "replied" || row.messageStatus === "received").length,
      excluded: prospects.filter((row) => row.excluded).length,
    },
  };
}
