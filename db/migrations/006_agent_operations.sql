-- Prospection 95 · opérations agent complémentaires et matérialisation des diagnostics.

CREATE TABLE IF NOT EXISTS app.agent_prospect_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES app.campaigns(id) ON DELETE CASCADE,
  prospect_id uuid NOT NULL REFERENCES app.prospects(id) ON DELETE CASCADE,
  agent_run_id uuid,
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (campaign_id, prospect_id, idempotency_key)
);

CREATE OR REPLACE FUNCTION agent_api.register_prospect(
  p_campaign_id uuid,
  p_full_name text,
  p_email text,
  p_organization_name text,
  p_job_title text,
  p_website_url text,
  p_source_label text,
  p_source_url text,
  p_source_evidence jsonb,
  p_qualification_score numeric,
  p_qualification_reason text,
  p_run_id uuid,
  p_idempotency_key text
)
RETURNS TABLE(prospect_id uuid, campaign_id uuid, state text, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit
AS $$
DECLARE
  normalized text := app.canonical_email(p_email);
  organization_uuid uuid;
  prospect_uuid uuid;
  registration_uuid uuid;
  link_state text;
  was_created boolean := false;
BEGIN
  IF length(coalesce(p_idempotency_key, '')) NOT BETWEEN 8 AND 200
     OR normalized !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR jsonb_typeof(coalesce(p_source_evidence, '{}'::jsonb)) <> 'object'
     OR p_qualification_score IS NULL OR p_qualification_score NOT BETWEEN 0 AND 1
     OR coalesce(length(btrim(p_qualification_reason)), 0) = 0 THEN
    RAISE EXCEPTION 'invalid_prospect_registration' USING ERRCODE = '22023';
  END IF;

  SELECT r.prospect_id INTO prospect_uuid
    FROM app.agent_prospect_registrations r
   WHERE r.idempotency_key = p_idempotency_key;
  IF prospect_uuid IS NOT NULL THEN
    RETURN QUERY
      SELECT prospect_uuid, r.campaign_id, cp.state, false
      FROM app.agent_prospect_registrations r
      JOIN app.campaign_prospects cp
        ON cp.campaign_id = r.campaign_id AND cp.prospect_id = r.prospect_id
      WHERE r.idempotency_key = p_idempotency_key;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app.campaigns c
     WHERE c.id = p_campaign_id AND c.status = 'active' AND NOT c.imported_disabled
  ) THEN
    RAISE EXCEPTION 'campaign_not_active' USING ERRCODE = 'P0001';
  END IF;

  IF nullif(btrim(p_organization_name), '') IS NOT NULL THEN
    SELECT o.id INTO organization_uuid
      FROM app.organizations o
     WHERE lower(o.name) = lower(btrim(p_organization_name))
     ORDER BY o.created_at LIMIT 1;
    IF organization_uuid IS NULL THEN
      INSERT INTO app.organizations (name, website_url)
      VALUES (btrim(p_organization_name), nullif(btrim(p_website_url), ''))
      RETURNING id INTO organization_uuid;
    END IF;
  END IF;

  SELECT p.id INTO prospect_uuid
    FROM app.prospects p
   WHERE p.normalized_email = normalized AND p.deleted_at IS NULL;
  IF prospect_uuid IS NULL THEN
    INSERT INTO app.prospects (
      organization_id, full_name, job_title, email, contact_raw, contact_kind,
      website_url, source_label, source_url, source_evidence,
      qualification_state, qualification_score, qualification_reason
    ) VALUES (
      organization_uuid, coalesce(btrim(p_full_name), ''), nullif(btrim(p_job_title), ''),
      normalized, normalized, 'email', nullif(btrim(p_website_url), ''),
      nullif(btrim(p_source_label), ''), nullif(btrim(p_source_url), ''),
      coalesce(p_source_evidence, '{}'::jsonb), 'qualified',
      p_qualification_score, btrim(p_qualification_reason)
    ) RETURNING id INTO prospect_uuid;
    was_created := true;
  END IF;

  link_state := CASE
    WHEN app.is_excluded(normalized) THEN 'excluded'
    WHEN EXISTS (SELECT 1 FROM app.contact_history h WHERE h.normalized_email = normalized) THEN 'rejected'
    ELSE 'candidate'
  END;

  INSERT INTO app.campaign_prospects (campaign_id, prospect_id, state, notes)
  VALUES (p_campaign_id, prospect_uuid, link_state,
          CASE WHEN link_state = 'rejected' THEN 'Déjà contacté globalement' ELSE NULL END)
  ON CONFLICT (campaign_id, prospect_id) DO NOTHING;

  INSERT INTO app.agent_prospect_registrations
    (campaign_id, prospect_id, agent_run_id, idempotency_key)
  VALUES (p_campaign_id, prospect_uuid, p_run_id, p_idempotency_key)
  RETURNING id INTO registration_uuid;

  INSERT INTO audit.event_log
    (actor_type, actor_id, event_type, entity_type, entity_id, metadata)
  VALUES ('prospection_agent', p_run_id::text, 'prospect_registered', 'prospect',
          prospect_uuid::text,
          jsonb_build_object('campaign_id', p_campaign_id,
                             'registration_id', registration_uuid,
                             'state', link_state,
                             'created', was_created));

  RETURN QUERY SELECT prospect_uuid, p_campaign_id, link_state, was_created;
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
DECLARE
  request_uuid uuid;
  email_required boolean;
  sender_email text;
  destination text;
  message_uuid uuid;
  job_uuid uuid;
