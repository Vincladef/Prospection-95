-- Isolated Neon branch; no external message, pixel request or real personal data.
DO $test$
#variable_conflict use_variable
DECLARE sender uuid;cid uuid;pid uuid;conv uuid;mid uuid;eid uuid;vid uuid;aid uuid;v record; ok boolean;
 payload jsonb; created jsonb; created_id uuid;
 k text:='automatic046:'||gen_random_uuid(); base timestamptz:=date_trunc('hour',clock_timestamp())-interval '2 hours';
BEGIN
 BEGIN
 SELECT id INTO sender FROM app.gmail_accounts WHERE status='active' AND credential_id IS NOT NULL LIMIT 1;
 INSERT INTO app.campaigns(name,status,sender_strategy,fixed_sender_account_id,tracking_opens_enabled,tracking_clicks_enabled,advanced_interactions_enabled,read_delay_enabled)
 VALUES(k,'inactive','fixed',sender,true,true,false,false) RETURNING id INTO cid;
 INSERT INTO app.prospects(full_name,email,contact_raw,contact_kind) VALUES(k,k||'@example.test',k||'@example.test','email') RETURNING id INTO pid;
 INSERT INTO app.experiments(campaign_id,name,idempotency_key) VALUES(cid,k,k) RETURNING id INTO eid;
 INSERT INTO app.experiment_variants(experiment_id,code) VALUES(eid,'A') RETURNING id INTO vid;
 INSERT INTO app.experiment_assignments(experiment_id,variant_id,prospect_id,campaign_id,assignment_key) VALUES(eid,vid,pid,cid,k) RETURNING id INTO aid;
 INSERT INTO app.conversations(campaign_id,prospect_id,sender_account_id,experiment_assignment_id) VALUES(cid,pid,sender,aid) RETURNING id INTO conv;
 INSERT INTO app.email_messages(conversation_id,direction,kind,sender_account_id,from_address,to_addresses,step,status,technical_confirmation,smtp_accepted_at,
 tracking_opens_enabled,tracking_clicks_enabled,advanced_interactions_enabled,read_delay_enabled)
 VALUES(conv,'outbound','prospection',sender,'sender@example.test',ARRAY[k||'@example.test'],'J0','smtp_accepted',true,base-interval '1 day',true,true,false,false) RETURNING id INTO mid;
 PERFORM app.record_interaction_bucket(mid,'open','proxy');
 PERFORM app.record_interaction_bucket(mid,'open','proxy');
 IF (SELECT request_count FROM app.interaction_buckets WHERE message_id=mid AND event_type='open')<>2 THEN RAISE EXCEPTION 'repeated_observations_lost'; END IF;
 -- Only fixtures fast-forward server observations to deterministic times.
 UPDATE app.interaction_buckets SET first_seen=base,last_seen=base+interval '10 seconds' WHERE message_id=mid;
 INSERT INTO app.interaction_buckets(message_id,event_type,bucket_hour,agent_class,first_seen,last_seen)
 VALUES(mid,'open',base,'browser',base+interval '20 seconds',base+interval '20 seconds'),
 (mid,'click',base,'browser',base+interval '50 seconds',base+interval '50 seconds'),
 (mid,'click',base,'automated',base+interval '21 seconds',base+interval '21 seconds');
 SELECT * INTO v FROM app.message_engagement WHERE message_id=mid;
 IF v.open_requests<>3 OR v.proxy_open_requests<>2 OR v.direct_open_requests<>1 OR v.mean_open_interval_seconds<>10 THEN RAISE EXCEPTION 'open_counts_or_frequency_wrong'; END IF;
 IF v.open_to_click_seconds IS DISTINCT FROM 30 OR v.reading_time_seconds IS NOT NULL OR v.open_reliability<>'noisy' THEN RAISE EXCEPTION 'reading_time_fabricated_or_scanner_used'; END IF;
 SELECT * INTO v FROM agent_api.interaction_metrics WHERE variant_id=vid;
 IF v.open_requests<>3 OR v.repeated_open_messages<>1 OR v.delay_samples IS DISTINCT FROM 1 OR v.mean_open_to_click_seconds IS DISTINCT FROM 30 THEN RAISE EXCEPTION 'variant_rollup_wrong'; END IF;


 UPDATE app.campaigns SET tracking_clicks_enabled=false WHERE id=cid;
 IF app.record_interaction_bucket(mid,'click','browser') THEN RAISE EXCEPTION 'disabled_click_source_collected'; END IF;
 IF NOT app.record_interaction_bucket(mid,'open','browser') THEN RAISE EXCEPTION 'frequency_requires_clicks'; END IF;
 -- Disabling future collection must not hide an already observed delay.
 UPDATE app.campaigns SET tracking_opens_enabled=false WHERE id=cid;
 IF app.record_interaction_bucket(mid,'open','browser') THEN RAISE EXCEPTION 'disabled_open_source_collected'; END IF;
 IF (SELECT open_to_click_seconds FROM app.message_engagement WHERE message_id=mid) IS DISTINCT FROM 30::numeric THEN RAISE EXCEPTION 'historical_delay_disappeared'; END IF;
 RAISE SQLSTATE 'P9501';
 EXCEPTION WHEN SQLSTATE 'P9501' THEN NULL;
 END;
END;
$test$;
