-- Isolated validation branch only. All fixtures roll back; no network or SMTP.
DO $test$
#variable_conflict use_variable
DECLARE sender uuid; cid uuid; pid uuid; conv uuid; j0 uuid; followup uuid; job app.outbox_jobs;
 source1 uuid; source2 uuid; source3 uuid; output_id uuid; run_id uuid; claim jsonb; draft_id uuid; manual_id uuid;
 k text:='reply-reliability:'||gen_random_uuid(); caught boolean; at0 timestamptz:=clock_timestamp()-interval '1 hour';
BEGIN
 BEGIN
 SELECT id INTO sender FROM app.gmail_accounts WHERE status='active' AND credential_id IS NOT NULL LIMIT 1;
 UPDATE app.campaigns SET status='inactive' WHERE status IN ('active','existing_only');
 UPDATE app.gmail_accounts SET timezone='UTC',send_days=ARRAY[1,2,3,4,5,6,7]::smallint[],send_start='00:00',send_end='23:59',daily_limit=100,warmup_daily_limit=100 WHERE id=sender;
 INSERT INTO app.campaigns(name,status,sender_strategy,fixed_sender_account_id,reply_mode,reply_iteration_instructions)
 VALUES(k,'existing_only','fixed',sender,'draft',ARRAY['Répondre']) RETURNING id INTO cid;
 INSERT INTO app.prospects(full_name,email,contact_raw,contact_kind) VALUES('Fixture',k||'@example.test',k||'@example.test','email') RETURNING id INTO pid;
 INSERT INTO app.conversations(campaign_id,prospect_id,sender_account_id,created_at) VALUES(cid,pid,sender,at0) RETURNING id INTO conv;
 INSERT INTO app.email_messages(conversation_id,direction,kind,sender_account_id,from_address,to_addresses,step,subject,body_text,status,sent_at,smtp_accepted_at,technical_confirmation,internet_message_id)
 VALUES(conv,'outbound','prospection',sender,'sender@example.test',ARRAY[k||'@example.test'],'J0','Sujet','Message','smtp_accepted',at0,at0,true,'<original-'||k||'>') RETURNING id INTO j0;
 -- A replay of the app's own Sent copy must not become a manual reply or stop its sequence.
 PERFORM app.record_sent_message(sender,conv,'sender@example.test',ARRAY[k||'@example.test'],'Sujet','Message',NULL,'<original-'||k||'>',NULL,'{}','__SENT__',987654321,10,at0,'{}');
 IF EXISTS(SELECT 1 FROM app.conversations WHERE id=conv AND followups_stopped_at IS NOT NULL) THEN RAISE EXCEPTION 'own_sent_copy_stopped_sequence'; END IF;
 IF (SELECT count(*) FROM app.email_messages WHERE conversation_id=conv)<>1 THEN RAISE EXCEPTION 'own_sent_copy_duplicated'; END IF;
 INSERT INTO app.email_messages(conversation_id,direction,kind,sender_account_id,from_address,to_addresses,step,subject,body_text,status)
 VALUES(conv,'outbound','prospection',sender,'sender@example.test',ARRAY[k||'@example.test'],'R1','Re: Sujet','Relance','scheduled') RETURNING id INTO followup;
 INSERT INTO app.outbox_jobs(message_id,conversation_id,campaign_id,prospect_id,account_id,step,job_kind,status,approval_required,due_at,idempotency_key)
 VALUES(followup,conv,cid,pid,sender,'R1','prospection','scheduled',false,clock_timestamp()-interval '1 second',k||':r1');
 SELECT * INTO job FROM app.lease_outbox_jobs(k,1,180);
 IF job.message_id IS DISTINCT FROM followup THEN RAISE EXCEPTION 'followup_not_leased'; END IF;
 job:=app.start_outbox_attempt(job.id,job.lease_token);
 IF job.status<>'deferred' OR EXISTS(SELECT 1 FROM app.outbox_attempts WHERE job_id=job.id) THEN RAISE EXCEPTION 'followup_started_without_gmail_check'; END IF;
 UPDATE app.outbox_jobs SET due_at=clock_timestamp()-interval '1 second' WHERE id=job.id;
 SELECT * INTO job FROM app.lease_outbox_jobs(k,1,180);
 -- Initial ingestion before association, then replay with the right thread.
 source1:=(app.record_inbound_message(sender,NULL,'unrelated',k||'@example.test',ARRAY['sender@example.test'],'Re: Sujet','Question',NULL,'{}','<reply-'||k||'>',NULL,'{}',NULL,NULL,'__LIVE_ALL__',987654321,99,NULL,at0+interval '10 minutes','{}')).id;
 IF EXISTS(SELECT 1 FROM app.imap_cursors WHERE account_id=sender AND mailbox_name='__LIVE_ALL__' AND last_uid=99) THEN RAISE EXCEPTION 'per_message_cursor_advanced'; END IF;
 PERFORM app.record_inbound_message(sender,conv,'reply',k||'@example.test',ARRAY['sender@example.test'],'Re: Sujet','Question',NULL,'{}','<reply-'||k||'>',NULL,'{}',NULL,NULL,'INBOX',987654321,5,NULL,at0+interval '10 minutes','{}');
 IF NOT EXISTS(SELECT 1 FROM app.email_messages WHERE id=source1 AND conversation_id=conv AND kind='reply') THEN RAISE EXCEPTION 'unassociated_reply_not_repaired'; END IF;
 IF (SELECT count(*) FROM app.email_messages WHERE internet_message_id='<reply-'||k||'>')<>1 THEN RAISE EXCEPTION 'replayed_reply_duplicated'; END IF;
 IF (SELECT status FROM app.outbox_jobs WHERE id=job.id)<>'cancelled' OR (SELECT status FROM app.email_messages WHERE id=followup)<>'cancelled' THEN RAISE EXCEPTION 'late_reply_not_cancelled'; END IF;
 IF EXISTS(SELECT 1 FROM app.outbox_attempts WHERE job_id=job.id) THEN RAISE EXCEPTION 'smtp_after_reply'; END IF;
 run_id:=agent_api.begin_run('prospection',k,k);
 PERFORM agent_api.classify_response(source1,'information','neutral',false,1,'Fixture',run_id,k||':analysis');
 claim:=agent_api.claim_reply_iteration(source1,run_id,k||':claim');
 PERFORM agent_api.complete_reply_iteration((claim->>'iterationRunId')::uuid,run_id,'Re: Sujet','Réponse proposée',k||':complete');
 SELECT id INTO draft_id FROM app.reply_draft_requests WHERE source_message_id=source1;
 UPDATE app.reply_draft_requests SET state='created' WHERE id=draft_id;
 manual_id:=(app.record_sent_message(sender,conv,'sender@example.test',ARRAY[k||'@example.test'],'Re: Sujet','Réponse manuelle conservée',NULL,'<manual-'||k||'>','<reply-'||k||'>','{}','__SENT__',987654321,101,at0+interval '20 minutes','{}')).id;
 IF (SELECT state FROM app.reply_draft_requests WHERE id=draft_id)<>'sent_manually' THEN RAISE EXCEPTION 'sent_draft_not_reconciled'; END IF;
 IF (SELECT state FROM app.reply_workflows WHERE source_message_id=source1)<>'sent' OR app.reply_source_is_current(source1) THEN RAISE EXCEPTION 'manual_reply_not_settled'; END IF;
 IF (SELECT count(*) FROM app.reply_iteration_runs WHERE workflow_id=(claim->>'workflowId')::uuid AND status='completed')<>1 THEN RAISE EXCEPTION 'ai_history_lost'; END IF;
 -- A further inbound is a new exchange; replaying the older Sent does not settle it.
 source2:=(app.record_inbound_message(sender,conv,'reply',k||'@example.test',ARRAY['sender@example.test'],'Suite','Autre question',NULL,'{}','<reply2-'||k||'>','<manual-'||k||'>','{}',NULL,NULL,'INBOX',987654321,6,NULL,at0+interval '30 minutes','{}')).id;
 PERFORM agent_api.classify_response(source2,'information','neutral',false,1,'Fixture',run_id,k||':analysis2');
 claim:=agent_api.claim_reply_iteration(source2,run_id,k||':claim2');
 PERFORM agent_api.complete_reply_iteration((claim->>'iterationRunId')::uuid,run_id,'Re: Suite','Deuxième réponse',k||':complete2');
 PERFORM app.record_sent_message(sender,conv,'sender@example.test',ARRAY[k||'@example.test'],'Re: Sujet','Réponse manuelle conservée',NULL,'<manual-'||k||'>','<reply-'||k||'>','{}','__LIVE_SENT__',987654321,102,at0+interval '20 minutes','{}');
 IF NOT app.reply_source_is_current(source2) THEN RAISE EXCEPTION 'new_exchange_blocked_by_old_send'; END IF;
 IF (SELECT count(*) FROM app.email_messages WHERE id=manual_id AND body_text='Réponse manuelle conservée')<>1 THEN RAISE EXCEPTION 'manual_content_changed'; END IF;
 SELECT id INTO draft_id FROM app.reply_draft_requests WHERE source_message_id=source2;
 UPDATE app.reply_draft_requests SET state='created' WHERE id=draft_id;
 -- A newer human message obsoletes an already-created Gmail draft in tracking.
 source3:=(app.record_inbound_message(sender,conv,'reply',k||'@example.test',ARRAY['sender@example.test'],'Suite','Précision',NULL,'{}','<reply3-'||k||'>',NULL,'{}',NULL,NULL,'INBOX',987654321,7,NULL,at0+interval '40 minutes','{}')).id;
 IF (SELECT state FROM app.reply_draft_requests WHERE id=draft_id)<>'stale' THEN RAISE EXCEPTION 'created_draft_not_marked_obsolete'; END IF;
 -- Queue an automatic reply for the newest exchange.
 UPDATE app.campaigns SET reply_mode='automatic',reply_auto_scope='all' WHERE id=cid;
 PERFORM agent_api.classify_response(source3,'information','neutral',false,1,'Fixture',run_id,k||':analysis3');
 claim:=agent_api.claim_reply_iteration(source3,run_id,k||':claim3');
 PERFORM agent_api.complete_reply_iteration((claim->>'iterationRunId')::uuid,run_id,'Re: Suite','Réponse automatique',k||':complete3');
 SELECT output_message_id INTO output_id FROM app.reply_workflows WHERE source_message_id=source3;
 UPDATE app.reply_workflows SET due_at=clock_timestamp()-interval '1 second' WHERE source_message_id=source3;
 UPDATE app.outbox_jobs SET due_at=clock_timestamp()-interval '1 second' WHERE message_id=output_id;
 SELECT * INTO job FROM app.lease_outbox_jobs(k,1,180);
 IF job.message_id IS DISTINCT FROM output_id THEN RAISE EXCEPTION 'automatic_reply_not_leased'; END IF;
 -- Late historical mail cannot move the latest-reply timestamp backwards.
 PERFORM app.record_inbound_message(sender,conv,'reply',k||'@example.test',ARRAY['sender@example.test'],'Ancien','Ancien message',NULL,'{}','<old-'||k||'>',NULL,'{}',NULL,NULL,'INBOX',987654321,8,NULL,at0+interval '5 minutes','{}');
 IF (SELECT last_inbound_at FROM app.conversations WHERE id=conv)<>at0+interval '40 minutes' THEN RAISE EXCEPTION 'last_inbound_regressed'; END IF;
 IF (SELECT status FROM app.outbox_jobs WHERE id=job.id)<>'reserved' THEN RAISE EXCEPTION 'old_inbound_cancelled_newer_reply'; END IF;
 UPDATE app.outbox_jobs SET mailbox_checked_at=clock_timestamp(),mailbox_check_token=job.lease_token WHERE id=job.id;
 UPDATE app.email_messages SET internet_message_id='<output-'||k||'>' WHERE id=output_id;
 PERFORM app.start_outbox_attempt(job.id,job.lease_token);
 PERFORM app.mark_smtp_uncertain(job.id,job.lease_token,'fixture_timeout',NULL);
 -- The prospect can write again while a previous SMTP attempt is ambiguous.
 PERFORM app.record_inbound_message(sender,conv,'reply',k||'@example.test',ARRAY['sender@example.test'],'Suite','Dernière question',NULL,'{}','<reply4-'||k||'>',NULL,'{}',NULL,NULL,'INBOX',987654321,9,NULL,at0+interval '50 minutes','{}');
 PERFORM app.record_sent_message(sender,conv,'sender@example.test',ARRAY[k||'@example.test'],'Re: Suite','Réponse automatique',NULL,'<output-'||k||'>','<reply3-'||k||'>','{}','__SENT__',987654321,103,at0+interval '45 minutes','{}');
 IF (SELECT status FROM app.outbox_jobs WHERE id=job.id)<>'completed' OR NOT (SELECT technical_confirmation FROM app.email_messages WHERE id=output_id) THEN RAISE EXCEPTION 'sent_proof_not_reconciled'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.conversations WHERE id=conv AND state='replied' AND followups_stopped_at IS NOT NULL AND next_step_due_at IS NULL) THEN RAISE EXCEPTION 'sent_proof_resumed_followups'; END IF;
 IF EXISTS(SELECT 1 FROM app.email_messages WHERE conversation_id=conv AND kind='manual' AND internet_message_id='<output-'||k||'>') THEN RAISE EXCEPTION 'automatic_sent_became_manual_duplicate'; END IF;
 RAISE SQLSTATE 'P9501';
 EXCEPTION WHEN SQLSTATE 'P9501' THEN NULL;
 END;
END;
$test$;
