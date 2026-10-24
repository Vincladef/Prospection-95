-- Prospection 95 · révisions de campagne persistantes, séquentielles et auditables.
-- Une activation planifiée traite au plus une passe par campagne. Les versions
-- intermédiaires restent archivées et aucun prospect n'est exposé avant la fin.

CREATE OR REPLACE FUNCTION app.extract_campaign_iteration_instructions(p_instructions text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $extract_iterations$
DECLARE
  marker constant text := '<!-- prospection-95:writing-iterations:v1 -->';
  line text;
  lines text[];
  result text[] := '{}'::text[];
  current_instruction text;
  expected_number integer := 1;
  parsed_number integer;
BEGIN
  IF NOT starts_with(coalesce(p_instructions, ''), marker) THEN
    RETURN ARRAY[coalesce(p_instructions, '')];
  END IF;

  lines := regexp_split_to_array(replace(coalesce(p_instructions, ''), E'\r\n', E'\n'), E'\n');
  FOREACH line IN ARRAY lines LOOP
    IF line = marker AND expected_number = 1 AND current_instruction IS NULL THEN
      CONTINUE;
    END IF;

    IF line ~ '^### Itération [0-9]+[[:space:]]*$' THEN
      parsed_number := substring(line FROM '^### Itération ([0-9]+)')::integer;
      IF parsed_number <> expected_number OR parsed_number > 10 THEN
        RETURN ARRAY[coalesce(p_instructions, '')];
      END IF;
      IF current_instruction IS NOT NULL THEN
        result := array_append(result, btrim(current_instruction, E' \t\n\r'));
      END IF;
      current_instruction := '';
      expected_number := expected_number + 1;
    ELSIF current_instruction IS NOT NULL THEN
      current_instruction := current_instruction
        || CASE WHEN current_instruction = '' THEN '' ELSE E'\n' END
        || line;
    ELSIF btrim(line) <> '' THEN
      RETURN ARRAY[coalesce(p_instructions, '')];
    END IF;
  END LOOP;

  IF current_instruction IS NOT NULL THEN
    result := array_append(result, btrim(current_instruction, E' \t\n\r'));
  END IF;

  IF coalesce(cardinality(result), 0) BETWEEN 1 AND 10 THEN
    RETURN result;
  END IF;
  RETURN ARRAY[coalesce(p_instructions, '')];
END;
$extract_iterations$;

CREATE TABLE IF NOT EXISTS app.campaign_iteration_states (
  campaign_id uuid PRIMARY KEY REFERENCES app.campaigns(id) ON DELETE CASCADE,
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
  CHECK ((status = 'running') = (claimed_iteration_run_id IS NOT NULL)),
  CHECK ((status = 'running') = (claimed_iteration IS NOT NULL)),
  CHECK ((status = 'running') = (claim_expires_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS app.campaign_iteration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES app.campaigns(id) ON DELETE CASCADE,
  configuration_hash text NOT NULL CHECK (configuration_hash ~ '^[a-f0-9]{32}$'),
  iteration_number smallint NOT NULL CHECK (iteration_number BETWEEN 1 AND 10),
  total_iterations smallint NOT NULL CHECK (total_iterations BETWEEN 1 AND 10),
  instruction text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','superseded')),
  agent_run_id uuid NOT NULL REFERENCES audit.agent_runs(id) ON DELETE RESTRICT,
  input_sequence jsonb NOT NULL CHECK (jsonb_typeof(input_sequence) = 'object'),
  output_sequence jsonb CHECK (output_sequence IS NULL OR jsonb_typeof(output_sequence) = 'object'),
  input_template_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  output_template_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
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

DO $claim_fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'campaign_iteration_states_claim_fk'
      AND conrelid = 'app.campaign_iteration_states'::regclass
  ) THEN
    ALTER TABLE app.campaign_iteration_states
      ADD CONSTRAINT campaign_iteration_states_claim_fk
      FOREIGN KEY (claimed_iteration_run_id)
      REFERENCES app.campaign_iteration_runs(id)
      ON DELETE SET NULL
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END;
$claim_fk$;

CREATE UNIQUE INDEX IF NOT EXISTS campaign_iteration_one_pass_per_agent_run_uq
  ON app.campaign_iteration_runs (campaign_id, agent_run_id);
CREATE INDEX IF NOT EXISTS campaign_iteration_runs_campaign_idx
  ON app.campaign_iteration_runs (campaign_id, started_at DESC);
CREATE INDEX IF NOT EXISTS campaign_iteration_states_pending_idx
  ON app.campaign_iteration_states (status, updated_at)
  WHERE status IN ('pending','running');

CREATE OR REPLACE FUNCTION app.prevent_completed_campaign_iteration_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $immutable_iteration$
BEGIN
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'completed_campaign_iteration_is_immutable' USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$immutable_iteration$;

DROP TRIGGER IF EXISTS immutable_completed_campaign_iteration ON app.campaign_iteration_runs;
CREATE TRIGGER immutable_completed_campaign_iteration
BEFORE UPDATE OR DELETE ON app.campaign_iteration_runs
FOR EACH ROW EXECUTE FUNCTION app.prevent_completed_campaign_iteration_mutation();

CREATE OR REPLACE FUNCTION app.sync_campaign_iteration_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $sync_iteration_state$
DECLARE
  parsed_instructions text[];
  next_hash text;
  current_state app.campaign_iteration_states%ROWTYPE;
  next_status text;
BEGIN
  parsed_instructions := app.extract_campaign_iteration_instructions(NEW.ai_instructions);
  next_hash := md5(coalesce(NEW.ai_instructions, ''));
  next_status := CASE WHEN NEW.status::text = 'archived' THEN 'cancelled' ELSE 'pending' END;

  SELECT * INTO current_state
  FROM app.campaign_iteration_states
  WHERE campaign_id = NEW.id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO app.campaign_iteration_states (
      campaign_id, configuration_hash, iteration_instructions,
      total_iterations, completed_iterations, status
    ) VALUES (
      NEW.id, next_hash, parsed_instructions,
      cardinality(parsed_instructions), 0, next_status
    );
    RETURN NEW;
  END IF;

  IF current_state.configuration_hash IS DISTINCT FROM next_hash THEN
    UPDATE app.campaign_iteration_runs
       SET status = 'superseded', error_code = 'configuration_changed'
     WHERE campaign_id = NEW.id AND status = 'running';

    UPDATE app.campaign_iteration_states
       SET configuration_hash = next_hash,
           iteration_instructions = parsed_instructions,
           total_iterations = cardinality(parsed_instructions),
           completed_iterations = 0,
           status = next_status,
           claimed_iteration_run_id = NULL,
           claimed_iteration = NULL,
           claim_expires_at = NULL,
           last_error_code = NULL,
           version = version + 1,
           updated_at = clock_timestamp()
     WHERE campaign_id = NEW.id;
  ELSIF NEW.status::text = 'archived' THEN
    UPDATE app.campaign_iteration_runs
       SET status = 'superseded', error_code = 'campaign_archived'
     WHERE campaign_id = NEW.id AND status = 'running';

    UPDATE app.campaign_iteration_states
       SET status = 'cancelled',
           claimed_iteration_run_id = NULL,
           claimed_iteration = NULL,
           claim_expires_at = NULL,
           version = version + 1,
           updated_at = clock_timestamp()
     WHERE campaign_id = NEW.id AND status <> 'cancelled';
  ELSIF current_state.status = 'cancelled' THEN
    UPDATE app.campaign_iteration_states
       SET status = CASE
             WHEN completed_iterations >= total_iterations THEN 'completed'
             ELSE 'pending'
           END,
           version = version + 1,
           updated_at = clock_timestamp()
     WHERE campaign_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$sync_iteration_state$;

DROP TRIGGER IF EXISTS sync_campaign_iteration_state ON app.campaigns;
CREATE TRIGGER sync_campaign_iteration_state
AFTER INSERT OR UPDATE OF ai_instructions, status ON app.campaigns
FOR EACH ROW EXECUTE FUNCTION app.sync_campaign_iteration_state();

INSERT INTO app.campaign_iteration_states (
  campaign_id, configuration_hash, iteration_instructions,
  total_iterations, completed_iterations, status
)
SELECT
  c.id,
  md5(coalesce(c.ai_instructions, '')),
  app.extract_campaign_iteration_instructions(c.ai_instructions),
  cardinality(app.extract_campaign_iteration_instructions(c.ai_instructions)),
  0,
  CASE WHEN c.status = 'archived' THEN 'cancelled' ELSE 'pending' END
FROM app.campaigns c
ON CONFLICT (campaign_id) DO NOTHING;

CREATE OR REPLACE FUNCTION app.current_campaign_sequence(p_campaign_id uuid)
RETURNS TABLE(sequence_payload jsonb, template_ids uuid[])
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, app
AS $current_sequence$
DECLARE
  step_names app.sequence_step[] := ARRAY['J0','R1','R2','R3','R4','R5']::app.sequence_step[];
  step_name app.sequence_step;
  template_row app.message_templates%ROWTYPE;
  bodies jsonb := '[]'::jsonb;
  instructions jsonb := '[]'::jsonb;
  parsed_initial jsonb;
  subject_value text := '';
  subject_instruction text := '';
  body_instruction text;
BEGIN
  template_ids := '{}'::uuid[];
  FOREACH step_name IN ARRAY step_names LOOP
    SELECT * INTO template_row
    FROM app.message_templates t
    WHERE t.campaign_id = p_campaign_id
      AND t.step = step_name
      AND t.iteration = 1
    ORDER BY t.version DESC, t.created_at DESC
    LIMIT 1;

    template_ids := array_append(template_ids, template_row.id);
    bodies := bodies || jsonb_build_array(coalesce(template_row.body, ''));
    body_instruction := coalesce(template_row.instructions, '');

    IF step_name = 'J0'::app.sequence_step THEN
      subject_value := coalesce(template_row.subject, '');
      BEGIN
        parsed_initial := template_row.instructions::jsonb;
        IF jsonb_typeof(parsed_initial) = 'object' THEN
          subject_instruction := coalesce(parsed_initial->>'subject', '');
          body_instruction := coalesce(parsed_initial->>'body', '');
        END IF;
      EXCEPTION WHEN OTHERS THEN
        subject_instruction := '';
        body_instruction := coalesce(template_row.instructions, '');
      END;
    END IF;

    instructions := instructions || jsonb_build_array(body_instruction);
  END LOOP;

  sequence_payload := jsonb_build_object(
    'subject', subject_value,
    'subjectInstructions', subject_instruction,
    'steps', bodies,
    'stepInstructions', instructions
  );
  RETURN NEXT;
END;
$current_sequence$;

CREATE OR REPLACE VIEW agent_api.pending_campaign_iterations
WITH (security_barrier = true)
AS
SELECT
  s.campaign_id,
  c.name AS campaign_name,
  s.status,
  s.completed_iterations,
  s.total_iterations,
  CASE
    WHEN s.status = 'pending' THEN s.completed_iterations + 1
    WHEN s.status = 'running' THEN s.claimed_iteration
    ELSE NULL
  END AS current_iteration,
  CASE
    WHEN s.status = 'pending' THEN s.iteration_instructions[s.completed_iterations + 1]
    ELSE NULL
  END AS next_instruction,
  s.claim_expires_at,
  s.last_error_code,
  s.version,
  s.updated_at
FROM app.campaign_iteration_states s
JOIN app.campaigns c ON c.id = s.campaign_id
WHERE c.status = 'active'
  AND c.archived_at IS NULL
  AND NOT c.imported_disabled
  AND s.status IN ('pending','running');

CREATE OR REPLACE VIEW agent_api.campaign_iteration_history
WITH (security_barrier = true)
AS
SELECT
  r.id AS iteration_run_id,
  r.campaign_id,
  r.iteration_number,
  r.total_iterations,
  r.instruction,
  r.status,
  r.agent_run_id,
  r.input_sequence,
  r.output_sequence,
  r.started_at,
  r.completed_at,
  r.error_code
FROM app.campaign_iteration_runs r;

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
  c.updated_at,
  CASE
    WHEN c.sender_strategy = 'fixed' THEN ARRAY[c.fixed_sender_account_id]::uuid[]
    ELSE coalesce((
      SELECT array_agg(csa.account_id ORDER BY csa.account_id)
      FROM app.campaign_sender_accounts csa
      JOIN app.gmail_accounts a ON a.id = csa.account_id
      WHERE csa.campaign_id = c.id AND csa.enabled
        AND a.status = 'active' AND a.paused_at IS NULL AND a.deleted_at IS NULL
    ), '{}'::uuid[])
  END AS allowed_sender_account_ids,
  s.status AS writing_iteration_status,
  coalesce(s.completed_iterations, 0) AS writing_iterations_completed,
  coalesce(s.total_iterations, 1) AS writing_iterations_total
FROM app.campaigns c
LEFT JOIN app.campaign_iteration_states s ON s.campaign_id = c.id
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
JOIN app.campaign_iteration_states iteration_state
  ON iteration_state.campaign_id = c.id
 AND iteration_state.status = 'completed'
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

CREATE OR REPLACE FUNCTION agent_api.claim_campaign_iteration(
  p_campaign_id uuid,
  p_run_id uuid,
  p_idempotency_key text
)
RETURNS TABLE(
  iteration_run_id uuid,
  campaign_id uuid,
  iteration_number smallint,
  total_iterations smallint,
  instruction text,
  input_sequence jsonb,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit
AS $claim_iteration$
DECLARE
  campaign_row app.campaigns%ROWTYPE;
  state_row app.campaign_iteration_states%ROWTYPE;
  existing_run app.campaign_iteration_runs%ROWTYPE;
  sequence_row record;
  next_iteration smallint;
  created_run app.campaign_iteration_runs%ROWTYPE;
BEGIN
  IF length(coalesce(p_idempotency_key, '')) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO existing_run
  FROM app.campaign_iteration_runs r
  WHERE r.claim_idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing_run.campaign_id IS DISTINCT FROM p_campaign_id
       OR existing_run.agent_run_id IS DISTINCT FROM p_run_id THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN QUERY SELECT
      existing_run.id, existing_run.campaign_id, existing_run.iteration_number,
      existing_run.total_iterations, existing_run.instruction,
      existing_run.input_sequence, existing_run.status;
    RETURN;
  END IF;

  SELECT * INTO existing_run
  FROM app.campaign_iteration_runs r
  WHERE r.campaign_id = p_campaign_id AND r.agent_run_id = p_run_id;
  IF FOUND THEN
    RETURN QUERY SELECT
      existing_run.id, existing_run.campaign_id, existing_run.iteration_number,
      existing_run.total_iterations, existing_run.instruction,
      existing_run.input_sequence, existing_run.status;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM audit.agent_runs ar
    WHERE ar.id = p_run_id AND ar.agent_type = 'prospection' AND ar.status = 'running'
  ) THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO campaign_row
  FROM app.campaigns c
  WHERE c.id = p_campaign_id
  FOR UPDATE;
  IF NOT FOUND OR campaign_row.status <> 'active' OR campaign_row.archived_at IS NOT NULL
     OR campaign_row.imported_disabled THEN
    RAISE EXCEPTION 'campaign_not_active' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO state_row
  FROM app.campaign_iteration_states s
  WHERE s.campaign_id = p_campaign_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign_iteration_state_missing' USING ERRCODE = 'P0001';
  END IF;

  IF state_row.status = 'completed' THEN
    RAISE EXCEPTION 'campaign_iterations_completed' USING ERRCODE = 'P0001';
  END IF;
  IF state_row.status = 'cancelled' THEN
    RAISE EXCEPTION 'campaign_iterations_cancelled' USING ERRCODE = 'P0001';
  END IF;
  IF state_row.status = 'running' AND state_row.claim_expires_at > clock_timestamp() THEN
    RAISE EXCEPTION 'campaign_iteration_busy' USING ERRCODE = 'P0001';
  END IF;

  IF state_row.status = 'running' THEN
    UPDATE app.campaign_iteration_runs AS expired_run
       SET status = 'failed', error_code = 'claim_expired'
     WHERE expired_run.id = state_row.claimed_iteration_run_id
       AND expired_run.status = 'running';
  END IF;

  next_iteration := state_row.completed_iterations + 1;
  SELECT * INTO sequence_row FROM app.current_campaign_sequence(p_campaign_id);

  INSERT INTO app.campaign_iteration_runs (
    campaign_id, configuration_hash, iteration_number, total_iterations,
    instruction, agent_run_id, input_sequence, input_template_ids,
    claim_idempotency_key
  ) VALUES (
    p_campaign_id, state_row.configuration_hash, next_iteration,
    state_row.total_iterations, state_row.iteration_instructions[next_iteration],
    p_run_id, sequence_row.sequence_payload, sequence_row.template_ids,
    p_idempotency_key
  ) RETURNING * INTO created_run;

  UPDATE app.campaign_iteration_states AS claimed_state
     SET status = 'running',
         claimed_iteration_run_id = created_run.id,
         claimed_iteration = next_iteration,
         claim_expires_at = clock_timestamp() + interval '2 hours',
         last_error_code = NULL,
         version = version + 1,
         updated_at = clock_timestamp()
   WHERE claimed_state.campaign_id = p_campaign_id;

  INSERT INTO audit.event_log (
    actor_type, actor_id, correlation_id, event_type, entity_type, entity_id, metadata
  ) VALUES (
    'prospection_agent', p_run_id::text, p_run_id, 'campaign_iteration_claimed',
    'campaign', p_campaign_id::text,
    jsonb_build_object('iterationRunId', created_run.id,
                       'iteration', next_iteration,
                       'total', state_row.total_iterations,
                       'idempotencyKey', p_idempotency_key)
  );

  RETURN QUERY SELECT
    created_run.id, created_run.campaign_id, created_run.iteration_number,
    created_run.total_iterations, created_run.instruction,
    created_run.input_sequence, created_run.status;
END;
$claim_iteration$;

CREATE OR REPLACE FUNCTION agent_api.complete_campaign_iteration(
  p_iteration_run_id uuid,
  p_run_id uuid,
  p_sequence jsonb,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit
AS $complete_iteration$
DECLARE
  iteration_run app.campaign_iteration_runs%ROWTYPE;
  campaign_row app.campaigns%ROWTYPE;
  state_row app.campaign_iteration_states%ROWTYPE;
  prior_template app.message_templates%ROWTYPE;
  new_template_id uuid;
  new_template_ids uuid[] := '{}'::uuid[];
  step_names app.sequence_step[] := ARRAY['J0','R1','R2','R3','R4','R5']::app.sequence_step[];
  step_index integer;
  subject_value text;
  body_value text;
  instruction_value text;
  next_state text;
  clean_sequence jsonb;
BEGIN
  IF length(coalesce(p_idempotency_key, '')) NOT BETWEEN 8 AND 200
     OR jsonb_typeof(p_sequence) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_sequence->'steps') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_sequence->'stepInstructions') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_sequence->'steps') <> 6
     OR jsonb_array_length(p_sequence->'stepInstructions') <> 6
     OR jsonb_typeof(p_sequence->'subject') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_sequence->'subjectInstructions') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'invalid_campaign_iteration_sequence' USING ERRCODE = '22023';
  END IF;

  subject_value := p_sequence->>'subject';
  IF length(subject_value) NOT BETWEEN 1 AND 998
     OR length(p_sequence->>'subjectInstructions') > 100000 THEN
    RAISE EXCEPTION 'invalid_campaign_iteration_sequence' USING ERRCODE = '22023';
  END IF;
  FOR step_index IN 0..5 LOOP
    IF jsonb_typeof(p_sequence->'steps'->step_index) IS DISTINCT FROM 'string'
       OR jsonb_typeof(p_sequence->'stepInstructions'->step_index) IS DISTINCT FROM 'string'
       OR length(btrim(coalesce((p_sequence->'steps')->>step_index, ''))) = 0
       OR length((p_sequence->'steps')->>step_index) > 100000
       OR length((p_sequence->'stepInstructions')->>step_index) > 100000 THEN
      RAISE EXCEPTION 'invalid_campaign_iteration_sequence' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  SELECT * INTO iteration_run
  FROM app.campaign_iteration_runs r
  WHERE r.id = p_iteration_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign_iteration_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF iteration_run.agent_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'campaign_iteration_run_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF iteration_run.status = 'completed' THEN
    IF iteration_run.completion_idempotency_key IS DISTINCT FROM p_idempotency_key THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505';
    END IF;
    RETURN jsonb_build_object(
      'iterationRunId', iteration_run.id,
      'campaignId', iteration_run.campaign_id,
      'iteration', iteration_run.iteration_number,
      'total', iteration_run.total_iterations,
      'status', 'completed',
      'alreadyCompleted', true
    );
  END IF;
  IF iteration_run.status <> 'running' THEN
    RAISE EXCEPTION 'campaign_iteration_not_running' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audit.agent_runs ar
    WHERE ar.id = p_run_id AND ar.agent_type = 'prospection' AND ar.status = 'running'
  ) THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO campaign_row
  FROM app.campaigns c
  WHERE c.id = iteration_run.campaign_id
  FOR UPDATE;
  IF NOT FOUND OR campaign_row.status <> 'active' OR campaign_row.archived_at IS NOT NULL
     OR campaign_row.imported_disabled THEN
    RAISE EXCEPTION 'campaign_not_active' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO state_row
  FROM app.campaign_iteration_states s
  WHERE s.campaign_id = iteration_run.campaign_id
  FOR UPDATE;
  IF NOT FOUND
     OR state_row.configuration_hash IS DISTINCT FROM iteration_run.configuration_hash
     OR state_row.claimed_iteration_run_id IS DISTINCT FROM iteration_run.id
     OR state_row.status <> 'running' THEN
    RAISE EXCEPTION 'campaign_iteration_claim_lost' USING ERRCODE = 'P0001';
  END IF;

  clean_sequence := jsonb_build_object(
    'subject', subject_value,
    'subjectInstructions', p_sequence->>'subjectInstructions',
    'steps', p_sequence->'steps',
    'stepInstructions', p_sequence->'stepInstructions'
  );

  FOR step_index IN 0..5 LOOP
    SELECT * INTO prior_template
    FROM app.message_templates t
    WHERE t.campaign_id = iteration_run.campaign_id
      AND t.step = step_names[step_index + 1]
      AND t.iteration = 1
    ORDER BY t.version DESC, t.created_at DESC
    LIMIT 1;

    body_value := (clean_sequence->'steps')->>step_index;
    instruction_value := CASE WHEN step_index = 0 THEN
      jsonb_build_object(
        'subject', clean_sequence->>'subjectInstructions',
        'body', (clean_sequence->'stepInstructions')->>step_index
      )::text
    ELSE (clean_sequence->'stepInstructions')->>step_index END;

    INSERT INTO app.message_templates (
      campaign_id, step, iteration, version, subject, body, instructions,
      supersedes_id, created_by
    ) VALUES (
      iteration_run.campaign_id, step_names[step_index + 1], 1,
      coalesce(prior_template.version, 0) + 1,
      subject_value, body_value, instruction_value, prior_template.id,
      'prospection_agent_iteration_' || iteration_run.iteration_number::text
    ) RETURNING id INTO new_template_id;
    new_template_ids := array_append(new_template_ids, new_template_id);
  END LOOP;

  UPDATE app.campaign_iteration_runs
     SET status = 'completed',
         output_sequence = clean_sequence,
         output_template_ids = new_template_ids,
         completion_idempotency_key = p_idempotency_key,
         completed_at = clock_timestamp(),
         error_code = NULL
   WHERE id = iteration_run.id;

  next_state := CASE
    WHEN iteration_run.iteration_number >= iteration_run.total_iterations THEN 'completed'
    ELSE 'pending'
  END;
  UPDATE app.campaign_iteration_states
     SET completed_iterations = iteration_run.iteration_number,
         status = next_state,
         claimed_iteration_run_id = NULL,
         claimed_iteration = NULL,
         claim_expires_at = NULL,
         last_error_code = NULL,
         version = version + 1,
         updated_at = clock_timestamp()
   WHERE campaign_id = iteration_run.campaign_id;

  UPDATE app.campaigns
     SET version = version + 1, updated_at = clock_timestamp()
   WHERE id = iteration_run.campaign_id;

  INSERT INTO audit.event_log (
    actor_type, actor_id, correlation_id, event_type, entity_type, entity_id, metadata
  ) VALUES (
    'prospection_agent', p_run_id::text, p_run_id, 'campaign_iteration_completed',
    'campaign', iteration_run.campaign_id::text,
    jsonb_build_object('iterationRunId', iteration_run.id,
                       'iteration', iteration_run.iteration_number,
                       'total', iteration_run.total_iterations,
                       'state', next_state,
                       'idempotencyKey', p_idempotency_key)
  );

  RETURN jsonb_build_object(
    'iterationRunId', iteration_run.id,
    'campaignId', iteration_run.campaign_id,
    'iteration', iteration_run.iteration_number,
    'total', iteration_run.total_iterations,
    'status', next_state,
    'alreadyCompleted', false
  );
