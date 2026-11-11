-- Isolated branch only. All fixture data rolls back; no SMTP calls.
DO $test$
#variable_conflict use_variable
DECLARE
 campaign_id uuid; prospect_id uuid; sender_id uuid; run_id uuid; state_id uuid;
 iteration record; replay record; result jsonb; proposed jsonb; conversation_id uuid;
 n int; step_n int; fixture_message uuid; fixture_job app.outbox_jobs; key text:='writing-recovery-fixture:'||gen_random_uuid(); rejected boolean;
 before_outbox bigint; before_sent text; snapshot text; current_version bigint;
 short_sequence jsonb:='{"subject":"Sujet fixture","subjectInstructions":"","steps":["Initial fixture","Premier rappel fixture","Dernier rappel fixture","","",""],"stepInstructions":["","","","Ne pas envoyer","Ne pas envoyer","Ne pas envoyer"]}';
 long_sequence jsonb:='{"subject":"Sujet fixture","subjectInstructions":"","steps":["Initial","Un","Deux","Trois","Quatre","Cinq"],"stepInstructions":["","","","","",""]}';
BEGIN
 BEGIN
  SELECT count(*) INTO before_outbox FROM app.outbox_jobs;
  SELECT md5(coalesce(jsonb_agg(to_jsonb(m) ORDER BY id)::text,'')) INTO before_sent FROM app.email_messages m WHERE technical_confirmation;
  SELECT id INTO sender_id FROM app.gmail_accounts WHERE status='active' AND credential_id IS NOT NULL LIMIT 1;
  INSERT INTO app.campaigns(name,status,sender_strategy,fixed_sender_account_id,validation_policy,writing_iteration_instructions)
   VALUES(key,'active','fixed',sender_id,'manual',ARRAY['Préparer','Relire','Finaliser']) RETURNING id INTO campaign_id;
  INSERT INTO app.message_templates(campaign_id,step,version,subject,body,instructions)
   SELECT campaign_id,(ARRAY['J0','R1','R2','R3','R4','R5'])[i+1]::app.sequence_step,1,
    short_sequence->>'subject',short_sequence->'steps'->>i,short_sequence->'stepInstructions'->>i FROM generate_series(0,5) i;
  run_id:=agent_api.begin_run('prospection',key||':failed',key||':failed');
  SELECT r.prospect_id INTO prospect_id FROM agent_api.register_prospect(campaign_id,'Fixture',key||'@example.test',NULL,NULL,NULL,'fixture',NULL,'{}',1,'Fixture vérifiée',run_id,key||':register') r;
  -- The queue contains both a never-started candidate and a reserved prospect.
  IF NOT EXISTS(SELECT 1 FROM agent_api.pending_prospect_writing q WHERE q.prospect_id=prospect_id AND q.iteration_status='not_started' AND q.next_action='write') THEN RAISE EXCEPTION 'candidate_missing_from_queue'; END IF;
  PERFORM agent_api.reserve_prospect(campaign_id,prospect_id,run_id,key||':reserve');
  IF NOT EXISTS(SELECT 1 FROM agent_api.pending_prospect_writing q WHERE q.prospect_id=prospect_id AND q.state='reserved') THEN RAISE EXCEPTION 'reserved_missing_from_queue'; END IF;
  SELECT * INTO iteration FROM agent_api.claim_prospect_iteration(campaign_id,prospect_id,NULL,run_id,key||':bad-claim');
  state_id:=iteration.iteration_state_id;
  result:=agent_api.validate_prospect_iteration_sequence(iteration.iteration_run_id,run_id,short_sequence-'stepInstructions');
  IF (result->>'valid')::boolean THEN RAISE EXCEPTION 'malformed_payload_accepted'; END IF;
  PERFORM agent_api.fail_prospect_iteration(iteration.iteration_run_id,run_id,'invalid_prospect_iteration_sequence');
  PERFORM agent_api.complete_run(run_id,'partial','{}','fixture_invalid_sequence');
  -- Retry the failed first pass in a new activation, then two further passes.
  FOR n IN 1..3 LOOP
   run_id:=agent_api.begin_run('prospection',key||':run:'||n,key||':run:'||n);
    SELECT * INTO iteration FROM agent_api.claim_prospect_iteration(campaign_id,prospect_id,NULL,run_id,key||':claim:'||n);
   IF iteration.iteration_number<>n THEN RAISE EXCEPTION 'wrong_resumed_pass'; END IF;
   result:=agent_api.validate_prospect_iteration_sequence(iteration.iteration_run_id,run_id,short_sequence);
   IF NOT (result->>'valid')::boolean OR (result->>'requiredMessages')::int<>3 THEN RAISE EXCEPTION 'short_sequence_rejected'; END IF;
   result:=agent_api.validate_prospect_iteration_sequence(iteration.iteration_run_id,run_id,long_sequence);
   IF (result->>'valid')::boolean THEN RAISE EXCEPTION 'unauthorized_extra_followups_accepted'; END IF;
   PERFORM agent_api.complete_prospect_iteration(iteration.iteration_run_id,run_id,short_sequence,key||':complete:'||n);
   PERFORM agent_api.complete_prospect_iteration(iteration.iteration_run_id,run_id,short_sequence,key||':complete:'||n);
   SELECT * INTO replay FROM agent_api.claim_prospect_iteration(campaign_id,prospect_id,NULL,run_id,key||':replay:'||n);
   IF replay.iteration_run_id<>iteration.iteration_run_id OR replay.iteration_number<>n THEN RAISE EXCEPTION 'two_passes_in_one_run'; END IF;
    IF (SELECT completed_iterations FROM app.prospect_iteration_states s WHERE s.id=state_id)<>n THEN RAISE EXCEPTION 'progress_not_persisted'; END IF;
   IF n<3 THEN
    rejected:=false;
    BEGIN PERFORM agent_api.propose_completed_sequence(state_id,sender_id,run_id,key||':premature');
    EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'prospect_iterations_incomplete' THEN RAISE; END IF;rejected:=true; END;
    IF NOT rejected THEN RAISE EXCEPTION 'premature_finalization'; END IF;
   ELSE
      proposed:=agent_api.propose_completed_sequence(state_id,sender_id,run_id,key||':propose');
    IF agent_api.propose_completed_sequence(state_id,sender_id,run_id,key||':propose') IS DISTINCT FROM proposed THEN RAISE EXCEPTION 'proposal_not_idempotent'; END IF;
      conversation_id:=(proposed->>'conversationId')::uuid;
    IF (SELECT count(*) FROM app.email_messages m WHERE m.conversation_id=conversation_id)<>3
       OR EXISTS(SELECT 1 FROM app.email_messages m WHERE m.conversation_id=conversation_id AND (m.step IN ('R3','R4','R5') OR m.status<>'pending_approval')) THEN RAISE EXCEPTION 'extra_or_approved_messages_created'; END IF;
    SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY r.id)::text) INTO snapshot FROM app.prospect_iteration_runs r WHERE r.state_id=state_id;
    SELECT version INTO current_version FROM app.prospects WHERE id=prospect_id;
    IF NOT EXISTS(SELECT 1 FROM crm_api.pending_sequences p WHERE p.prospect_id=prospect_id AND jsonb_array_length(p.messages)=3) THEN RAISE EXCEPTION 'short_sequence_not_editable'; END IF;
    result:=crm_api.crm_pending_sequence_revise(campaign_id,prospect_id,current_version,jsonb_build_object('subject','Révision fixture','steps',short_sequence->'steps'));
    IF (result->>'messagesRevised')::int<>3 THEN RAISE EXCEPTION 'wrong_short_revision_count'; END IF;
      IF (SELECT md5(jsonb_agg(to_jsonb(r) ORDER BY r.id)::text) FROM app.prospect_iteration_runs r WHERE r.state_id=state_id)<>snapshot THEN RAISE EXCEPTION 'archived_iterations_mutated'; END IF;
    -- Simulate confirmations only inside a rollback block, without SMTP.
    -- J0/R1 keep their due date, and the actual last step R2 ends the sequence.
    BEGIN
     FOR step_n IN 0..2 LOOP
      SELECT id INTO fixture_message FROM app.email_messages m WHERE m.conversation_id=conversation_id
       AND m.step=(ARRAY['J0','R1','R2'])[step_n+1]::app.sequence_step ORDER BY content_version DESC LIMIT 1;
      INSERT INTO app.outbox_jobs(message_id,conversation_id,campaign_id,prospect_id,account_id,step,job_kind,status,
       lease_token,lease_owner,lease_expires_at,attempt_count,idempotency_key,approved_at,due_at)
       VALUES(fixture_message,conversation_id,campaign_id,prospect_id,sender_id,(ARRAY['J0','R1','R2'])[step_n+1]::app.sequence_step,
        'prospection','running',gen_random_uuid(),key,clock_timestamp()+interval '5 minutes',1,key||':smtp-fixture:'||step_n,clock_timestamp(),clock_timestamp())
       RETURNING * INTO fixture_job;
      PERFORM app.confirm_smtp_acceptance(fixture_job.id,fixture_job.lease_token,'fixture',clock_timestamp());
      IF step_n<2 AND (SELECT next_step_due_at FROM app.conversations WHERE id=conversation_id) IS NULL THEN RAISE EXCEPTION 'short_sequence_stopped_early'; END IF;
      IF step_n=2 AND (SELECT next_step_due_at FROM app.conversations WHERE id=conversation_id) IS NOT NULL THEN RAISE EXCEPTION 'phantom_followup_due'; END IF;
     END LOOP;
     RAISE SQLSTATE 'P9502' USING MESSAGE='smtp_fixture_rollback';
    EXCEPTION WHEN SQLSTATE 'P9502' THEN NULL;
    END;
   END IF;
   PERFORM agent_api.complete_run(run_id,'completed','{}',NULL);
  END LOOP;
  IF (SELECT count(*) FROM app.prospect_iteration_runs r WHERE r.state_id=state_id AND r.status='completed')<>3 THEN RAISE EXCEPTION 'lost_iteration_history'; END IF;
  -- An existing 1/6 cycle resumes at 2/6 instead of restarting or finalizing.
  UPDATE app.campaigns SET writing_iteration_instructions=ARRAY['1','2','3','4','5','6'] WHERE id=campaign_id;
  INSERT INTO app.message_templates(campaign_id,step,version,subject,body,instructions)
   SELECT campaign_id,(ARRAY['J0','R1','R2','R3','R4','R5'])[i+1]::app.sequence_step,2,
    long_sequence->>'subject',long_sequence->'steps'->>i,'' FROM generate_series(0,5) i;
  run_id:=agent_api.begin_run('prospection',key||':long1',key||':long1');
  SELECT r.prospect_id INTO prospect_id FROM agent_api.register_prospect(campaign_id,'Long fixture',key||'-long@example.test',NULL,NULL,NULL,'fixture',NULL,'{}',1,'Fixture',run_id,key||':register-long') r;
  PERFORM agent_api.reserve_prospect(campaign_id,prospect_id,run_id,key||':reserve-long');
  FOR n IN 1..2 LOOP
   IF n=2 THEN run_id:=agent_api.begin_run('prospection',key||':long2',key||':long2'); END IF;
   SELECT * INTO iteration FROM agent_api.claim_prospect_iteration(campaign_id,prospect_id,NULL,run_id,key||':long-claim:'||n);
   IF iteration.iteration_number<>n OR iteration.total_iterations<>6 THEN RAISE EXCEPTION 'long_cycle_reset'; END IF;
   IF (agent_api.validate_prospect_iteration_sequence(iteration.iteration_run_id,run_id,short_sequence)->>'valid')::boolean THEN RAISE EXCEPTION 'long_cycle_truncated'; END IF;
   PERFORM agent_api.complete_prospect_iteration(iteration.iteration_run_id,run_id,long_sequence,key||':long-complete:'||n);
   PERFORM agent_api.complete_run(run_id,'completed','{}',NULL);
  END LOOP;
  IF (SELECT completed_iterations FROM app.prospect_iteration_states WHERE id=iteration.iteration_state_id)<>2 THEN RAISE EXCEPTION 'long_resume_not_persisted'; END IF;
  IF (SELECT count(*) FROM app.outbox_jobs)<>before_outbox THEN RAISE EXCEPTION 'outbound_job_created'; END IF;
  IF (SELECT md5(coalesce(jsonb_agg(to_jsonb(m) ORDER BY id)::text,'')) FROM app.email_messages m WHERE technical_confirmation)<>before_sent THEN RAISE EXCEPTION 'sent_history_changed'; END IF;
  IF has_table_privilege('prospection95_agent','app.prospect_iteration_runs','UPDATE')
    OR has_function_privilege('prospection95_agent','app.confirm_smtp_acceptance(uuid,uuid,text,timestamptz)','EXECUTE')
    THEN RAISE EXCEPTION 'agent_privileges_broadened'; END IF;
  RAISE SQLSTATE 'P9501' USING MESSAGE='fixture_complete_rollback';
 EXCEPTION WHEN SQLSTATE 'P9501' THEN NULL;
 END;
END $test$;
