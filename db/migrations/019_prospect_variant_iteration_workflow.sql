-- Prospection 95 · révisions persistantes par prospect et contexte A/B.
-- La migration 018 reste un historique de campagne, mais n'est plus le verrou
-- opérationnel de la préparation personnalisée.

DROP TRIGGER IF EXISTS sync_campaign_iteration_state ON app.campaigns;

UPDATE app.campaign_iteration_runs
SET status = 'superseded', error_code = 'superseded_by_prospect_workflow'
WHERE status = 'running';

UPDATE app.campaign_iteration_states
SET status = 'cancelled',
    claimed_iteration_run_id = NULL,
    claimed_iteration = NULL,
    claim_expires_at = NULL,
    last_error_code = 'superseded_by_prospect_workflow',
    version = version + 1,
    updated_at = clock_timestamp()
WHERE status IN ('pending','running');

CREATE OR REPLACE VIEW agent_api.pending_campaign_iterations
WITH (security_barrier = true)
AS
SELECT
  s.campaign_id,
  c.name AS campaign_name,
  s.status,
  s.completed_iterations,
  s.total_iterations,
  NULL::integer AS current_iteration,
  NULL::text AS next_instruction,
  s.claim_expires_at,
  s.last_error_code,
  s.version,
  s.updated_at
FROM app.campaign_iteration_states s
JOIN app.campaigns c ON c.id = s.campaign_id
WHERE false;

-- La contrainte historique traitait NULL comme toujours distinct et permettait
-- donc plusieurs attributions « séquence entière » au même prospect.
CREATE UNIQUE INDEX IF NOT EXISTS experiment_assignments_stable_context_uq
  ON app.experiment_assignments (experiment_id, prospect_id, assigned_for_step)
  NULLS NOT DISTINCT;

