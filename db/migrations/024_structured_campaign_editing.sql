-- Prospection 95 · structured writing passes and unrestricted, versioned CRM editing.
-- Campaign and experiment history is preserved; already-started prospect work keeps
-- the exact snapshot it began with.

ALTER TABLE app.campaigns
  ADD COLUMN IF NOT EXISTS writing_iteration_instructions text[];

UPDATE app.campaigns
SET writing_iteration_instructions = app.extract_campaign_iteration_instructions(ai_instructions)
WHERE writing_iteration_instructions IS NULL;

ALTER TABLE app.campaigns
  ALTER COLUMN writing_iteration_instructions SET DEFAULT ARRAY['']::text[],
  ALTER COLUMN writing_iteration_instructions SET NOT NULL;

DO $writing_iterations_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'campaigns_writing_iterations_check'
      AND conrelid = 'app.campaigns'::regclass
  ) THEN
    ALTER TABLE app.campaigns
      ADD CONSTRAINT campaigns_writing_iterations_check
      CHECK (cardinality(writing_iteration_instructions) BETWEEN 1 AND 10);
  END IF;
END;
$writing_iterations_constraint$;

-- Before v24 this field was exclusively the iteration editor. Clear it once,
-- after its content has been copied, so agents do not receive the same pass as
-- both common guidance and the current pass. Re-applying v24 preserves any new
-- common guidance written after the migration.
UPDATE app.campaigns
SET ai_instructions = ''
WHERE NOT EXISTS (
  SELECT 1 FROM app.schema_migrations WHERE version='024_structured_campaign_editing'
);

ALTER TABLE app.experiments
  ADD COLUMN IF NOT EXISTS supersedes_id uuid REFERENCES app.experiments(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);

CREATE OR REPLACE FUNCTION app.effective_variant_sequence(
  p_campaign_id uuid,
  p_variant_id uuid
)
RETURNS TABLE(sequence_payload jsonb, revision_instructions text[], configuration_hash text)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, app
AS $effective_variant_sequence$
DECLARE
  base_row record;
  campaign_iterations text[];
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

  SELECT c.writing_iteration_instructions INTO campaign_iterations
  FROM app.campaigns c WHERE c.id = p_campaign_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'campaign_not_found' USING ERRCODE = 'P0001'; END IF;
  revision_instructions := campaign_iterations;

  IF p_variant_id IS NOT NULL THEN
    SELECT v.overrides, v.version INTO variant_overrides, variant_version
    FROM app.experiment_variants v
    JOIN app.experiments e ON e.id = v.experiment_id
    WHERE v.id = p_variant_id AND e.campaign_id = p_campaign_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'variant_not_in_campaign' USING ERRCODE = 'P0001'; END IF;
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
  IF jsonb_typeof(candidate) = 'string' THEN sequence_payload := jsonb_set(sequence_payload, '{steps,0}', candidate, false); END IF;
  candidate := group_value->'bodyInstructions';
  IF jsonb_typeof(candidate) = 'string' THEN sequence_payload := jsonb_set(sequence_payload, '{stepInstructions,0}', candidate, false); END IF;

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

  passes := variant_overrides #> '{iterations,draftPasses}';
  IF jsonb_typeof(passes) = 'array'
     AND jsonb_array_length(passes) BETWEEN 1 AND 10
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(passes) pass WHERE jsonb_typeof(pass) <> 'string') THEN
    SELECT array_agg(value ORDER BY position) INTO revision_instructions
    FROM jsonb_array_elements_text(passes) WITH ORDINALITY AS item(value, position);
  END IF;

  configuration_hash := md5(
    sequence_payload::text || ':' || to_jsonb(revision_instructions)::text || ':' ||
    coalesce(p_variant_id::text, 'reference') || ':' || coalesce(variant_version::text, '0')
  );
  RETURN NEXT;
END;
$effective_variant_sequence$;

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
  frozen_hash text;
  effective_row record;
  writing_context jsonb;
  attachment_context jsonb;
