-- Isolated Neon branch only. No SMTP calls; every fixture change rolls back.
DO $test$
#variable_conflict use_variable
DECLARE
  campaign_id uuid; sender_id uuid; prospect_id uuid; run_id uuid;
  iteration record; proposed jsonb; conversation_id uuid; leased app.outbox_jobs;
  seq jsonb := '{"subject":"Validation du mode existant","subjectInstructions":"","steps":["Message initial de test","Relance un de test","Relance deux de test","Relance trois de test","Relance quatre de test","Relance cinq de test"],"stepInstructions":["","","","","",""]}';
  key text := 'existing-only-test:' || gen_random_uuid()::text;
  before_hash text; iteration_count bigint; rejected boolean;
BEGIN
 BEGIN
  SELECT id INTO sender_id FROM app.gmail_accounts WHERE status='active' AND credential_id IS NOT NULL LIMIT 1;
  IF sender_id IS NULL THEN RAISE EXCEPTION 'test_requires_active_sender'; END IF;
  UPDATE app.campaigns SET status='inactive' WHERE status IN ('active','existing_only');
  UPDATE app.gmail_accounts SET timezone='UTC',send_days=ARRAY[1,2,3,4,5,6,7]::smallint[],
    send_start='00:00',send_end='23:59',daily_limit=100,warmup_daily_limit=100 WHERE id=sender_id;
  INSERT INTO app.campaigns(name,status,sender_strategy,fixed_sender_account_id,validation_policy,writing_iteration_instructions)
    VALUES(key,'active','fixed',sender_id,'manual',ARRAY['']) RETURNING id INTO campaign_id;
  run_id := agent_api.begin_run('prospection',key,key);
  SELECT r.prospect_id INTO prospect_id FROM agent_api.register_prospect(campaign_id,'Fixture',
    key || '@example.test',NULL,NULL,NULL,'fixture',NULL,'{}',1,'Test isolé',run_id,key || ':register') r;
  before_hash := app.prospect_writing_input_hash(campaign_id,prospect_id,NULL);
  PERFORM crm_api.crm_campaign_update(campaign_id,1,'{"status":"existing_only"}');
  IF app.prospect_writing_input_hash(campaign_id,prospect_id,NULL) <> before_hash THEN RAISE EXCEPTION 'status_reset_writing_hash'; END IF;
  IF NOT EXISTS(SELECT 1 FROM agent_api.eligible_prospects e WHERE e.campaign_id=campaign_id AND e.prospect_id=prospect_id) THEN RAISE EXCEPTION 'existing_prospect_hidden'; END IF;
  rejected := false;
  BEGIN
    PERFORM agent_api.register_prospect(campaign_id,'Blocked',key || '-blocked@example.test',NULL,NULL,NULL,'fixture',NULL,'{}',1,'Test isolé',run_id,key || ':blocked');
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'campaign_not_active' THEN RAISE; END IF;
    rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'new_registration_allowed'; END IF;
  IF EXISTS(SELECT 1 FROM app.prospects WHERE normalized_email=key || '-blocked@example.test') THEN RAISE EXCEPTION 'blocked_registration_created_prospect'; END IF;
  PERFORM agent_api.register_prospect(campaign_id,'Fixture',key || '@example.test',NULL,NULL,NULL,'fixture',NULL,'{}',1,'Test isolé',run_id,key || ':register');
  PERFORM app.reserve_campaign_prospect(campaign_id,prospect_id,run_id,key || ':reserve');
  SELECT * INTO iteration FROM agent_api.claim_prospect_iteration(campaign_id,prospect_id,NULL,run_id,key || ':claim');
  IF iteration.iteration_run_id IS NULL THEN RAISE EXCEPTION 'writing_not_claimed'; END IF;
  PERFORM agent_api.complete_prospect_iteration(iteration.iteration_run_id,run_id,seq,key || ':complete');
  SELECT count(*) INTO iteration_count FROM app.prospect_iteration_runs WHERE state_id=iteration.iteration_state_id AND status='completed';
  proposed := agent_api.propose_completed_sequence(iteration.iteration_state_id,sender_id,run_id,key || ':propose');
  conversation_id := (proposed->>'conversationId')::uuid;
  UPDATE app.email_messages SET status='approved' WHERE email_messages.conversation_id=conversation_id;
  PERFORM app.schedule_due_messages(50);
  IF NOT EXISTS(SELECT 1 FROM app.outbox_jobs j WHERE j.conversation_id=conversation_id AND j.status='scheduled') THEN RAISE EXCEPTION 'existing_send_not_scheduled'; END IF;
  UPDATE app.outbox_jobs SET due_at=clock_timestamp()-interval '1 second' WHERE outbox_jobs.conversation_id=conversation_id;
  SELECT * INTO leased FROM app.lease_outbox_jobs('existing-only-fixture',1,40);
  IF leased.conversation_id IS DISTINCT FROM conversation_id THEN RAISE EXCEPTION 'existing_send_not_leased'; END IF;
  UPDATE app.campaigns SET status='active' WHERE id=campaign_id;
  IF (SELECT count(*) FROM app.prospect_iteration_runs WHERE state_id=iteration.iteration_state_id AND status='completed') <> iteration_count THEN RAISE EXCEPTION 'iterations_reset'; END IF;
  PERFORM agent_api.register_prospect(campaign_id,'Resumed',key || '-resumed@example.test',NULL,NULL,NULL,'fixture',NULL,'{}',1,'Test isolé',run_id,key || ':resumed');
  UPDATE app.outbox_jobs SET status='scheduled',lease_expires_at=NULL WHERE id=leased.id;
  UPDATE app.campaigns SET status='inactive' WHERE id=campaign_id;
  IF EXISTS(SELECT 1 FROM app.lease_outbox_jobs('inactive-fixture',1,40)) THEN RAISE EXCEPTION 'inactive_send_leased'; END IF;
  UPDATE app.campaigns SET status='archived' WHERE id=campaign_id;
  IF EXISTS(SELECT 1 FROM app.lease_outbox_jobs('archived-fixture',1,40)) THEN RAISE EXCEPTION 'archived_send_leased'; END IF;
  RAISE SQLSTATE 'P9501' USING MESSAGE='fixture_complete_rollback';
 EXCEPTION WHEN SQLSTATE 'P9501' THEN NULL;
 END;
END;
$test$;
