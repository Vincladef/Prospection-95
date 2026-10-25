-- Prospection 95 · corrections ciblées : envois, déprogrammation, A/B,
-- déduplication J0 et empreinte des entrées rédactionnelles.

BEGIN;

-- Une seule campagne peut réserver ou préparer un prospect à la fois. La
-- contrainte porte sur le prospect globalement dédupliqué par adresse.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_prospects_one_active_campaign_uq
  ON app.campaign_prospects (prospect_id)
  WHERE state IN ('reserved','prepared','engaged');

-- Un résultat SMTP incertain continue de bloquer tout autre J0. Les statuts
-- terminaux libèrent l'index ; contact_history prend alors le relais.
CREATE UNIQUE INDEX IF NOT EXISTS outbox_one_active_j0_per_prospect_uq
  ON app.outbox_jobs (prospect_id)
  WHERE prospect_id IS NOT NULL
    AND job_kind = 'prospection'
    AND step = 'J0'
    AND status NOT IN ('completed','failed','cancelled');

-- Le worker verrouille le message avant de passer en sending. Si une
-- validation a été retirée ou si le prospect a déjà été contacté, le job est
-- annulé avant toute tentative SMTP et le statut retourné le signale au worker.
CREATE OR REPLACE FUNCTION app.start_outbox_attempt(
  p_job_id uuid,
  p_lease_token uuid
)
RETURNS app.outbox_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $start_outbox_attempt$
DECLARE
  job app.outbox_jobs;
  message_status app.message_status;
  prospect_email text;
BEGIN
  SELECT * INTO job
    FROM app.outbox_jobs
   WHERE id = p_job_id
     AND lease_token = p_lease_token
     AND status IN ('reserved','running')
     AND lease_expires_at >= clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lease_not_owned_or_expired' USING ERRCODE = 'P0001';
  END IF;
  IF job.status = 'running' THEN
    RETURN job;
  END IF;

  SELECT m.status INTO message_status
    FROM app.email_messages m
   WHERE m.id = job.message_id
   FOR UPDATE;

  IF job.job_kind = 'prospection' AND message_status IS DISTINCT FROM 'scheduled' THEN
    UPDATE app.outbox_jobs
       SET status = 'cancelled', cancelled_at = clock_timestamp(),
           cancel_reason = 'message_not_scheduled', lease_expires_at = NULL,
           updated_at = clock_timestamp()
     WHERE id = job.id
     RETURNING * INTO job;
    RETURN job;
  END IF;

  IF job.job_kind = 'prospection' AND job.step = 'J0' THEN
    SELECT p.normalized_email INTO prospect_email
      FROM app.prospects p
     WHERE p.id = job.prospect_id
     FOR UPDATE;
    IF prospect_email IS NULL
       OR EXISTS (
         SELECT 1 FROM app.contact_history h
          WHERE h.normalized_email = prospect_email
       ) THEN
      UPDATE app.outbox_jobs
         SET status = 'cancelled', cancelled_at = clock_timestamp(),
             cancel_reason = 'already_contacted', lease_expires_at = NULL,
             updated_at = clock_timestamp()
       WHERE id = job.id
       RETURNING * INTO job;
      UPDATE app.email_messages
         SET status = 'cancelled', updated_at = clock_timestamp()
       WHERE id = job.message_id AND status = 'scheduled';
      RETURN job;
    END IF;
  END IF;

  INSERT INTO app.outbox_attempts (job_id, attempt_number, lease_token)
  VALUES (job.id, job.attempt_count, p_lease_token)
  ON CONFLICT (job_id, attempt_number) DO NOTHING;

  UPDATE app.outbox_jobs
     SET status = 'running', updated_at = clock_timestamp()
   WHERE id = job.id
   RETURNING * INTO job;
  UPDATE app.email_messages
     SET status = 'sending', updated_at = clock_timestamp()
   WHERE id = job.message_id AND status NOT IN ('smtp_accepted','cancelled');
  RETURN job;
END;
$start_outbox_attempt$;