CREATE TABLE IF NOT EXISTS app.prospect_iteration_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES app.campaigns(id) ON DELETE CASCADE,
  prospect_id uuid NOT NULL REFERENCES app.prospects(id) ON DELETE CASCADE,
  experiment_assignment_id uuid REFERENCES app.experiment_assignments(id) ON DELETE RESTRICT,
  experiment_id uuid REFERENCES app.experiments(id) ON DELETE RESTRICT,
  variant_id uuid REFERENCES app.experiment_variants(id) ON DELETE RESTRICT,
  configuration_hash text NOT NULL CHECK (configuration_hash ~ '^[a-f0-9]{32}$'),
  iteration_instructions text[] NOT NULL CHECK (cardinality(iteration_instructions) BETWEEN 1 AND 10),
  total_iterations smallint NOT NULL CHECK (total_iterations BETWEEN 1 AND 10),
  completed_iterations smallint NOT NULL DEFAULT 0 CHECK (completed_iterations >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','completed','cancelled')),
  claimed_iteration_run_id uuid,
  claimed_iteration smallint,
  claim_expires_at timestamptz,
  last_error_code text,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (completed_iterations <= total_iterations),
  CHECK ((experiment_assignment_id IS NULL) = (experiment_id IS NULL)),
  CHECK ((experiment_assignment_id IS NULL) = (variant_id IS NULL)),
  CHECK ((status = 'running') = (claimed_iteration_run_id IS NOT NULL)),
  CHECK ((status = 'running') = (claimed_iteration IS NOT NULL)),
  CHECK ((status = 'running') = (claim_expires_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS prospect_iteration_context_uq
  ON app.prospect_iteration_states (campaign_id, prospect_id, experiment_assignment_id)
  NULLS NOT DISTINCT;

CREATE TABLE IF NOT EXISTS app.prospect_iteration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_id uuid NOT NULL REFERENCES app.prospect_iteration_states(id) ON DELETE CASCADE,
  campaign_id uuid NOT NULL REFERENCES app.campaigns(id) ON DELETE CASCADE,
  prospect_id uuid NOT NULL REFERENCES app.prospects(id) ON DELETE CASCADE,
  experiment_assignment_id uuid REFERENCES app.experiment_assignments(id) ON DELETE RESTRICT,
  variant_id uuid REFERENCES app.experiment_variants(id) ON DELETE RESTRICT,
  configuration_hash text NOT NULL CHECK (configuration_hash ~ '^[a-f0-9]{32}$'),
  iteration_number smallint NOT NULL CHECK (iteration_number BETWEEN 1 AND 10),
  total_iterations smallint NOT NULL CHECK (total_iterations BETWEEN 1 AND 10),
  instruction text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','superseded')),
  agent_run_id uuid NOT NULL REFERENCES audit.agent_runs(id) ON DELETE RESTRICT,
  input_sequence jsonb NOT NULL CHECK (jsonb_typeof(input_sequence) = 'object'),
  output_sequence jsonb CHECK (output_sequence IS NULL OR jsonb_typeof(output_sequence) = 'object'),
  claim_idempotency_key text NOT NULL UNIQUE CHECK (length(claim_idempotency_key) BETWEEN 8 AND 200),
  completion_idempotency_key text UNIQUE CHECK (
    completion_idempotency_key IS NULL OR length(completion_idempotency_key) BETWEEN 8 AND 200
  ),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  error_code text,
  CHECK (iteration_number <= total_iterations),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((status = 'completed') = (output_sequence IS NOT NULL))
);

DO $prospect_claim_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'prospect_iteration_states_claim_fk'
      AND conrelid = 'app.prospect_iteration_states'::regclass
  ) THEN
    ALTER TABLE app.prospect_iteration_states
      ADD CONSTRAINT prospect_iteration_states_claim_fk
      FOREIGN KEY (claimed_iteration_run_id)
      REFERENCES app.prospect_iteration_runs(id)
      ON DELETE SET NULL
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END;
$prospect_claim_fk$;

CREATE UNIQUE INDEX IF NOT EXISTS prospect_iteration_one_pass_per_agent_run_uq
  ON app.prospect_iteration_runs (state_id, agent_run_id);
CREATE INDEX IF NOT EXISTS prospect_iteration_runs_state_idx
  ON app.prospect_iteration_runs (state_id, started_at DESC);
CREATE INDEX IF NOT EXISTS prospect_iteration_states_pending_idx
  ON app.prospect_iteration_states (status, updated_at)
  WHERE status IN ('pending','running');

CREATE OR REPLACE FUNCTION app.prevent_completed_prospect_iteration_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $immutable_prospect_iteration$
BEGIN
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'completed_prospect_iteration_is_immutable' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$immutable_prospect_iteration$;

DROP TRIGGER IF EXISTS immutable_completed_prospect_iteration ON app.prospect_iteration_runs;
CREATE TRIGGER immutable_completed_prospect_iteration
BEFORE UPDATE OR DELETE ON app.prospect_iteration_runs
FOR EACH ROW EXECUTE FUNCTION app.prevent_completed_prospect_iteration_mutation();

CREATE OR REPLACE FUNCTION app.valid_sequence_payload(p_sequence jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $valid_sequence$
DECLARE
  item_index integer;
BEGIN
  IF jsonb_typeof(p_sequence) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_sequence->'steps') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_sequence->'stepInstructions') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_sequence->'steps') <> 6
     OR jsonb_array_length(p_sequence->'stepInstructions') <> 6
     OR jsonb_typeof(p_sequence->'subject') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_sequence->'subjectInstructions') IS DISTINCT FROM 'string'
     OR length(p_sequence->>'subject') NOT BETWEEN 1 AND 998
     OR length(p_sequence->>'subjectInstructions') > 100000 THEN
    RETURN false;
  END IF;
  FOR item_index IN 0..5 LOOP
    IF jsonb_typeof(p_sequence->'steps'->item_index) IS DISTINCT FROM 'string'
       OR jsonb_typeof(p_sequence->'stepInstructions'->item_index) IS DISTINCT FROM 'string'
       OR length(btrim(coalesce((p_sequence->'steps')->>item_index, ''))) = 0
       OR length((p_sequence->'steps')->>item_index) > 100000
       OR length((p_sequence->'stepInstructions')->>item_index) > 100000 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$valid_sequence$;

