-- Validation branch only; the sentinel rolls back every fixture and setting.
DO $test$
#variable_conflict use_variable
DECLARE a uuid; c uuid; p uuid; conv uuid; original uuid; inbound uuid; t app.mailbox_threads;
 j app.outbox_jobs; again app.outbox_jobs; msg app.email_messages; k text:='mailbox-test:'||gen_random_uuid(); caught boolean;
BEGIN
 BEGIN
 SELECT id INTO a FROM app.gmail_accounts WHERE credential_id IS NOT NULL AND deleted_at IS NULL LIMIT 1;
 IF a IS NULL THEN RAISE EXCEPTION 'test_requires_connected_account'; END IF;
 UPDATE app.settings SET outbound_enabled=true,emergency_stop=false;
 UPDATE app.gmail_accounts SET status='active',paused_at=NULL,pause_source=NULL,timezone='UTC',
  send_days=ARRAY[1,2,3,4,5,6,7]::smallint[],send_start='00:00',send_end='23:59',daily_limit=1000,warmup_daily_limit=1000 WHERE id=a;
 UPDATE app.campaigns SET status='inactive' WHERE status IN ('active','existing_only');
 INSERT INTO app.campaigns(name,status,sender_strategy,fixed_sender_account_id) VALUES(k,'inactive','fixed',a) RETURNING id INTO c;
 INSERT INTO app.prospects(full_name,email,contact_raw) VALUES('Mailbox fixture',k||'@example.test',k||'@example.test') RETURNING id INTO p;
 INSERT INTO app.conversations(campaign_id,prospect_id,sender_account_id) VALUES(c,p,a) RETURNING id INTO conv;
 INSERT INTO app.email_messages(conversation_id,direction,kind,step,sender_account_id,from_address,to_addresses,subject,body_text,status)
 VALUES(conv,'outbound','prospection','J0',a,'sender@example.test',ARRAY[k||'@example.test'],'Sujet','Brouillon de séquence','draft') RETURNING id INTO original;
 IF EXISTS(SELECT 1 FROM app.mailbox_threads WHERE conversation_id=conv) THEN RAISE EXCEPTION 'unsent_sequence_in_mailbox'; END IF;
 UPDATE app.email_messages SET status='smtp_accepted',technical_confirmation=true,smtp_accepted_at=clock_timestamp()-interval '1 hour',internet_message_id='<'||k||':initial>' WHERE id=original;
 SELECT * INTO t FROM app.mailbox_threads WHERE conversation_id=conv;
 IF t.id IS NULL OR t.account_id<>a OR t.needs_reply OR t.last_message_id<>original THEN RAISE EXCEPTION 'confirmed_initial_not_attached'; END IF;
 inbound:=(app.record_inbound_message(a,conv,'reply',k||'@example.test',ARRAY['sender@example.test'],'Re: Sujet','Question réelle',NULL,'{}','<'||k||':inbound>',NULL,'{}',NULL,NULL,'INBOX',99999,1,NULL,clock_timestamp(),'{"unread":true}')).id;
 SELECT * INTO t FROM app.mailbox_threads WHERE id=t.id;
 IF NOT t.needs_reply OR NOT t.unread OR t.last_message_id<>inbound THEN RAISE EXCEPTION 'inbound_state_incorrect'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.conversations WHERE id=conv AND followups_stopped_at IS NOT NULL) THEN RAISE EXCEPTION 'reply_did_not_stop_followups'; END IF;
 UPDATE app.mailbox_threads SET draft_body='Réponse manuelle',draft_version=2 WHERE id=t.id;
 caught:=false;BEGIN PERFORM app.mailbox_queue_reply(t.id,1,inbound,k||':stale');EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'stale_draft_version_accepted'; END IF;
 j:=app.mailbox_queue_reply(t.id,2,inbound,k||':send');
 again:=app.mailbox_queue_reply(t.id,2,inbound,k||':send');
 IF j.id<>again.id THEN RAISE EXCEPTION 'manual_reply_not_idempotent'; END IF;
 SELECT * INTO msg FROM app.email_messages WHERE id=j.message_id;
 IF msg.sender_account_id<>a OR msg.from_address<>(SELECT email FROM app.gmail_accounts WHERE id=a)
  OR msg.body_text<>'Réponse manuelle' OR msg.kind<>'manual' THEN RAISE EXCEPTION 'manual_reply_wrong_identity_or_content'; END IF;
 IF NOT app.mailbox_reply_is_current(j.id) THEN RAISE EXCEPTION 'current_manual_reply_blocked'; END IF;
 -- A new message makes the queued reply stale and blocks SMTP.
 PERFORM app.record_inbound_message(a,conv,'reply',k||'@example.test',ARRAY['sender@example.test'],'Suite','Nouvelle question',NULL,'{}','<'||k||':new>',NULL,'{}',NULL,NULL,'INBOX',99999,2,NULL,clock_timestamp()+interval '1 second','{}');
 IF app.mailbox_reply_is_current(j.id) THEN RAISE EXCEPTION 'stale_reply_still_ready'; END IF;
 UPDATE app.outbox_jobs SET status='cancelled',cancel_reason='fixture' WHERE id=j.id;
 SELECT * INTO t FROM app.mailbox_threads WHERE id=t.id;
 UPDATE app.mailbox_threads SET draft_version=3,draft_body='Dernière réponse' WHERE id=t.id;
 j:=app.mailbox_queue_reply(t.id,3,t.last_message_id,k||':second');
 -- Simulate only the internal confirmation contract. This is not a Gmail test.
 UPDATE app.outbox_jobs SET status='running',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '5 minutes',attempt_count=1 WHERE id=j.id RETURNING * INTO j;
 PERFORM app.confirm_smtp_acceptance(j.id,j.lease_token,'fixture-no-network',clock_timestamp()+interval '2 seconds');
 SELECT * INTO t FROM app.mailbox_threads WHERE id=t.id;
 IF t.needs_reply OR t.draft_body<>'' OR t.draft_version<>4 OR t.last_message_id<>j.message_id THEN RAISE EXCEPTION 'manual_confirmation_did_not_settle_mailbox'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.conversations WHERE id=conv AND followups_stopped_at IS NOT NULL AND next_step_due_at IS NULL AND current_step='J0') THEN RAISE EXCEPTION 'manual_confirmation_changed_sequence'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.mailbox_sync_jobs WHERE thread_id=t.id AND kind='draft') THEN RAISE EXCEPTION 'sent_draft_cleanup_missing'; END IF;
 -- Standalone threads never need a fabricated prospect or campaign.
 INSERT INTO app.mailbox_threads(account_id,remote_key,correspondent) VALUES(a,k||':standalone','standalone@example.test') RETURNING * INTO t;
 INSERT INTO app.email_messages(mailbox_thread_id,direction,kind,from_address,to_addresses,status,received_at,internet_message_id)
 VALUES(t.id,'inbound','unrelated','standalone@example.test',ARRAY['sender@example.test'],'received',clock_timestamp(),'<'||k||':standalone>') RETURNING id INTO inbound;
 UPDATE app.mailbox_threads SET draft_body='Bonjour',draft_version=2 WHERE id=t.id;
 j:=app.mailbox_queue_reply(t.id,2,inbound,k||':standalone-send');
 IF j.conversation_id IS NOT NULL OR j.campaign_id IS NOT NULL OR j.prospect_id IS NOT NULL OR NOT app.mailbox_reply_is_current(j.id) THEN RAISE EXCEPTION 'standalone_reply_requires_crm'; END IF;
 UPDATE app.outbox_jobs SET status='running',lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '5 minutes',attempt_count=1 WHERE id=j.id RETURNING * INTO j;
 PERFORM app.mark_smtp_uncertain(j.id,j.lease_token,'fixture_timeout',NULL);
 SELECT * INTO msg FROM app.email_messages WHERE id=j.message_id;
 PERFORM app.record_sent_message(a,NULL,(SELECT email FROM app.gmail_accounts WHERE id=a),ARRAY['standalone@example.test'],
  'Re: Sujet','Bonjour',NULL,msg.internet_message_id,NULL,'{}','__SENT__',99999,55,clock_timestamp(),'{}');
 IF (SELECT status FROM app.outbox_jobs WHERE id=j.id)<>'completed' OR NOT (SELECT technical_confirmation FROM app.email_messages WHERE id=j.message_id)
 THEN RAISE EXCEPTION 'standalone_uncertain_send_not_reconciled'; END IF;
 IF (SELECT count(*) FROM app.email_messages WHERE internet_message_id=msg.internet_message_id)<>1 THEN RAISE EXCEPTION 'standalone_sent_copy_duplicated'; END IF;
 -- Persistent pause remains authoritative for a new send.
 UPDATE app.mailbox_threads SET draft_version=5,draft_body='Autre réponse' WHERE id=t.id;
 SELECT last_message_id INTO inbound FROM app.mailbox_threads WHERE id=t.id;
 UPDATE app.settings SET emergency_stop=true;
 caught:=false;BEGIN PERFORM app.mailbox_queue_reply(t.id,5,inbound,k||':paused');EXCEPTION WHEN OTHERS THEN caught:=true;END;
 IF NOT caught THEN RAISE EXCEPTION 'emergency_stop_bypassed'; END IF;
 IF has_table_privilege('prospection95_agent','app.mailbox_threads','SELECT') OR has_function_privilege('prospection95_crm','app.mailbox_queue_reply(uuid,bigint,uuid,text)','EXECUTE') THEN RAISE EXCEPTION 'mailbox_agent_privilege_leak'; END IF;
 RAISE SQLSTATE 'P9501';
 EXCEPTION WHEN SQLSTATE 'P9501' THEN NULL;
 END;
END; $test$;