-- Un Message-ID déjà connu identifie un envoi de l'application. La copie IMAP
-- complète alors ses coordonnées sans le transformer en envoi manuel. Seule
-- l'insertion d'un message absent déclenche l'arrêt manual_outbound.
CREATE OR REPLACE FUNCTION app.record_sent_message(
  p_mailbox_account_id uuid,
  p_conversation_id uuid,
  p_from_address text,
  p_to_addresses text[],
  p_subject text DEFAULT '',
  p_body_text text DEFAULT '',
  p_body_html text DEFAULT NULL,
  p_internet_message_id text DEFAULT NULL,
  p_in_reply_to text DEFAULT NULL,
  p_references_header text[] DEFAULT '{}'::text[],
  p_imap_mailbox text DEFAULT '__SENT__',
  p_imap_uidvalidity bigint DEFAULT NULL,
  p_imap_uid bigint DEFAULT NULL,
  p_sent_at timestamptz DEFAULT clock_timestamp(),
  p_raw_headers jsonb DEFAULT '{}'::jsonb
)
RETURNS app.email_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $record_sent_message$
DECLARE
  result app.email_messages;
  target_prospect_id uuid;
  target_email text;
  manual_outbound boolean := false;
BEGIN
  IF p_conversation_id IS NULL
     OR cardinality(p_to_addresses) < 1
     OR coalesce(btrim(p_from_address), '') = ''
     OR jsonb_typeof(coalesce(p_raw_headers, '{}'::jsonb)) <> 'object'
     OR (p_internet_message_id IS NULL
         AND (p_imap_mailbox IS NULL OR p_imap_uidvalidity IS NULL OR p_imap_uid IS NULL))
     OR ((p_imap_uidvalidity IS NULL) <> (p_imap_uid IS NULL)) THEN
    RAISE EXCEPTION 'invalid_sent_message' USING ERRCODE = '22023';
  END IF;

  SELECT m.* INTO result
    FROM app.email_messages m
   WHERE (p_internet_message_id IS NOT NULL
          AND m.sender_account_id = p_mailbox_account_id
          AND m.internet_message_id = p_internet_message_id)
      OR (m.mailbox_account_id = p_mailbox_account_id
          AND p_imap_uid IS NOT NULL
          AND m.imap_mailbox = p_imap_mailbox
          AND m.imap_uidvalidity = p_imap_uidvalidity
          AND m.imap_uid = p_imap_uid)
   ORDER BY m.created_at
   LIMIT 1;

  IF result.id IS NOT NULL THEN
    UPDATE app.email_messages
       SET mailbox_account_id = coalesce(mailbox_account_id, p_mailbox_account_id),
           internet_message_id = coalesce(internet_message_id, p_internet_message_id),
           imap_mailbox = coalesce(imap_mailbox, p_imap_mailbox),
           imap_uidvalidity = coalesce(imap_uidvalidity, p_imap_uidvalidity),
           imap_uid = coalesce(imap_uid, p_imap_uid),
           sent_at = coalesce(sent_at, p_sent_at),
           updated_at = clock_timestamp()
     WHERE id = result.id
     RETURNING * INTO result;
  ELSE
    INSERT INTO app.email_messages (
      conversation_id, direction, kind, sender_account_id, mailbox_account_id,
      from_address, to_addresses, subject, body_text, body_html,
      internet_message_id, in_reply_to, references_header,
      imap_mailbox, imap_uidvalidity, imap_uid,
      status, sent_at, technical_confirmation, source, raw_headers
    ) VALUES (
      p_conversation_id, 'outbound', 'manual', p_mailbox_account_id,
      p_mailbox_account_id, p_from_address, p_to_addresses,
      coalesce(p_subject, ''), coalesce(p_body_text, ''), p_body_html,
      p_internet_message_id, p_in_reply_to, coalesce(p_references_header, '{}'::text[]),
      p_imap_mailbox, p_imap_uidvalidity, p_imap_uid,
      'sent_manually', p_sent_at, true, 'gmail_sent_sync',
      coalesce(p_raw_headers, '{}'::jsonb)
    ) RETURNING * INTO result;
    manual_outbound := true;
  END IF;

  IF manual_outbound THEN
    SELECT c.prospect_id, p.normalized_email
      INTO target_prospect_id, target_email
      FROM app.conversations c
      JOIN app.prospects p ON p.id = c.prospect_id
     WHERE c.id = p_conversation_id;

    UPDATE app.conversations
       SET state = 'active',
           last_outbound_at = greatest(coalesce(last_outbound_at, p_sent_at), p_sent_at),
           followups_stopped_at = coalesce(followups_stopped_at, clock_timestamp()),
           followups_stop_reason = coalesce(followups_stop_reason, 'manual_outbound'),
           next_step_due_at = NULL, updated_at = clock_timestamp(), version = version + 1
     WHERE id = p_conversation_id;

    UPDATE app.outbox_jobs
       SET status = 'cancelled', cancelled_at = clock_timestamp(),
           cancel_reason = 'manual_outbound', updated_at = clock_timestamp()
     WHERE conversation_id = p_conversation_id
       AND status IN ('requested','pending','scheduled','deferred','reserved');

    IF target_email IS NOT NULL THEN
      INSERT INTO app.contact_history (
        normalized_email, prospect_id, first_contact_at, confirmation_source,
        technically_confirmed, conversation_id, source_reference
      ) VALUES (
        target_email, target_prospect_id, p_sent_at, 'gmail_sent_sync', true,
        p_conversation_id, p_internet_message_id
      ) ON CONFLICT (normalized_email) DO UPDATE
        SET technically_confirmed = true,
            confirmation_source = CASE
              WHEN app.contact_history.confirmation_source = 'smtp_confirmed'
                THEN app.contact_history.confirmation_source
              ELSE 'gmail_sent_sync'
            END,
            first_contact_at = coalesce(app.contact_history.first_contact_at, EXCLUDED.first_contact_at),
            conversation_id = coalesce(app.contact_history.conversation_id, EXCLUDED.conversation_id),
            source_reference = coalesce(app.contact_history.source_reference, EXCLUDED.source_reference);
      UPDATE app.prospects
         SET contact_state = CASE WHEN contact_state = 'never_contacted'
                                  THEN 'conversation_in_progress' ELSE contact_state END,
             updated_at = clock_timestamp()
       WHERE id = target_prospect_id;
    END IF;
  END IF;

  RETURN result;