BEGIN
  -- A started cycle is an immutable editorial snapshot. Campaign, attachment,
  -- prospect or A/B edits apply to future cycles and never reset completed work.
  SELECT s.writing_input_hash INTO frozen_hash
  FROM app.prospect_iteration_states s
  WHERE s.campaign_id = p_campaign_id
    AND s.prospect_id = p_prospect_id
    AND s.variant_id IS NOT DISTINCT FROM p_variant_id
    AND s.writing_input_hash IS NOT NULL
    AND (s.completed_iterations > 0 OR EXISTS (
      SELECT 1 FROM app.prospect_iteration_runs r WHERE r.state_id = s.id
    ))
  ORDER BY s.created_at DESC LIMIT 1;
  IF frozen_hash IS NOT NULL THEN RETURN frozen_hash; END IF;

  SELECT * INTO effective_row FROM app.effective_variant_sequence(p_campaign_id, p_variant_id);
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
             'fullName', p.full_name, 'jobTitle', p.job_title,
             'email', p.normalized_email, 'websiteUrl', p.website_url,
             'sourceLabel', p.source_label, 'sourceUrl', p.source_url,
             'sourceEvidence', p.source_evidence,
             'qualificationScore', p.qualification_score,
             'qualificationReason', p.qualification_reason
           )
         ) INTO writing_context
  FROM app.campaigns c
  JOIN app.prospects p ON p.id = p_prospect_id
  CROSS JOIN app.settings settings
  WHERE c.id = p_campaign_id AND settings.singleton;
  IF writing_context IS NULL THEN
    RAISE EXCEPTION 'prospect_writing_context_missing' USING ERRCODE = 'P0001';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', attachment.id, 'scope', attachment.scope_type,
           'field', attachment.field_key, 'filename', attachment.filename,
           'contentType', attachment.content_type, 'size', attachment.size_bytes,
           'blob', attachment.blob_key, 'text', attachment.extracted_text
         ) ORDER BY attachment.scope_type, attachment.field_key,
                    attachment.created_at, attachment.id), '[]'::jsonb)
    INTO attachment_context
  FROM app.instruction_attachments attachment
  WHERE attachment.deleted_at IS NULL
    AND (attachment.scope_type = 'global' OR attachment.campaign_id = p_campaign_id)
    AND (attachment.scope_type = 'global' OR attachment.field_key !~ '^variant:' OR
         (p_variant_id IS NOT NULL AND attachment.field_key LIKE 'variant:' || p_variant_id::text || ':%'));

  RETURN md5(jsonb_build_object(
    'format', 'prospect-writing-input-v3',
    'effectiveSequenceHash', effective_row.configuration_hash,
    'context', writing_context,
    'attachments', attachment_context
  )::text);
END;
$prospect_writing_input_hash$;

CREATE OR REPLACE VIEW agent_api.campaign_parameters
WITH (security_barrier = true)
AS
SELECT
  c.id AS campaign_id, c.name, c.status, c.target_description,
  c.qualification_criteria, c.daily_new_contact_goal, c.validation_policy,
  c.sender_strategy, c.fixed_sender_account_id, c.ai_instructions,
  c.reply_instructions,
  c.tracking_opens_enabled, c.tracking_clicks_enabled,
  c.experiment_policy, c.next_test_instructions, c.version, c.updated_at,
  CASE WHEN c.sender_strategy = 'fixed' THEN ARRAY[c.fixed_sender_account_id]::uuid[]
       ELSE coalesce((SELECT array_agg(csa.account_id ORDER BY csa.account_id)
         FROM app.campaign_sender_accounts csa JOIN app.gmail_accounts a ON a.id=csa.account_id
         WHERE csa.campaign_id=c.id AND csa.enabled AND a.status='active'
           AND a.paused_at IS NULL AND a.deleted_at IS NULL), '{}'::uuid[]) END
    AS allowed_sender_account_ids,
  s.status AS writing_iteration_status,
  coalesce(s.completed_iterations,0) AS writing_iterations_completed,
  coalesce(s.total_iterations,cardinality(c.writing_iteration_instructions)) AS writing_iterations_total,
  c.writing_iteration_instructions
FROM app.campaigns c
LEFT JOIN app.campaign_iteration_states s ON s.campaign_id=c.id
WHERE c.archived_at IS NULL;

