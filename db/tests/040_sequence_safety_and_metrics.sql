-- Isolated Neon branch. Every fixture rolls back; no external SMTP.
DO $test$
#variable_conflict use_variable
DECLARE sender uuid; sender2 uuid; cid uuid; pid uuid; conv uuid; j0 uuid; r1 uuid; r2 uuid; job app.outbox_jobs;
 eid uuid; va uuid; vb uuid; aid uuid; src uuid; run_id uuid; metrics record; at0 timestamptz:=clock_timestamp()-interval '20 minutes';
 k text:='safety040:'||gen_random_uuid(); p2 uuid; c2 uuid; m2 uuid;
BEGIN
 BEGIN
 SELECT id INTO sender FROM app.gmail_accounts WHERE status='active' AND credential_id IS NOT NULL LIMIT 1;
 UPDATE app.campaigns SET status='inactive' WHERE status IN ('active','existing_only');
 UPDATE app.gmail_accounts SET timezone='UTC',send_days=ARRAY[1,2,3,4,5,6,7]::smallint[],send_start='00:00',send_end='23:59',daily_limit=100,warmup_daily_limit=100 WHERE id=sender;
 INSERT INTO app.campaigns(name,status,sender_strategy,fixed_sender_account_id) VALUES(k,'active','fixed',sender) RETURNING id INTO cid;
 INSERT INTO app.prospects(full_name,email,contact_raw,contact_kind) VALUES(k,k||'@example.test',k||'@example.test','email') RETURNING id INTO pid;
 INSERT INTO app.conversations(campaign_id,prospect_id,sender_account_id,created_at) VALUES(cid,pid,sender,at0) RETURNING id INTO conv;
 INSERT INTO app.email_messages(conversation_id,direction,kind,sender_account_id,from_address,to_addresses,step,status,smtp_accepted_at,sent_at,technical_confirmation)
 VALUES(conv,'outbound','prospection',sender,'sender@example.test',ARRAY[k||'@example.test'],'J0','smtp_accepted',at0,at0,true) RETURNING id INTO j0;
 INSERT INTO app.email_messages(conversation_id,direction,kind,sender_account_id,from_address,to_addresses,step,status)
 VALUES(conv,'outbound','prospection',sender,'sender@example.test',ARRAY[k||'@example.test'],'R1','scheduled') RETURNING id INTO r1;
 INSERT INTO app.outbox_jobs(message_id,conversation_id,campaign_id,prospect_id,account_id,step,job_kind,status,approval_required,due_at,idempotency_key)
 VALUES(r1,conv,cid,pid,sender,'R1','prospection','scheduled',false,clock_timestamp(),k||':early') RETURNING * INTO job;
 IF job.due_at<at0+interval '3 days' THEN RAISE EXCEPTION 'manual_schedule_bypassed_delay'; END IF;
 IF EXISTS(SELECT 1 FROM app.lease_outbox_jobs(k,1,300) WHERE id=job.id) THEN RAISE EXCEPTION 'early_followup_leased'; END IF;
 UPDATE app.outbox_jobs SET status='reserved',lease_owner=k,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '5 minutes',attempt_count=1 WHERE id=job.id RETURNING * INTO job;
 UPDATE app.outbox_jobs SET mailbox_checked_at=clock_timestamp(),mailbox_check_token=job.lease_token WHERE id=job.id;
 job:=app.start_outbox_attempt(job.id,job.lease_token);
 IF job.status<>'deferred' OR EXISTS(SELECT 1 FROM app.outbox_attempts WHERE job_id=job.id) THEN RAISE EXCEPTION 'early_smtp_attempt'; END IF;
 INSERT INTO app.email_messages(conversation_id,direction,kind,sender_account_id,from_address,to_addresses,step,status)
 VALUES(conv,'outbound','prospection',sender,'sender@example.test',ARRAY[k||'@example.test'],'R2','approved') RETURNING id INTO r2;
 IF app.prospection_message_is_eligible(r2) OR app.prospection_earliest_at(r2) IS NOT NULL THEN RAISE EXCEPTION 'missing_previous_step_allowed'; END IF;
 UPDATE app.conversations SET followups_stopped_at=clock_timestamp(),followups_stop_reason='manual_outbound',state='active' WHERE id=conv;
 IF app.prospection_message_is_eligible(r1) OR (SELECT state FROM app.conversations WHERE id=conv)='active' THEN RAISE EXCEPTION 'stopped_conversation_active'; END IF;
 UPDATE app.outbox_jobs SET status='scheduled' WHERE id=job.id RETURNING * INTO job;
 IF job.status<>'cancelled' THEN RAISE EXCEPTION 'stopped_manual_schedule_survived'; END IF;

 INSERT INTO app.experiments(campaign_id,name,status,contacts_per_variant_threshold,total_responses_threshold,idempotency_key)
 VALUES(cid,k,'recruiting',2,2,k) RETURNING id INTO eid;
 INSERT INTO app.experiment_variants(experiment_id,code) VALUES(eid,'A') RETURNING id INTO va;
 INSERT INTO app.experiment_variants(experiment_id,code) VALUES(eid,'B') RETURNING id INTO vb;
 INSERT INTO app.experiment_assignments(experiment_id,variant_id,prospect_id,campaign_id,assignment_key) VALUES(eid,va,pid,cid,k||':A') RETURNING id INTO aid;
 UPDATE app.conversations SET experiment_assignment_id=aid WHERE id=conv;
 IF (SELECT exposed_at FROM app.experiment_variants WHERE id=va) IS NOT NULL THEN RAISE EXCEPTION 'draft_assignment_exposed'; END IF;
 -- Reconcile an actual fixture acknowledgement; only now the variant is exposed.
 UPDATE app.email_messages SET technical_confirmation=true WHERE id=j0;
 UPDATE app.email_messages SET status='smtp_accepted',technical_confirmation=true,smtp_accepted_at=at0+interval '3 days',sent_at=at0+interval '3 days' WHERE id=r1;
 UPDATE app.email_messages SET status='smtp_accepted',technical_confirmation=true,smtp_accepted_at=at0+interval '10 days',sent_at=at0+interval '10 days' WHERE id=r2;
 IF (SELECT exposed_at FROM app.experiment_variants WHERE id=va) IS DISTINCT FROM at0 THEN RAISE EXCEPTION 'real_exposure_missing'; END IF;
 IF app.prospection_earliest_at(r2) IS DISTINCT FROM at0+interval '10 days' THEN RAISE EXCEPTION 'r2_delay_wrong'; END IF;
 INSERT INTO app.email_messages(conversation_id,direction,kind,from_address,to_addresses,status,received_at)
 VALUES(conv,'inbound','reply',k||'@example.test',ARRAY['sender@example.test'],'received',at0+interval '11 days') RETURNING id INTO src;
 run_id:=agent_api.begin_run('prospection',k,k);
 PERFORM agent_api.classify_response(src,'positive','positive',false,1,'Fixture',run_id,k||':response1');
 INSERT INTO app.email_messages(conversation_id,direction,kind,from_address,to_addresses,status,received_at)
 VALUES(conv,'inbound','reply',k||'@example.test',ARRAY['sender@example.test'],'received',at0+interval '12 days') RETURNING id INTO src;
 PERFORM agent_api.classify_response(src,'information','neutral',false,1,'Fixture',run_id,k||':response2');
 SELECT * INTO metrics FROM agent_api.experiment_metrics WHERE variant_id=va;
 IF metrics.smtp_accepted<>3 OR metrics.contacted_prospects<>1 OR metrics.replied_prospects<>1 THEN RAISE EXCEPTION 'unique_prospect_metrics_wrong'; END IF;
 INSERT INTO app.prospects(full_name,email,contact_raw,contact_kind) VALUES(k||'metricB',k||'metricB@example.test',k||'metricB@example.test','email') RETURNING id INTO p2;
 INSERT INTO app.experiment_assignments(experiment_id,variant_id,prospect_id,campaign_id,assignment_key) VALUES(eid,vb,p2,cid,k||':B') RETURNING id INTO aid;
 INSERT INTO app.conversations(campaign_id,prospect_id,sender_account_id,experiment_assignment_id) VALUES(cid,p2,sender,aid) RETURNING id INTO c2;
 INSERT INTO app.email_messages(conversation_id,direction,kind,sender_account_id,from_address,to_addresses,step,status,smtp_accepted_at,sent_at,technical_confirmation)
 SELECT c2,'outbound','prospection',sender,'sender@example.test',ARRAY[k||'metricB@example.test'],step,'smtp_accepted',at0,at0,true
 FROM unnest(ARRAY['J0','R1','R2']::app.sequence_step[]) step;
 INSERT INTO app.email_messages(conversation_id,direction,kind,from_address,to_addresses,status,received_at)
 VALUES(c2,'inbound','reply',k||'metricB@example.test',ARRAY['sender@example.test'],'received',at0+interval '1 minute') RETURNING id INTO src;
 PERFORM agent_api.classify_response(src,'information','neutral',false,1,'Fixture',run_id,k||':Bresponse');
 IF agent_api.advance_experiment(eid,run_id,k||':advance')<>'recruiting' THEN RAISE EXCEPTION 'email_count_advanced_threshold'; END IF;

 -- Fair dispatch: both accounts have eligible work, the less-used one goes first.
 INSERT INTO app.gmail_accounts(email,role,status,credential_id,timezone,send_days,send_start,send_end,daily_limit)
 SELECT k||'@gmail.test',role,'active',credential_id,'UTC',ARRAY[1,2,3,4,5,6,7]::smallint[],'00:00','23:59',100 FROM app.gmail_accounts WHERE id=sender RETURNING id INTO sender2;
 INSERT INTO app.prospects(full_name,email,contact_raw,contact_kind) VALUES(k||'2',k||'2@example.test',k||'2@example.test','email') RETURNING id INTO p2;
 INSERT INTO app.conversations(campaign_id,prospect_id,sender_account_id) VALUES(cid,p2,sender2) RETURNING id INTO c2;
 INSERT INTO app.email_messages(conversation_id,direction,kind,sender_account_id,from_address,to_addresses,step,status)
 VALUES(c2,'outbound','prospection',sender2,k||'@gmail.test',ARRAY[k||'2@example.test'],'J0','scheduled') RETURNING id INTO m2;
 INSERT INTO app.outbox_jobs(message_id,conversation_id,campaign_id,prospect_id,account_id,step,job_kind,status,approval_required,due_at,idempotency_key)
 VALUES(m2,c2,cid,p2,sender2,'J0','prospection','scheduled',false,clock_timestamp()-interval '1 second',k||':Bsend');
 -- Reuse first account's campaign with another, untouched prospect.
 INSERT INTO app.prospects(full_name,email,contact_raw,contact_kind) VALUES(k||'3',k||'3@example.test',k||'3@example.test','email') RETURNING id INTO p2;
 INSERT INTO app.conversations(campaign_id,prospect_id,sender_account_id) VALUES(cid,p2,sender) RETURNING id INTO c2;
 INSERT INTO app.email_messages(conversation_id,direction,kind,sender_account_id,from_address,to_addresses,step,status)
 VALUES(c2,'outbound','prospection',sender,'sender@example.test',ARRAY[k||'3@example.test'],'J0','scheduled') RETURNING id INTO m2;
 INSERT INTO app.outbox_jobs(message_id,conversation_id,campaign_id,prospect_id,account_id,step,job_kind,status,approval_required,due_at,idempotency_key)
 VALUES(m2,c2,cid,p2,sender,'J0','prospection','scheduled',false,clock_timestamp()-interval '2 days',k||':Asend');
 SELECT * INTO job FROM app.lease_outbox_jobs(k,1,300);
 IF job.account_id IS DISTINCT FROM sender2 THEN RAISE EXCEPTION 'old_backlog_starves_other_account'; END IF;
 job:=app.start_outbox_attempt(job.id,job.lease_token);
 IF NOT app.outbox_commit_is_ready(job.id,job.lease_token) THEN RAISE EXCEPTION 'valid_commit_blocked'; END IF;
 UPDATE app.gmail_accounts SET paused_at=clock_timestamp(),pause_reason='Fixture',pause_source='manual' WHERE id=sender2;
 IF app.outbox_commit_is_ready(job.id,job.lease_token) THEN RAISE EXCEPTION 'paused_account_commit_allowed'; END IF;
 RAISE SQLSTATE 'P9501';
 EXCEPTION WHEN SQLSTATE 'P9501' THEN NULL;
 END;
END;
$test$;
