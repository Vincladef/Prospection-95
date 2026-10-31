-- Branch-only fixtures, rolled back; no external calls.
DO $test$
DECLARE aid uuid; bid uuid; run_id uuid; d jsonb; first_id uuid; ev jsonb; k text:='volume-fixture:'||gen_random_uuid(); caught boolean; msg uuid; job app.outbox_jobs;
BEGIN
 BEGIN
 INSERT INTO app.gmail_accounts(email,role,daily_limit,warmup_daily_limit) VALUES(k||'@example.test','sender',20,10) RETURNING id INTO aid;
 INSERT INTO app.bobwork_snapshots(account_id,connected,warmup_state,metrics,observed_at) VALUES(aid,true,'active','{"spam_rate_7d_pct":0}',clock_timestamp()) RETURNING id INTO bid;
 ev:=jsonb_build_array(jsonb_build_object('kind','bobwork','id',bid));
 run_id:=agent_api.begin_run('deliverability',k,k);
 d:=agent_api.decide_account_volume(aid,NULL,'maintain',NULL,80,'Fixture maintien',ev,run_id,k||':maintain');
 first_id:=(d->>'id')::uuid;
 IF app.account_volume_limit(aid)<>10 THEN RAISE EXCEPTION 'user_warmup_ceiling_ignored'; END IF;
 d:=agent_api.decide_account_volume(aid,first_id,'reduce',4,70,'Fixture réduction',ev,run_id,k||':reduce');
 d:=agent_api.decide_account_volume(aid,first_id,'reduce',4,70,'Fixture réduction',ev,run_id,k||':reduce');
 IF app.account_volume_limit(aid)<>4 THEN RAISE EXCEPTION 'reduction_not_applied'; END IF;
 caught:=false;
 BEGIN PERFORM agent_api.decide_account_volume(aid,first_id,'increase',8,80,'Fixture conflit',ev,run_id,k||':stale'); EXCEPTION WHEN raise_exception THEN caught:=SQLERRM='volume_decision_conflict'; END;
 IF NOT caught THEN RAISE EXCEPTION 'stale_decision_accepted'; END IF;
 UPDATE app.gmail_accounts SET status='active',timezone='UTC',send_days=ARRAY[1,2,3,4,5,6,7]::smallint[],send_start='00:00',send_end='23:59' WHERE id=aid;
 INSERT INTO app.email_messages(direction,kind,step,sender_account_id,from_address,to_addresses,status)
 VALUES('outbound','diagnostic','J0',aid,k||'@example.test',ARRAY['fixture@example.test'],'scheduled') RETURNING id INTO msg;
 INSERT INTO app.outbox_jobs(message_id,account_id,step,job_kind,status,approval_required,due_at,idempotency_key)
 VALUES(msg,aid,'J0','diagnostic','scheduled',false,clock_timestamp()-interval '1 second',k||':job');
 SELECT * INTO job FROM app.lease_outbox_jobs('volume-fixture',1,40);
 IF job.message_id IS DISTINCT FROM msg THEN RAISE EXCEPTION 'fixture_not_leased'; END IF;
 d:=agent_api.decide_account_volume(aid,(d->>'id')::uuid,'suspend',0,NULL,'Fixture suspension',ev,run_id,k||':suspend');
 IF app.account_volume_limit(aid)<>0 THEN RAISE EXCEPTION 'suspension_not_applied'; END IF;
 PERFORM app.start_outbox_attempt(job.id,job.lease_token);
 IF (SELECT status FROM app.outbox_jobs WHERE id=job.id)<>'deferred' OR EXISTS(SELECT 1 FROM app.outbox_attempts WHERE job_id=job.id) THEN RAISE EXCEPTION 'late_suspension_did_not_stop_smtp'; END IF;
 UPDATE app.gmail_accounts SET paused_at=clock_timestamp(),pause_source='manual' WHERE id=aid;
 d:=agent_api.decide_account_volume(aid,(d->>'id')::uuid,'increase',7,80,'Fixture reprise graduelle',ev,run_id,k||':increase');
 IF app.account_volume_limit(aid)<>7 OR NOT EXISTS(SELECT 1 FROM app.gmail_accounts WHERE id=aid AND paused_at IS NOT NULL AND daily_limit=20 AND warmup_daily_limit=10) THEN RAISE EXCEPTION 'manual_limits_or_pause_overwritten'; END IF;
 caught:=false;
 BEGIN PERFORM agent_api.decide_account_volume(aid,(d->>'id')::uuid,'increase',11,90,'Fixture dépassement',ev,run_id,k||':over'); EXCEPTION WHEN raise_exception THEN caught:=SQLERRM='invalid_volume_target'; END;
 IF NOT caught THEN RAISE EXCEPTION 'user_ceiling_exceeded'; END IF;
 caught:=false;
 BEGIN PERFORM agent_api.decide_account_volume(aid,(d->>'id')::uuid,'maintain',NULL,80,'Fixture preuve absente','[]',run_id,k||':missing'); EXCEPTION WHEN raise_exception THEN caught:=SQLERRM='latest_bobwork_evidence_required'; END;
 IF NOT caught THEN RAISE EXCEPTION 'ungrounded_score_accepted'; END IF;
 UPDATE app.gmail_accounts SET daily_limit=3,warmup_daily_limit=2 WHERE id=aid;
 IF app.account_volume_limit(aid)<>2 THEN RAISE EXCEPTION 'changed_user_ceiling_ignored'; END IF;
 caught:=false;
 BEGIN UPDATE app.deliverability_decisions SET rationale='overwrite' WHERE id=(d->>'id')::uuid; EXCEPTION WHEN SQLSTATE '55000' THEN caught:=true; END;
 IF NOT caught THEN RAISE EXCEPTION 'decision_history_mutable'; END IF;
 RAISE SQLSTATE 'P9501';
 EXCEPTION WHEN SQLSTATE 'P9501' THEN NULL;
 END;
END;
$test$;
