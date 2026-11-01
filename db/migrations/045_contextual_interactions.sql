-- Retain all requester classes; uncertainty is context, not a collection veto.
ALTER TABLE app.reading_sessions ADD COLUMN provider text NOT NULL DEFAULT 'unknown', ADD COLUMN transport text NOT NULL DEFAULT 'unknown', ADD COLUMN probable_automation boolean;
-- Keep legacy exclusions intact while allowing a new, measured observation.
ALTER TABLE app.reading_sessions ADD COLUMN legacy_excluded boolean NOT NULL DEFAULT false;
ALTER TABLE app.reading_sessions DROP CONSTRAINT reading_sessions_message_id_client_key;
ALTER TABLE app.reading_sessions ADD CONSTRAINT reading_sessions_message_id_client_generation_key UNIQUE(message_id,client,legacy_excluded);
UPDATE app.reading_sessions SET legacy_excluded=true WHERE state IN ('proxy','automated','unverified');
CREATE OR REPLACE FUNCTION app.begin_reading_session(p_message uuid,p_client text) RETURNS jsonb
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
 SELECT * INTO s FROM app.reading_sessions WHERE message_id=p_message AND client=p_client AND NOT legacy_excluded;
 IF FOUND THEN RETURN jsonb_build_object('stream',false,'reason','already_observed'); END IF;
   -- One locked row makes the global free-tier budget atomic across all edge
   -- locations and invocations. Replays cannot open additional long streams.
   SELECT * INTO b FROM app.reading_budget WHERE singleton FOR UPDATE;
   UPDATE app.reading_budget SET
     daily_sessions=CASE WHEN budget_day=d THEN daily_sessions ELSE 0 END,budget_day=d,
     monthly_sessions=CASE WHEN budget_month=mo THEN monthly_sessions ELSE 0 END,budget_month=mo
   WHERE singleton RETURNING * INTO b;
   IF EXISTS(SELECT 1 FROM app.reading_sessions WHERE message_id=p_message AND client=p_client AND NOT legacy_excluded)
   THEN RETURN jsonb_build_object('stream',false,'reason','already_observed'); END IF;
   IF b.daily_sessions>=100 OR b.monthly_sessions>=2000 OR
     (SELECT count(*) FROM app.reading_sessions WHERE state='active' AND started_at>t-interval '60 seconds')>=8
   THEN v_state:='budget'; ELSE v_state:='active'; END IF;
 INSERT INTO app.reading_sessions(message_id,client,state,ended_at)
 VALUES(p_message,p_client,v_state,CASE WHEN v_state<>'active' THEN t END)
 ON CONFLICT(message_id,client,legacy_excluded) DO NOTHING RETURNING id INTO v_id;
 IF v_id IS NULL THEN RETURN jsonb_build_object('stream',false,'reason','already_observed'); END IF;
 IF v_state='active' THEN UPDATE app.reading_budget SET daily_sessions=daily_sessions+1,monthly_sessions=monthly_sessions+1 WHERE singleton; END IF;
 RETURN jsonb_build_object('stream',v_state='active','id',v_id,'reason',v_state);
END;
$$;


