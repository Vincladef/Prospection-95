-- Prospection 95 · continuité Gmail, rebonds permanents, cycle A/B/C et
-- répartition équilibrée des comptes expéditeurs.

BEGIN;

-- Un rebond temporaire reste observable sans interrompre la conversation.
-- Un DSN 5.x.x confirmé par le parseur IMAP arrête les relances et exclut
-- l'adresse afin qu'une autre campagne ne tente pas un nouveau J0.
CREATE OR REPLACE FUNCTION app.stop_followups_on_inbound()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $stop_followups_on_inbound$
DECLARE
  prospect_email text;
BEGIN
  IF NEW.direction <> 'inbound' OR NEW.conversation_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.kind NOT IN ('automatic_reply','out_of_office','bounce','unrelated') THEN
    UPDATE app.conversations
       SET state = 'replied', last_inbound_at = coalesce(NEW.received_at, clock_timestamp()),
           followups_stopped_at = clock_timestamp(), followups_stop_reason = 'relevant_inbound',
           next_step_due_at = NULL, updated_at = clock_timestamp(), version = version + 1
     WHERE id = NEW.conversation_id AND followups_stopped_at IS NULL;
    UPDATE app.outbox_jobs
       SET status = 'cancelled', cancelled_at = clock_timestamp(),
           cancel_reason = 'relevant_inbound', updated_at = clock_timestamp()
     WHERE conversation_id = NEW.conversation_id
       AND status IN ('requested','pending','scheduled','deferred','reserved');
    UPDATE app.prospects SET contact_state = 'replied', updated_at = clock_timestamp()
     WHERE id = (SELECT prospect_id FROM app.conversations WHERE id = NEW.conversation_id);
  ELSIF NEW.kind = 'bounce'
        AND coalesce((NEW.raw_headers->>'permanentBounce')::boolean, false) THEN
    SELECT p.normalized_email INTO prospect_email
      FROM app.conversations conversation
      JOIN app.prospects p ON p.id = conversation.prospect_id
     WHERE conversation.id = NEW.conversation_id;

    UPDATE app.conversations
       SET state = 'cancelled', last_inbound_at = coalesce(NEW.received_at, clock_timestamp()),
           followups_stopped_at = coalesce(followups_stopped_at, clock_timestamp()),
           followups_stop_reason = coalesce(followups_stop_reason, 'permanent_bounce'),
           next_step_due_at = NULL, updated_at = clock_timestamp(), version = version + 1
     WHERE id = NEW.conversation_id;
    UPDATE app.outbox_jobs
       SET status = 'cancelled', cancelled_at = clock_timestamp(),
           cancel_reason = 'permanent_bounce', updated_at = clock_timestamp()
     WHERE conversation_id = NEW.conversation_id
       AND status IN ('requested','pending','scheduled','deferred','reserved');
    UPDATE app.prospects
       SET contact_state = 'do_not_contact', updated_at = clock_timestamp()
     WHERE id = (SELECT prospect_id FROM app.conversations WHERE id = NEW.conversation_id);
    IF prospect_email IS NOT NULL THEN
      INSERT INTO app.exclusions
        (match_type, match_value, reason, source, permanent, created_by)
      VALUES
        ('email', prospect_email, 'Rebond permanent Gmail (DSN 5.x.x)', 'agent', true, 'imap-sync')
      ON CONFLICT (match_type, normalized_value) WHERE revoked_at IS NULL DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$stop_followups_on_inbound$;

-- Le gagnant est un fait explicite : aucune variante n'est déduite ou inventée
-- par le backend. L'agent ne peut conclure qu'après seuils et maturité.
ALTER TABLE app.experiments
  ADD COLUMN IF NOT EXISTS winner_variant_id uuid
  REFERENCES app.experiment_variants(id) ON DELETE RESTRICT;