END;
$complete_iteration$;

CREATE OR REPLACE FUNCTION agent_api.fail_campaign_iteration(
  p_iteration_run_id uuid,
  p_run_id uuid,
  p_error_code text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit
AS $fail_iteration$
DECLARE
  iteration_run app.campaign_iteration_runs%ROWTYPE;
  safe_error_code text := left(coalesce(nullif(btrim(p_error_code), ''), 'iteration_failed'), 180);
BEGIN
  SELECT * INTO iteration_run
  FROM app.campaign_iteration_runs r
  WHERE r.id = p_iteration_run_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign_iteration_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF iteration_run.agent_run_id IS DISTINCT FROM p_run_id THEN
    RAISE EXCEPTION 'campaign_iteration_run_mismatch' USING ERRCODE = 'P0001';
  END IF;
  IF iteration_run.status = 'failed' THEN
    RETURN;
  END IF;
  IF iteration_run.status <> 'running' THEN
    RAISE EXCEPTION 'campaign_iteration_not_running' USING ERRCODE = 'P0001';
  END IF;

  UPDATE app.campaign_iteration_runs
     SET status = 'failed', error_code = safe_error_code
   WHERE id = iteration_run.id;

  UPDATE app.campaign_iteration_states
     SET status = 'pending',
         claimed_iteration_run_id = NULL,
         claimed_iteration = NULL,
         claim_expires_at = NULL,
         last_error_code = safe_error_code,
         version = version + 1,
         updated_at = clock_timestamp()
   WHERE campaign_id = iteration_run.campaign_id
     AND claimed_iteration_run_id = iteration_run.id;

  INSERT INTO audit.event_log (
    actor_type, actor_id, correlation_id, event_type, entity_type, entity_id, metadata
  ) VALUES (
    'prospection_agent', p_run_id::text, p_run_id, 'campaign_iteration_failed',
    'campaign', iteration_run.campaign_id::text,
    jsonb_build_object('iterationRunId', iteration_run.id,
                       'iteration', iteration_run.iteration_number,
                       'errorCode', safe_error_code)
  );
END;
$fail_iteration$;

REVOKE ALL ON TABLE app.campaign_iteration_states, app.campaign_iteration_runs
  FROM PUBLIC, prospection95_agent;
REVOKE INSERT, UPDATE, DELETE
  ON TABLE app.campaign_iteration_states, app.campaign_iteration_runs
  FROM prospection95_app;
GRANT SELECT
  ON TABLE app.campaign_iteration_states, app.campaign_iteration_runs
  TO prospection95_app;

REVOKE ALL ON FUNCTION app.extract_campaign_iteration_instructions(text)
  FROM PUBLIC, prospection95_agent;
REVOKE ALL ON FUNCTION app.prevent_completed_campaign_iteration_mutation()
  FROM PUBLIC, prospection95_agent;
REVOKE ALL ON FUNCTION app.sync_campaign_iteration_state()
  FROM PUBLIC, prospection95_agent;
REVOKE ALL ON FUNCTION app.current_campaign_sequence(uuid)
  FROM PUBLIC, prospection95_agent;
GRANT EXECUTE ON FUNCTION app.extract_campaign_iteration_instructions(text),
  app.current_campaign_sequence(uuid) TO prospection95_app;

REVOKE ALL ON TABLE agent_api.pending_campaign_iterations,
  agent_api.campaign_iteration_history FROM PUBLIC;
GRANT SELECT ON TABLE agent_api.pending_campaign_iterations,
  agent_api.campaign_iteration_history TO prospection95_agent;

REVOKE ALL ON FUNCTION agent_api.claim_campaign_iteration(uuid,uuid,text),
  agent_api.complete_campaign_iteration(uuid,uuid,jsonb,text),
  agent_api.fail_campaign_iteration(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_api.claim_campaign_iteration(uuid,uuid,text),
  agent_api.complete_campaign_iteration(uuid,uuid,jsonb,text),
  agent_api.fail_campaign_iteration(uuid,uuid,text) TO prospection95_agent;

INSERT INTO app.schema_migrations (version)
VALUES
  ('015_crm_plugin_contract'),
  ('016_crm_campaign_update'),
  ('017_crm_campaign_ai_instructions'),
  ('018_campaign_iteration_workflow')
ON CONFLICT (version) DO NOTHING;
