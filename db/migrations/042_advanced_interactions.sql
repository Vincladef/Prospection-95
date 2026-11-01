-- Optional analyses reuse the existing signed pixel and redirect. No new beacon.
ALTER TABLE app.campaigns ADD COLUMN advanced_interactions_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE app.campaigns ADD COLUMN read_delay_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE app.email_messages ADD COLUMN advanced_interactions_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE app.email_messages ADD COLUMN read_delay_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE app.interaction_buckets (
 message_id uuid NOT NULL REFERENCES app.email_messages(id) ON DELETE CASCADE,
 event_type text NOT NULL CHECK(event_type IN ('open','click')),
 bucket_hour timestamptz NOT NULL,
 agent_class text NOT NULL CHECK(agent_class IN ('browser','proxy','automated','unknown')),
 first_seen timestamptz NOT NULL,last_seen timestamptz NOT NULL,request_count bigint NOT NULL DEFAULT 1 CHECK(request_count>0),
 PRIMARY KEY(message_id,event_type,bucket_hour,agent_class)
);
CREATE INDEX interaction_buckets_retention_idx ON app.interaction_buckets(bucket_hour);
REVOKE ALL ON app.interaction_buckets FROM PUBLIC,prospection95_agent,prospection95_crm;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.interaction_buckets TO prospection95_app;

-- Only server time, coarse client class and counters are stored. No IP, raw UA,
-- cookies, device identity, extra URLs or cross-site tracking.
CREATE FUNCTION app.record_interaction_bucket(p_message uuid,p_kind text,p_class text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE t timestamptz:=clock_timestamp();
BEGIN
 IF p_class NOT IN ('browser','proxy','automated','unknown') OR p_kind NOT IN ('open','click') THEN RAISE EXCEPTION 'invalid_interaction_sample'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.email_messages m JOIN app.conversations conv ON conv.id=m.conversation_id JOIN app.campaigns c ON c.id=conv.campaign_id
  WHERE m.id=p_message AND m.technical_confirmation AND m.direction='outbound' AND m.advanced_interactions_enabled AND c.advanced_interactions_enabled
  AND CASE WHEN p_kind='open' THEN c.tracking_opens_enabled AND m.tracking_opens_enabled ELSE c.tracking_clicks_enabled AND m.tracking_clicks_enabled END) THEN RETURN false; END IF;
 INSERT INTO app.interaction_buckets(message_id,event_type,bucket_hour,agent_class,first_seen,last_seen)
 VALUES(p_message,p_kind,date_trunc('hour',t),p_class,t,t)
 ON CONFLICT(message_id,event_type,bucket_hour,agent_class) DO UPDATE SET request_count=app.interaction_buckets.request_count+1,last_seen=t;
 RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app.record_interaction_bucket(uuid,text,text) FROM PUBLIC,prospection95_agent,prospection95_crm;
GRANT EXECUTE ON FUNCTION app.record_interaction_bucket(uuid,text,text) TO prospection95_app;

CREATE VIEW app.message_engagement WITH(security_barrier=true) AS
WITH samples AS (
 SELECT message_id,sum(request_count) FILTER(WHERE event_type='open') AS open_requests,
  sum(request_count) FILTER(WHERE event_type='open' AND agent_class='proxy') AS proxy_open_requests,
  sum(request_count) FILTER(WHERE event_type='open' AND agent_class='automated') AS automated_open_requests,
  sum(request_count) FILTER(WHERE event_type='open' AND agent_class='browser') AS direct_open_requests,
  min(first_seen) FILTER(WHERE event_type='open') AS first_open,max(last_seen) FILTER(WHERE event_type='open') AS last_open,
  min(first_seen) FILTER(WHERE event_type='open' AND agent_class='browser') AS first_direct_open,
  count(*) FILTER(WHERE event_type='open') AS open_buckets
 FROM app.interaction_buckets WHERE bucket_hour>=clock_timestamp()-interval '90 days' GROUP BY message_id
)
SELECT m.id AS message_id,conv.campaign_id,a.experiment_id,a.variant_id,
 m.advanced_interactions_enabled AS analysis_enabled,m.read_delay_enabled,
 s.open_requests,s.proxy_open_requests,s.automated_open_requests,s.direct_open_requests,s.first_open,s.last_open,
 CASE WHEN s.open_requests>1 THEN extract(epoch FROM (s.last_open-s.first_open))/(s.open_requests-1) END AS mean_open_interval_seconds,
 CASE WHEN m.read_delay_enabled AND c.read_delay_enabled AND m.advanced_interactions_enabled THEN
  (SELECT min(extract(epoch FROM (b.first_seen-s.first_direct_open))) FROM app.interaction_buckets b
   WHERE b.message_id=m.id AND b.event_type='click' AND b.agent_class='browser' AND b.first_seen>=s.first_direct_open
    AND b.bucket_hour>=clock_timestamp()-interval '90 days') END AS open_to_click_seconds,
 'noisy'::text AS open_reliability,'approximate'::text AS delay_reliability,NULL::numeric AS reading_time_seconds