BEGIN
  IF length(coalesce(p_idempotency_key, '')) NOT BETWEEN 8 AND 200
     OR p_priority NOT BETWEEN 0 AND 1000 THEN
    RAISE EXCEPTION 'invalid_diagnostic_request' USING ERRCODE = '22023';
  END IF;
  SELECT requires_test_email INTO email_required
    FROM app.deliverability_providers
   WHERE id = p_provider_id AND enabled;
  IF email_required IS NULL THEN
    RAISE EXCEPTION 'provider_not_available' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.provider_limits
     WHERE provider_id = p_provider_id AND blocked_until > clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'provider_temporarily_blocked' USING ERRCODE = 'P0001';
  END IF;
  SELECT a.email INTO sender_email
    FROM app.gmail_accounts a
   WHERE a.id = p_sender_account_id AND a.status = 'active'
     AND a.paused_at IS NULL AND a.credential_id IS NOT NULL;
  IF sender_email IS NULL THEN
    RAISE EXCEPTION 'sender_not_available' USING ERRCODE = 'P0001';
  END IF;

  SELECT coalesce(nullif(app.canonical_email(p_destination_address), ''), i.normalized_email)
    INTO destination
    FROM (SELECT 1) seed
    LEFT JOIN app.test_inboxes i ON i.id = p_test_inbox_id AND i.enabled;
  IF email_required AND destination !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'diagnostic_destination_required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO app.diagnostic_requests (
    provider_id, sender_account_id, test_inbox_id, status, priority,
    requested_by_run_id, destination_address, requires_email, idempotency_key
  ) VALUES (
    p_provider_id, p_sender_account_id, p_test_inbox_id,
    CASE WHEN email_required THEN 'send_requested'::app.diagnostic_status
         ELSE 'awaiting_report'::app.diagnostic_status END,
    p_priority, p_run_id, destination, email_required, p_idempotency_key
  ) ON CONFLICT (idempotency_key) DO UPDATE
      SET idempotency_key = EXCLUDED.idempotency_key
  RETURNING id, outbox_job_id INTO request_uuid, job_uuid;

  IF email_required AND job_uuid IS NULL THEN
    INSERT INTO app.email_messages (
      diagnostic_request_id, direction, kind, step, sender_account_id,
      from_address, to_addresses, subject, body_text, status, source
    ) VALUES (
      request_uuid, 'outbound', 'diagnostic', 'diagnostic', p_sender_account_id,
      sender_email, ARRAY[destination],
      'Prospection 95 — diagnostic ' || left(request_uuid::text, 8),
      'Message technique de diagnostic. Référence : ' || request_uuid::text,
      'scheduled', 'agent'
    ) RETURNING id INTO message_uuid;

    INSERT INTO app.outbox_jobs (
      message_id, account_id, step, job_kind, status, approval_required,
      approved_at, due_at, idempotency_key
    ) VALUES (
      message_uuid, p_sender_account_id, 'diagnostic', 'diagnostic', 'scheduled',
      false, clock_timestamp(), clock_timestamp(), 'diagnostic:' || request_uuid::text
    ) RETURNING id INTO job_uuid;

    UPDATE app.diagnostic_requests SET outbox_job_id = job_uuid
     WHERE id = request_uuid;
  END IF;
  RETURN request_uuid;