CREATE OR REPLACE FUNCTION app.effective_variant_sequence(
  p_campaign_id uuid,
  p_variant_id uuid
)
RETURNS TABLE(
  sequence_payload jsonb,
  revision_instructions text[],
  configuration_hash text
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, app
AS $effective_variant_sequence$
DECLARE
  base_row record;
  variant_overrides jsonb := '{}'::jsonb;
  variant_version integer;
  candidate jsonb;
  group_value jsonb;
  group_name text;
  step_index integer;
  passes jsonb;
BEGIN
  SELECT * INTO base_row FROM app.current_campaign_sequence(p_campaign_id);
  IF base_row.sequence_payload IS NULL THEN
    RAISE EXCEPTION 'campaign_sequence_missing' USING ERRCODE = 'P0001';
  END IF;
  sequence_payload := base_row.sequence_payload;

  IF p_variant_id IS NOT NULL THEN
    SELECT v.overrides, v.version
      INTO variant_overrides, variant_version
    FROM app.experiment_variants v
    JOIN app.experiments e ON e.id = v.experiment_id
    WHERE v.id = p_variant_id AND e.campaign_id = p_campaign_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'variant_not_in_campaign' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  candidate := variant_overrides #> '{subject,subject}';
  IF jsonb_typeof(candidate) = 'string' THEN
    sequence_payload := jsonb_set(sequence_payload, '{subject}', candidate, false);
  END IF;
  candidate := variant_overrides #> '{subject,subjectInstructions}';
  IF jsonb_typeof(candidate) = 'string' THEN
    sequence_payload := jsonb_set(sequence_payload, '{subjectInstructions}', candidate, false);
  END IF;

  group_value := variant_overrides->'initial';
  candidate := group_value->'body';
  IF jsonb_typeof(candidate) = 'string' THEN
    sequence_payload := jsonb_set(sequence_payload, '{steps,0}', candidate, false);
  END IF;
  candidate := group_value->'bodyInstructions';
  IF jsonb_typeof(candidate) = 'string' THEN
    sequence_payload := jsonb_set(sequence_payload, '{stepInstructions,0}', candidate, false);
  END IF;

  FOR step_index IN 1..5 LOOP
    group_name := 'followup' || (step_index - 1)::text;
    group_value := variant_overrides->group_name;
    candidate := group_value->'body';
    IF jsonb_typeof(candidate) = 'string' THEN
      sequence_payload := jsonb_set(sequence_payload, ARRAY['steps', step_index::text], candidate, false);
    END IF;
    candidate := group_value->'instructions';
    IF jsonb_typeof(candidate) = 'string' THEN
      sequence_payload := jsonb_set(sequence_payload, ARRAY['stepInstructions', step_index::text], candidate, false);
    END IF;
  END LOOP;

  SELECT app.extract_campaign_iteration_instructions(c.ai_instructions)
    INTO revision_instructions
  FROM app.campaigns c
  WHERE c.id = p_campaign_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0001';
  END IF;

  passes := variant_overrides #> '{iterations,draftPasses}';
  IF jsonb_typeof(passes) = 'array'
     AND jsonb_array_length(passes) BETWEEN 1 AND 10
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(passes) pass
       WHERE jsonb_typeof(pass) <> 'string'
     ) THEN
    SELECT array_agg(value ORDER BY position)
      INTO revision_instructions
    FROM jsonb_array_elements_text(passes) WITH ORDINALITY AS item(value, position);
  END IF;

  configuration_hash := md5(
    sequence_payload::text || ':' || to_jsonb(revision_instructions)::text || ':' ||
    coalesce(p_variant_id::text, 'reference') || ':' || coalesce(variant_version::text, '0')
  );
  RETURN NEXT;
END;
$effective_variant_sequence$;

CREATE OR REPLACE VIEW agent_api.writing_settings
WITH (security_barrier = true)
AS
SELECT timezone, general_writing_instructions, version, updated_at
FROM app.settings
WHERE singleton;