CREATE FUNCTION app.begin_reading_session_v2(p_message uuid,p_client text,p_provider text,p_transport text,p_automated boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE r jsonb;
BEGIN
 IF p_provider NOT IN ('gmail','apple','apple_possible','outlook','thunderbird','yahoo','unknown') OR p_transport NOT IN ('proxy','direct','unknown') OR p_automated IS NULL THEN RAISE EXCEPTION 'invalid_interaction_context'; END IF;
 r:=app.begin_reading_session(p_message,p_client);
 IF r?'id' THEN UPDATE app.reading_sessions SET provider=p_provider,transport=p_transport,probable_automation=p_automated WHERE id=(r->>'id')::uuid; END IF;
 RETURN r;
END;
$$;
REVOKE ALL ON FUNCTION app.begin_reading_session_v2(uuid,text,text,text,boolean) FROM PUBLIC,prospection95_agent,prospection95_crm;
GRANT EXECUTE ON FUNCTION app.begin_reading_session_v2(uuid,text,text,text,boolean) TO prospection95_app;

CREATE TABLE app.open_contexts (
 message_id uuid NOT NULL REFERENCES app.email_messages(id) ON DELETE CASCADE,
 bucket_hour timestamptz NOT NULL,provider text NOT NULL,transport text NOT NULL,probable_automation boolean NOT NULL,
 requests bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(message_id,bucket_hour,provider,transport,probable_automation)
);
CREATE INDEX open_contexts_retention_idx ON app.open_contexts(bucket_hour);
REVOKE ALL ON app.open_contexts FROM PUBLIC,prospection95_app,prospection95_agent,prospection95_crm;
GRANT SELECT,DELETE ON app.open_contexts TO prospection95_app;
CREATE FUNCTION app.record_open_context(p_message uuid,p_provider text,p_transport text,p_automated boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF p_provider NOT IN ('gmail','apple','apple_possible','outlook','thunderbird','yahoo','unknown') OR p_transport NOT IN ('proxy','direct','unknown') OR p_automated IS NULL THEN RAISE EXCEPTION 'invalid_interaction_context'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.email_messages m JOIN app.conversations conv ON conv.id=m.conversation_id JOIN app.campaigns c ON c.id=conv.campaign_id WHERE m.id=p_message AND m.direction='outbound' AND m.technical_confirmation AND c.tracking_opens_enabled AND coalesce(m.tracking_opens_enabled,c.tracking_opens_enabled)) THEN RETURN false; END IF;
 INSERT INTO app.open_contexts(message_id,bucket_hour,provider,transport,probable_automation)
 VALUES(p_message,date_trunc('hour',clock_timestamp()),p_provider,p_transport,p_automated)
 ON CONFLICT(message_id,bucket_hour,provider,transport,probable_automation) DO UPDATE SET requests=app.open_contexts.requests+1;
 RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app.record_open_context(uuid,text,text,boolean) FROM PUBLIC,prospection95_agent,prospection95_crm;
GRANT EXECUTE ON FUNCTION app.record_open_context(uuid,text,text,boolean) TO prospection95_app;
CREATE VIEW agent_api.open_context_metrics WITH(security_barrier=true) AS
SELECT conv.campaign_id,a.experiment_id,a.variant_id,o.provider,o.transport,o.probable_automation,
 sum(o.requests) AS requests,count(DISTINCT m.id) AS messages,count(DISTINCT conv.prospect_id) AS prospects
FROM app.open_contexts o JOIN app.email_messages m ON m.id=o.message_id JOIN app.conversations conv ON conv.id=m.conversation_id
LEFT JOIN app.experiment_assignments a ON a.id=conv.experiment_assignment_id AND (a.assigned_for_step IS NULL OR a.assigned_for_step=m.step)
WHERE o.bucket_hour>=clock_timestamp()-interval '90 days' AND m.kind='prospection' AND m.technical_confirmation
GROUP BY conv.campaign_id,a.experiment_id,a.variant_id,o.provider,o.transport,o.probable_automation;
CREATE VIEW agent_api.reading_context_metrics WITH(security_barrier=true) AS
WITH per_prospect AS (
 SELECT conv.campaign_id,a.experiment_id,a.variant_id,conv.prospect_id,r.provider,r.transport,r.probable_automation,
 count(*) AS attempts,count(*) FILTER(WHERE r.state='disconnected') AS samples,
 avg(r.seconds) FILTER(WHERE r.state='disconnected') AS mean_seconds,
 count(*) FILTER(WHERE r.state='capped') AS capped_samples,
 count(*) FILTER(WHERE r.state='transport_error' OR (r.state='active' AND r.started_at<clock_timestamp()-interval '75 seconds')) AS failed_samples,
 count(*) FILTER(WHERE r.state='budget') AS budget_limited
 FROM app.reading_sessions r JOIN app.email_messages m ON m.id=r.message_id JOIN app.conversations conv ON conv.id=m.conversation_id
 LEFT JOIN app.experiment_assignments a ON a.id=conv.experiment_assignment_id AND (a.assigned_for_step IS NULL OR a.assigned_for_step=m.step)
 WHERE r.started_at>=clock_timestamp()-interval '90 days' AND m.kind='prospection' AND m.technical_confirmation
 GROUP BY conv.campaign_id,a.experiment_id,a.variant_id,conv.prospect_id,r.provider,r.transport,r.probable_automation
)
SELECT campaign_id,experiment_id,variant_id,provider,transport,probable_automation,sum(attempts) AS attempts,
 sum(samples) AS samples,count(mean_seconds) AS measured_prospects,avg(mean_seconds) AS mean_seconds,
 sum(capped_samples) AS capped_samples,sum(failed_samples) AS failed_samples,sum(budget_limited) AS budget_limited,
 'requester_hint'::text AS context_reliability,'connection_duration'::text AS method
FROM per_prospect GROUP BY campaign_id,experiment_id,variant_id,provider,transport,probable_automation;
GRANT SELECT ON agent_api.open_context_metrics,agent_api.reading_context_metrics TO prospection95_app,prospection95_agent;
INSERT INTO app.schema_migrations(version) VALUES('045_contextual_interactions') ON CONFLICT(version) DO NOTHING;
