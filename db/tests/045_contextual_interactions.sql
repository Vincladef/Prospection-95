-- Synthetic fixtures only, always rolled back. No outbound request or email.
DO $test$
#variable_conflict use_variable
DECLARE sender uuid;cid uuid;pid uuid;conv uuid;mid uuid;mid2 uuid;mid3 uuid;eid uuid;vid uuid;aid uuid;v record;s jsonb;s2 jsonb;created jsonb;created_id uuid;
 k text:='context045:'||gen_random_uuid();
BEGIN
 BEGIN
 SELECT id INTO sender FROM app.gmail_accounts WHERE status='active' AND credential_id IS NOT NULL LIMIT 1;
 INSERT INTO app.campaigns(name,status,sender_strategy,fixed_sender_account_id,tracking_opens_enabled,reading_time_enabled)
 VALUES(k,'inactive','fixed',sender,true,true) RETURNING id INTO cid;
 INSERT INTO app.prospects(full_name,email,contact_raw,contact_kind) VALUES(k,k||'@example.test',k||'@example.test','email') RETURNING id INTO pid;
 INSERT INTO app.experiments(campaign_id,name,idempotency_key) VALUES(cid,k,k) RETURNING id INTO eid;
 INSERT INTO app.experiment_variants(experiment_id,code) VALUES(eid,'A') RETURNING id INTO vid;
 INSERT INTO app.experiment_assignments(experiment_id,variant_id,prospect_id,campaign_id,assignment_key) VALUES(eid,vid,pid,cid,k) RETURNING id INTO aid;
 INSERT INTO app.conversations(campaign_id,prospect_id,sender_account_id,experiment_assignment_id) VALUES(cid,pid,sender,aid) RETURNING id INTO conv;
 INSERT INTO app.email_messages(conversation_id,direction,kind,sender_account_id,from_address,to_addresses,step,status,technical_confirmation,smtp_accepted_at,tracking_opens_enabled,reading_time_enabled)
 VALUES(conv,'outbound','prospection',sender,'sender@example.test',ARRAY[k||'@example.test'],'J0','smtp_accepted',true,clock_timestamp()-interval '1 day',true,true) RETURNING id INTO mid;

 INSERT INTO app.reading_sessions(message_id,client,state,legacy_excluded,ended_at) VALUES(mid,'proxy','proxy',true,clock_timestamp());
 s:=app.begin_reading_session_v2(mid,'proxy','gmail','proxy',true);
 IF (s->>'stream')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'proxy_excluded'; END IF;
 UPDATE app.reading_sessions SET started_at=clock_timestamp()-interval '7 seconds' WHERE id=(s->>'id')::uuid;
 PERFORM app.finish_reading_session((s->>'id')::uuid,'disconnected',7000);
 SELECT * INTO v FROM agent_api.reading_context_metrics WHERE variant_id=vid AND provider='gmail';
 IF v.samples IS DISTINCT FROM 1::numeric OR v.mean_seconds IS DISTINCT FROM 7::numeric OR v.probable_automation IS DISTINCT FROM true OR v.transport<>'proxy' THEN RAISE EXCEPTION 'noisy_context_lost'; END IF;
 IF (SELECT reading_time_seconds FROM agent_api.reading_metrics WHERE variant_id=vid) IS DISTINCT FROM 7::numeric THEN RAISE EXCEPTION 'noisy_duration_discarded'; END IF;
 s2:=app.begin_reading_session_v2(mid,'unverified','apple_possible','unknown',false);
 IF (s2->>'stream')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'unknown_client_excluded'; END IF;
 UPDATE app.reading_sessions SET started_at=clock_timestamp()-interval '50 seconds' WHERE id=(s2->>'id')::uuid;
 PERFORM app.finish_reading_session((s2->>'id')::uuid,'capped',50000);
 SELECT * INTO v FROM agent_api.reading_context_metrics WHERE variant_id=vid AND provider='apple_possible';
 IF v.capped_samples IS DISTINCT FROM 1::numeric OR v.mean_seconds IS NOT NULL THEN RAISE EXCEPTION 'censored_duration_invented'; END IF;
 PERFORM app.record_open_context(mid,'gmail','proxy',true);
 PERFORM app.record_open_context(mid,'gmail','proxy',true);
 SELECT * INTO v FROM agent_api.open_context_metrics WHERE variant_id=vid AND provider='gmail';
 IF v.requests IS DISTINCT FROM 2::numeric OR v.prospects<>1 THEN RAISE EXCEPTION 'opening_context_wrong'; END IF;
 UPDATE app.reading_budget SET daily_sessions=100,monthly_sessions=2000 WHERE singleton;
 s2:=app.begin_reading_session_v2(mid,'automated','outlook','unknown',true);
 IF (s2->>'stream')::boolean IS DISTINCT FROM false OR s2->>'reason'<>'budget' THEN RAISE EXCEPTION 'uncertain_clients_bypass_quota'; END IF;
 UPDATE app.campaigns SET tracking_opens_enabled=false WHERE id=cid;
 IF app.record_open_context(mid,'unknown','unknown',false) THEN RAISE EXCEPTION 'disabled_tracking_context_collected'; END IF;
 IF (app.begin_reading_session_v2(mid,'thunderbird','thunderbird','direct',false)->>'reason')<>'disabled' THEN RAISE EXCEPTION 'disabled_tracking_duration_collected'; END IF;
 RAISE SQLSTATE 'P9501';
 EXCEPTION WHEN SQLSTATE 'P9501' THEN NULL;
 END;
END;
$test$;