CREATE OR REPLACE VIEW crm_api.campaigns
WITH (security_barrier = true)
AS
SELECT c.id AS campaign_id, c.folder_id, c.name, c.status, c.target_description,
       c.daily_new_contact_goal, c.validation_policy, c.sender_strategy,
       c.fixed_sender_account_id, c.ai_instructions, c.writing_iteration_instructions,
       c.reply_instructions, c.tracking_opens_enabled, c.tracking_clicks_enabled,
       c.experiment_policy, c.next_test_instructions, c.version, c.updated_at,
       coalesce((SELECT array_agg(a.account_id ORDER BY a.account_id)
                 FROM app.campaign_sender_accounts a
                 WHERE a.campaign_id=c.id AND a.enabled), '{}'::uuid[]) AS sender_account_ids
FROM app.campaigns c;

CREATE OR REPLACE VIEW crm_api.campaign_sequences
WITH (security_barrier = true)
AS
SELECT c.id AS campaign_id, s.sequence_payload, c.version AS campaign_version
FROM app.campaigns c CROSS JOIN LATERAL app.current_campaign_sequence(c.id) s;

CREATE OR REPLACE VIEW crm_api.experiments
WITH (security_barrier = true)
AS
SELECT e.id AS experiment_id, e.campaign_id, e.supersedes_id, e.revision,
       e.name, e.status, e.scope, e.target_step, e.comparable_population,
       e.allocation_method, e.primary_metric, e.contacts_per_variant_threshold,
       e.total_responses_threshold, e.maturity_delay, e.decision, e.limitations,
       e.created_at, e.updated_at
FROM app.experiments e;

CREATE OR REPLACE VIEW crm_api.experiment_variants
WITH (security_barrier = true)
AS
SELECT v.id AS variant_id, v.experiment_id, v.code, v.name, v.weight,
       v.overrides, v.version, v.exposed_at
FROM app.experiment_variants v;

GRANT SELECT ON crm_api.campaigns, crm_api.campaign_sequences,
  crm_api.experiments, crm_api.experiment_variants TO prospection95_crm;

CREATE OR REPLACE FUNCTION crm_api.crm_campaign_create_v2(p_payload jsonb, p_idempotency_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $crm_campaign_create_v2$
DECLARE
  passes jsonb;
  result jsonb;
  campaign_uuid uuid;
BEGIN
  passes := p_payload #> '{campaign,writingIterations}';
  IF jsonb_typeof(passes) IS DISTINCT FROM 'array'
     OR jsonb_array_length(passes) NOT BETWEEN 1 AND 10
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(passes) x WHERE jsonb_typeof(x) <> 'string') THEN
    RAISE EXCEPTION 'crm_invalid_writing_iterations';
  END IF;
  result := crm_api.crm_campaign_create(p_payload, p_idempotency_key);
  campaign_uuid := (result->>'campaignId')::uuid;
  UPDATE app.campaigns c SET writing_iteration_instructions = p.values
  FROM (SELECT array_agg(value ORDER BY position) AS values
        FROM jsonb_array_elements_text(passes) WITH ORDINALITY x(value,position)) p
  WHERE c.id = campaign_uuid;
  RETURN result || jsonb_build_object('writingIterations', jsonb_array_length(passes));
END;
$crm_campaign_create_v2$;