CREATE OR REPLACE VIEW agent_api.prospect_iteration_progress
WITH (security_barrier = true)
AS
SELECT
  s.id AS iteration_state_id,
  s.campaign_id,
  s.prospect_id,
  s.experiment_assignment_id,
  s.experiment_id,
  s.variant_id,
  v.code AS variant_code,
  s.status,
  s.completed_iterations,
  s.total_iterations,
  CASE
    WHEN s.status = 'pending' THEN s.completed_iterations + 1
    WHEN s.status = 'running' THEN s.claimed_iteration
    ELSE NULL
  END AS current_iteration,
  s.claim_expires_at,
  s.last_error_code,
  s.version,
  s.updated_at,
  s.configuration_hash
FROM app.prospect_iteration_states s
LEFT JOIN app.experiment_variants v ON v.id = s.variant_id;

CREATE OR REPLACE VIEW agent_api.prospect_iteration_history
WITH (security_barrier = true)
AS
SELECT
  r.id AS iteration_run_id,
  r.state_id AS iteration_state_id,
  r.campaign_id,
  r.prospect_id,
  r.experiment_assignment_id,
  r.variant_id,
  v.code AS variant_code,
  r.iteration_number,
  r.total_iterations,
  r.instruction,
  r.status,
  r.agent_run_id,
  r.input_sequence,
  r.output_sequence,
  r.started_at,
  r.completed_at,
  r.error_code,
  r.configuration_hash
