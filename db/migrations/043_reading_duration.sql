-- Duration is obtained from a single streaming image, never from open-to-click.
-- Transport observations remain approximate and incompatible clients are excluded.
ALTER TABLE app.campaigns ADD COLUMN reading_time_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE app.email_messages ADD COLUMN reading_time_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE app.reading_budget (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 budget_day date NOT NULL DEFAULT (clock_timestamp() AT TIME ZONE 'UTC')::date,
 budget_month date NOT NULL DEFAULT date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date,
 daily_sessions integer NOT NULL DEFAULT 0,monthly_sessions integer NOT NULL DEFAULT 0
);
INSERT INTO app.reading_budget(singleton) VALUES(true);
CREATE TABLE app.reading_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 message_id uuid NOT NULL REFERENCES app.email_messages(id) ON DELETE CASCADE,
 client text NOT NULL CHECK(client IN ('thunderbird','outlook_desktop','proxy','automated','unverified')),
 state text NOT NULL CHECK(state IN ('active','disconnected','capped','transport_error','proxy','automated','unverified','budget')),
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(),ended_at timestamptz,
 elapsed_ms integer CHECK(elapsed_ms BETWEEN 0 AND 50000),
 seconds integer CHECK(seconds BETWEEN 0 AND 50),
 UNIQUE(message_id,client),
 CHECK((state IN ('disconnected','capped') AND seconds IS NOT NULL AND elapsed_ms IS NOT NULL AND ended_at IS NOT NULL)
   OR (state NOT IN ('disconnected','capped') AND seconds IS NULL))
);
CREATE INDEX reading_sessions_retention_idx ON app.reading_sessions(started_at);
CREATE INDEX reading_sessions_active_idx ON app.reading_sessions(started_at) WHERE state='active';
REVOKE ALL ON app.reading_sessions,app.reading_budget FROM PUBLIC,prospection95_app,prospection95_agent,prospection95_crm;
GRANT SELECT,DELETE ON app.reading_sessions TO prospection95_app;

CREATE FUNCTION app.begin_reading_session(p_message uuid,p_client text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE t timestamptz:=clock_timestamp(); s app.reading_sessions; b app.reading_budget; v_state text; v_id uuid;
 d date:=(clock_timestamp() AT TIME ZONE 'UTC')::date;
 mo date:=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
 IF p_client NOT IN ('thunderbird','outlook_desktop','proxy','automated','unverified') THEN RAISE EXCEPTION 'invalid_reading_client'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.email_messages m JOIN app.conversations conv ON conv.id=m.conversation_id JOIN app.campaigns c ON c.id=conv.campaign_id
   WHERE m.id=p_message AND m.direction='outbound' AND m.kind='prospection' AND m.technical_confirmation
   AND m.reading_time_enabled AND c.reading_time_enabled AND m.tracking_opens_enabled AND c.tracking_opens_enabled)
 THEN RETURN jsonb_build_object('stream',false,'reason','disabled'); END IF;
 SELECT * INTO s FROM app.reading_sessions WHERE message_id=p_message AND client=p_client;
 IF FOUND THEN RETURN jsonb_build_object('stream',false,'reason','already_observed'); END IF;
 IF p_client IN ('proxy','automated','unverified') THEN
   v_state:=p_client;
 ELSE
   -- One locked row makes the global free-tier budget atomic across all edge
   -- locations and invocations. Replays cannot open additional long streams.
   SELECT * INTO b FROM app.reading_budget WHERE singleton FOR UPDATE;
   UPDATE app.reading_budget SET
     daily_sessions=CASE WHEN budget_day=d THEN daily_sessions ELSE 0 END,budget_day=d,
     monthly_sessions=CASE WHEN budget_month=mo THEN monthly_sessions ELSE 0 END,budget_month=mo
   WHERE singleton RETURNING * INTO b;
   IF EXISTS(SELECT 1 FROM app.reading_sessions WHERE message_id=p_message AND client=p_client)
   THEN RETURN jsonb_build_object('stream',false,'reason','already_observed'); END IF;
   IF b.daily_sessions>=100 OR b.monthly_sessions>=2000 OR
     (SELECT count(*) FROM app.reading_sessions WHERE state='active' AND started_at>t-interval '60 seconds')>=8
   THEN v_state:='budget'; ELSE v_state:='active'; END IF;
 END IF;
 INSERT INTO app.reading_sessions(message_id,client,state,ended_at)
 VALUES(p_message,p_client,v_state,CASE WHEN v_state<>'active' THEN t END)
 ON CONFLICT(message_id,client) DO NOTHING RETURNING id INTO v_id;
 IF v_id IS NULL THEN RETURN jsonb_build_object('stream',false,'reason','already_observed'); END IF;
 IF v_state='active' THEN UPDATE app.reading_budget SET daily_sessions=daily_sessions+1,monthly_sessions=monthly_sessions+1 WHERE singleton; END IF;
 RETURN jsonb_build_object('stream',v_state='active','id',v_id,'reason',v_state);