CREATE OR REPLACE FUNCTION crm_api.crm_campaign_update(
  p_campaign_id uuid, p_expected_version bigint, p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $crm_campaign_update$
DECLARE
  c app.campaigns%ROWTYPE;
  s jsonb;
  passes jsonb;
  pass_values text[];
  st text;
  old_t app.message_templates%ROWTYPE;
  new_body text;
  new_instr text;
  new_subject text;
  i integer;
  changed integer := 0;
  f text;
  fields text[] := ARRAY['J0','R1','R2','R3','R4','R5'];
  sender_ids uuid[];
BEGIN
  IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR p_patch='{}'::jsonb
     OR length(p_patch::text)>1000000 THEN RAISE EXCEPTION 'crm_invalid_patch'; END IF;
  SELECT * INTO c FROM app.campaigns WHERE id=p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'crm_campaign_not_found'; END IF;
  IF c.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'crm_version_conflict: %',c.version; END IF;
  FOR f IN SELECT jsonb_object_keys(p_patch) LOOP
    IF f NOT IN ('name','status','folderId','targetDescription','dailyNewContactGoal',
      'validationPolicy','senderStrategy','fixedSenderAccountId','senderAccountIds',
      'aiInstructions','writingIterations','replyInstructions','trackingOpensEnabled',
      'trackingClicksEnabled','experimentPolicy','nextTestInstructions','sequence') THEN
      RAISE EXCEPTION 'crm_unsupported_field: %',f;
    END IF;
  END LOOP;
  IF p_patch ? 'name' AND length(btrim(coalesce(p_patch->>'name',''))) NOT BETWEEN 1 AND 180 THEN RAISE EXCEPTION 'crm_invalid_name'; END IF;
  IF p_patch ? 'status' AND p_patch->>'status' NOT IN ('inactive','active','archived') THEN RAISE EXCEPTION 'crm_invalid_status'; END IF;
  IF p_patch ? 'validationPolicy' AND p_patch->>'validationPolicy' NOT IN ('manual','automatic') THEN RAISE EXCEPTION 'crm_invalid_validation_policy'; END IF;
  IF p_patch ? 'senderStrategy' AND p_patch->>'senderStrategy' NOT IN ('fixed','pool') THEN RAISE EXCEPTION 'crm_invalid_sender_strategy'; END IF;
  IF p_patch ? 'experimentPolicy' AND p_patch->>'experimentPolicy' NOT IN ('continue','stabilize') THEN RAISE EXCEPTION 'crm_invalid_experiment_policy'; END IF;
  IF p_patch ? 'dailyNewContactGoal' AND (p_patch->>'dailyNewContactGoal')::integer NOT BETWEEN 0 AND 10000 THEN RAISE EXCEPTION 'crm_invalid_daily_goal'; END IF;
  IF p_patch ? 'writingIterations' THEN
    passes := p_patch->'writingIterations';
    IF jsonb_typeof(passes) IS DISTINCT FROM 'array' OR jsonb_array_length(passes) NOT BETWEEN 1 AND 10
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(passes) x WHERE jsonb_typeof(x)<>'string') THEN
      RAISE EXCEPTION 'crm_invalid_writing_iterations';
    END IF;
    SELECT array_agg(value ORDER BY position) INTO pass_values
    FROM jsonb_array_elements_text(passes) WITH ORDINALITY x(value,position);
  END IF;
  IF p_patch ? 'sequence' THEN
    s:=p_patch->'sequence';
    IF jsonb_typeof(s)<>'object' OR jsonb_typeof(s->'steps')<>'array'
       OR jsonb_typeof(s->'stepInstructions')<>'array'
       OR jsonb_array_length(s->'steps')<>6 OR jsonb_array_length(s->'stepInstructions')<>6 THEN
      RAISE EXCEPTION 'crm_invalid_sequence';
    END IF;
  END IF;
  IF p_patch ? 'senderAccountIds' THEN
    IF jsonb_typeof(p_patch->'senderAccountIds')<>'array' OR jsonb_array_length(p_patch->'senderAccountIds')>100 THEN RAISE EXCEPTION 'crm_invalid_sender_pool'; END IF;
    SELECT coalesce(array_agg(value::uuid), '{}'::uuid[]) INTO sender_ids FROM jsonb_array_elements_text(p_patch->'senderAccountIds');
    IF EXISTS (SELECT 1 FROM unnest(sender_ids) id LEFT JOIN app.gmail_accounts a ON a.id=id
      WHERE a.id IS NULL OR a.deleted_at IS NOT NULL OR a.status<>'active' OR a.paused_at IS NOT NULL OR a.role NOT IN ('sender','primary')) THEN
      RAISE EXCEPTION 'crm_sender_pool_not_authorized';
    END IF;
  END IF;

  UPDATE app.campaigns SET
    name=CASE WHEN p_patch?'name' THEN btrim(p_patch->>'name') ELSE name END,
    status=CASE WHEN p_patch?'status' THEN (p_patch->>'status')::app.campaign_status ELSE status END,
    folder_id=CASE WHEN p_patch?'folderId' THEN nullif(p_patch->>'folderId','')::uuid ELSE folder_id END,
    target_description=CASE WHEN p_patch?'targetDescription' THEN p_patch->>'targetDescription' ELSE target_description END,
    daily_new_contact_goal=CASE WHEN p_patch?'dailyNewContactGoal' THEN (p_patch->>'dailyNewContactGoal')::integer ELSE daily_new_contact_goal END,
    validation_policy=CASE WHEN p_patch?'validationPolicy' THEN (p_patch->>'validationPolicy')::app.validation_policy ELSE validation_policy END,
    sender_strategy=CASE WHEN p_patch?'senderStrategy' THEN (p_patch->>'senderStrategy')::app.sender_strategy ELSE sender_strategy END,
    fixed_sender_account_id=CASE WHEN p_patch?'fixedSenderAccountId' THEN nullif(p_patch->>'fixedSenderAccountId','')::uuid ELSE fixed_sender_account_id END,
    ai_instructions=CASE WHEN p_patch?'aiInstructions' THEN p_patch->>'aiInstructions' ELSE ai_instructions END,
    writing_iteration_instructions=coalesce(pass_values,writing_iteration_instructions),
    reply_instructions=CASE WHEN p_patch?'replyInstructions' THEN p_patch->>'replyInstructions' ELSE reply_instructions END,
    tracking_opens_enabled=CASE WHEN p_patch?'trackingOpensEnabled' THEN (p_patch->>'trackingOpensEnabled')::boolean ELSE tracking_opens_enabled END,
    tracking_clicks_enabled=CASE WHEN p_patch?'trackingClicksEnabled' THEN (p_patch->>'trackingClicksEnabled')::boolean ELSE tracking_clicks_enabled END,
    experiment_policy=CASE WHEN p_patch?'experimentPolicy' THEN p_patch->>'experimentPolicy' ELSE experiment_policy END,
    next_test_instructions=CASE WHEN p_patch?'nextTestInstructions' THEN p_patch->>'nextTestInstructions' ELSE next_test_instructions END,
    imported_disabled=CASE WHEN p_patch->>'status'='active' THEN false ELSE imported_disabled END,
    archived_at=CASE WHEN p_patch->>'status'='archived' THEN coalesce(archived_at,clock_timestamp()) WHEN p_patch?'status' THEN NULL ELSE archived_at END,
    version=version+1, updated_at=clock_timestamp()
  WHERE id=p_campaign_id;

  IF sender_ids IS NOT NULL THEN
    UPDATE app.campaign_sender_accounts SET enabled = account_id=ANY(sender_ids) WHERE campaign_id=p_campaign_id;
    INSERT INTO app.campaign_sender_accounts(campaign_id,account_id)
    SELECT p_campaign_id,id FROM unnest(sender_ids) id
    ON CONFLICT(campaign_id,account_id) DO UPDATE SET enabled=true;
  END IF;

  IF s IS NOT NULL THEN
    FOR i IN 0..5 LOOP
      st:=fields[i+1];
      SELECT * INTO old_t FROM app.message_templates
       WHERE campaign_id=p_campaign_id AND step=st::app.sequence_step AND iteration=1
       ORDER BY version DESC LIMIT 1;
      new_subject:=coalesce(s->>'subject',''); new_body:=coalesce((s->'steps')->>i,'');
      new_instr:=CASE WHEN i=0 THEN jsonb_build_object('subject',coalesce(s->>'subjectInstructions',''),'body',coalesce((s->'stepInstructions')->>i,''))::text ELSE coalesce((s->'stepInstructions')->>i,'') END;
      IF length(new_body)>100000 OR length(new_instr)>100000 THEN RAISE EXCEPTION 'crm_message_too_long'; END IF;
      IF old_t.id IS NULL OR (old_t.subject,old_t.body,old_t.instructions) IS DISTINCT FROM (new_subject,new_body,new_instr) THEN
        INSERT INTO app.message_templates(campaign_id,step,iteration,version,subject,body,instructions,supersedes_id,created_by)
        VALUES(p_campaign_id,st::app.sequence_step,1,coalesce(old_t.version,0)+1,new_subject,new_body,new_instr,old_t.id,'prospection-95-plugin');
        changed:=changed+1;
      END IF;
    END LOOP;
  END IF;
  INSERT INTO audit.event_log(actor_type,actor_id,event_type,entity_type,entity_id,after_state,metadata)
  SELECT 'user','prospection-95','crm_campaign_updated','campaign',p_campaign_id::text,
    jsonb_build_object('previousVersion',c.version,'version',updated.version,'status',updated.status),
    jsonb_build_object('templateVersionsAdded',changed,'fields',coalesce((SELECT jsonb_agg(key) FROM jsonb_object_keys(p_patch) key),'[]'::jsonb))
  FROM app.campaigns updated WHERE updated.id=p_campaign_id;
  RETURN (SELECT jsonb_build_object('campaignId',id,'previousVersion',c.version,'version',version,'status',status,'templatesUpdated',changed) FROM app.campaigns WHERE id=p_campaign_id);
