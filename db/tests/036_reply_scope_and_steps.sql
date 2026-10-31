-- Branch only; no external calls; every fixture change rolls back.
DO $test$
#variable_conflict use_variable
DECLARE cid uuid; pid uuid; sender uuid; conv uuid; src uuid; run_id uuid; claim jsonb; out_id uuid; job_id uuid;
 k text:='scope-fixture:'||gen_random_uuid(); payload jsonb; result jsonb; eid uuid; vid uuid; aid uuid;
BEGIN
 BEGIN
 SELECT id INTO sender FROM app.gmail_accounts WHERE status='active' AND credential_id IS NOT NULL LIMIT 1;
 INSERT INTO app.campaigns(name,status,sender_strategy,fixed_sender_account_id,reply_mode,reply_instructions,reply_iteration_instructions)
 VALUES(k,'existing_only','fixed',sender,'automatic','Consigne générale',ARRAY['Rédiger la réponse']) RETURNING id INTO cid;
 IF NOT EXISTS(SELECT 1 FROM app.campaigns WHERE id=cid AND reply_auto_scope='first' AND reply_instructions=''
    AND reply_iteration_instructions=ARRAY[E'Consigne générale\n\nRédiger la réponse'] AND tracking_opens_enabled AND tracking_clicks_enabled) THEN RAISE EXCEPTION 'campaign_defaults_or_normalization_failed'; END IF;
 INSERT INTO app.prospects(full_name,email,contact_raw,contact_kind) VALUES('Scope fixture',k||'@example.test',k||'@example.test','email') RETURNING id INTO pid;
 INSERT INTO app.conversations(campaign_id,prospect_id,sender_account_id) VALUES(cid,pid,sender) RETURNING id INTO conv;
 INSERT INTO app.instruction_attachments(scope_type,campaign_id,field_key,filename,content_type,size_bytes,blob_key,extracted_text,created_by)
 VALUES('campaign',cid,'reply','contexte.txt','text/plain',20,k,'Contexte de réponse vérifiable','fixture');
 run_id:=agent_api.begin_run('prospection',k,k);
 INSERT INTO app.email_messages(conversation_id,direction,kind,from_address,to_addresses,status,received_at)
 VALUES(conv,'inbound','reply',k||'@example.test',ARRAY['sender@example.test'],'received',clock_timestamp()) RETURNING id INTO src;
 PERFORM agent_api.classify_response(src,'information','neutral',false,1,'Fixture',run_id,k||':analysis1');
 claim:=agent_api.claim_reply_iteration(src,run_id,k||':claim1');
 IF claim->>'replyMode'<>'automatic' OR claim->>'instruction'<>E'Consigne générale\n\nRédiger la réponse'
    OR NOT (claim->'replyAttachments' @> '[{"filename":"contexte.txt","text":"Contexte de réponse vérifiable"}]') THEN RAISE EXCEPTION 'first_reply_context_incorrect'; END IF;
 PERFORM agent_api.complete_reply_iteration((claim->>'iterationRunId')::uuid,run_id,'Re: fixture','Première réponse',k||':complete1');
 SELECT output_message_id INTO out_id FROM app.reply_workflows WHERE source_message_id=src;
 IF out_id IS NULL THEN RAISE EXCEPTION 'first_reply_not_automatic'; END IF;
 UPDATE app.campaigns SET reply_auto_scope='all' WHERE id=cid;
 UPDATE app.campaigns SET reply_auto_scope='first' WHERE id=cid;
 IF (SELECT state FROM app.reply_workflows WHERE source_message_id=src)<>'queued' THEN RAISE EXCEPTION 'scope_withdrew_first_reply'; END IF;
 -- A second inbound turn must be a draft, even if scope is later broadened.
 INSERT INTO app.email_messages(conversation_id,direction,kind,from_address,to_addresses,status,received_at)
 VALUES(conv,'inbound','reply',k||'@example.test',ARRAY['sender@example.test'],'received',clock_timestamp()+interval '1 second') RETURNING id INTO src;
 PERFORM agent_api.classify_response(src,'information','neutral',false,1,'Fixture',run_id,k||':analysis2');
 claim:=agent_api.claim_reply_iteration(src,run_id,k||':claim2');
 IF claim->>'replyMode'<>'draft' THEN RAISE EXCEPTION 'second_exchange_would_send'; END IF;
 UPDATE app.campaigns SET reply_auto_scope='all' WHERE id=cid;
 PERFORM agent_api.complete_reply_iteration((claim->>'iterationRunId')::uuid,run_id,'Re: suite','Deuxième réponse',k||':complete2');
 IF NOT EXISTS(SELECT 1 FROM app.reply_draft_requests WHERE source_message_id=src AND state='requested') THEN RAISE EXCEPTION 'second_exchange_not_draft'; END IF;
 -- All exchanges still allows later automation; restricting it withdraws only unsent later replies.
 INSERT INTO app.email_messages(conversation_id,direction,kind,from_address,to_addresses,status,received_at)
 VALUES(conv,'inbound','reply',k||'@example.test',ARRAY['sender@example.test'],'received',clock_timestamp()+interval '2 seconds') RETURNING id INTO src;
 PERFORM agent_api.classify_response(src,'information','neutral',false,1,'Fixture',run_id,k||':analysis3');
 claim:=agent_api.claim_reply_iteration(src,run_id,k||':claim3');
 IF claim->>'replyMode'<>'automatic' THEN RAISE EXCEPTION 'all_scope_not_automatic'; END IF;
 PERFORM agent_api.complete_reply_iteration((claim->>'iterationRunId')::uuid,run_id,'Re: suite','Troisième réponse',k||':complete3');
 SELECT j.id INTO job_id FROM app.reply_workflows w JOIN app.outbox_jobs j ON j.message_id=w.output_message_id WHERE w.source_message_id=src;
 UPDATE app.campaigns SET reply_auto_scope='first' WHERE id=cid;
 IF (SELECT status FROM app.outbox_jobs WHERE id=job_id)<>'cancelled' OR NOT EXISTS(SELECT 1 FROM app.reply_draft_requests WHERE source_message_id=src) THEN RAISE EXCEPTION 'restrict_scope_failed_to_withdraw'; END IF;
 -- The legacy field maps to step one; repeated patches must not duplicate text.
 PERFORM crm_api.crm_campaign_update(cid,(SELECT version FROM app.campaigns WHERE id=cid),'{"replyInstructions":"Consigne mise à jour"}');
 PERFORM crm_api.crm_campaign_update(cid,(SELECT version FROM app.campaigns WHERE id=cid),'{"replyInstructions":"Consigne mise à jour"}');
 IF NOT EXISTS(SELECT 1 FROM app.campaigns WHERE id=cid AND reply_instructions='' AND reply_iteration_instructions=ARRAY['Consigne mise à jour']) THEN RAISE EXCEPTION 'legacy_patch_duplicated_instructions'; END IF;
 -- CRM creation defaults on; explicit opt-outs remain off.
 payload:=jsonb_build_object('campaign',jsonb_build_object('name',k||':crm','status','inactive','senderStrategy','pool','senderAccountIds','[]'::jsonb,
 'writingIterations','[""]'::jsonb,'sequence',jsonb_build_object('subject','','subjectInstructions','','steps','["","","","","",""]'::jsonb,'stepInstructions','["","","","","",""]'::jsonb)));
 result:=crm_api.crm_campaign_create_v2(payload,k||':crm');
 IF NOT EXISTS(SELECT 1 FROM app.campaigns WHERE id=(result->>'campaignId')::uuid AND tracking_opens_enabled AND tracking_clicks_enabled AND reply_auto_scope='first') THEN RAISE EXCEPTION 'crm_creation_defaults_off'; END IF;
 payload:=jsonb_set(payload,'{campaign,name}',to_jsonb(k||':off'));
 payload:=jsonb_set(jsonb_set(payload,'{campaign,trackingOpensEnabled}','false'),'{campaign,trackingClicksEnabled}','false');
 result:=crm_api.crm_campaign_create_v2(payload,k||':off');
 IF NOT EXISTS(SELECT 1 FROM app.campaigns WHERE id=(result->>'campaignId')::uuid AND NOT tracking_opens_enabled AND NOT tracking_clicks_enabled) THEN RAISE EXCEPTION 'explicit_tracking_optout_lost'; END IF;
 -- A/B reply steps and their attachments remain separate from the reference.
 INSERT INTO app.experiments(campaign_id,name,idempotency_key) VALUES(cid,'Fixture B',k||':experiment') RETURNING id INTO eid;
 INSERT INTO app.experiment_variants(experiment_id,code,overrides)
 VALUES(eid,'B','{"reply":{"replyIterations":["Consigne propre B","Améliorer B"]}}') RETURNING id INTO vid;
 INSERT INTO app.experiment_assignments(experiment_id,variant_id,prospect_id,campaign_id,assigned_for_step,assignment_key)
 VALUES(eid,vid,pid,cid,'J0',k||':assignment') RETURNING id INTO aid;
 UPDATE app.conversations SET experiment_assignment_id=aid WHERE id=conv;
 INSERT INTO app.instruction_attachments(scope_type,campaign_id,field_key,filename,content_type,size_bytes,blob_key,extracted_text,created_by)
 VALUES('campaign',cid,'variant:'||vid||':reply','variante-b.txt','text/plain',9,k||':file-b','Contexte B','fixture');
 INSERT INTO app.email_messages(conversation_id,direction,kind,from_address,to_addresses,status,received_at)
 VALUES(conv,'inbound','reply',k||'@example.test',ARRAY['sender@example.test'],'received',clock_timestamp()+interval '3 seconds') RETURNING id INTO src;
 PERFORM agent_api.classify_response(src,'information','neutral',false,1,'Fixture',run_id,k||':analysis4');
 claim:=agent_api.claim_reply_iteration(src,run_id,k||':claim4');
 IF claim->>'total'<>'2' OR claim->>'instruction'<>'Consigne propre B' OR claim->>'replyInstructions'<>''
   OR NOT(claim->'replyAttachments' @> '[{"filename":"variante-b.txt","text":"Contexte B"}]') THEN RAISE EXCEPTION 'variant_reply_context_lost'; END IF;
 RAISE SQLSTATE 'P9501';
 EXCEPTION WHEN SQLSTATE 'P9501' THEN NULL;
 END;
END;
$test$;