END;
$record_sent_message$;

-- Les mesures A/B proviennent des faits déjà persistés. Les réponses IMAP
-- pertinentes restent "à classer" jusqu'à la présence d'une analyse IA.
CREATE OR REPLACE VIEW agent_api.experiment_metrics
WITH (security_barrier = true)
AS
WITH assignment_rollup AS (
  SELECT a.experiment_id, a.variant_id,
         count(DISTINCT a.prospect_id) AS assigned_prospects,
         min(a.assigned_at) AS first_assignment_at
  FROM app.experiment_assignments a
  GROUP BY a.experiment_id, a.variant_id
), sent_rollup AS (
  SELECT a.experiment_id, a.variant_id,
         count(DISTINCT m.id) FILTER (
           WHERE m.status = 'smtp_accepted' AND m.technical_confirmation
         ) AS smtp_accepted,
         max(m.smtp_accepted_at) FILTER (
           WHERE m.status = 'smtp_accepted' AND m.technical_confirmation
         ) AS last_sent_at
  FROM app.experiment_assignments a
  JOIN app.conversations c ON c.experiment_assignment_id = a.id
  JOIN app.email_messages m
    ON m.conversation_id = c.id AND m.direction = 'outbound'
  GROUP BY a.experiment_id, a.variant_id
), response_rollup AS (
  SELECT a.experiment_id, a.variant_id,
         count(DISTINCT m.id) FILTER (
           WHERE analysis.classification IN ('positive','negative','information','meeting','ambiguous','opposition')
         ) AS human_replies,
         count(DISTINCT m.id) FILTER (
           WHERE analysis.classification IN ('positive','negative','information','meeting','ambiguous','opposition')
             AND (analysis.classification = 'positive' OR analysis.commercial_sentiment = 'positive')
         ) AS positive_replies,
         count(DISTINCT m.id) FILTER (
           WHERE analysis.classification IN ('positive','negative','information','meeting','ambiguous','opposition')
             AND analysis.meeting_confirmed
         ) AS confirmed_meetings,
         count(DISTINCT m.id) FILTER (WHERE analysis.id IS NULL) AS unclassified_responses,
         max(coalesce(analysis.created_at, m.received_at)) AS last_response_at
  FROM app.experiment_assignments a
  JOIN app.conversations c ON c.experiment_assignment_id = a.id
  JOIN app.email_messages m
    ON m.conversation_id = c.id
   AND m.direction = 'inbound'
   AND m.kind = 'reply'
   AND m.status = 'received'
  LEFT JOIN app.inbound_analyses analysis ON analysis.message_id = m.id
  GROUP BY a.experiment_id, a.variant_id
), tracking_rollup AS (
  SELECT event.experiment_id, event.variant_id,
         count(DISTINCT event.message_id) FILTER (
           WHERE event.event_type = 'open' AND event.measured
         ) AS measured_opens,
         count(DISTINCT event.message_id) FILTER (
           WHERE event.event_type = 'click' AND event.measured
         ) AS measured_clicks,
         max(event.event_at) FILTER (
           WHERE event.event_type IN ('open','click') AND event.measured
         ) AS last_tracking_at
  FROM app.experiment_events event
  GROUP BY event.experiment_id, event.variant_id
)
SELECT assignment.experiment_id,
       assignment.variant_id,
       assignment.assigned_prospects,
       coalesce(sent.smtp_accepted, 0) AS smtp_accepted,
       coalesce(response.human_replies, 0) AS human_replies,
       coalesce(response.positive_replies, 0) AS positive_replies,
       coalesce(response.confirmed_meetings, 0) AS confirmed_meetings,
       coalesce(tracking.measured_opens, 0) AS measured_opens,
       coalesce(tracking.measured_clicks, 0) AS measured_clicks,
       assignment.first_assignment_at,
       greatest(sent.last_sent_at, response.last_response_at, tracking.last_tracking_at) AS last_event_at,
       coalesce(response.unclassified_responses, 0) AS unclassified_responses