-- Répare uniquement les anciens doublons jamais exposés : le premier test
-- reste ouvert, les suivants redeviennent prêts. Un test ayant une attribution
-- n'est jamais réécrit par cette migration.
WITH open_tests AS (
  SELECT experiment.id,
         row_number() OVER (
           PARTITION BY experiment.campaign_id
           ORDER BY experiment.started_at NULLS LAST, experiment.created_at, experiment.id
         ) AS open_rank
    FROM app.experiments experiment
   WHERE experiment.status IN ('recruiting','threshold_reached','awaiting_observations','mature')
), unused_duplicates AS (
  SELECT open_tests.id
    FROM open_tests
   WHERE open_tests.open_rank > 1
     AND NOT EXISTS (
       SELECT 1 FROM app.experiment_assignments assignment
        WHERE assignment.experiment_id = open_tests.id
     )
)
UPDATE app.experiments experiment
   SET status = 'draft', started_at = NULL, threshold_reached_at = NULL,
       mature_at = NULL, updated_at = clock_timestamp()
  FROM unused_duplicates duplicate
 WHERE experiment.id = duplicate.id;

CREATE UNIQUE INDEX IF NOT EXISTS experiments_one_open_per_campaign_uq
  ON app.experiments (campaign_id)
  WHERE status IN ('recruiting','threshold_reached','awaiting_observations','mature');

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
  ) ORDER BY v.code) FILTER (WHERE v.id IS NOT NULL), '[]'::jsonb) AS variants,
  e.winner_variant_id,
  winner.code AS winner_variant_code
FROM app.experiments e
LEFT JOIN app.experiment_variants v ON v.experiment_id = e.id
LEFT JOIN app.experiment_variants winner ON winner.id = e.winner_variant_id
GROUP BY e.id, winner.code;

CREATE OR REPLACE FUNCTION agent_api.activate_experiment(
  p_experiment_id uuid,
  p_run_id uuid,
  p_idempotency_key text
)
RETURNS app.experiment_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit
AS $activate_experiment$
DECLARE target app.experiments%ROWTYPE;
BEGIN
  IF length(coalesce(p_idempotency_key, '')) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit.agent_runs r WHERE r.id = p_run_id AND r.agent_type = 'prospection' AND r.status = 'running') THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO target FROM app.experiments WHERE id = p_experiment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'experiment_not_found' USING ERRCODE = 'P0001'; END IF;
  IF target.status = 'recruiting' THEN RETURN target.status; END IF;
  IF target.status <> 'draft' THEN RAISE EXCEPTION 'experiment_not_activatable' USING ERRCODE = 'P0001'; END IF;
  IF (SELECT count(*) FROM app.experiment_variants v WHERE v.experiment_id = target.id) < 2 THEN
    RAISE EXCEPTION 'experiment_requires_two_variants' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM app.experiments other
     WHERE other.campaign_id = target.campaign_id AND other.id <> target.id
       AND other.status IN ('recruiting','threshold_reached','awaiting_observations','mature')
  ) THEN
    RAISE EXCEPTION 'campaign_experiment_already_active' USING ERRCODE = 'P0001';
  END IF;
  UPDATE app.experiments SET status = 'recruiting', started_at = coalesce(started_at, clock_timestamp()),
         updated_at = clock_timestamp() WHERE id = target.id RETURNING status INTO target.status;
  INSERT INTO audit.event_log (actor_type, actor_id, correlation_id, event_type, entity_type, entity_id, metadata)
  VALUES ('prospection_agent', p_run_id::text, p_run_id, 'experiment_activated', 'experiment', target.id::text,
          jsonb_build_object('idempotencyKey', p_idempotency_key));
  RETURN target.status;
END;
$activate_experiment$;

CREATE OR REPLACE FUNCTION agent_api.advance_experiment(
  p_experiment_id uuid,
  p_run_id uuid,
  p_idempotency_key text
)
RETURNS app.experiment_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit, agent_api
AS $advance_experiment$
DECLARE
  target app.experiments%ROWTYPE;
  variant_count integer;
  variants_at_contact_threshold integer;
  confirmed_human_replies integer;