FROM app.prospect_iteration_runs r
LEFT JOIN app.experiment_variants v ON v.id = r.variant_id;

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
  IF NOT EXISTS (
    SELECT 1 FROM audit.agent_runs ar
    WHERE ar.id = p_run_id AND ar.agent_type = 'prospection' AND ar.status = 'running'
  ) THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO experiment_row
  FROM app.experiments e
  WHERE e.id = p_experiment_id AND e.status IN ('recruiting','threshold_reached')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'experiment_not_recruiting' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.campaign_prospects cp
    WHERE cp.campaign_id = experiment_row.campaign_id
      AND cp.prospect_id = p_prospect_id
      AND cp.state = 'reserved'
  ) THEN
    RAISE EXCEPTION 'prospect_not_reserved' USING ERRCODE = 'P0001';
  END IF;
  chosen_step := CASE WHEN experiment_row.scope = 'step' THEN experiment_row.target_step ELSE NULL END;

  -- Sérialise aussi par prospect : deux activations concurrentes doivent
  -- retrouver exactement la même attribution, y compris pour le scope NULL.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_experiment_id::text || ':' || p_prospect_id::text || ':' || coalesce(chosen_step::text, 'sequence'),
    95
  ));

  SELECT * INTO assignment_row
  FROM app.experiment_assignments a
  WHERE a.experiment_id = p_experiment_id
    AND a.prospect_id = p_prospect_id
    AND a.assigned_for_step IS NOT DISTINCT FROM chosen_step
  ORDER BY a.assigned_at
  LIMIT 1;
  IF NOT FOUND THEN
    assignment_row := app.assign_experiment_variant(
      p_experiment_id, p_prospect_id, chosen_step, p_idempotency_key
    );
  END IF;

  INSERT INTO app.experiment_events (
    experiment_id, variant_id, assignment_id, prospect_id,
    event_type, event_at, measured, confidence, source,
    idempotency_key, metadata
  ) VALUES (
    assignment_row.experiment_id, assignment_row.variant_id, assignment_row.id,
    assignment_row.prospect_id, 'assigned', assignment_row.assigned_at,
    true, 'confirmed', 'prospection_agent',
    'assignment:' || assignment_row.id::text,
    jsonb_build_object('runId', p_run_id)
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  INSERT INTO audit.event_log (
    actor_type, actor_id, correlation_id, event_type, entity_type, entity_id, metadata
  ) VALUES (
    'prospection_agent', p_run_id::text, p_run_id, 'experiment_variant_assigned',
    'prospect', p_prospect_id::text,
    jsonb_build_object('assignmentId', assignment_row.id,
                       'experimentId', assignment_row.experiment_id,
                       'variantId', assignment_row.variant_id,
                       'idempotencyKey', p_idempotency_key)
  );

  RETURN QUERY
  SELECT assignment_row.id, assignment_row.campaign_id,
         assignment_row.experiment_id, assignment_row.variant_id,
         v.code, assignment_row.assigned_for_step
  FROM app.experiment_variants v
  WHERE v.id = assignment_row.variant_id;
END;
$assign_prospect_variant$;

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
  effective_hash text;
  settings_version bigint;
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
  SELECT s.version INTO settings_version FROM app.settings s WHERE s.singleton;
  effective_hash := md5(
    effective_row.configuration_hash || ':' || prospect_row.version::text || ':' || settings_version::text
  );

  INSERT INTO app.prospect_iteration_states (
    campaign_id, prospect_id, experiment_assignment_id, experiment_id, variant_id,
    configuration_hash, iteration_instructions, total_iterations
  ) VALUES (
    p_campaign_id, p_prospect_id, assignment_row.id,
    assignment_row.experiment_id, assignment_row.variant_id,
    effective_hash, effective_row.revision_instructions,
    cardinality(effective_row.revision_instructions)
  ) ON CONFLICT DO NOTHING;

  SELECT * INTO state_row
  FROM app.prospect_iteration_states s
  WHERE s.campaign_id = p_campaign_id
    AND s.prospect_id = p_prospect_id
    AND s.experiment_assignment_id IS NOT DISTINCT FROM assignment_row.id
  FOR UPDATE;

  IF state_row.configuration_hash IS DISTINCT FROM effective_hash THEN
    UPDATE app.prospect_iteration_runs AS old_run
       SET status = 'superseded', error_code = 'configuration_changed'
     WHERE old_run.state_id = state_row.id AND old_run.status = 'running';
    UPDATE app.prospect_iteration_states AS changed_state
       SET configuration_hash = effective_hash,
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
    assignment_row.variant_id, effective_hash, next_iteration,
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

CREATE OR REPLACE FUNCTION agent_api.complete_prospect_iteration(
  p_iteration_run_id uuid,
  p_run_id uuid,
  p_sequence jsonb,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit
AS $complete_prospect_iteration$
DECLARE
  iteration_run app.prospect_iteration_runs%ROWTYPE;
  state_row app.prospect_iteration_states%ROWTYPE;
  clean_sequence jsonb;
  next_state text;
BEGIN
  IF length(coalesce(p_idempotency_key, '')) NOT BETWEEN 8 AND 200
     OR NOT app.valid_sequence_payload(p_sequence) THEN
    RAISE EXCEPTION 'invalid_prospect_iteration_sequence' USING ERRCODE = '22023';
  END IF;
  clean_sequence := jsonb_build_object(
    'subject', p_sequence->>'subject',
    'subjectInstructions', p_sequence->>'subjectInstructions',
    'steps', p_sequence->'steps',
    'stepInstructions', p_sequence->'stepInstructions'
  );

  SELECT * INTO iteration_run
  FROM app.prospect_iteration_runs r
  WHERE r.id = p_iteration_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prospect_iteration_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF iteration_run.agent_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'prospect_iteration_run_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF iteration_run.status = 'completed' THEN
    IF iteration_run.completion_idempotency_key IS DISTINCT FROM p_idempotency_key THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'iterationRunId', iteration_run.id,
      'iterationStateId', iteration_run.state_id,
      'iteration', iteration_run.iteration_number,
      'total', iteration_run.total_iterations,
      'status', 'completed',
      'alreadyCompleted', true
    );
  END IF;
  IF iteration_run.status <> 'running' THEN
    RAISE EXCEPTION 'prospect_iteration_not_running' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audit.agent_runs ar
    WHERE ar.id = p_run_id AND ar.agent_type = 'prospection' AND ar.status = 'running'
  ) THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO state_row
  FROM app.prospect_iteration_states s
  WHERE s.id = iteration_run.state_id
  FOR UPDATE;
  IF NOT FOUND
     OR state_row.configuration_hash IS DISTINCT FROM iteration_run.configuration_hash
     OR state_row.claimed_iteration_run_id IS DISTINCT FROM iteration_run.id
     OR state_row.status <> 'running' THEN
    RAISE EXCEPTION 'prospect_iteration_claim_lost' USING ERRCODE = 'P0001';
  END IF;

  UPDATE app.prospect_iteration_runs AS finished_run
     SET status = 'completed',
         output_sequence = clean_sequence,
         completion_idempotency_key = p_idempotency_key,
         completed_at = clock_timestamp(),
         error_code = NULL
   WHERE finished_run.id = iteration_run.id;

  next_state := CASE
    WHEN iteration_run.iteration_number >= iteration_run.total_iterations THEN 'completed'
    ELSE 'pending'
  END;
  UPDATE app.prospect_iteration_states AS advanced_state
     SET completed_iterations = iteration_run.iteration_number,
         status = next_state,
         claimed_iteration_run_id = NULL,
         claimed_iteration = NULL,
         claim_expires_at = NULL,
         last_error_code = NULL,
         version = version + 1,
         updated_at = clock_timestamp()
   WHERE advanced_state.id = state_row.id;

  INSERT INTO audit.event_log (
    actor_type, actor_id, correlation_id, event_type, entity_type, entity_id, metadata
  ) VALUES (
    'prospection_agent', p_run_id::text, p_run_id, 'prospect_iteration_completed',
    'prospect', iteration_run.prospect_id::text,
    jsonb_build_object('iterationRunId', iteration_run.id,
                       'iterationStateId', iteration_run.state_id,
                       'campaignId', iteration_run.campaign_id,
                       'variantId', iteration_run.variant_id,
                       'iteration', iteration_run.iteration_number,
                       'total', iteration_run.total_iterations,
                       'state', next_state,
                       'idempotencyKey', p_idempotency_key)
  );

  RETURN jsonb_build_object(
    'iterationRunId', iteration_run.id,
    'iterationStateId', iteration_run.state_id,
    'campaignId', iteration_run.campaign_id,
    'prospectId', iteration_run.prospect_id,
    'variantId', iteration_run.variant_id,
    'iteration', iteration_run.iteration_number,
    'total', iteration_run.total_iterations,
    'status', next_state,
    'alreadyCompleted', false
  );