END;
$$;

CREATE OR REPLACE FUNCTION app.sync_diagnostic_request_from_outbox()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF NEW.job_kind <> 'diagnostic' OR NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'completed' THEN
    UPDATE app.diagnostic_requests
       SET status = 'awaiting_report', failure_code = NULL,
           failure_detail = NULL, updated_at = clock_timestamp()
     WHERE outbox_job_id = NEW.id;
  ELSIF NEW.status IN ('failed','uncertain','cancelled') THEN
    UPDATE app.diagnostic_requests
       SET status = 'failed',
           failure_code = coalesce(NEW.last_error_code, 'diagnostic_' || NEW.status::text),
           failure_detail = NULL, updated_at = clock_timestamp()
     WHERE outbox_job_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sync_diagnostic_request_from_outbox ON app.outbox_jobs;
CREATE TRIGGER sync_diagnostic_request_from_outbox
AFTER UPDATE OF status ON app.outbox_jobs
FOR EACH ROW EXECUTE FUNCTION app.sync_diagnostic_request_from_outbox();

CREATE OR REPLACE FUNCTION agent_api.record_provider_limit(
  p_provider_id uuid,
  p_scope_type text,
  p_scope_value text,
  p_evidence_level text,
  p_limit_count integer,
  p_window_interval interval,
  p_refusal_text text,
  p_blocked_until timestamptz,
  p_source_url text,
  p_observed_at timestamptz,
  p_run_id uuid,
  p_idempotency_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit
AS $$
DECLARE result_uuid uuid;
BEGIN
  IF length(coalesce(p_idempotency_key, '')) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  SELECT (e.metadata->>'provider_limit_id')::uuid INTO result_uuid
    FROM audit.event_log e
   WHERE e.event_type = 'provider_limit_recorded'
     AND e.metadata->>'idempotency_key' = p_idempotency_key
   ORDER BY e.occurred_at DESC LIMIT 1;
  IF result_uuid IS NOT NULL THEN RETURN result_uuid; END IF;

  INSERT INTO app.provider_limits (
    provider_id, scope_type, scope_value, evidence_level, limit_count,
    window_interval, refusal_text, blocked_until, source_url, observed_at
  ) VALUES (
    p_provider_id, p_scope_type, nullif(btrim(p_scope_value), ''), p_evidence_level,
    p_limit_count, p_window_interval, nullif(btrim(p_refusal_text), ''),
    p_blocked_until, nullif(btrim(p_source_url), ''),
    coalesce(p_observed_at, clock_timestamp())
  ) RETURNING id INTO result_uuid;
  INSERT INTO audit.event_log
    (actor_type, actor_id, event_type, entity_type, entity_id, metadata)
  VALUES ('deliverability_agent', p_run_id::text, 'provider_limit_recorded',
          'deliverability_provider', p_provider_id::text,
          jsonb_build_object('provider_limit_id', result_uuid,
                             'idempotency_key', p_idempotency_key));
  RETURN result_uuid;
END;
$$;

CREATE OR REPLACE FUNCTION agent_api.raise_incident(
  p_account_id uuid,
  p_severity app.incident_severity,
  p_title text,
  p_evidence jsonb,
  p_review_at timestamptz,
  p_apply_protective_pause boolean,
  p_run_id uuid,
  p_idempotency_key text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit
AS $$
DECLARE incident_uuid uuid;
BEGIN
  IF length(coalesce(p_idempotency_key, '')) NOT BETWEEN 8 AND 200
     OR coalesce(length(btrim(p_title)), 0) = 0
     OR jsonb_typeof(coalesce(p_evidence, '[]'::jsonb)) <> 'array'
     OR (p_apply_protective_pause AND p_severity <> 'serious') THEN
    RAISE EXCEPTION 'invalid_incident' USING ERRCODE = '22023';
  END IF;
  SELECT (e.metadata->>'incident_id')::uuid INTO incident_uuid
    FROM audit.event_log e
   WHERE e.event_type = 'deliverability_incident_raised'
     AND e.metadata->>'idempotency_key' = p_idempotency_key
   ORDER BY e.occurred_at DESC LIMIT 1;
  IF incident_uuid IS NOT NULL THEN RETURN incident_uuid; END IF;

  INSERT INTO app.incidents (
    account_id, severity, title, evidence, source, protective_pause_applied,
    review_at, created_by_run_id
  ) VALUES (
    p_account_id, p_severity, btrim(p_title), coalesce(p_evidence, '[]'::jsonb),
    'agent', p_apply_protective_pause, p_review_at, p_run_id
  ) RETURNING id INTO incident_uuid;

  IF p_apply_protective_pause THEN
    UPDATE app.gmail_accounts
       SET paused_at = coalesce(paused_at, clock_timestamp()),
           pause_source = coalesce(pause_source, 'automatic'),
           pause_reason = coalesce(pause_reason, 'Incident de délivrabilité : ' || btrim(p_title)),
           review_at = coalesce(review_at, p_review_at),
           version = version + 1,
           updated_at = clock_timestamp()
     WHERE id = p_account_id AND deleted_at IS NULL;
  END IF;

  INSERT INTO audit.event_log
    (actor_type, actor_id, event_type, entity_type, entity_id, metadata)
  VALUES ('deliverability_agent', p_run_id::text, 'deliverability_incident_raised',
          'gmail_account', p_account_id::text,
          jsonb_build_object('incident_id', incident_uuid,
                             'idempotency_key', p_idempotency_key,
                             'protective_pause', p_apply_protective_pause));
  RETURN incident_uuid;
END;
$$;

REVOKE ALL ON TABLE app.agent_prospect_registrations FROM PUBLIC, prospection95_agent;
REVOKE ALL ON FUNCTION app.sync_diagnostic_request_from_outbox() FROM PUBLIC, prospection95_agent;

GRANT EXECUTE ON FUNCTION agent_api.register_prospect(uuid,text,text,text,text,text,text,text,jsonb,numeric,text,uuid,text) TO prospection95_agent;
GRANT EXECUTE ON FUNCTION agent_api.request_diagnostic(uuid,uuid,uuid,text,uuid,text,integer) TO prospection95_agent;
GRANT EXECUTE ON FUNCTION agent_api.record_provider_limit(uuid,text,text,text,integer,interval,text,timestamptz,text,timestamptz,uuid,text) TO prospection95_agent;
GRANT EXECUTE ON FUNCTION agent_api.raise_incident(uuid,app.incident_severity,text,jsonb,timestamptz,boolean,uuid,text) TO prospection95_agent;

INSERT INTO app.schema_migrations (version)
VALUES ('006_agent_operations')
ON CONFLICT (version) DO NOTHING;
