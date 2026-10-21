-- Prospection 95 · surface SQL restreinte pour les deux planifications ChatGPT.

ALTER TABLE app.email_messages ADD COLUMN IF NOT EXISTS proposal_key text;
CREATE UNIQUE INDEX IF NOT EXISTS email_messages_proposal_key_uq
  ON app.email_messages (proposal_key) WHERE proposal_key IS NOT NULL;

CREATE OR REPLACE VIEW agent_api.campaign_parameters
WITH (security_barrier = true)
AS
SELECT
  c.id AS campaign_id,
  c.name,
  c.status,
  c.target_description,
  c.qualification_criteria,
  c.daily_new_contact_goal,
  c.validation_policy,
  c.sender_strategy,
  c.fixed_sender_account_id,
  c.ai_instructions,
  c.reply_instructions,
  c.tracking_opens_enabled,
  c.tracking_clicks_enabled,
  c.experiment_policy,
  c.next_test_instructions,
  c.version,
  c.updated_at
FROM app.campaigns c
WHERE c.archived_at IS NULL;

CREATE OR REPLACE VIEW agent_api.eligible_prospects
WITH (security_barrier = true)
AS
SELECT
  cp.campaign_id,
  p.id AS prospect_id,
  p.full_name,
  p.job_title,
  p.normalized_email AS email,
  p.website_url,
  p.source_label,
  p.source_url,
  p.source_evidence,
  p.qualification_score,
  p.qualification_reason,
  cp.state,
  cp.assigned_sender_account_id,
  cp.created_at
FROM app.campaign_prospects cp
JOIN app.campaigns c ON c.id = cp.campaign_id
JOIN app.prospects p ON p.id = cp.prospect_id
WHERE c.status = 'active'
  AND NOT c.imported_disabled
  AND p.deleted_at IS NULL
  AND p.qualification_state = 'qualified'
  AND p.contact_state = 'never_contacted'
  AND p.normalized_email IS NOT NULL
  AND cp.state IN ('candidate','reserved')
  AND NOT app.is_excluded(p.normalized_email)
  AND NOT EXISTS (SELECT 1 FROM app.contact_history h WHERE h.normalized_email = p.normalized_email);

CREATE OR REPLACE VIEW agent_api.unanalyzed_responses
WITH (security_barrier = true)
AS
SELECT
  m.id AS message_id,
  m.conversation_id,
  conv.campaign_id,
  conv.prospect_id,
  conv.sender_account_id,
  m.from_address,
  m.to_addresses,
  m.subject,
  m.body_text,
  m.received_at,
  m.internet_message_id,
  m.in_reply_to,
  m.references_header,
  p.full_name AS prospect_name,
  p.organization_id,
  c.name AS campaign_name,
  c.reply_instructions,
  conv.experiment_assignment_id
FROM app.email_messages m
JOIN app.conversations conv ON conv.id = m.conversation_id
JOIN app.campaigns c ON c.id = conv.campaign_id
JOIN app.prospects p ON p.id = conv.prospect_id
LEFT JOIN app.inbound_analyses a ON a.message_id = m.id
WHERE m.direction = 'inbound'
  AND m.kind NOT IN ('automatic_reply','out_of_office','bounce','unrelated')
  AND a.id IS NULL;

CREATE OR REPLACE VIEW agent_api.experiments
WITH (security_barrier = true)
AS
SELECT
  e.id AS experiment_id,
  e.campaign_id,
  e.name,
  e.status,
  e.scope,
  e.target_step,
  e.comparable_population,
  e.allocation_method,
  e.primary_metric,
  e.contacts_per_variant_threshold,
  e.total_responses_threshold,
  e.maturity_delay,
  e.started_at,
  e.threshold_reached_at,
  e.mature_at,
  e.decision,
  e.limitations,
  COALESCE(jsonb_agg(jsonb_build_object(
    'id', v.id,
    'code', v.code,
    'name', v.name,
    'weight', v.weight,
    'base_variant_id', v.base_variant_id,
    'overrides', v.overrides,
    'version', v.version
  ) ORDER BY v.code) FILTER (WHERE v.id IS NOT NULL), '[]'::jsonb) AS variants
FROM app.experiments e
LEFT JOIN app.experiment_variants v ON v.experiment_id = e.id
GROUP BY e.id;