FROM assignment_rollup assignment
LEFT JOIN sent_rollup sent
  ON sent.experiment_id = assignment.experiment_id AND sent.variant_id = assignment.variant_id
LEFT JOIN response_rollup response
  ON response.experiment_id = assignment.experiment_id AND response.variant_id = assignment.variant_id
LEFT JOIN tracking_rollup tracking
  ON tracking.experiment_id = assignment.experiment_id AND tracking.variant_id = assignment.variant_id;

-- Empreinte v2 : uniquement les entrées effectivement utiles à la rédaction.
-- Une colonne séparée permet de prendre une photographie de référence sans
-- réécrire les hashes ni les historiques des cycles déjà commencés.
ALTER TABLE app.prospect_iteration_states
  ADD COLUMN IF NOT EXISTS writing_input_hash text
  CHECK (writing_input_hash IS NULL OR writing_input_hash ~ '^[a-f0-9]{32}$');

CREATE OR REPLACE FUNCTION app.prospect_writing_input_hash(
  p_campaign_id uuid,
  p_prospect_id uuid,
  p_variant_id uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, app
AS $prospect_writing_input_hash$
DECLARE
  effective_row record;
  writing_context jsonb;
  attachment_context jsonb;
BEGIN
  SELECT * INTO effective_row
  FROM app.effective_variant_sequence(p_campaign_id, p_variant_id);

  SELECT jsonb_build_object(
           'campaign', jsonb_build_object(
             'name', c.name,
             'targetDescription', c.target_description,
             'qualificationCriteria', c.qualification_criteria,
             'aiInstructions', c.ai_instructions,
             'replyInstructions', c.reply_instructions
           ),
           'generalWritingInstructions', settings.general_writing_instructions,
           'prospect', jsonb_build_object(
             'fullName', p.full_name,
             'jobTitle', p.job_title,
             'email', p.normalized_email,
             'websiteUrl', p.website_url,
             'sourceLabel', p.source_label,
             'sourceUrl', p.source_url,
             'sourceEvidence', p.source_evidence,
             'qualificationScore', p.qualification_score,
             'qualificationReason', p.qualification_reason
           )
         )
    INTO writing_context
    FROM app.campaigns c
    JOIN app.prospects p ON p.id = p_prospect_id
    CROSS JOIN app.settings settings
   WHERE c.id = p_campaign_id AND settings.singleton;
  IF writing_context IS NULL THEN
    RAISE EXCEPTION 'prospect_writing_context_missing' USING ERRCODE = 'P0001';
  END IF;

  SELECT coalesce(jsonb_agg(
           jsonb_build_object(
             'id', attachment.id,
             'scope', attachment.scope_type,
             'field', attachment.field_key,
             'filename', attachment.filename,
             'contentType', attachment.content_type,
             'size', attachment.size_bytes,
             'blob', attachment.blob_key,
             'text', attachment.extracted_text
           ) ORDER BY attachment.scope_type, attachment.field_key,
                      attachment.created_at, attachment.id
         ), '[]'::jsonb)
    INTO attachment_context
    FROM app.instruction_attachments attachment
   WHERE attachment.deleted_at IS NULL
     AND (
       attachment.scope_type = 'global'
       OR attachment.campaign_id = p_campaign_id
     )
     AND (
       attachment.scope_type = 'global'
       OR attachment.field_key !~ '^variant:'
       OR (
         p_variant_id IS NOT NULL
         AND attachment.field_key LIKE 'variant:' || p_variant_id::text || ':%'
       )
     );

  RETURN md5(jsonb_build_object(
    'format', 'prospect-writing-input-v2',
    'effectiveSequenceHash', effective_row.configuration_hash,
    'context', writing_context,
    'attachments', attachment_context
  )::text);
END;
$prospect_writing_input_hash$;

UPDATE app.prospect_iteration_states state
   SET writing_input_hash = app.prospect_writing_input_hash(
         state.campaign_id, state.prospect_id, state.variant_id
       )
 WHERE state.writing_input_hash IS NULL;

CREATE OR REPLACE FUNCTION agent_api.claim_prospect_iteration(
  p_campaign_id uuid,
  p_prospect_id uuid,
  p_experiment_assignment_id uuid,
  p_run_id uuid,
  p_idempotency_key text
)
RETURNS TABLE(
  iteration_run_id uuid,
  iteration_state_id uuid,
  campaign_id uuid,
  prospect_id uuid,
  experiment_assignment_id uuid,
  variant_id uuid,
  variant_code text,
  iteration_number smallint,
  total_iterations smallint,
  instruction text,
  input_sequence jsonb,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit
AS $claim_prospect_iteration$
DECLARE
  campaign_row app.campaigns%ROWTYPE;
  prospect_row app.prospects%ROWTYPE;
  assignment_row app.experiment_assignments%ROWTYPE;
  effective_row record;
  state_row app.prospect_iteration_states%ROWTYPE;
  existing_run app.prospect_iteration_runs%ROWTYPE;
  created_run app.prospect_iteration_runs%ROWTYPE;
  writing_hash text;
  next_iteration smallint;
  code_value text;
BEGIN
  IF length(coalesce(p_idempotency_key, '')) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO existing_run
  FROM app.prospect_iteration_runs r
  WHERE r.claim_idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing_run.campaign_id IS DISTINCT FROM p_campaign_id
       OR existing_run.prospect_id IS DISTINCT FROM p_prospect_id
       OR existing_run.agent_run_id IS DISTINCT FROM p_run_id THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT existing_run.id, existing_run.state_id,
      existing_run.campaign_id, existing_run.prospect_id,
      existing_run.experiment_assignment_id, existing_run.variant_id,
      v.code, existing_run.iteration_number, existing_run.total_iterations,
      existing_run.instruction, existing_run.input_sequence, existing_run.status
    FROM app.experiment_variants v
    WHERE v.id = existing_run.variant_id
    UNION ALL
    SELECT existing_run.id, existing_run.state_id,
      existing_run.campaign_id, existing_run.prospect_id,
      NULL::uuid, NULL::uuid, NULL::text,
      existing_run.iteration_number, existing_run.total_iterations,
      existing_run.instruction, existing_run.input_sequence, existing_run.status
    WHERE existing_run.variant_id IS NULL;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audit.agent_runs ar
    WHERE ar.id = p_run_id AND ar.agent_type = 'prospection' AND ar.status = 'running'
  ) THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO campaign_row FROM app.campaigns c
  WHERE c.id = p_campaign_id FOR UPDATE;
  IF NOT FOUND OR campaign_row.status <> 'active' OR campaign_row.archived_at IS NOT NULL
     OR campaign_row.imported_disabled THEN
    RAISE EXCEPTION 'campaign_not_active' USING ERRCODE = 'P0001';
  END IF;
  SELECT p.* INTO prospect_row
  FROM app.prospects p
  JOIN app.campaign_prospects cp
    ON cp.prospect_id = p.id AND cp.campaign_id = p_campaign_id
  WHERE p.id = p_prospect_id AND p.deleted_at IS NULL AND cp.state = 'reserved'
  FOR UPDATE OF p;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prospect_not_reserved' USING ERRCODE = 'P0001';
  END IF;

  IF p_experiment_assignment_id IS NOT NULL THEN
    SELECT * INTO assignment_row
    FROM app.experiment_assignments a
    WHERE a.id = p_experiment_assignment_id
      AND a.campaign_id = p_campaign_id
      AND a.prospect_id = p_prospect_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'experiment_assignment_mismatch' USING ERRCODE = 'P0001';
    END IF;
    SELECT v.code INTO code_value FROM app.experiment_variants v WHERE v.id = assignment_row.variant_id;
  ELSIF EXISTS (
    SELECT 1 FROM app.experiments e
    WHERE e.campaign_id = p_campaign_id AND e.status IN ('recruiting','threshold_reached')
  ) THEN
    RAISE EXCEPTION 'experiment_assignment_required' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO effective_row
  FROM app.effective_variant_sequence(p_campaign_id, assignment_row.variant_id);
  writing_hash := app.prospect_writing_input_hash(
    p_campaign_id, p_prospect_id, assignment_row.variant_id
  );

  INSERT INTO app.prospect_iteration_states (
    campaign_id, prospect_id, experiment_assignment_id, experiment_id, variant_id,
    configuration_hash, writing_input_hash, iteration_instructions, total_iterations
  ) VALUES (
    p_campaign_id, p_prospect_id, assignment_row.id,
    assignment_row.experiment_id, assignment_row.variant_id,
    writing_hash, writing_hash, effective_row.revision_instructions,
    cardinality(effective_row.revision_instructions)
  ) ON CONFLICT DO NOTHING;

  SELECT * INTO state_row
  FROM app.prospect_iteration_states s
  WHERE s.campaign_id = p_campaign_id
    AND s.prospect_id = p_prospect_id
    AND s.experiment_assignment_id IS NOT DISTINCT FROM assignment_row.id
  FOR UPDATE;

  IF state_row.writing_input_hash IS DISTINCT FROM writing_hash THEN
    UPDATE app.prospect_iteration_runs AS old_run
       SET status = 'superseded', error_code = 'configuration_changed'
     WHERE old_run.state_id = state_row.id AND old_run.status = 'running';
    UPDATE app.prospect_iteration_states AS changed_state
       SET configuration_hash = writing_hash,
           writing_input_hash = writing_hash,
           iteration_instructions = effective_row.revision_instructions,
           total_iterations = cardinality(effective_row.revision_instructions),
           completed_iterations = 0,
           status = 'pending',
           claimed_iteration_run_id = NULL,
           claimed_iteration = NULL,
           claim_expires_at = NULL,
           last_error_code = NULL,
           version = version + 1,
           updated_at = clock_timestamp()
     WHERE changed_state.id = state_row.id
     RETURNING * INTO state_row;
  END IF;

  SELECT * INTO existing_run
  FROM app.prospect_iteration_runs r
  WHERE r.state_id = state_row.id AND r.agent_run_id = p_run_id;
  IF FOUND THEN
    RETURN QUERY SELECT existing_run.id, existing_run.state_id,
      existing_run.campaign_id, existing_run.prospect_id,
      existing_run.experiment_assignment_id, existing_run.variant_id,
      code_value, existing_run.iteration_number, existing_run.total_iterations,
      existing_run.instruction, existing_run.input_sequence, existing_run.status;
    RETURN;
  END IF;

  IF state_row.status = 'completed' THEN
    RAISE EXCEPTION 'prospect_iterations_completed' USING ERRCODE = 'P0001';
  END IF;
  IF state_row.status = 'running' AND state_row.claim_expires_at > clock_timestamp() THEN
    RAISE EXCEPTION 'prospect_iteration_busy' USING ERRCODE = 'P0001';
  END IF;
  IF state_row.status = 'running' THEN
    UPDATE app.prospect_iteration_runs AS expired_run
       SET status = 'failed', error_code = 'claim_expired'
     WHERE expired_run.id = state_row.claimed_iteration_run_id
       AND expired_run.status = 'running';
  END IF;

  next_iteration := state_row.completed_iterations + 1;
  IF next_iteration = 1 THEN
    created_run.input_sequence := effective_row.sequence_payload;
  ELSE
    SELECT r.output_sequence INTO created_run.input_sequence
    FROM app.prospect_iteration_runs r
    WHERE r.state_id = state_row.id AND r.status = 'completed'
      AND r.iteration_number = next_iteration - 1
    ORDER BY r.completed_at DESC LIMIT 1;
  END IF;
  IF created_run.input_sequence IS NULL THEN
    RAISE EXCEPTION 'previous_prospect_iteration_missing' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO app.prospect_iteration_runs (
    state_id, campaign_id, prospect_id, experiment_assignment_id, variant_id,
    configuration_hash, iteration_number, total_iterations, instruction,
    agent_run_id, input_sequence, claim_idempotency_key
  ) VALUES (
    state_row.id, p_campaign_id, p_prospect_id, assignment_row.id,
    assignment_row.variant_id, state_row.configuration_hash, next_iteration,
    state_row.total_iterations, state_row.iteration_instructions[next_iteration],
    p_run_id, created_run.input_sequence, p_idempotency_key
  ) RETURNING * INTO created_run;

  UPDATE app.prospect_iteration_states AS claimed_state
     SET status = 'running',
         claimed_iteration_run_id = created_run.id,
         claimed_iteration = next_iteration,
         claim_expires_at = clock_timestamp() + interval '2 hours',
         last_error_code = NULL,
         version = version + 1,
         updated_at = clock_timestamp()
   WHERE claimed_state.id = state_row.id;

  INSERT INTO audit.event_log (
    actor_type, actor_id, correlation_id, event_type, entity_type, entity_id, metadata
  ) VALUES (
    'prospection_agent', p_run_id::text, p_run_id, 'prospect_iteration_claimed',
    'prospect', p_prospect_id::text,
    jsonb_build_object('iterationRunId', created_run.id,
                       'iterationStateId', state_row.id,
                       'campaignId', p_campaign_id,
                       'assignmentId', assignment_row.id,
                       'variantId', assignment_row.variant_id,
                       'iteration', next_iteration,
                       'total', state_row.total_iterations,
                       'idempotencyKey', p_idempotency_key)
  );

  RETURN QUERY SELECT created_run.id, created_run.state_id,
    created_run.campaign_id, created_run.prospect_id,
    created_run.experiment_assignment_id, created_run.variant_id,
    code_value, created_run.iteration_number, created_run.total_iterations,
    created_run.instruction, created_run.input_sequence, created_run.status;
END;
$claim_prospect_iteration$;

CREATE OR REPLACE FUNCTION agent_api.propose_completed_sequence(
  p_iteration_state_id uuid,
  p_sender_account_id uuid,
  p_run_id uuid,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit, agent_api
AS $propose_completed_sequence$
DECLARE
  state_row app.prospect_iteration_states%ROWTYPE;
  final_sequence jsonb;
  message_payload jsonb;
  conversation_uuid uuid;
  current_writing_hash text;
BEGIN
  IF length(coalesce(p_idempotency_key, '')) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audit.agent_runs ar
    WHERE ar.id = p_run_id AND ar.agent_type = 'prospection' AND ar.status = 'running'
  ) THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO state_row
  FROM app.prospect_iteration_states s
  WHERE s.id = p_iteration_state_id
  FOR UPDATE;
  IF NOT FOUND OR state_row.status <> 'completed' THEN
    RAISE EXCEPTION 'prospect_iterations_incomplete' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.campaign_prospects cp
    WHERE cp.campaign_id = state_row.campaign_id
      AND cp.prospect_id = state_row.prospect_id
      AND cp.state = 'reserved'
  ) THEN
    RAISE EXCEPTION 'prospect_not_reserved' USING ERRCODE = 'P0001';
  END IF;

  current_writing_hash := app.prospect_writing_input_hash(
    state_row.campaign_id, state_row.prospect_id, state_row.variant_id
  );
  IF current_writing_hash IS DISTINCT FROM state_row.writing_input_hash THEN
    RAISE EXCEPTION 'prospect_iteration_configuration_changed' USING ERRCODE = 'P0001';
  END IF;

  SELECT r.output_sequence INTO final_sequence
  FROM app.prospect_iteration_runs r
  WHERE r.state_id = state_row.id
    AND r.status = 'completed'
    AND r.iteration_number = state_row.total_iterations
  ORDER BY r.completed_at DESC LIMIT 1;
  IF NOT app.valid_sequence_payload(final_sequence) THEN
    RAISE EXCEPTION 'completed_sequence_missing' USING ERRCODE = 'P0001';
  END IF;

  SELECT jsonb_agg(
    jsonb_build_object('body', item.value, 'subject', final_sequence->>'subject')
    ORDER BY item.position
  ) INTO message_payload
  FROM jsonb_array_elements_text(final_sequence->'steps')
       WITH ORDINALITY AS item(value, position);

  conversation_uuid := agent_api.propose_sequence(
    state_row.campaign_id,
    state_row.prospect_id,
    p_sender_account_id,
    final_sequence->>'subject',
    message_payload,
    p_run_id,
    p_idempotency_key
  );

  IF state_row.experiment_assignment_id IS NOT NULL THEN
    UPDATE app.conversations
       SET experiment_assignment_id = state_row.experiment_assignment_id,
           updated_at = clock_timestamp()
     WHERE id = conversation_uuid;
    UPDATE app.experiment_assignments
       SET exposed_at = coalesce(exposed_at, clock_timestamp())
     WHERE id = state_row.experiment_assignment_id;
    UPDATE app.experiment_variants
       SET exposed_at = coalesce(exposed_at, clock_timestamp())
     WHERE id = state_row.variant_id;
  END IF;

  RETURN jsonb_build_object(
    'conversationId', conversation_uuid,
    'iterationStateId', state_row.id,
    'campaignId', state_row.campaign_id,
    'prospectId', state_row.prospect_id,
    'experimentAssignmentId', state_row.experiment_assignment_id,
    'variantId', state_row.variant_id
  );