FROM app.email_messages m JOIN app.conversations conv ON conv.id=m.conversation_id JOIN app.campaigns c ON c.id=conv.campaign_id
LEFT JOIN app.experiment_assignments a ON a.id=conv.experiment_assignment_id AND (a.assigned_for_step IS NULL OR a.assigned_for_step=m.step)
LEFT JOIN samples s ON s.message_id=m.id
WHERE m.direction='outbound' AND m.kind='prospection' AND m.technical_confirmation;
REVOKE ALL ON app.message_engagement FROM PUBLIC,prospection95_agent,prospection95_crm;
GRANT SELECT ON app.message_engagement TO prospection95_app;
CREATE VIEW agent_api.interaction_metrics WITH(security_barrier=true) AS
SELECT campaign_id,experiment_id,variant_id,count(*) FILTER(WHERE analysis_enabled) AS measured_messages,
 count(*) FILTER(WHERE open_requests>0) AS observed_messages,
 sum(open_requests) AS open_requests,count(*) FILTER(WHERE open_requests>1) AS repeated_open_messages,
 sum(proxy_open_requests) AS proxy_open_requests,sum(automated_open_requests) AS automated_open_requests,sum(direct_open_requests) AS direct_open_requests,
 CASE WHEN sum(open_requests-1) FILTER(WHERE open_requests>1)>0 THEN
 sum(extract(epoch FROM(last_open-first_open))) FILTER(WHERE open_requests>1)/sum(open_requests-1) FILTER(WHERE open_requests>1) END AS mean_open_interval_seconds,
 count(open_to_click_seconds) AS delay_samples,avg(open_to_click_seconds) AS mean_open_to_click_seconds,
 NULL::numeric AS reading_time_seconds,'noisy'::text AS open_reliability,'approximate'::text AS delay_reliability,
 '90 days'::text AS observation_window
FROM app.message_engagement GROUP BY campaign_id,experiment_id,variant_id;
GRANT SELECT ON agent_api.interaction_metrics TO prospection95_app,prospection95_agent;
CREATE VIEW agent_api.interaction_timeline WITH(security_barrier=true) AS
SELECT e.campaign_id,e.experiment_id,e.variant_id,b.bucket_hour,b.event_type,b.agent_class,sum(b.request_count) AS requests
FROM app.interaction_buckets b JOIN app.message_engagement e ON e.message_id=b.message_id
WHERE b.bucket_hour>=clock_timestamp()-interval '90 days' GROUP BY e.campaign_id,e.experiment_id,e.variant_id,b.bucket_hour,b.event_type,b.agent_class;
GRANT SELECT ON agent_api.interaction_timeline TO prospection95_agent,prospection95_app;

DO $contract$
DECLARE src text;
BEGIN
 src:=pg_get_functiondef('crm_api.crm_campaign_update(uuid,bigint,jsonb)'::regprocedure);
 src:=replace(src,'''trackingClicksEnabled'',','''trackingClicksEnabled'',''advancedInteractionsEnabled'',''readDelayEnabled'',');
 src:=replace(src,'UPDATE app.campaigns SET', $p$UPDATE app.campaigns SET
  advanced_interactions_enabled=CASE WHEN p_patch?'advancedInteractionsEnabled' THEN (p_patch->>'advancedInteractionsEnabled')::boolean ELSE advanced_interactions_enabled END,
  read_delay_enabled=CASE WHEN p_patch?'readDelayEnabled' THEN (p_patch->>'readDelayEnabled')::boolean ELSE read_delay_enabled END,$p$);
 EXECUTE src;
 src:=pg_get_functiondef('crm_api.crm_campaign_create(jsonb,text)'::regprocedure);
 src:=replace(src,'tracking_opens_enabled,tracking_clicks_enabled,experiment_policy',
   'tracking_opens_enabled,tracking_clicks_enabled,advanced_interactions_enabled,read_delay_enabled,experiment_policy');
 src:=replace(src,'coalesce((c->>''trackingClicksEnabled'')::boolean,true),',
   'coalesce((c->>''trackingClicksEnabled'')::boolean,true),coalesce((c->>''advancedInteractionsEnabled'')::boolean,false),coalesce((c->>''readDelayEnabled'')::boolean,false),');
 EXECUTE src;
 IF position('c.advanced_interactions_enabled' IN pg_get_viewdef('crm_api.campaigns'::regclass,true))=0 THEN
 EXECUTE 'CREATE OR REPLACE VIEW crm_api.campaigns WITH(security_barrier=true) AS '||replace(pg_get_viewdef('crm_api.campaigns'::regclass,true),'FROM app.campaigns c;',', c.advanced_interactions_enabled,c.read_delay_enabled FROM app.campaigns c;');
 END IF;
 IF position('c.advanced_interactions_enabled' IN pg_get_viewdef('agent_api.campaign_parameters'::regclass,true))=0 THEN
 EXECUTE 'CREATE OR REPLACE VIEW agent_api.campaign_parameters WITH(security_barrier=true) AS '||replace(pg_get_viewdef('agent_api.campaign_parameters'::regclass,true),'FROM app.campaigns c',', c.advanced_interactions_enabled,c.read_delay_enabled FROM app.campaigns c');
 END IF;
END;
$contract$;
INSERT INTO app.schema_migrations(version) VALUES('042_advanced_interactions') ON CONFLICT(version) DO NOTHING;