CREATE OR REPLACE VIEW agent_api.experiment_metrics
WITH (security_barrier = true)
AS
SELECT
  a.experiment_id,
  a.variant_id,
  count(DISTINCT a.prospect_id) AS assigned_prospects,
  count(DISTINCT ev.message_id) FILTER (WHERE ev.event_type = 'smtp_accepted') AS smtp_accepted,
  count(*) FILTER (WHERE ev.event_type = 'human_reply') AS human_replies,
  count(*) FILTER (WHERE ev.event_type = 'positive_reply') AS positive_replies,
  count(*) FILTER (WHERE ev.event_type = 'confirmed_meeting') AS confirmed_meetings,
  count(*) FILTER (WHERE ev.event_type = 'open' AND ev.measured) AS measured_opens,
  count(*) FILTER (WHERE ev.event_type = 'click' AND ev.measured) AS measured_clicks,
  min(a.assigned_at) AS first_assignment_at,
  max(ev.event_at) AS last_event_at
FROM app.experiment_assignments a
LEFT JOIN app.experiment_events ev ON ev.assignment_id = a.id
GROUP BY a.experiment_id, a.variant_id;

CREATE OR REPLACE VIEW agent_api.account_restrictions
WITH (security_barrier = true)
AS
SELECT
  a.id AS account_id,
  a.email,
  a.status,
  a.daily_limit,
  a.warmup_daily_limit,
  a.send_days,
  a.send_start,
  a.send_end,
  a.timezone,
  a.paused_at,
  a.pause_source,
  a.pause_reason,
  a.review_at,
  a.smtp_verified_at,
  a.imap_verified_at,
  bw.warmup_state,
  bw.observed_at AS bobwork_observed_at,
  incident.severity AS active_incident_severity,
  incident.title AS active_incident_title
FROM app.gmail_accounts a
LEFT JOIN LATERAL (
  SELECT b.warmup_state, b.observed_at
  FROM app.bobwork_snapshots b
  WHERE b.account_id = a.id ORDER BY b.observed_at DESC LIMIT 1
) bw ON true
LEFT JOIN LATERAL (
  SELECT i.severity, i.title
  FROM app.incidents i
  WHERE i.account_id = a.id AND i.resolved_at IS NULL
  ORDER BY i.severity DESC, i.started_at DESC LIMIT 1
) incident ON true
WHERE a.deleted_at IS NULL;

CREATE OR REPLACE VIEW agent_api.deliverability_catalog
WITH (security_barrier = true)
AS
SELECT
  p.id AS provider_id,
  p.name,
  p.base_url,
  p.enabled,
  p.test_type,
  p.requires_test_email,
  p.capabilities,
  p.documentation_url,
  p.quota_description,
  limit_info.scope_type AS latest_limit_scope,
  limit_info.evidence_level AS latest_limit_evidence,
  limit_info.blocked_until,
  limit_info.refusal_text,
  report.overall_state AS latest_state,
  report.observed_at AS latest_observed_at,
  report.report_url AS latest_report_url
FROM app.deliverability_providers p
LEFT JOIN LATERAL (
  SELECT l.scope_type, l.evidence_level, l.blocked_until, l.refusal_text
  FROM app.provider_limits l WHERE l.provider_id = p.id ORDER BY l.observed_at DESC LIMIT 1
) limit_info ON true
LEFT JOIN LATERAL (
  SELECT r.overall_state, r.observed_at, r.report_url
  FROM app.diagnostic_reports r
  JOIN app.diagnostic_requests q ON q.id = r.request_id
  WHERE q.provider_id = p.id ORDER BY r.observed_at DESC LIMIT 1
) report ON true;

CREATE OR REPLACE VIEW agent_api.pending_operations
WITH (security_barrier = true)
AS
SELECT 'diagnostic'::text AS operation_type, q.id AS operation_id, q.status::text AS status,
       q.idempotency_key, q.created_at, q.updated_at, q.failure_code AS error_code
FROM app.diagnostic_requests q
WHERE q.status NOT IN ('reported','failed','cancelled')
UNION ALL
SELECT 'reply_draft', d.id, d.state, d.idempotency_key, d.created_at, d.updated_at,
       CASE WHEN d.state = 'failed' THEN 'draft_sync_failed' ELSE NULL END
FROM app.reply_draft_requests d
WHERE d.state NOT IN ('created','sent_manually','dismissed');