BEGIN
  IF length(coalesce(p_idempotency_key, '')) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit.agent_runs r WHERE r.id = p_run_id AND r.agent_type = 'prospection' AND r.status = 'running') THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO target FROM app.experiments WHERE id = p_experiment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'experiment_not_found' USING ERRCODE = 'P0001'; END IF;
  IF target.status NOT IN ('recruiting','threshold_reached','awaiting_observations','mature') THEN
    RETURN target.status;
  END IF;

  SELECT count(*)::integer,
         count(*) FILTER (WHERE coalesce(metrics.smtp_accepted, 0) >= target.contacts_per_variant_threshold)::integer,
         coalesce(sum(metrics.human_replies), 0)::integer
    INTO variant_count, variants_at_contact_threshold, confirmed_human_replies
    FROM app.experiment_variants variant
    LEFT JOIN agent_api.experiment_metrics metrics
      ON metrics.experiment_id = variant.experiment_id AND metrics.variant_id = variant.id
   WHERE variant.experiment_id = target.id;

  IF target.status IN ('recruiting','threshold_reached')
     AND variant_count >= 2
     AND variants_at_contact_threshold = variant_count
     AND confirmed_human_replies >= target.total_responses_threshold THEN
    UPDATE app.experiments
       SET status = 'awaiting_observations',
           threshold_reached_at = coalesce(threshold_reached_at, clock_timestamp()),
           mature_at = coalesce(mature_at, clock_timestamp() + maturity_delay),
           updated_at = clock_timestamp()
     WHERE id = target.id RETURNING * INTO target;
  END IF;
  IF target.status = 'awaiting_observations' AND target.mature_at <= clock_timestamp() THEN
    UPDATE app.experiments SET status = 'mature', updated_at = clock_timestamp()
     WHERE id = target.id RETURNING * INTO target;
  END IF;
  RETURN target.status;
END;
$advance_experiment$;

CREATE OR REPLACE FUNCTION agent_api.conclude_experiment(
  p_experiment_id uuid,
  p_winner_variant_id uuid,
  p_decision text,
  p_limitations text,
  p_run_id uuid,
  p_idempotency_key text
)
RETURNS app.experiment_status
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit
AS $conclude_experiment$
DECLARE target app.experiments%ROWTYPE;
BEGIN
  IF length(coalesce(p_idempotency_key, '')) NOT BETWEEN 8 AND 200
     OR length(btrim(coalesce(p_decision, ''))) NOT BETWEEN 1 AND 10000
     OR length(coalesce(p_limitations, '')) > 10000 THEN
    RAISE EXCEPTION 'invalid_experiment_conclusion' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit.agent_runs r WHERE r.id = p_run_id AND r.agent_type = 'prospection' AND r.status = 'running') THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO target FROM app.experiments WHERE id = p_experiment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'experiment_not_found' USING ERRCODE = 'P0001'; END IF;
  IF target.status = 'closed' AND target.winner_variant_id = p_winner_variant_id THEN RETURN target.status; END IF;
  IF target.status <> 'mature' THEN RAISE EXCEPTION 'experiment_not_mature' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.experiment_variants v WHERE v.id = p_winner_variant_id AND v.experiment_id = target.id) THEN
    RAISE EXCEPTION 'winner_variant_mismatch' USING ERRCODE = 'P0001';
  END IF;
  UPDATE app.experiments
     SET status = 'closed', winner_variant_id = p_winner_variant_id,
         decision = btrim(p_decision), limitations = nullif(btrim(coalesce(p_limitations, '')), ''),
         analyzed_at = clock_timestamp(), closed_at = clock_timestamp(), updated_at = clock_timestamp()
   WHERE id = target.id RETURNING * INTO target;
  INSERT INTO audit.event_log (actor_type, actor_id, correlation_id, event_type, entity_type, entity_id, metadata)
  VALUES ('prospection_agent', p_run_id::text, p_run_id, 'experiment_concluded', 'experiment', target.id::text,
          jsonb_build_object('winnerVariantId', p_winner_variant_id, 'idempotencyKey', p_idempotency_key));
  RETURN target.status;
END;
$conclude_experiment$;

-- Attribution pondérée et sérialisée. Pour une campagne stabilisée, toute
-- nouvelle attribution reprend uniquement la variante gagnante archivée.
CREATE OR REPLACE FUNCTION app.assign_experiment_variant(
  p_experiment_id uuid,
  p_prospect_id uuid,
  p_step app.sequence_step,
  p_assignment_key text
)
RETURNS app.experiment_assignments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $assign_experiment_variant$
DECLARE
  chosen app.experiment_variants;
  experiment_row app.experiments;
  result app.experiment_assignments;
  stabilized boolean;