END;
$complete_prospect_iteration$;

CREATE OR REPLACE FUNCTION agent_api.fail_prospect_iteration(
  p_iteration_run_id uuid,
  p_run_id uuid,
  p_error_code text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit
AS $fail_prospect_iteration$
DECLARE
  iteration_run app.prospect_iteration_runs%ROWTYPE;
  safe_error_code text := left(coalesce(nullif(btrim(p_error_code), ''), 'iteration_failed'), 180);
BEGIN
  SELECT * INTO iteration_run
  FROM app.prospect_iteration_runs r
  WHERE r.id = p_iteration_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'prospect_iteration_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF iteration_run.agent_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'prospect_iteration_run_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF iteration_run.status = 'failed' THEN RETURN; END IF;
  IF iteration_run.status <> 'running' THEN
    RAISE EXCEPTION 'prospect_iteration_not_running' USING ERRCODE = 'P0001';
  END IF;

  UPDATE app.prospect_iteration_runs AS failed_run
     SET status = 'failed', error_code = safe_error_code
   WHERE failed_run.id = iteration_run.id;
  UPDATE app.prospect_iteration_states AS released_state
     SET status = 'pending',
         claimed_iteration_run_id = NULL,
         claimed_iteration = NULL,
         claim_expires_at = NULL,
         last_error_code = safe_error_code,
         version = version + 1,
         updated_at = clock_timestamp()
   WHERE released_state.id = iteration_run.state_id
     AND released_state.claimed_iteration_run_id = iteration_run.id;

  INSERT INTO audit.event_log (
    actor_type, actor_id, correlation_id, event_type, entity_type, entity_id, metadata
  ) VALUES (
    'prospection_agent', p_run_id::text, p_run_id, 'prospect_iteration_failed',
    'prospect', iteration_run.prospect_id::text,
    jsonb_build_object('iterationRunId', iteration_run.id,
                       'iterationStateId', iteration_run.state_id,
                       'iteration', iteration_run.iteration_number,
                       'errorCode', safe_error_code)
  );
END;
$fail_prospect_iteration$;

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
  effective_row record;
  current_hash text;
  prospect_version bigint;
  settings_version bigint;
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

  SELECT * INTO effective_row
  FROM app.effective_variant_sequence(state_row.campaign_id, state_row.variant_id);
  SELECT p.version INTO prospect_version FROM app.prospects p WHERE p.id = state_row.prospect_id;
  SELECT s.version INTO settings_version FROM app.settings s WHERE s.singleton;
  current_hash := md5(
    effective_row.configuration_hash || ':' || prospect_version::text || ':' || settings_version::text
  );
  IF current_hash IS DISTINCT FROM state_row.configuration_hash THEN
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

REVOKE ALL ON TABLE app.prospect_iteration_states, app.prospect_iteration_runs
  FROM PUBLIC, prospection95_agent;
REVOKE INSERT, UPDATE, DELETE
  ON TABLE app.prospect_iteration_states, app.prospect_iteration_runs
  FROM prospection95_app;
GRANT SELECT
  ON TABLE app.prospect_iteration_states, app.prospect_iteration_runs
  TO prospection95_app;

REVOKE ALL ON FUNCTION app.prevent_completed_prospect_iteration_mutation(),
  app.valid_sequence_payload(jsonb),
  app.effective_variant_sequence(uuid,uuid)
  FROM PUBLIC, prospection95_agent;

REVOKE ALL ON TABLE agent_api.writing_settings,
  agent_api.prospect_iteration_progress,
  agent_api.prospect_iteration_history FROM PUBLIC;
GRANT SELECT ON TABLE agent_api.writing_settings,
  agent_api.prospect_iteration_progress,
  agent_api.prospect_iteration_history TO prospection95_agent;

REVOKE ALL ON FUNCTION agent_api.assign_prospect_variant(uuid,uuid,uuid,text),
  agent_api.claim_prospect_iteration(uuid,uuid,uuid,uuid,text),
  agent_api.complete_prospect_iteration(uuid,uuid,jsonb,text),
  agent_api.fail_prospect_iteration(uuid,uuid,text),
  agent_api.propose_completed_sequence(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_api.assign_prospect_variant(uuid,uuid,uuid,text),
  agent_api.claim_prospect_iteration(uuid,uuid,uuid,uuid,text),
  agent_api.complete_prospect_iteration(uuid,uuid,jsonb,text),
  agent_api.fail_prospect_iteration(uuid,uuid,text),
  agent_api.propose_completed_sequence(uuid,uuid,uuid,text) TO prospection95_agent;

REVOKE EXECUTE ON FUNCTION agent_api.propose_sequence(uuid,uuid,uuid,text,jsonb,uuid,text)
  FROM prospection95_agent;
REVOKE EXECUTE ON FUNCTION agent_api.claim_campaign_iteration(uuid,uuid,text),
  agent_api.complete_campaign_iteration(uuid,uuid,jsonb,text),
  agent_api.fail_campaign_iteration(uuid,uuid,text)
  FROM prospection95_agent;

-- Le login runtime est créé par l'infrastructure Neon, pas par le schéma.
-- Sur une installation neuve qui ne l'a pas encore, la migration reste rejouable.
DO $runtime_agent_membership$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prospection95_runtime') THEN
    REVOKE EXECUTE ON FUNCTION agent_api.propose_sequence(uuid,uuid,uuid,text,jsonb,uuid,text)
      FROM prospection95_runtime;
    REVOKE EXECUTE ON FUNCTION agent_api.claim_campaign_iteration(uuid,uuid,text),
      agent_api.complete_campaign_iteration(uuid,uuid,jsonb,text),
      agent_api.fail_campaign_iteration(uuid,uuid,text)
      FROM prospection95_runtime;
    GRANT prospection95_agent TO prospection95_runtime;
  END IF;
END;
$runtime_agent_membership$;

INSERT INTO app.schema_migrations (version)
VALUES ('019_prospect_variant_iteration_workflow')
ON CONFLICT (version) DO NOTHING;
