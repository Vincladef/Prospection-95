-- Isolated Neon branch only; all changes roll back. No external email calls.
DO $test$
#variable_conflict use_variable
DECLARE cid uuid; pid uuid; sender uuid; conv uuid; inbound uuid; inbound2 uuid;
 run1 uuid; run2 uuid; claim jsonb; claim2 jsonb; result jsonb; wid uuid; output uuid; job app.outbox_jobs;
 k text := 'reply-fixture:'||gen_random_uuid(); caught boolean; original_due timestamptz; accepted_at timestamptz;
BEGIN
 BEGIN
 SELECT id INTO sender FROM app.gmail_accounts WHERE status='active' AND credential_id IS NOT NULL LIMIT 1;
 UPDATE app.campaigns SET status='inactive' WHERE status IN ('active','existing_only');
 UPDATE app.gmail_accounts SET timezone='UTC',send_days=ARRAY[1,2,3,4,5,6,7]::smallint[],send_start='00:00',send_end='23:59',daily_limit=100,warmup_daily_limit=100 WHERE id=sender;
 INSERT INTO app.campaigns(name,status,sender_strategy,fixed_sender_account_id,reply_iteration_instructions,reply_auto_scope)
 VALUES(k,'existing_only','fixed',sender,ARRAY['Première réponse','Affiner la réponse'],'all') RETURNING id INTO cid;
 INSERT INTO app.prospects(full_name,email,contact_raw,contact_kind) VALUES('Fixture',k||'@example.test',k||'@example.test','email') RETURNING id INTO pid;
 INSERT INTO app.conversations(campaign_id,prospect_id,sender_account_id) VALUES(cid,pid,sender) RETURNING id INTO conv;
 INSERT INTO app.email_messages(conversation_id,direction,kind,from_address,to_addresses,subject,body_text,status,received_at,internet_message_id)
 VALUES(conv,'inbound','reply',k||'@example.test',ARRAY['sender@example.test'],'Question','Bonjour, intéressé','received',clock_timestamp(),'<source-'||k||'>') RETURNING id INTO inbound;
 run1:=agent_api.begin_run('prospection',k||':1',k||':1');
 run2:=agent_api.begin_run('prospection',k||':2',k||':2');
 -- Unclassified messages must never receive automatic output.
 caught:=false;
 BEGIN PERFORM agent_api.claim_reply_iteration(inbound,run1,k||':blocked'); EXCEPTION WHEN raise_exception THEN caught:=SQLERRM='reply_source_not_eligible'; END;
 IF NOT caught THEN RAISE EXCEPTION 'unclassified_reply_allowed'; END IF;
 PERFORM agent_api.classify_response(inbound,'positive','positive',false,1,'Fixture',run1,k||':analysis');
 claim:=agent_api.claim_reply_iteration(inbound,run1,k||':claim1');
 wid:=(claim->>'workflowId')::uuid;
 PERFORM agent_api.complete_reply_iteration((claim->>'iterationRunId')::uuid,run1,'Re: Question','Réponse passe 1',k||':done1');
 claim2:=agent_api.claim_reply_iteration(inbound,run1,k||':same-run');
 IF claim2->>'iteration' <> '1' OR claim2->>'status'<>'completed' THEN RAISE EXCEPTION 'multiple_passes_same_run'; END IF;
 IF EXISTS(SELECT 1 FROM app.reply_draft_requests WHERE source_message_id=inbound) THEN RAISE EXCEPTION 'early_draft'; END IF;
 claim:=agent_api.claim_reply_iteration(inbound,run2,k||':claim2');
 IF claim->>'body'<>'Réponse passe 1' THEN RAISE EXCEPTION 'previous_reply_lost'; END IF;
 PERFORM agent_api.complete_reply_iteration((claim->>'iterationRunId')::uuid,run2,'Re: Question','Réponse finale',k||':done2');
 PERFORM agent_api.complete_reply_iteration((claim->>'iterationRunId')::uuid,run2,'Re: Question','Réponse finale',k||':done2');
 IF (SELECT count(*) FROM app.reply_draft_requests WHERE source_message_id=inbound)<>1 THEN RAISE EXCEPTION 'missing_or_duplicate_draft'; END IF;
 IF EXISTS(SELECT 1 FROM app.outbox_jobs WHERE conversation_id=conv) THEN RAISE EXCEPTION 'default_mode_sent_email'; END IF;
 IF (SELECT completed_iterations FROM app.reply_workflows WHERE id=wid)<>2 THEN RAISE EXCEPTION 'reply_pass_count_wrong'; END IF;
 -- A later message creates a distinct turn and supersedes the older pending draft.
 UPDATE app.campaigns SET reply_mode='automatic',reply_iteration_instructions=ARRAY['Réponse au nouvel échange'] WHERE id=cid;
 INSERT INTO app.email_messages(conversation_id,direction,kind,from_address,to_addresses,subject,body_text,status,received_at,internet_message_id)
 VALUES(conv,'inbound','reply',k||'@example.test',ARRAY['sender@example.test'],'Re: Question','Nouvelle question','received',clock_timestamp()+interval '1 second','<source2-'||k||'>') RETURNING id INTO inbound2;
 PERFORM agent_api.classify_response(inbound2,'information','neutral',false,1,'Fixture',run2,k||':analysis2');
 claim:=agent_api.claim_reply_iteration(inbound2,run2,k||':turn2');
 PERFORM agent_api.complete_reply_iteration((claim->>'iterationRunId')::uuid,run2,'Re: Question','Réponse automatique au nouvel échange',k||':done3');
 SELECT output_message_id,due_at INTO output,original_due FROM app.reply_workflows WHERE source_message_id=inbound2;
 PERFORM agent_api.complete_reply_iteration((claim->>'iterationRunId')::uuid,run2,'Re: Question','Réponse automatique au nouvel échange',k||':done3');
 IF (SELECT due_at FROM app.reply_workflows WHERE source_message_id=inbound2)<>original_due THEN RAISE EXCEPTION 'retry_changed_random_delay'; END IF;
 IF original_due<clock_timestamp()+interval '9 minutes 59 seconds' THEN RAISE EXCEPTION 'human_delay_not_enforced'; END IF;
 IF EXISTS(SELECT 1 FROM app.reply_draft_requests WHERE source_message_id=inbound2) THEN RAISE EXCEPTION 'automatic_created_draft'; END IF;
 SELECT * INTO job FROM app.outbox_jobs WHERE message_id=output;
 IF app.reply_job_is_ready(job.id) THEN RAISE EXCEPTION 'reply_eligible_before_delay'; END IF;
 -- Tests fast-forward only fixture timestamps. No SMTP function or network call is made.
 UPDATE app.reply_workflows SET due_at=clock_timestamp()-interval '1 second' WHERE source_message_id=inbound2;
 UPDATE app.outbox_jobs SET due_at=clock_timestamp()-interval '1 second' WHERE id=job.id;
 IF app.reply_job_is_ready(job.id) THEN RAISE EXCEPTION 'reply_allowed_before_sent_sync'; END IF;
 INSERT INTO app.imap_cursors(account_id,mailbox_name,caught_up_at) VALUES(sender,'__LIVE_SENT__',clock_timestamp())
 ON CONFLICT(account_id,mailbox_name) DO UPDATE SET caught_up_at=EXCLUDED.caught_up_at;
 IF NOT app.reply_job_is_ready(job.id) THEN RAISE EXCEPTION 'eligible_reply_blocked'; END IF;
 UPDATE app.campaigns SET status='inactive' WHERE id=cid;
 IF app.reply_job_is_ready(job.id) THEN RAISE EXCEPTION 'inactive_reply_allowed'; END IF;
 UPDATE app.campaigns SET status='existing_only' WHERE id=cid;
 INSERT INTO app.exclusions(match_type,match_value,reason,source,created_by)
 VALUES('email',k||'@example.test','Fixture','reply','fixture');
 IF app.reply_job_is_ready(job.id) THEN RAISE EXCEPTION 'excluded_reply_allowed'; END IF;
 UPDATE app.exclusions SET revoked_at=clock_timestamp() WHERE match_value=k||'@example.test';
 SELECT * INTO job FROM app.lease_outbox_jobs('reply-fixture',1,40);
 IF job.message_id IS DISTINCT FROM output THEN RAISE EXCEPTION 'reply_not_leased'; END IF;
 -- Simulate only the SMTP acknowledgement on an isolated fixture, never an external send.
 PERFORM app.start_outbox_attempt(job.id,job.lease_token);
 PERFORM app.confirm_smtp_acceptance(job.id,job.lease_token,'fixture-no-network',clock_timestamp());
 IF (SELECT state FROM app.reply_workflows WHERE source_message_id=inbound2)<>'sent' THEN RAISE EXCEPTION 'reply_confirmation_missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.conversations WHERE id=conv AND next_step_due_at IS NULL AND current_step='J0') THEN RAISE EXCEPTION 'reply_confirmation_resumed_sequence'; END IF;
 -- A third turn can use the same run, but owns another workflow.
 INSERT INTO app.email_messages(conversation_id,direction,kind,from_address,to_addresses,subject,body_text,status,received_at)
 VALUES(conv,'inbound','reply',k||'@example.test',ARRAY['sender@example.test'],'Suite','Encore une question','received',clock_timestamp()+interval '2 seconds') RETURNING id INTO inbound2;
 PERFORM agent_api.classify_response(inbound2,'information','neutral',false,1,'Fixture',run2,k||':analysis3');
 claim:=agent_api.claim_reply_iteration(inbound2,run2,k||':turn3');
 PERFORM agent_api.complete_reply_iteration((claim->>'iterationRunId')::uuid,run2,'Re: Suite','Autre réponse automatique',k||':done4');
 UPDATE app.campaigns SET reply_mode='draft' WHERE id=cid;
 IF (SELECT state FROM app.reply_workflows WHERE source_message_id=inbound2)<>'draft_requested' THEN RAISE EXCEPTION 'mode_change_not_withdrawn'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.reply_draft_requests WHERE source_message_id=inbound2 AND state='requested') THEN RAISE EXCEPTION 'mode_change_lost_reply'; END IF;
 -- Another automatic turn is cancelled if the prospect writes before SMTP.
 UPDATE app.campaigns SET reply_mode='automatic' WHERE id=cid;
 INSERT INTO app.email_messages(conversation_id,direction,kind,from_address,to_addresses,status,received_at)
 VALUES(conv,'inbound','reply',k||'@example.test',ARRAY['sender@example.test'],'received',clock_timestamp()+interval '3 seconds') RETURNING id INTO inbound2;
 PERFORM agent_api.classify_response(inbound2,'information','neutral',false,1,'Fixture',run2,k||':analysis4');
 claim:=agent_api.claim_reply_iteration(inbound2,run2,k||':turn4');
 PERFORM agent_api.complete_reply_iteration((claim->>'iterationRunId')::uuid,run2,'Re: Suite','Réponse à retirer',k||':done5');
 SELECT output_message_id INTO output FROM app.reply_workflows WHERE source_message_id=inbound2;
 UPDATE app.reply_workflows SET due_at=clock_timestamp()-interval '1 second' WHERE source_message_id=inbound2;
 UPDATE app.outbox_jobs SET due_at=clock_timestamp()-interval '1 second' WHERE message_id=output;
 UPDATE app.imap_cursors SET caught_up_at=clock_timestamp() WHERE account_id=sender AND mailbox_name='__LIVE_SENT__';
 SELECT * INTO job FROM app.lease_outbox_jobs('reply-fixture-2',1,40);
 IF job.message_id IS DISTINCT FROM output THEN RAISE EXCEPTION 'next_reply_not_leased'; END IF;
 -- A new inbound message arriving before SMTP withdraws the lease.
 INSERT INTO app.email_messages(conversation_id,direction,kind,from_address,to_addresses,status,received_at)
 VALUES(conv,'inbound','reply',k||'@example.test',ARRAY['sender@example.test'],'received',clock_timestamp()+interval '4 seconds') RETURNING id INTO inbound2;
 IF app.reply_job_is_ready(job.id) THEN RAISE EXCEPTION 'stale_reply_still_eligible'; END IF;
 IF (SELECT status FROM app.outbox_jobs WHERE id=job.id)<>'cancelled' THEN RAISE EXCEPTION 'stale_reply_not_cancelled'; END IF;
 PERFORM agent_api.classify_response(inbound2,'negative','negative',false,1,'Refus explicite de la fixture',run2,k||':negative');
 caught:=false;
 BEGIN PERFORM agent_api.claim_reply_iteration(inbound2,run2,k||':refused');
 EXCEPTION WHEN raise_exception THEN caught:=SQLERRM='reply_source_not_eligible'; END;
 IF NOT caught THEN RAISE EXCEPTION 'negative_reply_allowed'; END IF;
 IF (SELECT count(*) FROM app.reply_iteration_runs WHERE workflow_id=wid AND status='completed')<>2 THEN RAISE EXCEPTION 'history_lost'; END IF;
 caught:=false;
 BEGIN UPDATE app.reply_iteration_runs SET body='Retouche interdite' WHERE workflow_id=wid AND status='completed';
 EXCEPTION WHEN SQLSTATE '55000' THEN caught:=true; END;
 IF NOT caught THEN RAISE EXCEPTION 'history_mutable'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.conversations WHERE id=conv AND followups_stopped_at IS NOT NULL AND next_step_due_at IS NULL) THEN RAISE EXCEPTION 'followups_resumed'; END IF;
 RAISE SQLSTATE 'P9501';
 EXCEPTION WHEN SQLSTATE 'P9501' THEN NULL;
 END;
END;
$test$;