BEGIN
  IF length(coalesce(p_assignment_key, '')) < 8 THEN
    RAISE EXCEPTION 'invalid_assignment_key' USING ERRCODE = '22023';
  END IF;
  SELECT e.* INTO experiment_row
    FROM app.experiments e JOIN app.campaigns c ON c.id = e.campaign_id
   WHERE e.id = p_experiment_id
     AND (e.status IN ('recruiting','threshold_reached')
          OR (e.status = 'closed' AND c.experiment_policy = 'stabilize' AND e.winner_variant_id IS NOT NULL))
   FOR UPDATE OF e;
  IF NOT FOUND THEN RAISE EXCEPTION 'experiment_not_recruiting' USING ERRCODE = 'P0001'; END IF;
  stabilized := experiment_row.status = 'closed' AND experiment_row.winner_variant_id IS NOT NULL;
  IF NOT EXISTS (SELECT 1 FROM app.campaign_prospects WHERE campaign_id = experiment_row.campaign_id AND prospect_id = p_prospect_id) THEN
    RAISE EXCEPTION 'prospect_not_in_campaign' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_experiment_id::text || coalesce(p_step::text, ''), 95));
  SELECT v.* INTO chosen
    FROM app.experiment_variants v
    LEFT JOIN LATERAL (
      SELECT count(*) AS allocation_count FROM app.experiment_assignments a
       WHERE a.variant_id = v.id AND a.assigned_for_step IS NOT DISTINCT FROM p_step
    ) count_by_variant ON true
   WHERE v.experiment_id = p_experiment_id
     AND (NOT stabilized OR v.id = experiment_row.winner_variant_id)
   ORDER BY (count_by_variant.allocation_count / v.weight) ASC, random()
   LIMIT 1;
  IF chosen.id IS NULL THEN RAISE EXCEPTION 'experiment_has_no_variants' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO app.experiment_assignments
    (experiment_id, variant_id, prospect_id, campaign_id, assigned_for_step, assignment_key)
  VALUES
    (p_experiment_id, chosen.id, p_prospect_id, experiment_row.campaign_id, p_step, p_assignment_key)
  ON CONFLICT (assignment_key) DO NOTHING RETURNING * INTO result;
  IF result.id IS NULL THEN SELECT * INTO result FROM app.experiment_assignments WHERE assignment_key = p_assignment_key; END IF;
  RETURN result;
END;
$assign_experiment_variant$;

CREATE OR REPLACE FUNCTION agent_api.assign_prospect_variant(
  p_experiment_id uuid,
  p_prospect_id uuid,
  p_run_id uuid,
  p_idempotency_key text
)
RETURNS TABLE(
  assignment_id uuid,
  campaign_id uuid,
  experiment_id uuid,
  variant_id uuid,
  variant_code text,
  assigned_for_step app.sequence_step
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit
AS $assign_prospect_variant$
DECLARE
  experiment_row app.experiments%ROWTYPE;
  assignment_row app.experiment_assignments%ROWTYPE;
  chosen_step app.sequence_step;
BEGIN
  IF length(coalesce(p_idempotency_key, '')) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM audit.agent_runs ar WHERE ar.id = p_run_id AND ar.agent_type = 'prospection' AND ar.status = 'running') THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  SELECT e.* INTO experiment_row
    FROM app.experiments e JOIN app.campaigns c ON c.id = e.campaign_id
   WHERE e.id = p_experiment_id
     AND (e.status IN ('recruiting','threshold_reached')
          OR (e.status = 'closed' AND c.experiment_policy = 'stabilize' AND e.winner_variant_id IS NOT NULL))
   FOR UPDATE OF e;
  IF NOT FOUND THEN RAISE EXCEPTION 'experiment_not_recruiting' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.campaign_prospects cp
     WHERE cp.campaign_id = experiment_row.campaign_id AND cp.prospect_id = p_prospect_id AND cp.state = 'reserved'
  ) THEN RAISE EXCEPTION 'prospect_not_reserved' USING ERRCODE = 'P0001'; END IF;
  chosen_step := CASE WHEN experiment_row.scope = 'step' THEN experiment_row.target_step ELSE NULL END;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_experiment_id::text || ':' || p_prospect_id::text || ':' || coalesce(chosen_step::text, 'sequence'), 95
  ));
  SELECT * INTO assignment_row FROM app.experiment_assignments a
   WHERE a.experiment_id = p_experiment_id AND a.prospect_id = p_prospect_id
     AND a.assigned_for_step IS NOT DISTINCT FROM chosen_step
   ORDER BY a.assigned_at LIMIT 1;
  IF NOT FOUND THEN
    assignment_row := app.assign_experiment_variant(p_experiment_id, p_prospect_id, chosen_step, p_idempotency_key);
  END IF;
  INSERT INTO app.experiment_events (
    experiment_id, variant_id, assignment_id, prospect_id, event_type, event_at,
    measured, confidence, source, idempotency_key, metadata
  ) VALUES (
    assignment_row.experiment_id, assignment_row.variant_id, assignment_row.id,
    assignment_row.prospect_id, 'assigned', assignment_row.assigned_at,
    true, 'confirmed', 'prospection_agent', 'assignment:' || assignment_row.id::text,
    jsonb_build_object('runId', p_run_id)
  ) ON CONFLICT (idempotency_key) DO NOTHING;
  INSERT INTO audit.event_log (actor_type, actor_id, correlation_id, event_type, entity_type, entity_id, metadata)
  VALUES ('prospection_agent', p_run_id::text, p_run_id, 'experiment_variant_assigned', 'prospect', p_prospect_id::text,
          jsonb_build_object('assignmentId', assignment_row.id, 'experimentId', assignment_row.experiment_id,
                             'variantId', assignment_row.variant_id, 'idempotencyKey', p_idempotency_key));
  RETURN QUERY SELECT assignment_row.id, assignment_row.campaign_id, assignment_row.experiment_id,
                      assignment_row.variant_id, v.code, assignment_row.assigned_for_step
    FROM app.experiment_variants v WHERE v.id = assignment_row.variant_id;