END;
$$;

CREATE FUNCTION app.finish_reading_session(p_id uuid,p_end text,p_elapsed_ms integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE t timestamptz:=clock_timestamp(); s app.reading_sessions; v_state text;
BEGIN
 IF p_end NOT IN ('disconnected','capped','transport_error') OR p_elapsed_ms IS NULL OR p_elapsed_ms<0 OR p_elapsed_ms>50000
 THEN RAISE EXCEPTION 'invalid_reading_result'; END IF;
 SELECT * INTO s FROM app.reading_sessions WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR s.state<>'active' THEN RETURN false; END IF;
 v_state:=p_end;
 IF t-s.started_at>interval '75 seconds' OR
   abs(extract(epoch FROM(t-s.started_at))-p_elapsed_ms/1000.0)>15 OR
   (p_end='capped' AND p_elapsed_ms<>50000)
 THEN v_state:='transport_error'; END IF;
 UPDATE app.reading_sessions SET state=v_state,ended_at=t,elapsed_ms=p_elapsed_ms,
   seconds=CASE WHEN v_state IN ('disconnected','capped') THEN round(p_elapsed_ms/1000.0)::integer END
 WHERE id=p_id;
 RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app.begin_reading_session(uuid,text),app.finish_reading_session(uuid,text,integer) FROM PUBLIC,prospection95_agent,prospection95_crm;
GRANT EXECUTE ON FUNCTION app.begin_reading_session(uuid,text),app.finish_reading_session(uuid,text,integer) TO prospection95_app;

CREATE VIEW app.message_reading WITH(security_barrier=true) AS
SELECT m.id AS message_id,conv.campaign_id,conv.prospect_id,a.experiment_id,a.variant_id,
 m.reading_time_enabled AS enabled,
 -- At most one first usable connection per email; extra client types/reopens
 -- cannot over-weight it. Capped connections do not enter the exact mean.
 chosen.seconds AS reading_time_seconds,chosen.state='capped' AS capped,
 EXISTS(SELECT 1 FROM app.reading_sessions r WHERE r.message_id=m.id AND r.started_at>=clock_timestamp()-interval '90 days') AS attempted,
 EXISTS(SELECT 1 FROM app.reading_sessions r WHERE r.message_id=m.id AND r.started_at>=clock_timestamp()-interval '90 days' AND r.state IN ('proxy','automated','unverified')) AS incompatible,
 EXISTS(SELECT 1 FROM app.reading_sessions r WHERE r.message_id=m.id AND r.started_at>=clock_timestamp()-interval '90 days' AND (r.state='transport_error' OR (r.state='active' AND r.started_at<clock_timestamp()-interval '75 seconds'))) AS transport_error,
 EXISTS(SELECT 1 FROM app.reading_sessions r WHERE r.message_id=m.id AND r.started_at>=clock_timestamp()-interval '90 days' AND r.state='budget') AS budget_limited
FROM app.email_messages m JOIN app.conversations conv ON conv.id=m.conversation_id
LEFT JOIN app.experiment_assignments a ON a.id=conv.experiment_assignment_id AND (a.assigned_for_step IS NULL OR a.assigned_for_step=m.step)
LEFT JOIN LATERAL (SELECT r.seconds,r.state FROM app.reading_sessions r
 WHERE r.message_id=m.id AND r.started_at>=clock_timestamp()-interval '90 days' AND r.state IN ('disconnected','capped')
 ORDER BY r.started_at LIMIT 1) chosen ON true
WHERE m.direction='outbound' AND m.kind='prospection' AND m.technical_confirmation;
REVOKE ALL ON app.message_reading FROM PUBLIC,prospection95_agent,prospection95_crm;
GRANT SELECT ON app.message_reading TO prospection95_app;

-- Give each prospect the same weight in A/B/C comparisons, even when one has
-- received several follow-ups. Censored observations are counted separately.
CREATE VIEW agent_api.reading_metrics WITH(security_barrier=true) AS
WITH per_prospect AS (
 SELECT campaign_id,experiment_id,variant_id,prospect_id,
 count(*) FILTER(WHERE enabled) AS enabled_messages,count(*) FILTER(WHERE attempted) AS attempted_messages,
 count(reading_time_seconds) FILTER(WHERE NOT capped) AS samples,
 avg(reading_time_seconds) FILTER(WHERE NOT capped) AS mean_seconds,
 count(*) FILTER(WHERE capped) AS capped_samples,
 count(*) FILTER(WHERE incompatible AND reading_time_seconds IS NULL) AS incompatible_messages,
 count(*) FILTER(WHERE transport_error AND reading_time_seconds IS NULL) AS failed_messages,
 count(*) FILTER(WHERE budget_limited AND reading_time_seconds IS NULL) AS budget_limited_messages
 FROM app.message_reading GROUP BY campaign_id,experiment_id,variant_id,prospect_id
)
SELECT campaign_id,experiment_id,variant_id,sum(enabled_messages) AS enabled_messages,sum(attempted_messages) AS attempted_messages,
 sum(samples) AS samples,count(mean_seconds) AS measured_prospects,avg(mean_seconds) AS reading_time_seconds,
 sum(capped_samples) AS capped_samples,sum(incompatible_messages) AS incompatible_messages,
 sum(failed_messages) AS failed_messages,sum(budget_limited_messages) AS budget_limited_messages,
 'approximate'::text AS reliability,'connection_duration'::text AS method,
 50 AS limit_seconds,1 AS resolution_seconds,'90 days'::text AS observation_window
FROM per_prospect GROUP BY campaign_id,experiment_id,variant_id;
GRANT SELECT ON agent_api.reading_metrics TO prospection95_app,prospection95_agent;

DO $contract$
DECLARE src text;
BEGIN
 src:=pg_get_functiondef('crm_api.crm_campaign_update(uuid,bigint,jsonb)'::regprocedure);
 src:=replace(src,'''readDelayEnabled'',','''readDelayEnabled'',''readingTimeEnabled'',');
 src:=replace(src,'UPDATE app.campaigns SET', $p$UPDATE app.campaigns SET
 reading_time_enabled=CASE WHEN p_patch?'readingTimeEnabled' THEN (p_patch->>'readingTimeEnabled')::boolean ELSE reading_time_enabled END,$p$);
 IF position('''readingTimeEnabled''' IN src)=0 THEN RAISE EXCEPTION 'reading_crm_update_patch_failed'; END IF;
 EXECUTE src;
 src:=pg_get_functiondef('crm_api.crm_campaign_create(jsonb,text)'::regprocedure);
 src:=replace(src,'advanced_interactions_enabled,read_delay_enabled,experiment_policy','advanced_interactions_enabled,read_delay_enabled,reading_time_enabled,experiment_policy');
 src:=replace(src,'coalesce((c->>''readDelayEnabled'')::boolean,false),','coalesce((c->>''readDelayEnabled'')::boolean,false),coalesce((c->>''readingTimeEnabled'')::boolean,false),');
 IF position('reading_time_enabled' IN src)=0 THEN RAISE EXCEPTION 'reading_crm_create_patch_failed'; END IF;
 EXECUTE src;
 EXECUTE 'CREATE OR REPLACE VIEW crm_api.campaigns WITH(security_barrier=true) AS '||replace(pg_get_viewdef('crm_api.campaigns'::regclass,true),'FROM app.campaigns c;',', c.reading_time_enabled FROM app.campaigns c;');
 EXECUTE 'CREATE OR REPLACE VIEW agent_api.campaign_parameters WITH(security_barrier=true) AS '||replace(pg_get_viewdef('agent_api.campaign_parameters'::regclass,true),'FROM app.campaigns c',', c.reading_time_enabled FROM app.campaigns c');
END;
$contract$;
INSERT INTO app.schema_migrations(version) VALUES('043_reading_duration') ON CONFLICT(version) DO NOTHING;
