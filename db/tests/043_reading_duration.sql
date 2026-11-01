-- Synthetic fixtures only, always rolled back. No outbound request or email.
DO $test$
#variable_conflict use_variable
DECLARE sender uuid;cid uuid;pid uuid;conv uuid;mid uuid;mid2 uuid;mid3 uuid;eid uuid;vid uuid;aid uuid;v record;s jsonb;s2 jsonb;created jsonb;created_id uuid;
 k text:='reading043:'||gen_random_uuid();
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
 -- A proxy never yields a fake 50s value or consumes a long-session allowance.
 s:=app.begin_reading_session(mid,'proxy');
 IF (s->>'stream')::boolean THEN RAISE EXCEPTION 'proxy_streamed'; END IF;
 SELECT * INTO v FROM agent_api.reading_metrics WHERE variant_id=vid;
 IF v.reading_time_seconds IS NOT NULL OR v.incompatible_messages<>1 THEN RAISE EXCEPTION 'proxy_fabricated_duration'; END IF;
 s:=app.begin_reading_session(mid,'thunderbird');
 IF NOT (s->>'stream')::boolean THEN RAISE EXCEPTION 'direct_measurement_not_started'; END IF;
 s2:=app.begin_reading_session(mid,'thunderbird');
 IF (s2->>'stream')::boolean OR s2->>'reason'<>'already_observed' THEN RAISE EXCEPTION 'replay_created_another_stream'; END IF;
 UPDATE app.reading_sessions SET started_at=clock_timestamp()-interval '7.4 seconds' WHERE id=(s->>'id')::uuid;
 IF NOT app.finish_reading_session((s->>'id')::uuid,'disconnected',7400) THEN RAISE EXCEPTION 'finish_missing'; END IF;
 IF app.finish_reading_session((s->>'id')::uuid,'disconnected',19000) THEN RAISE EXCEPTION 'finish_not_idempotent'; END IF;
 SELECT * INTO v FROM agent_api.reading_metrics WHERE variant_id=vid;
 IF v.reading_time_seconds<>7 OR v.samples<>1 OR v.measured_prospects<>1 OR v.incompatible_messages<>0 OR v.reliability<>'approximate' THEN RAISE EXCEPTION 'rounded_measurement_or_variant_wrong'; END IF;
 -- A follow-up to the same prospect cannot double their comparison weight.
 INSERT INTO app.email_messages(conversation_id,direction,kind,sender_account_id,from_address,to_addresses,step,status,technical_confirmation,smtp_accepted_at,tracking_opens_enabled,reading_time_enabled)
 VALUES(conv,'outbound','prospection',sender,'sender@example.test',ARRAY[k||'@example.test'],'R1','smtp_accepted',true,clock_timestamp(),true,true) RETURNING id INTO mid2;
 s2:=app.begin_reading_session(mid2,'thunderbird');
 UPDATE app.reading_sessions SET started_at=clock_timestamp()-interval '17 seconds' WHERE id=(s2->>'id')::uuid;
 PERFORM app.finish_reading_session((s2->>'id')::uuid,'disconnected',17000);
 SELECT * INTO v FROM agent_api.reading_metrics WHERE variant_id=vid;
 IF v.reading_time_seconds<>12 OR v.samples<>2 OR v.measured_prospects<>1 THEN RAISE EXCEPTION 'prospect_weight_duplicated'; END IF;
 -- The 50s ceiling is censored, not a claimed exact reading duration.
 INSERT INTO app.email_messages(conversation_id,direction,kind,sender_account_id,from_address,to_addresses,step,status,technical_confirmation,smtp_accepted_at,tracking_opens_enabled,reading_time_enabled)
 VALUES(conv,'outbound','prospection',sender,'sender@example.test',ARRAY[k||'@example.test'],'R2','smtp_accepted',true,clock_timestamp(),true,true) RETURNING id INTO mid3;
 s2:=app.begin_reading_session(mid3,'thunderbird');
 UPDATE app.reading_sessions SET started_at=clock_timestamp()-interval '50 seconds' WHERE id=(s2->>'id')::uuid;
 PERFORM app.finish_reading_session((s2->>'id')::uuid,'capped',50000);
 SELECT * INTO v FROM agent_api.reading_metrics WHERE variant_id=vid;
 IF v.reading_time_seconds<>12 OR v.capped_samples<>1 OR v.samples<>2 THEN RAISE EXCEPTION 'censored_in_exact_average'; END IF;
 -- A lost/far too late report cannot turn a timed-out request into a reading.
 s2:=app.begin_reading_session(mid2,'outlook_desktop');
 UPDATE app.reading_sessions SET started_at=clock_timestamp()-interval '2 minutes' WHERE id=(s2->>'id')::uuid;
 PERFORM app.finish_reading_session((s2->>'id')::uuid,'disconnected',10000);
 IF (SELECT state FROM app.reading_sessions WHERE id=(s2->>'id')::uuid)<>'transport_error' THEN RAISE EXCEPTION 'expired_report_accepted'; END IF;
 -- Budget exhaustion falls back to a static image; no SMTP behavior is changed.
 UPDATE app.reading_budget SET daily_sessions=100,monthly_sessions=2000 WHERE singleton;
 s2:=app.begin_reading_session(mid3,'outlook_desktop');
 IF (s2->>'stream')::boolean OR s2->>'reason'<>'budget' THEN RAISE EXCEPTION 'budget_not_enforced'; END IF;
 -- Reply emails keep the ordinary pixel; sequence duration budgets are not wasted.
 UPDATE app.email_messages SET kind='reply' WHERE id=mid;
 IF (app.begin_reading_session(mid,'outlook_desktop')->>'reason')<>'disabled' THEN RAISE EXCEPTION 'unanalysed_reply_consumed_budget'; END IF;
 UPDATE app.email_messages SET kind='prospection' WHERE id=mid;
 -- Current and frozen settings both gate collection; no historical reconstruction.
 UPDATE app.campaigns SET reading_time_enabled=false WHERE id=cid;
 IF (app.begin_reading_session(mid,'outlook_desktop')->>'reason')<>'disabled' THEN RAISE EXCEPTION 'disabled_campaign_collected'; END IF;
 UPDATE app.campaigns SET reading_time_enabled=true WHERE id=cid;
 UPDATE app.email_messages SET technical_confirmation=false WHERE id=mid;
 IF (app.begin_reading_session(mid,'outlook_desktop')->>'reason')<>'disabled' THEN RAISE EXCEPTION 'unsent_measured'; END IF;
 UPDATE app.email_messages SET technical_confirmation=true,reading_time_enabled=false WHERE id=mid;
 IF (app.begin_reading_session(mid,'outlook_desktop')->>'reason')<>'disabled' THEN RAISE EXCEPTION 'send_snapshot_ignored'; END IF;
 created:=crm_api.crm_campaign_create_v2(jsonb_build_object('campaign',jsonb_build_object('name',k||':config','status','inactive','senderStrategy','fixed','fixedSenderAccountId',sender,
   'readingTimeEnabled',true,'writingIterations','[""]'::jsonb,
   'sequence',jsonb_build_object('subject','','subjectInstructions','','steps','["","","","","",""]'::jsonb,'stepInstructions','["","","","","",""]'::jsonb))),k||':config');
 created_id:=(created->>'campaignId')::uuid;
 IF NOT EXISTS(SELECT 1 FROM app.campaigns WHERE id=created_id AND reading_time_enabled) THEN RAISE EXCEPTION 'crm_create_reading_flag_lost'; END IF;
 PERFORM crm_api.crm_campaign_update(created_id,(SELECT version FROM app.campaigns WHERE id=created_id),'{"readingTimeEnabled":false}');
 IF EXISTS(SELECT 1 FROM app.campaigns WHERE id=created_id AND reading_time_enabled) THEN RAISE EXCEPTION 'crm_update_reading_flag_lost'; END IF;
 RAISE SQLSTATE 'P9501';
 EXCEPTION WHEN SQLSTATE 'P9501' THEN NULL;
 END;
END;
$test$;