CREATE OR REPLACE FUNCTION agent_api.begin_run(
  p_agent_type text,
  p_external_run_id text,
  p_idempotency_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit
AS $$
DECLARE run_uuid uuid;
BEGIN
  INSERT INTO audit.agent_runs (agent_type, external_run_id, idempotency_key)
  VALUES (p_agent_type, p_external_run_id, p_idempotency_key)
  ON CONFLICT (agent_type, idempotency_key) DO UPDATE SET external_run_id = EXCLUDED.external_run_id
  RETURNING id INTO run_uuid;
  RETURN run_uuid;
END;
$$;

CREATE OR REPLACE FUNCTION agent_api.complete_run(
  p_run_id uuid,
  p_status text,
  p_summary jsonb,
  p_error_code text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit
AS $$
BEGIN
  IF p_status NOT IN ('completed','partial','failed') OR jsonb_typeof(coalesce(p_summary, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'invalid_run_completion' USING ERRCODE = '22023';
  END IF;
  UPDATE audit.agent_runs SET status = p_status, summary = coalesce(p_summary, '{}'::jsonb),
    error_code = p_error_code, finished_at = clock_timestamp()
  WHERE id = p_run_id AND status = 'running';
  IF NOT FOUND THEN RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION agent_api.reserve_prospect(
  p_campaign_id uuid,
  p_prospect_id uuid,
  p_run_id uuid,
  p_idempotency_key text
)
RETURNS TABLE(campaign_id uuid, prospect_id uuid, state text, reserved_at timestamptz, reservation_key text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  SELECT r.campaign_id, r.prospect_id, r.state, r.reserved_at, r.reservation_key
  FROM app.reserve_campaign_prospect(p_campaign_id, p_prospect_id, p_run_id, p_idempotency_key) r;
$$;

CREATE OR REPLACE FUNCTION agent_api.propose_sequence(
  p_campaign_id uuid,
  p_prospect_id uuid,
  p_sender_account_id uuid,
  p_subject text,
  p_messages jsonb,
  p_run_id uuid,
  p_idempotency_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit
AS $$
DECLARE
  conversation_uuid uuid;
  existing_conversation_uuid uuid;
  existing_message_count integer;
  validation app.validation_policy;
  message_item jsonb;
  step_value app.sequence_step;
  index_value integer := 0;
BEGIN
  IF jsonb_typeof(p_messages) <> 'array' OR jsonb_array_length(p_messages) <> 6
     OR length(coalesce(p_idempotency_key, '')) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'sequence_requires_six_messages' USING ERRCODE = '22023';
  END IF;

  SELECT m.conversation_id INTO existing_conversation_uuid
    FROM app.email_messages m
   WHERE m.proposal_key = p_idempotency_key || ':J0';
  IF existing_conversation_uuid IS NOT NULL THEN
    SELECT count(*)::integer INTO existing_message_count
      FROM app.email_messages m
      JOIN app.conversations c ON c.id = m.conversation_id
     WHERE m.conversation_id = existing_conversation_uuid
       AND c.campaign_id = p_campaign_id AND c.prospect_id = p_prospect_id
       AND m.proposal_key IN (
         p_idempotency_key || ':J0', p_idempotency_key || ':R1',
         p_idempotency_key || ':R2', p_idempotency_key || ':R3',
         p_idempotency_key || ':R4', p_idempotency_key || ':R5'
       );
    IF existing_message_count = 6 THEN RETURN existing_conversation_uuid; END IF;
    RAISE EXCEPTION 'sequence_idempotency_conflict' USING ERRCODE = '23505';
  END IF;

  SELECT validation_policy INTO validation FROM app.campaigns
    WHERE id = p_campaign_id AND status = 'active' AND NOT imported_disabled;
  IF validation IS NULL THEN RAISE EXCEPTION 'campaign_not_active' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.campaign_prospects WHERE campaign_id = p_campaign_id AND prospect_id = p_prospect_id AND state = 'reserved') THEN
    RAISE EXCEPTION 'prospect_not_reserved' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.gmail_accounts a
    JOIN app.campaigns c ON c.id = p_campaign_id
    WHERE a.id = p_sender_account_id AND a.status = 'active' AND a.paused_at IS NULL
      AND (
        (c.sender_strategy = 'fixed' AND c.fixed_sender_account_id = a.id) OR
        (c.sender_strategy = 'pool' AND EXISTS (
          SELECT 1 FROM app.campaign_sender_accounts csa
           WHERE csa.campaign_id = c.id AND csa.account_id = a.id AND csa.enabled
        ))
      )
  ) THEN
    RAISE EXCEPTION 'sender_not_available_for_campaign' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO app.conversations (campaign_id, prospect_id, sender_account_id, state)
  VALUES (p_campaign_id, p_prospect_id, p_sender_account_id, 'prepared')
  ON CONFLICT (campaign_id, prospect_id) DO UPDATE SET updated_at = clock_timestamp()
  RETURNING id INTO conversation_uuid;

  FOR message_item IN SELECT value FROM jsonb_array_elements(p_messages)
  LOOP
    step_value := (ARRAY['J0','R1','R2','R3','R4','R5'])[index_value + 1]::app.sequence_step;
    IF coalesce(message_item->>'body', '') = '' THEN RAISE EXCEPTION 'message_body_missing_%', step_value USING ERRCODE = '22023'; END IF;
    INSERT INTO app.email_messages
      (conversation_id, direction, kind, step, sender_account_id, from_address, to_addresses,
       subject, body_text, status, source, proposal_key)
    SELECT conversation_uuid, 'outbound', 'prospection', step_value, p_sender_account_id,
      a.email, ARRAY[p.email], CASE WHEN step_value = 'J0' THEN p_subject ELSE coalesce(message_item->>'subject', p_subject) END,
      message_item->>'body', CASE WHEN validation = 'manual' THEN 'pending_approval'::app.message_status ELSE 'prepared'::app.message_status END,
      'agent', p_idempotency_key || ':' || step_value::text
    FROM app.gmail_accounts a, app.prospects p
    WHERE a.id = p_sender_account_id AND p.id = p_prospect_id
    ON CONFLICT (proposal_key) WHERE proposal_key IS NOT NULL DO NOTHING;
    index_value := index_value + 1;
  END LOOP;

  UPDATE app.campaign_prospects SET state = 'prepared', updated_at = clock_timestamp()
    WHERE campaign_id = p_campaign_id AND prospect_id = p_prospect_id;
  INSERT INTO audit.event_log (actor_type, actor_id, event_type, entity_type, entity_id, metadata)
    VALUES ('prospection_agent', p_run_id::text, 'sequence_proposed', 'conversation', conversation_uuid::text,
      jsonb_build_object('idempotency_key', p_idempotency_key));
  RETURN conversation_uuid;
END;
$$;

CREATE OR REPLACE FUNCTION agent_api.classify_response(
  p_message_id uuid,
  p_classification app.response_classification,
  p_sentiment text,
  p_meeting_confirmed boolean,
  p_confidence numeric,
  p_rationale text,
  p_run_id uuid,
  p_idempotency_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit
AS $$
DECLARE analysis_uuid uuid; prospect_uuid uuid; prospect_email text;
BEGIN
  INSERT INTO app.inbound_analyses
    (message_id, classification, commercial_sentiment, meeting_confirmed, confidence, rationale, agent_run_id, idempotency_key)
  VALUES
    (p_message_id, p_classification, p_sentiment, p_meeting_confirmed, p_confidence, p_rationale, p_run_id, p_idempotency_key)
  ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
  RETURNING id INTO analysis_uuid;
  IF p_classification = 'opposition' THEN
    SELECT conv.prospect_id, p.normalized_email INTO prospect_uuid, prospect_email
    FROM app.email_messages m JOIN app.conversations conv ON conv.id = m.conversation_id
    JOIN app.prospects p ON p.id = conv.prospect_id WHERE m.id = p_message_id;
    INSERT INTO app.exclusions (match_type, match_value, reason, source, created_by)
      VALUES ('email', prospect_email, 'Opposition explicite détectée dans une réponse', 'reply', 'prospection_agent')
      ON CONFLICT (match_type, normalized_value) WHERE revoked_at IS NULL DO NOTHING;
    UPDATE app.prospects SET contact_state = 'opposition', updated_at = clock_timestamp() WHERE id = prospect_uuid;
  END IF;
  RETURN analysis_uuid;
END;
$$;

CREATE OR REPLACE FUNCTION agent_api.propose_reply_draft(
  p_source_message_id uuid,
  p_subject text,
  p_body text,
  p_idempotency_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE draft_uuid uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM app.inbound_analyses WHERE message_id = p_source_message_id AND classification = 'opposition') THEN
    RAISE EXCEPTION 'opposition_cannot_receive_draft' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO app.reply_draft_requests
    (source_message_id, conversation_id, sender_account_id, proposed_subject, proposed_body, idempotency_key)
  SELECT p_source_message_id, m.conversation_id, c.sender_account_id, p_subject, p_body, p_idempotency_key
  FROM app.email_messages m JOIN app.conversations c ON c.id = m.conversation_id
  WHERE m.id = p_source_message_id AND m.direction = 'inbound'
  ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
  RETURNING id INTO draft_uuid;
  IF draft_uuid IS NULL THEN RAISE EXCEPTION 'inbound_message_not_found' USING ERRCODE = 'P0001'; END IF;
  RETURN draft_uuid;
END;
$$;

CREATE OR REPLACE FUNCTION agent_api.propose_experiment(
  p_campaign_id uuid,
  p_name text,
  p_scope text,
  p_primary_metric text,
  p_variants jsonb,
  p_run_id uuid,
  p_idempotency_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE experiment_uuid uuid; variant jsonb;
BEGIN
  IF jsonb_typeof(p_variants) <> 'array' OR jsonb_array_length(p_variants) < 2 THEN
    RAISE EXCEPTION 'experiment_requires_two_variants' USING ERRCODE = '22023';
  END IF;
  INSERT INTO app.experiments
    (campaign_id, name, scope, primary_metric, created_by_run_id, idempotency_key)
  VALUES (p_campaign_id, p_name, p_scope, p_primary_metric, p_run_id, p_idempotency_key)
  ON CONFLICT (campaign_id, idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
  RETURNING id INTO experiment_uuid;
  FOR variant IN SELECT value FROM jsonb_array_elements(p_variants)
  LOOP
    INSERT INTO app.experiment_variants (experiment_id, code, name, weight, overrides)
    VALUES (experiment_uuid, upper(variant->>'code'), variant->>'name', coalesce((variant->>'weight')::numeric, 1), coalesce(variant->'overrides', '{}'::jsonb))
    ON CONFLICT (experiment_id, code) DO NOTHING;
  END LOOP;
  RETURN experiment_uuid;
END;
$$;

CREATE OR REPLACE FUNCTION agent_api.request_diagnostic(
  p_provider_id uuid,
  p_sender_account_id uuid,
  p_test_inbox_id uuid,
  p_destination_address text,
  p_run_id uuid,
  p_idempotency_key text,
  p_priority integer DEFAULT 100
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE request_uuid uuid; email_required boolean;
BEGIN
  SELECT requires_test_email INTO email_required FROM app.deliverability_providers
    WHERE id = p_provider_id AND enabled;
  IF email_required IS NULL THEN RAISE EXCEPTION 'provider_not_available' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM app.provider_limits WHERE provider_id = p_provider_id AND blocked_until > clock_timestamp()) THEN
    RAISE EXCEPTION 'provider_temporarily_blocked' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO app.diagnostic_requests
    (provider_id, sender_account_id, test_inbox_id, priority, requested_by_run_id,
     destination_address, requires_email, idempotency_key)
  VALUES
    (p_provider_id, p_sender_account_id, p_test_inbox_id, p_priority, p_run_id,
     p_destination_address, email_required, p_idempotency_key)
  ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
  RETURNING id INTO request_uuid;
  RETURN request_uuid;
END;
$$;

CREATE OR REPLACE FUNCTION agent_api.submit_diagnostic_report(
  p_request_id uuid,
  p_report_url text,
  p_source text,
  p_observed_at timestamptz,
  p_overall_state text,
  p_summary jsonb,
  p_provenance jsonb,
  p_results jsonb,
  p_idempotency_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE report_uuid uuid; result_item jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.diagnostic_requests WHERE id = p_request_id AND status IN ('awaiting_report','reported')) THEN
    RAISE EXCEPTION 'diagnostic_not_ready_for_report' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO app.diagnostic_reports
    (request_id, report_url, source, observed_at, overall_state, raw_summary, provenance, idempotency_key)
  VALUES
    (p_request_id, p_report_url, p_source, p_observed_at, p_overall_state, p_summary, p_provenance, p_idempotency_key)
  ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
  RETURNING id INTO report_uuid;
  IF jsonb_typeof(coalesce(p_results, '[]'::jsonb)) = 'array' THEN
    FOR result_item IN SELECT value FROM jsonb_array_elements(coalesce(p_results, '[]'::jsonb))
    LOOP
      INSERT INTO app.diagnostic_results (report_id, dimension, status, value_text, value_numeric, unit, confidence, details)
      VALUES (report_uuid, result_item->>'dimension', result_item->>'status', result_item->>'value_text',
        nullif(result_item->>'value_numeric','')::numeric, result_item->>'unit',
        coalesce(result_item->>'confidence','unknown'), coalesce(result_item->'details','{}'::jsonb))
      ON CONFLICT (report_id, dimension) DO NOTHING;
    END LOOP;
  END IF;
  UPDATE app.diagnostic_requests SET status = 'reported', updated_at = clock_timestamp() WHERE id = p_request_id;
  RETURN report_uuid;
END;
$$;

INSERT INTO app.schema_migrations (version)
VALUES ('004_agent_contract')
ON CONFLICT (version) DO NOTHING;