END;
$assign_prospect_variant$;

-- Le choix du compte est figé sur le prospect. Les nouvelles attributions de
-- pool sont pondérées par la charge déjà attribuée et protégées contre les runs
-- concurrents par un verrou transactionnel de campagne.
CREATE OR REPLACE FUNCTION app.select_campaign_sender(
  p_campaign_id uuid,
  p_prospect_id uuid,
  p_requested_account_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $select_campaign_sender$
DECLARE campaign_row app.campaigns%ROWTYPE; selected_id uuid;
BEGIN
  SELECT * INTO campaign_row FROM app.campaigns WHERE id = p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sender:' || p_campaign_id::text, 95));
  SELECT cp.assigned_sender_account_id INTO selected_id
    FROM app.campaign_prospects cp
    JOIN app.gmail_accounts account ON account.id = cp.assigned_sender_account_id
   WHERE cp.campaign_id = p_campaign_id AND cp.prospect_id = p_prospect_id
     AND account.status = 'active' AND account.paused_at IS NULL
     AND account.deleted_at IS NULL AND account.credential_id IS NOT NULL;
  IF selected_id IS NOT NULL THEN RETURN selected_id; END IF;

  IF campaign_row.sender_strategy = 'fixed' THEN
    selected_id := campaign_row.fixed_sender_account_id;
  ELSE
    SELECT candidate.account_id INTO selected_id
      FROM app.campaign_sender_accounts candidate
      JOIN app.gmail_accounts account ON account.id = candidate.account_id
      LEFT JOIN LATERAL (
        SELECT count(*)::numeric AS assigned_count
          FROM app.campaign_prospects cp
         WHERE cp.campaign_id = p_campaign_id
           AND cp.assigned_sender_account_id = candidate.account_id
           AND cp.state IN ('reserved','prepared','engaged','replied')
      ) load ON true
     WHERE candidate.campaign_id = p_campaign_id AND candidate.enabled
       AND account.status = 'active' AND account.paused_at IS NULL
       AND account.deleted_at IS NULL AND account.credential_id IS NOT NULL
       AND least(account.daily_limit, coalesce(account.warmup_daily_limit, account.daily_limit)) > 0
     ORDER BY load.assigned_count / candidate.weight,
              CASE WHEN candidate.account_id = p_requested_account_id THEN 0 ELSE 1 END,
              candidate.account_id
     LIMIT 1;
  END IF;
  IF selected_id IS NULL THEN RAISE EXCEPTION 'sender_not_available_for_campaign' USING ERRCODE = 'P0001'; END IF;
  UPDATE app.campaign_prospects SET assigned_sender_account_id = selected_id, updated_at = clock_timestamp()
   WHERE campaign_id = p_campaign_id AND prospect_id = p_prospect_id;
  RETURN selected_id;
END;
$select_campaign_sender$;

-- Le contrat public conserve son paramètre expéditeur pour compatibilité. En
-- pool, le backend choisit et persiste l'identité équilibrée avant la création.
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
  effective_sender_id uuid;
BEGIN
  IF length(coalesce(p_idempotency_key, '')) NOT BETWEEN 8 AND 200 THEN RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE = '22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM audit.agent_runs ar WHERE ar.id = p_run_id AND ar.agent_type = 'prospection' AND ar.status = 'running') THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO state_row FROM app.prospect_iteration_states s WHERE s.id = p_iteration_state_id FOR UPDATE;
  IF NOT FOUND OR state_row.status <> 'completed' THEN RAISE EXCEPTION 'prospect_iterations_incomplete' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.campaign_prospects cp WHERE cp.campaign_id = state_row.campaign_id AND cp.prospect_id = state_row.prospect_id AND cp.state = 'reserved') THEN
    RAISE EXCEPTION 'prospect_not_reserved' USING ERRCODE = 'P0001';
  END IF;
  current_writing_hash := app.prospect_writing_input_hash(state_row.campaign_id, state_row.prospect_id, state_row.variant_id);
  IF current_writing_hash IS DISTINCT FROM state_row.writing_input_hash THEN
    RAISE EXCEPTION 'prospect_iteration_configuration_changed' USING ERRCODE = 'P0001';
  END IF;
  SELECT r.output_sequence INTO final_sequence FROM app.prospect_iteration_runs r
   WHERE r.state_id = state_row.id AND r.status = 'completed' AND r.iteration_number = state_row.total_iterations
   ORDER BY r.completed_at DESC LIMIT 1;
  IF NOT app.valid_sequence_payload(final_sequence) THEN RAISE EXCEPTION 'completed_sequence_missing' USING ERRCODE = 'P0001'; END IF;
  SELECT jsonb_agg(jsonb_build_object('body', item.value, 'subject', final_sequence->>'subject') ORDER BY item.position)
    INTO message_payload FROM jsonb_array_elements_text(final_sequence->'steps') WITH ORDINALITY AS item(value, position);
  effective_sender_id := app.select_campaign_sender(state_row.campaign_id, state_row.prospect_id, p_sender_account_id);
  conversation_uuid := agent_api.propose_sequence(state_row.campaign_id, state_row.prospect_id, effective_sender_id,
    final_sequence->>'subject', message_payload, p_run_id, p_idempotency_key);
  IF state_row.experiment_assignment_id IS NOT NULL THEN
    UPDATE app.conversations SET experiment_assignment_id = state_row.experiment_assignment_id, updated_at = clock_timestamp() WHERE id = conversation_uuid;
    UPDATE app.experiment_assignments SET exposed_at = coalesce(exposed_at, clock_timestamp()) WHERE id = state_row.experiment_assignment_id;
    UPDATE app.experiment_variants SET exposed_at = coalesce(exposed_at, clock_timestamp()) WHERE id = state_row.variant_id;
  END IF;
  RETURN jsonb_build_object('conversationId', conversation_uuid, 'iterationStateId', state_row.id,
    'campaignId', state_row.campaign_id, 'prospectId', state_row.prospect_id,
    'experimentAssignmentId', state_row.experiment_assignment_id, 'variantId', state_row.variant_id,
    'senderAccountId', effective_sender_id);
END;
$propose_completed_sequence$;

REVOKE ALL ON FUNCTION app.select_campaign_sender(uuid,uuid,uuid),
  app.assign_experiment_variant(uuid,uuid,app.sequence_step,text)
  FROM PUBLIC, prospection95_agent;
GRANT EXECUTE ON FUNCTION app.select_campaign_sender(uuid,uuid,uuid),
  app.assign_experiment_variant(uuid,uuid,app.sequence_step,text)
  TO prospection95_app;
GRANT EXECUTE ON FUNCTION agent_api.activate_experiment(uuid,uuid,text),
  agent_api.advance_experiment(uuid,uuid,text),
  agent_api.conclude_experiment(uuid,uuid,text,text,uuid,text)
  TO prospection95_agent;
GRANT SELECT ON agent_api.experiments TO prospection95_agent, prospection95_app;

INSERT INTO app.schema_migrations (version)
VALUES ('023_final_prospecting_cycle')
ON CONFLICT (version) DO NOTHING;

COMMIT;
