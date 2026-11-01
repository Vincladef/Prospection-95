-- Secondary analyses follow actual source tracking, never legacy opt-in flags.
CREATE OR REPLACE FUNCTION app.record_interaction_bucket(p_message uuid,p_kind text,p_class text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE t timestamptz:=clock_timestamp();
BEGIN
 IF p_class NOT IN ('browser','proxy','automated','unknown') OR p_kind NOT IN ('open','click') THEN RAISE EXCEPTION 'invalid_interaction_sample'; END IF;
 IF NOT EXISTS(SELECT 1 FROM app.email_messages m JOIN app.conversations conv ON conv.id=m.conversation_id JOIN app.campaigns c ON c.id=conv.campaign_id
  WHERE m.id=p_message AND m.technical_confirmation AND m.direction='outbound'
  AND CASE WHEN p_kind='open' THEN c.tracking_opens_enabled AND coalesce(m.tracking_opens_enabled,c.tracking_opens_enabled) ELSE c.tracking_clicks_enabled AND coalesce(m.tracking_clicks_enabled,c.tracking_clicks_enabled) END) THEN RETURN false; END IF;
 INSERT INTO app.interaction_buckets(message_id,event_type,bucket_hour,agent_class,first_seen,last_seen)
 VALUES(p_message,p_kind,date_trunc('hour',t),p_class,t,t)
 ON CONFLICT(message_id,event_type,bucket_hour,agent_class) DO UPDATE SET request_count=app.interaction_buckets.request_count+1,last_seen=t;
 RETURN true;
END;
$$;
CREATE OR REPLACE VIEW app.message_engagement WITH(security_barrier=true) AS
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
 coalesce(m.tracking_opens_enabled,c.tracking_opens_enabled) AS analysis_enabled,
 (coalesce(m.tracking_opens_enabled,c.tracking_opens_enabled) AND coalesce(m.tracking_clicks_enabled,c.tracking_clicks_enabled)) AS read_delay_enabled,
 s.open_requests,s.proxy_open_requests,s.automated_open_requests,s.direct_open_requests,s.first_open,s.last_open,
 CASE WHEN s.open_requests>1 THEN extract(epoch FROM (s.last_open-s.first_open))/(s.open_requests-1) END AS mean_open_interval_seconds,
 CASE WHEN s.first_direct_open IS NOT NULL THEN
  (SELECT min(extract(epoch FROM (b.first_seen-s.first_direct_open))) FROM app.interaction_buckets b
   WHERE b.message_id=m.id AND b.event_type='click' AND b.agent_class='browser' AND b.first_seen>=s.first_direct_open
    AND b.bucket_hour>=clock_timestamp()-interval '90 days') END AS open_to_click_seconds,
 'noisy'::text AS open_reliability,'approximate'::text AS delay_reliability,NULL::numeric AS reading_time_seconds
FROM app.email_messages m JOIN app.conversations conv ON conv.id=m.conversation_id JOIN app.campaigns c ON c.id=conv.campaign_id
LEFT JOIN app.experiment_assignments a ON a.id=conv.experiment_assignment_id AND (a.assigned_for_step IS NULL OR a.assigned_for_step=m.step)
LEFT JOIN samples s ON s.message_id=m.id
WHERE m.direction='outbound' AND m.kind='prospection' AND m.technical_confirmation;
INSERT INTO app.schema_migrations(version) VALUES('046_automatic_interaction_analyses') ON CONFLICT(version) DO NOTHING;
