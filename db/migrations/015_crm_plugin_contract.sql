-- Prospection 95: controlled CRM plugin contract.
-- Create an inactive campaign with six message templates and optional draft experiments.
-- No direct business-table grant, no SMTP, no activation, no access to vault.
-- Re-applicable migration; changes performed inside an atomic SECURITY DEFINER function.
CREATE SCHEMA IF NOT EXISTS crm_api;
REVOKE ALL ON SCHEMA crm_api FROM PUBLIC;
CREATE TABLE IF NOT EXISTS crm_api.create_requests (
  idempotency_key text PRIMARY KEY,
  payload_hash text NOT NULL,
  campaign_id uuid NOT NULL UNIQUE REFERENCES app.campaigns(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON crm_api.create_requests FROM PUBLIC;
DO $role$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='prospection95_crm') THEN
    CREATE ROLE prospection95_crm NOLOGIN NOINHERIT;
  END IF;
END $role$;
CREATE OR REPLACE FUNCTION crm_api.crm_campaign_create(p_payload jsonb, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  c jsonb; s jsonb; tests jsonb; e jsonb; v jsonb;
  idx int; n int; m int; count_variants int;
  row_id uuid; experiment_id uuid; saved_id uuid; saved_hash text;
  key_hash text; campaign_name text; sender_id uuid; folder_id uuid;
  sstrategy text; ver bigint; allowed int;
  steps text[] := ARRAY['J0','R1','R2','R3','R4','R5'];
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' OR length(p_payload::text) > 1000000 THEN
    RAISE EXCEPTION 'crm_invalid_payload';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 160 THEN
    RAISE EXCEPTION 'crm_invalid_idempotency_key';
  END IF;
  c := p_payload->'campaign'; s := c->'sequence'; tests := coalesce(p_payload->'experiments','[]'::jsonb);
  IF jsonb_typeof(c) IS DISTINCT FROM 'object' OR jsonb_typeof(s) IS DISTINCT FROM 'object'
     OR jsonb_typeof(tests) IS DISTINCT FROM 'array'
     OR jsonb_typeof(s->'steps') IS DISTINCT FROM 'array'
     OR jsonb_typeof(s->'stepInstructions') IS DISTINCT FROM 'array'
     OR jsonb_array_length(s->'steps') <> 6 OR jsonb_array_length(s->'stepInstructions') <> 6
     OR jsonb_array_length(tests) > 10 THEN
    RAISE EXCEPTION 'crm_invalid_campaign_structure';
  END IF;
  campaign_name := btrim(coalesce(c->>'name',''));
  IF length(campaign_name) NOT BETWEEN 1 AND 180 THEN RAISE EXCEPTION 'crm_invalid_name'; END IF;
  IF c->>'status' IS DISTINCT FROM 'inactive' THEN RAISE EXCEPTION 'crm_only_inactive'; END IF;
  IF coalesce(c->>'validationPolicy','manual') NOT IN ('manual','automatic') THEN RAISE EXCEPTION 'crm_invalid_validation_policy'; END IF;
  IF coalesce(c->>'experimentPolicy','continue') NOT IN ('continue','stabilize') THEN RAISE EXCEPTION 'crm_invalid_experiment_policy'; END IF;
  sstrategy := coalesce(c->>'senderStrategy','fixed');
  IF sstrategy NOT IN ('fixed','pool') THEN RAISE EXCEPTION 'crm_invalid_sender_strategy'; END IF;
  IF coalesce((c->>'dailyNewContactGoal')::integer,0) NOT BETWEEN 0 AND 10000 THEN
    RAISE EXCEPTION 'crm_invalid_daily_goal';
  END IF;
  IF c->>'folderId' IS NOT NULL THEN
    folder_id := (c->>'folderId')::uuid;
    IF NOT EXISTS(SELECT 1 FROM app.campaign_folders WHERE id=folder_id) THEN RAISE EXCEPTION 'crm_folder_not_found'; END IF;
  END IF;
  IF sstrategy='fixed' AND c->>'fixedSenderAccountId' IS NOT NULL THEN
    sender_id := (c->>'fixedSenderAccountId')::uuid;
    IF NOT EXISTS(SELECT 1 FROM app.gmail_accounts
      WHERE id=sender_id AND deleted_at IS NULL AND status='active'
      AND paused_at IS NULL AND role IN ('sender','primary')) THEN
      RAISE EXCEPTION 'crm_sender_not_authorized';
    END IF;
  END IF;
  IF sstrategy='pool' THEN
    IF jsonb_typeof(c->'senderAccountIds') <> 'array'
       OR jsonb_array_length(c->'senderAccountIds') > 100 THEN
      RAISE EXCEPTION 'crm_invalid_sender_pool';
    END IF;
    SELECT count(*) INTO allowed FROM jsonb_array_elements_text(c->'senderAccountIds') AS x(id)
    JOIN app.gmail_accounts a ON a.id=x.id::uuid
    WHERE a.deleted_at IS NULL AND a.status='active' AND a.paused_at IS NULL
      AND a.role IN ('sender','primary');
    IF allowed <> jsonb_array_length(c->'senderAccountIds') THEN RAISE EXCEPTION 'crm_sender_pool_not_authorized'; END IF;
    IF (SELECT count(DISTINCT id) FROM jsonb_array_elements_text(c->'senderAccountIds') AS x(id))
         <> jsonb_array_length(c->'senderAccountIds') THEN RAISE EXCEPTION 'crm_duplicate_sender'; END IF;
  END IF;
  key_hash := md5(p_payload::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_idempotency_key, 95));
  SELECT campaign_id, payload_hash INTO saved_id,saved_hash
  FROM crm_api.create_requests WHERE idempotency_key=p_idempotency_key;
  IF FOUND THEN
    IF saved_hash <> key_hash THEN RAISE EXCEPTION 'crm_idempotency_conflict'; END IF;
    SELECT version INTO ver FROM app.campaigns WHERE id=saved_id;
    RETURN jsonb_build_object('campaignId',saved_id,'version',ver,'status','inactive','alreadyExisted',true);
  END IF;
  INSERT INTO app.campaigns
    (name,folder_id,status,target_description,daily_new_contact_goal,validation_policy,
     sender_strategy,fixed_sender_account_id,ai_instructions,reply_instructions,
     tracking_opens_enabled,tracking_clicks_enabled,experiment_policy,next_test_instructions)
  VALUES
    (campaign_name,folder_id,'inactive',
     coalesce(c->>'targetDescription',''),coalesce((c->>'dailyNewContactGoal')::integer,0),
     coalesce(c->>'validationPolicy','manual')::app.validation_policy,
     sstrategy::app.sender_strategy,CASE WHEN sstrategy='fixed' THEN sender_id ELSE NULL END,
     coalesce(c->>'aiInstructions',''),coalesce(c->>'replyInstructions',''),
     coalesce((c->>'trackingOpensEnabled')::boolean,false),
     coalesce((c->>'trackingClicksEnabled')::boolean,false),
     coalesce(c->>'experimentPolicy','continue'),coalesce(c->>'nextTestInstructions',''))
  RETURNING id,version INTO row_id,ver;
  IF sstrategy='pool' THEN
    INSERT INTO app.campaign_sender_accounts(campaign_id,account_id)
    SELECT row_id,value::uuid FROM jsonb_array_elements_text(c->'senderAccountIds') AS value;
  END IF;
  FOR idx IN 0..5 LOOP
    IF length(coalesce((s->'steps')->>idx,'')) > 100000
       OR length(coalesce((s->'stepInstructions')->>idx,'')) > 100000 THEN
      RAISE EXCEPTION 'crm_message_too_long';
    END IF;
    INSERT INTO app.message_templates(campaign_id,step,iteration,version,subject,body,instructions,created_by)
    VALUES(row_id,steps[idx+1]::app.sequence_step,1,1,coalesce(s->>'subject',''),
           coalesce((s->'steps')->>idx,''),
           CASE WHEN idx=0 THEN jsonb_build_object(
               'subject',coalesce(s->>'subjectInstructions',''),
               'body',coalesce((s->'stepInstructions')->>idx,''))::text
             ELSE coalesce((s->'stepInstructions')->>idx,'') END,
           'user');
  END LOOP;
  FOR n IN 0..jsonb_array_length(tests)-1 LOOP
    e := tests->n;
    IF jsonb_typeof(e) <> 'object' OR coalesce(e->>'status','draft') <> 'draft'
      OR length(btrim(coalesce(e->>'name',''))) NOT BETWEEN 1 AND 180
      OR e->>'scope' NOT IN ('population','subject','step','sequence','instructions','combined')
      OR jsonb_typeof(e->'variants') <> 'array' THEN
      RAISE EXCEPTION 'crm_invalid_experiment';
    END IF;
    count_variants := jsonb_array_length(e->'variants');
    IF count_variants NOT BETWEEN 2 AND 12 THEN RAISE EXCEPTION 'crm_invalid_variant_count'; END IF;
    IF coalesce((e->>'thresholdContactsPerVariant')::integer,40) < 1
       OR coalesce((e->>'thresholdReplies')::integer,20) < 1 THEN
      RAISE EXCEPTION 'crm_invalid_threshold';
    END IF;
    INSERT INTO app.experiments(campaign_id,name,status,scope,target_step,
      contacts_per_variant_threshold,total_responses_threshold,idempotency_key)
    VALUES(row_id,e->>'name','draft',e->>'scope',
      NULLIF(e->>'targetStep','')::app.sequence_step,
      coalesce((e->>'thresholdContactsPerVariant')::integer,40),
      coalesce((e->>'thresholdReplies')::integer,20),
      p_idempotency_key||':'||(n+1)::text)
    RETURNING id INTO experiment_id;
    FOR m IN 0..count_variants-1 LOOP
      v := (e->'variants')->m;
      IF jsonb_typeof(v) <> 'object' OR coalesce(v->>'label','') !~ '^[A-Z]{1,3}$'
         OR coalesce((v->>'allocationWeight')::numeric,1) <= 0
         OR jsonb_typeof(coalesce(v->'overrides','{}'::jsonb)) <> 'object'
         OR length(coalesce(v->>'name','')) > 180 THEN
        RAISE EXCEPTION 'crm_invalid_variant';
      END IF;
      INSERT INTO app.experiment_variants(experiment_id,code,name,weight,overrides)
      VALUES(experiment_id,v->>'label',v->>'name',
        coalesce((v->>'allocationWeight')::numeric,1),coalesce(v->'overrides','{}'::jsonb));
    END LOOP;
  END LOOP;
  INSERT INTO crm_api.create_requests(idempotency_key,payload_hash,campaign_id)
  VALUES(p_idempotency_key,key_hash,row_id);
  INSERT INTO audit.event_log(actor_type,actor_id,event_type,entity_type,entity_id,after_state,metadata)
  VALUES('user','prospection-95','crm_campaign_created','campaign',row_id::text,
    jsonb_build_object('name',campaign_name,'status','inactive','version',ver),
    jsonb_build_object('experiments',jsonb_array_length(tests),'idempotencyKey',p_idempotency_key));
  RETURN jsonb_build_object('campaignId',row_id,'version',ver,'status','inactive','experiments',jsonb_array_length(tests),'alreadyExisted',false);
END;
$function$

REVOKE ALL ON FUNCTION crm_api.crm_campaign_create(jsonb,text) FROM PUBLIC;
GRANT USAGE ON SCHEMA crm_api TO prospection95_crm;
GRANT EXECUTE ON FUNCTION crm_api.crm_campaign_create(jsonb,text) TO prospection95_crm;
GRANT prospection95_crm TO prospection95_owner WITH INHERIT FALSE, SET TRUE;
-- Invocation: BEGIN; SET LOCAL ROLE prospection95_crm;
-- SELECT crm_api.crm_campaign_create('<json>'::jsonb,'<idempotency-key>');
-- COMMIT;
