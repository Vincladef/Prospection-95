-- Isolated Neon branch only; simulated database acknowledgements, no SMTP.
DO $test$
#variable_conflict use_variable
DECLARE sender uuid; sender2 uuid; credential uuid; cid uuid; pid uuid; conv uuid; message uuid;
 item record; picked app.outbox_jobs; total integer; i integer; k text:='priority041:'||gen_random_uuid();
BEGIN
 BEGIN
 SELECT credential_id INTO credential FROM app.gmail_accounts WHERE status='active' AND credential_id IS NOT NULL LIMIT 1;
 UPDATE app.campaigns SET status='inactive' WHERE status IN ('active','existing_only');
 INSERT INTO app.gmail_accounts(email,role,status,credential_id,timezone,send_days,send_start,send_end,daily_limit,randomize_send_times)
 VALUES(k||'@gmail.test','sender','active',credential,'UTC',ARRAY[1,2,3,4,5,6,7]::smallint[],'00:00','23:59',3,false) RETURNING id INTO sender;
 INSERT INTO app.campaigns(name,status,sender_strategy,fixed_sender_account_id,validation_policy)
 VALUES(k,'active','fixed',sender,'automatic') RETURNING id INTO cid;
 FOR i IN 1..5 LOOP
  INSERT INTO app.prospects(full_name,email,contact_raw,contact_kind)
  VALUES(k||i,k||i||'@example.test',k||i||'@example.test','email') RETURNING id INTO pid;
  INSERT INTO app.conversations(campaign_id,prospect_id,sender_account_id,created_at,next_step_due_at)
  VALUES(cid,pid,sender,clock_timestamp()-interval '5 days',CASE WHEN i>3 THEN clock_timestamp()-interval '1 day' END) RETURNING id INTO conv;
  IF i>3 THEN
   INSERT INTO app.email_messages(conversation_id,direction,kind,sender_account_id,from_address,to_addresses,step,status,technical_confirmation,smtp_accepted_at,sent_at)
   VALUES(conv,'outbound','prospection',sender,k||'@gmail.test',ARRAY[k||i||'@example.test'],'J0','smtp_accepted',true,clock_timestamp()-interval '4 days',clock_timestamp()-interval '4 days');
  END IF;
  INSERT INTO app.email_messages(conversation_id,direction,kind,sender_account_id,from_address,to_addresses,subject,body_text,step,status)
  VALUES(conv,'outbound','prospection',sender,k||'@gmail.test',ARRAY[k||i||'@example.test'],'Fixture','Fixture',CASE WHEN i<=3 THEN 'J0'::app.sequence_step ELSE 'R1'::app.sequence_step END,'approved');
 END LOOP;
 PERFORM app.schedule_due_messages(1);
 IF (SELECT count(*) FROM app.outbox_jobs WHERE campaign_id=cid AND step='J0')<>1 THEN RAISE EXCEPTION 'scheduler_followup_before_initial'; END IF;
 PERFORM app.schedule_due_messages(50);
 UPDATE app.outbox_jobs SET due_at=clock_timestamp()-interval '1 second' WHERE campaign_id=cid;
 total:=0;
 FOR item IN SELECT * FROM app.lease_outbox_jobs(k,3,300) LOOP
  IF item.account_id<>sender OR item.step<>'J0' THEN RAISE EXCEPTION 'quota_consumed_by_followup'; END IF;
  total:=total+1;
  PERFORM app.confirm_smtp_acceptance(item.id,item.lease_token,'fixture-no-network',clock_timestamp());
 END LOOP;
 IF total<>3 THEN RAISE EXCEPTION 'three_initial_messages_not_selected'; END IF;
 IF EXISTS(SELECT 1 FROM app.lease_outbox_jobs(k,3,300)) THEN RAISE EXCEPTION 'quota_exceeded'; END IF;
 IF (SELECT count(*) FROM app.outbox_jobs WHERE campaign_id=cid AND step='R1' AND status='scheduled')<>2 THEN RAISE EXCEPTION 'followups_lost'; END IF;

 -- Cross-account priority must agree with per-account priority.
 UPDATE app.gmail_accounts SET daily_limit=10 WHERE id=sender;
 INSERT INTO app.gmail_accounts(email,role,status,credential_id,timezone,send_days,send_start,send_end,daily_limit,randomize_send_times)
 VALUES(k||'2@gmail.test','sender','active',credential,'UTC',ARRAY[1,2,3,4,5,6,7]::smallint[],'00:00','23:59',3,false) RETURNING id INTO sender2;
 INSERT INTO app.prospects(full_name,email,contact_raw,contact_kind)
 VALUES(k||'cross',k||'cross@example.test',k||'cross@example.test','email') RETURNING id INTO pid;
 INSERT INTO app.conversations(campaign_id,prospect_id,sender_account_id) VALUES(cid,pid,sender2) RETURNING id INTO conv;
 INSERT INTO app.email_messages(conversation_id,direction,kind,sender_account_id,from_address,to_addresses,step,status)
 VALUES(conv,'outbound','prospection',sender2,k||'2@gmail.test',ARRAY[k||'cross@example.test'],'J0','scheduled') RETURNING id INTO message;
 INSERT INTO app.outbox_jobs(message_id,conversation_id,campaign_id,prospect_id,account_id,step,status,approval_required,due_at,idempotency_key)
 VALUES(message,conv,cid,pid,sender2,'J0','scheduled',false,clock_timestamp(),k||':cross');
 SELECT * INTO picked FROM app.lease_outbox_jobs(k,1,300);
 IF picked.account_id IS DISTINCT FROM sender2 OR picked.step<>'J0' THEN RAISE EXCEPTION 'cross_account_initial_priority_missing'; END IF;
 -- A future J0 must not block a due follow-up elsewhere.
 UPDATE app.outbox_jobs SET status='scheduled',due_at=clock_timestamp()+interval '1 day',lease_expires_at=NULL,lease_token=NULL,lease_owner=NULL WHERE id=picked.id;
 SELECT * INTO picked FROM app.lease_outbox_jobs(k,1,300);
 IF picked.account_id IS DISTINCT FROM sender OR picked.step<>'R1' THEN RAISE EXCEPTION 'future_initial_blocked_due_followup'; END IF;
 RAISE SQLSTATE 'P9501';
 EXCEPTION WHEN SQLSTATE 'P9501' THEN NULL;
 END;
END;
$test$;