END;
$propose_completed_sequence$;

ALTER TABLE app.prospect_iteration_states
  ALTER COLUMN writing_input_hash SET NOT NULL;

REVOKE ALL ON FUNCTION app.prospect_writing_input_hash(uuid,uuid,uuid)
  FROM PUBLIC, prospection95_agent;
GRANT EXECUTE ON FUNCTION app.prospect_writing_input_hash(uuid,uuid,uuid)
  TO prospection95_app;

REVOKE ALL ON FUNCTION app.start_outbox_attempt(uuid,uuid),
  app.record_sent_message(uuid,uuid,text,text[],text,text,text,text,text,text[],text,bigint,bigint,timestamptz,jsonb)
  FROM PUBLIC, prospection95_agent;
GRANT EXECUTE ON FUNCTION app.start_outbox_attempt(uuid,uuid),
  app.record_sent_message(uuid,uuid,text,text[],text,text,text,text,text,text[],text,bigint,bigint,timestamptz,jsonb)
  TO prospection95_app;

GRANT SELECT ON agent_api.experiment_metrics TO prospection95_agent, prospection95_app;
GRANT EXECUTE ON FUNCTION agent_api.claim_prospect_iteration(uuid,uuid,uuid,uuid,text),
  agent_api.propose_completed_sequence(uuid,uuid,uuid,text)
  TO prospection95_agent;

INSERT INTO app.schema_migrations (version)
VALUES ('021_targeted_reliability_fixes')
ON CONFLICT (version) DO NOTHING;

COMMIT;
