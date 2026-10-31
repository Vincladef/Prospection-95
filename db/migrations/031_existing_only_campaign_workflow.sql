-- Keep the audited workflow intact; extend only campaign-running predicates.
-- Recruitment (register_prospect) deliberately remains restricted to active.
DO $workflow$
DECLARE routine regprocedure; original text; changed text;
BEGIN
  FOREACH routine IN ARRAY ARRAY[
    'app.reserve_campaign_prospect(uuid,uuid,uuid,text)'::regprocedure,
    'app.lease_outbox_jobs(text,integer,integer)'::regprocedure,
    'app.schedule_due_messages(integer)'::regprocedure,
    'agent_api.claim_campaign_iteration(uuid,uuid,text)'::regprocedure,
    'agent_api.complete_campaign_iteration(uuid,uuid,jsonb,text)'::regprocedure,
    'agent_api.claim_prospect_iteration(uuid,uuid,uuid,uuid,text)'::regprocedure,
    'agent_api.propose_sequence(uuid,uuid,uuid,text,jsonb,uuid,text)'::regprocedure,
    'crm_api.crm_campaign_update_ai_instructions(uuid,bigint,text)'::regprocedure,
    'crm_api.crm_campaign_update(uuid,bigint,jsonb)'::regprocedure
  ] LOOP
    original := pg_get_functiondef(routine);
    changed := replace(original, 'c.status = ''active''', 'c.status IN (''active'',''existing_only'')');
    changed := replace(changed, 'campaign_row.status <> ''active''', 'campaign_row.status NOT IN (''active'',''existing_only'')');
    changed := replace(changed, 'status = ''active'' AND NOT imported_disabled', 'status IN (''active'',''existing_only'') AND NOT imported_disabled');
    changed := replace(changed, '(''inactive'',''active'')', '(''inactive'',''active'',''existing_only'')');
    changed := replace(changed, '(''inactive'',''active'',''archived'')', '(''inactive'',''active'',''existing_only'',''archived'')');
    changed := replace(changed, 'p_patch->>''status''=''active''', 'p_patch->>''status'' IN (''active'',''existing_only'')');
    IF changed = original THEN RAISE EXCEPTION 'campaign_guard_not_found_in_%', routine; END IF;
    EXECUTE changed;
  END LOOP;
END;
$workflow$;

-- Existing qualified candidates remain available for reservation and writing.
DO $eligible$
DECLARE original text; changed text;
BEGIN
  original := pg_get_viewdef('agent_api.eligible_prospects'::regclass, true);
  changed := replace(original, 'c.status = ''active''::app.campaign_status', 'c.status IN (''active''::app.campaign_status,''existing_only''::app.campaign_status)');
  IF changed = original THEN RAISE EXCEPTION 'eligible_campaign_guard_not_found'; END IF;
  EXECUTE 'CREATE OR REPLACE VIEW agent_api.eligible_prospects WITH (security_barrier=true) AS ' || changed;
END;
$eligible$;

-- Retain the same safety requirements for both running campaign modes.
DO $constraints$
DECLARE item record;
BEGIN
  FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='app.campaigns'::regclass AND contype='c'
    AND (pg_get_constraintdef(oid) LIKE '%fixed_sender_account_id%' OR pg_get_constraintdef(oid) LIKE '%imported_disabled%')
  LOOP EXECUTE format('ALTER TABLE app.campaigns DROP CONSTRAINT %I',item.conname); END LOOP;
END;
$constraints$;
ALTER TABLE app.campaigns ADD CONSTRAINT campaigns_running_sender_check
  CHECK (sender_strategy <> 'fixed' OR fixed_sender_account_id IS NOT NULL OR status NOT IN ('active','existing_only'));
ALTER TABLE app.campaigns ADD CONSTRAINT campaigns_running_import_check
  CHECK (NOT imported_disabled OR status NOT IN ('active','existing_only'));

-- Serialize new automatic registrations against status changes. Replays using
-- an existing idempotency key still return the previously registered prospect.
DO $registration$
DECLARE original text; changed text;
BEGIN
  original := pg_get_functiondef('agent_api.register_prospect(uuid,text,text,text,text,text,text,text,jsonb,numeric,text,uuid,text)'::regprocedure);
  changed := replace(original,
    'IF NOT EXISTS (' || chr(10) || '    SELECT 1 FROM app.campaigns c',
    'PERFORM 1 FROM app.campaigns c');
  changed := replace(changed,
    'WHERE c.id = p_campaign_id AND c.status = ''active'' AND NOT c.imported_disabled' || chr(10) || '  ) THEN',
    'WHERE c.id = p_campaign_id AND c.status = ''active'' AND NOT c.imported_disabled FOR SHARE;' || chr(10) || '  IF NOT FOUND THEN');
  IF changed = original OR position('FOR SHARE;' IN changed)=0 THEN RAISE EXCEPTION 'registration_campaign_guard_not_found'; END IF;
  EXECUTE changed;
END;
$registration$;

INSERT INTO app.schema_migrations(version) VALUES ('031_existing_only_campaign_workflow')
ON CONFLICT (version) DO NOTHING;