END;
$crm_campaign_update$;

CREATE OR REPLACE FUNCTION crm_api.crm_experiment_save(
  p_campaign_id uuid,
  p_expected_campaign_version bigint,
  p_experiment_id uuid,
  p_payload jsonb,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $crm_experiment_save$
DECLARE
  campaign_row app.campaigns%ROWTYPE;
  previous app.experiments%ROWTYPE;
  new_id uuid;
  variants jsonb;
  variant jsonb;
  desired_status app.experiment_status;
  next_revision integer := 1;
  i integer;
BEGIN
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR length(coalesce(p_idempotency_key,'')) NOT BETWEEN 8 AND 240 THEN RAISE EXCEPTION 'crm_invalid_experiment_payload'; END IF;
  SELECT * INTO campaign_row FROM app.campaigns WHERE id=p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'crm_campaign_not_found'; END IF;
  IF campaign_row.version IS DISTINCT FROM p_expected_campaign_version THEN RAISE EXCEPTION 'crm_version_conflict: %',campaign_row.version; END IF;
  IF p_experiment_id IS NOT NULL THEN
    SELECT * INTO previous FROM app.experiments WHERE id=p_experiment_id AND campaign_id=p_campaign_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'crm_experiment_not_found'; END IF;
  END IF;
  IF coalesce(p_payload->>'status','')='cancelled' AND p_experiment_id IS NOT NULL THEN
    UPDATE app.experiments SET status='cancelled',closed_at=coalesce(closed_at,clock_timestamp()),updated_at=clock_timestamp() WHERE id=p_experiment_id;
    UPDATE app.campaigns SET version=version+1,updated_at=clock_timestamp() WHERE id=p_campaign_id;
    RETURN jsonb_build_object('campaignId',p_campaign_id,'experimentId',p_experiment_id,'status','cancelled','version',campaign_row.version+1);
  END IF;
  variants:=p_payload->'variants';
  IF jsonb_typeof(variants) IS DISTINCT FROM 'array' OR jsonb_array_length(variants) NOT BETWEEN 2 AND 12 THEN RAISE EXCEPTION 'crm_invalid_variant_count'; END IF;
  IF length(btrim(coalesce(p_payload->>'name',previous.name,''))) NOT BETWEEN 1 AND 180 THEN RAISE EXCEPTION 'crm_invalid_experiment_name'; END IF;
  IF coalesce(p_payload->>'scope',previous.scope,'sequence') NOT IN ('population','subject','step','sequence','instructions','combined') THEN RAISE EXCEPTION 'crm_invalid_experiment_scope'; END IF;
  desired_status:=CASE WHEN coalesce(p_payload->>'status','') IN ('draft','recruiting') THEN (p_payload->>'status')::app.experiment_status WHEN previous.status IN ('recruiting','threshold_reached','awaiting_observations','mature') THEN 'recruiting'::app.experiment_status ELSE 'draft'::app.experiment_status END;
  IF p_experiment_id IS NOT NULL THEN
    next_revision:=previous.revision+1;
    UPDATE app.experiments SET status='cancelled',closed_at=coalesce(closed_at,clock_timestamp()),updated_at=clock_timestamp() WHERE id=previous.id;
  END IF;
  INSERT INTO app.experiments(campaign_id,supersedes_id,revision,name,status,scope,target_step,
    comparable_population,allocation_method,primary_metric,contacts_per_variant_threshold,
    total_responses_threshold,maturity_delay,started_at,idempotency_key)
  VALUES(p_campaign_id,previous.id,next_revision,coalesce(p_payload->>'name',previous.name),desired_status,
    coalesce(p_payload->>'scope',previous.scope,'sequence'),nullif(p_payload->>'targetStep','')::app.sequence_step,
    coalesce((p_payload->>'comparablePopulation')::boolean,previous.comparable_population,true),
    coalesce(p_payload->>'allocationMethod',previous.allocation_method,'balanced_random'),
    coalesce(p_payload->>'primaryMetric',previous.primary_metric,'positive_reply'),
    coalesce((p_payload->>'thresholdContactsPerVariant')::integer,previous.contacts_per_variant_threshold,40),
    coalesce((p_payload->>'thresholdReplies')::integer,previous.total_responses_threshold,20),
    coalesce((p_payload->>'maturityDelayDays')::integer*interval '1 day',previous.maturity_delay,interval '14 days'),
    CASE WHEN desired_status='recruiting' THEN clock_timestamp() END,p_idempotency_key)
  RETURNING id INTO new_id;
  FOR i IN 0..jsonb_array_length(variants)-1 LOOP
    variant:=variants->i;
    IF coalesce(variant->>'label','') !~ '^[A-Z]{1,3}$' OR coalesce((variant->>'allocationWeight')::numeric,1)<=0 OR jsonb_typeof(coalesce(variant->'overrides','{}'::jsonb))<>'object' THEN RAISE EXCEPTION 'crm_invalid_variant'; END IF;
    INSERT INTO app.experiment_variants(experiment_id,code,name,weight,overrides)
    VALUES(new_id,variant->>'label',variant->>'name',coalesce((variant->>'allocationWeight')::numeric,1),coalesce(variant->'overrides','{}'::jsonb));
  END LOOP;
  UPDATE app.campaigns SET version=version+1,updated_at=clock_timestamp() WHERE id=p_campaign_id;
  INSERT INTO audit.event_log(actor_type,actor_id,event_type,entity_type,entity_id,after_state,metadata)
  VALUES('user','prospection-95',CASE WHEN p_experiment_id IS NULL THEN 'crm_experiment_created' ELSE 'crm_experiment_revised' END,
    'experiment',new_id::text,jsonb_build_object('campaignId',p_campaign_id,'status',desired_status,'revision',next_revision),
    jsonb_build_object('supersedesId',previous.id,'variants',jsonb_array_length(variants),'idempotencyKey',p_idempotency_key));
  RETURN jsonb_build_object('campaignId',p_campaign_id,'experimentId',new_id,'supersedesId',previous.id,
    'revision',next_revision,'status',desired_status,'version',campaign_row.version+1);
END;
$crm_experiment_save$;

CREATE OR REPLACE FUNCTION agent_api.assign_prospect_variant_v2(
  p_experiment_id uuid,
  p_prospect_id uuid,
  p_requested_variant_id uuid,
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
AS $assign_prospect_variant_v2$
DECLARE
  experiment_row app.experiments%ROWTYPE;
  assignment_row app.experiment_assignments%ROWTYPE;
  chosen_step app.sequence_step;
BEGIN
  IF length(coalesce(p_idempotency_key,'')) NOT BETWEEN 8 AND 200 THEN RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM audit.agent_runs ar WHERE ar.id=p_run_id AND ar.agent_type='prospection' AND ar.status='running') THEN RAISE EXCEPTION 'run_not_active' USING ERRCODE='P0001'; END IF;
  SELECT * INTO experiment_row FROM app.experiments e
   WHERE e.id=p_experiment_id AND e.status IN ('recruiting','threshold_reached') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'experiment_not_recruiting' USING ERRCODE='P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.campaign_prospects cp WHERE cp.campaign_id=experiment_row.campaign_id AND cp.prospect_id=p_prospect_id AND cp.state='reserved') THEN RAISE EXCEPTION 'prospect_not_reserved' USING ERRCODE='P0001'; END IF;
  chosen_step:=CASE WHEN experiment_row.scope='step' THEN experiment_row.target_step ELSE NULL END;
  IF experiment_row.allocation_method='descriptive_groups' THEN
    IF p_requested_variant_id IS NULL OR NOT EXISTS (SELECT 1 FROM app.experiment_variants v WHERE v.id=p_requested_variant_id AND v.experiment_id=p_experiment_id) THEN
      RAISE EXCEPTION 'descriptive_variant_required' USING ERRCODE='P0001';
    END IF;
  ELSIF p_requested_variant_id IS NOT NULL THEN
    RAISE EXCEPTION 'requested_variant_not_allowed_for_random_test' USING ERRCODE='P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_experiment_id::text||':'||p_prospect_id::text||':'||coalesce(chosen_step::text,'sequence'),95));
  SELECT * INTO assignment_row FROM app.experiment_assignments a
   WHERE a.experiment_id=p_experiment_id AND a.prospect_id=p_prospect_id
     AND a.assigned_for_step IS NOT DISTINCT FROM chosen_step ORDER BY a.assigned_at LIMIT 1;
  IF FOUND AND p_requested_variant_id IS NOT NULL AND assignment_row.variant_id IS DISTINCT FROM p_requested_variant_id THEN
    RAISE EXCEPTION 'existing_variant_assignment_mismatch' USING ERRCODE='P0001';
  END IF;
  IF NOT FOUND THEN
    IF experiment_row.allocation_method='descriptive_groups' THEN
      INSERT INTO app.experiment_assignments(experiment_id,variant_id,prospect_id,campaign_id,assigned_for_step,assignment_key)
      VALUES(p_experiment_id,p_requested_variant_id,p_prospect_id,experiment_row.campaign_id,chosen_step,p_idempotency_key)
      ON CONFLICT(assignment_key) DO NOTHING RETURNING * INTO assignment_row;
      IF assignment_row.id IS NULL THEN SELECT * INTO assignment_row FROM app.experiment_assignments WHERE assignment_key=p_idempotency_key; END IF;
    ELSE
      assignment_row:=app.assign_experiment_variant(p_experiment_id,p_prospect_id,chosen_step,p_idempotency_key);
    END IF;
  END IF;
  INSERT INTO app.experiment_events(experiment_id,variant_id,assignment_id,prospect_id,event_type,event_at,measured,confidence,source,idempotency_key,metadata)
  VALUES(assignment_row.experiment_id,assignment_row.variant_id,assignment_row.id,assignment_row.prospect_id,'assigned',assignment_row.assigned_at,true,'confirmed','prospection_agent','assignment:'||assignment_row.id::text,jsonb_build_object('runId',p_run_id))
  ON CONFLICT(idempotency_key) DO NOTHING;
  INSERT INTO audit.event_log(actor_type,actor_id,correlation_id,event_type,entity_type,entity_id,metadata)
  VALUES('prospection_agent',p_run_id::text,p_run_id,'experiment_variant_assigned','prospect',p_prospect_id::text,
    jsonb_build_object('assignmentId',assignment_row.id,'experimentId',assignment_row.experiment_id,'variantId',assignment_row.variant_id,'allocationMethod',experiment_row.allocation_method,'idempotencyKey',p_idempotency_key));
  RETURN QUERY SELECT assignment_row.id,assignment_row.campaign_id,assignment_row.experiment_id,assignment_row.variant_id,v.code,assignment_row.assigned_for_step
   FROM app.experiment_variants v WHERE v.id=assignment_row.variant_id;
END;
$assign_prospect_variant_v2$;

REVOKE ALL ON FUNCTION agent_api.assign_prospect_variant_v2(uuid,uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_api.assign_prospect_variant_v2(uuid,uuid,uuid,uuid,text) TO prospection95_agent;

REVOKE ALL ON FUNCTION crm_api.crm_campaign_create_v2(jsonb,text),
  crm_api.crm_campaign_update(uuid,bigint,jsonb),
  crm_api.crm_experiment_save(uuid,bigint,uuid,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_api.crm_campaign_create_v2(jsonb,text),
  crm_api.crm_campaign_update(uuid,bigint,jsonb),
  crm_api.crm_experiment_save(uuid,bigint,uuid,jsonb,text) TO prospection95_crm;

INSERT INTO app.schema_migrations(version)
VALUES('024_structured_campaign_editing')
ON CONFLICT(version) DO NOTHING;
