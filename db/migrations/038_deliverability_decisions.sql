CREATE TABLE app.deliverability_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES app.gmail_accounts(id),
 previous_decision_id uuid REFERENCES app.deliverability_decisions(id),
 action text NOT NULL CHECK(action IN ('maintain','reduce','suspend','increase')),
 daily_limit integer NOT NULL CHECK(daily_limit>=0), score numeric CHECK(score BETWEEN 0 AND 100),
 rationale text NOT NULL CHECK(length(btrim(rationale)) BETWEEN 1 AND 20000),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='array'),
 agent_run_id uuid NOT NULL REFERENCES audit.agent_runs(id), idempotency_key text NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX deliverability_decisions_account_idx ON app.deliverability_decisions(account_id,created_at DESC,id DESC);
REVOKE ALL ON app.deliverability_decisions FROM PUBLIC,prospection95_agent,prospection95_crm;
GRANT SELECT ON app.deliverability_decisions TO prospection95_app;
CREATE TRIGGER immutable_deliverability_decision BEFORE UPDATE OR DELETE ON app.deliverability_decisions FOR EACH ROW EXECUTE FUNCTION audit.forbid_event_mutation();

CREATE VIEW agent_api.deliverability_evidence WITH(security_barrier=true) AS
 SELECT 'bobwork'::text AS kind,b.id,b.account_id,b.observed_at,
 jsonb_build_object('metrics',b.metrics,'connected',b.connected,'warmupState',b.warmup_state) AS data FROM app.bobwork_snapshots b WHERE b.account_id IS NOT NULL
 UNION ALL
 SELECT 'diagnostic',r.id,q.sender_account_id,r.observed_at,
 jsonb_build_object('providerId',q.provider_id,'overallState',r.overall_state,'url',r.report_url,'summary',r.raw_summary,
 'results',(SELECT jsonb_agg(to_jsonb(d)-'id'-'report_id') FROM app.diagnostic_results d WHERE d.report_id=r.id))
 FROM app.diagnostic_reports r JOIN app.diagnostic_requests q ON q.id=r.request_id
 UNION ALL
 SELECT 'smtp',a.id,j.account_id,coalesce(a.finished_at,a.started_at),
 jsonb_build_object('outcome',a.outcome,'errorCode',a.error_code) FROM app.outbox_attempts a JOIN app.outbox_jobs j ON j.id=a.job_id;
CREATE VIEW agent_api.deliverability_decisions WITH(security_barrier=true) AS SELECT * FROM app.deliverability_decisions;
CREATE VIEW agent_api.account_volume_policy WITH(security_barrier=true) AS
 SELECT a.id AS account_id,a.daily_limit AS user_daily_limit,a.warmup_daily_limit,
 d.id AS decision_id,d.action,d.daily_limit AS ai_daily_limit,d.score,d.rationale,d.evidence,d.created_at AS decided_at,
 least(a.daily_limit,coalesce(a.warmup_daily_limit,a.daily_limit),coalesce(d.daily_limit,a.daily_limit)) AS effective_daily_limit,
 a.status,a.paused_at,a.pause_source
 FROM app.gmail_accounts a LEFT JOIN LATERAL(SELECT * FROM app.deliverability_decisions d WHERE d.account_id=a.id ORDER BY created_at DESC,id DESC LIMIT 1) d ON true WHERE a.deleted_at IS NULL;
GRANT SELECT ON agent_api.deliverability_evidence,agent_api.deliverability_decisions,agent_api.account_volume_policy TO prospection95_agent,prospection95_app;

CREATE FUNCTION agent_api.decide_account_volume(p_account_id uuid,p_expected_decision_id uuid,p_action text,p_daily_limit integer,p_score numeric,p_rationale text,p_evidence jsonb,p_run_id uuid,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app,audit AS $decision$
DECLARE a app.gmail_accounts; previous app.deliverability_decisions; saved app.deliverability_decisions;
 ceiling integer; current_limit integer; target integer; e jsonb; latest_b uuid; latest_d uuid;
BEGIN
 IF length(coalesce(p_idempotency_key,'')) NOT BETWEEN 8 AND 200 OR p_action NOT IN ('maintain','reduce','suspend','increase')
 OR length(btrim(coalesce(p_rationale,''))) NOT BETWEEN 1 AND 20000 OR (p_score IS NOT NULL AND (p_score<0 OR p_score>100))
 OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid_volume_decision'; END IF;
 IF NOT EXISTS(SELECT 1 FROM audit.agent_runs WHERE id=p_run_id AND agent_type='deliverability' AND status='running') THEN RAISE EXCEPTION 'deliverability_run_not_active'; END IF;
 SELECT * INTO a FROM app.gmail_accounts WHERE id=p_account_id AND deleted_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'account_not_found'; END IF;
 SELECT * INTO saved FROM app.deliverability_decisions WHERE idempotency_key=p_idempotency_key;
 IF FOUND THEN
  IF saved.account_id<>p_account_id OR saved.action<>p_action OR saved.rationale<>p_rationale OR saved.evidence<>p_evidence OR saved.score IS DISTINCT FROM p_score
    OR (p_daily_limit IS NOT NULL AND saved.daily_limit<>p_daily_limit) THEN RAISE EXCEPTION 'volume_idempotency_conflict'; END IF;
  RETURN to_jsonb(saved);
 END IF;
 SELECT * INTO previous FROM app.deliverability_decisions WHERE account_id=a.id ORDER BY created_at DESC,id DESC LIMIT 1;
 IF previous.id IS DISTINCT FROM p_expected_decision_id THEN RAISE EXCEPTION 'volume_decision_conflict'; END IF;
 ceiling:=least(a.daily_limit,coalesce(a.warmup_daily_limit,a.daily_limit));
 current_limit:=least(ceiling,coalesce(previous.daily_limit,ceiling));
 target:=CASE WHEN p_action='suspend' THEN 0 WHEN p_action='maintain' THEN current_limit ELSE p_daily_limit END;
 IF target IS NULL OR target<0 OR target>ceiling OR (p_action='reduce' AND target>=current_limit)
 OR (p_action='increase' AND target<=current_limit) OR (p_action='maintain' AND p_daily_limit IS NOT NULL AND p_daily_limit<>target)
 OR (p_action='suspend' AND p_daily_limit IS NOT NULL AND p_daily_limit<>0) THEN RAISE EXCEPTION 'invalid_volume_target'; END IF;
 FOR e IN SELECT * FROM jsonb_array_elements(p_evidence) LOOP
  IF NOT EXISTS(SELECT 1 FROM agent_api.deliverability_evidence v WHERE v.account_id=a.id AND v.kind=e->>'kind' AND v.id=(e->>'id')::uuid) THEN RAISE EXCEPTION 'volume_evidence_not_found'; END IF;
 END LOOP;
 SELECT id INTO latest_b FROM app.bobwork_snapshots WHERE account_id=a.id ORDER BY observed_at DESC,id DESC LIMIT 1;
 SELECT r.id INTO latest_d FROM app.diagnostic_reports r JOIN app.diagnostic_requests q ON q.id=r.request_id WHERE q.sender_account_id=a.id ORDER BY r.observed_at DESC,r.id DESC LIMIT 1;
 IF latest_b IS NOT NULL AND NOT p_evidence @> jsonb_build_array(jsonb_build_object('kind','bobwork','id',latest_b)) THEN RAISE EXCEPTION 'latest_bobwork_evidence_required'; END IF;
 IF latest_d IS NOT NULL AND NOT p_evidence @> jsonb_build_array(jsonb_build_object('kind','diagnostic','id',latest_d)) THEN RAISE EXCEPTION 'latest_diagnostic_evidence_required'; END IF;
 IF jsonb_array_length(p_evidence)=0 AND (p_score IS NOT NULL OR p_action<>'maintain') THEN RAISE EXCEPTION 'volume_decision_requires_evidence'; END IF;
 INSERT INTO app.deliverability_decisions(account_id,previous_decision_id,action,daily_limit,score,rationale,evidence,agent_run_id,idempotency_key)
 VALUES(a.id,previous.id,p_action,target,p_score,p_rationale,p_evidence,p_run_id,p_idempotency_key) RETURNING * INTO saved;
 RETURN to_jsonb(saved);
END;
$decision$;
REVOKE ALL ON FUNCTION agent_api.decide_account_volume(uuid,uuid,text,integer,numeric,text,jsonb,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_api.decide_account_volume(uuid,uuid,text,integer,numeric,text,jsonb,uuid,text) TO prospection95_agent;

CREATE FUNCTION app.account_volume_limit(p_account_id uuid) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $limit$
 SELECT least(a.daily_limit,coalesce(a.warmup_daily_limit,a.daily_limit),coalesce((SELECT d.daily_limit FROM app.deliverability_decisions d WHERE d.account_id=a.id ORDER BY d.created_at DESC,d.id DESC LIMIT 1),a.daily_limit)) FROM app.gmail_accounts a WHERE a.id=p_account_id;
$limit$;
REVOKE ALL ON FUNCTION app.account_volume_limit(uuid) FROM PUBLIC,prospection95_agent,prospection95_crm;
GRANT EXECUTE ON FUNCTION app.account_volume_limit(uuid) TO prospection95_app;
DO $lease$
DECLARE old text; revised text;
BEGIN
 old:=pg_get_functiondef('app.lease_outbox_jobs(text,integer,integer)'::regprocedure);
 revised:=replace(old,'effective_limit := LEAST(account_row.daily_limit,', 'effective_limit := LEAST(app.account_volume_limit(account_row.id), account_row.daily_limit,');
 IF old=revised THEN RAISE EXCEPTION 'volume_lease_patch_missing'; END IF;
 EXECUTE revised;
 old:=pg_get_functiondef('app.start_outbox_attempt(uuid,uuid)'::regprocedure);
 revised:=replace(old,'prospect_email text;','prospect_email text; volume_day_start timestamptz; volume_day_end timestamptz;');
 revised:=replace(revised,'IF job.status = ''running'' THEN',
 $patch$IF job.status='reserved' THEN
  PERFORM 1 FROM app.gmail_accounts WHERE id=job.account_id FOR UPDATE;
  SELECT date_trunc('day',clock_timestamp() AT TIME ZONE timezone) AT TIME ZONE timezone,
    (date_trunc('day',clock_timestamp() AT TIME ZONE timezone)+interval '1 day') AT TIME ZONE timezone
    INTO volume_day_start,volume_day_end FROM app.gmail_accounts WHERE id=job.account_id;
  IF NOT EXISTS(SELECT 1 FROM app.gmail_accounts WHERE id=job.account_id AND status='active' AND paused_at IS NULL AND deleted_at IS NULL)
     OR NOT EXISTS(SELECT 1 FROM app.settings WHERE singleton AND outbound_enabled AND NOT emergency_stop)
     OR (SELECT count(*) FROM app.email_messages m WHERE m.sender_account_id=job.account_id AND m.direction='outbound' AND m.technical_confirmation
     AND coalesce(m.smtp_accepted_at,m.sent_at)>=volume_day_start AND coalesce(m.smtp_accepted_at,m.sent_at)<volume_day_end)
     + (SELECT count(*) FROM app.outbox_jobs other WHERE other.account_id=job.account_id AND other.id<>job.id AND
       (other.status IN ('reserved','running') AND other.lease_expires_at>=clock_timestamp() OR other.status='uncertain' AND other.uncertain_since>=volume_day_start AND other.uncertain_since<volume_day_end))
     >=app.account_volume_limit(job.account_id) THEN
    UPDATE app.outbox_jobs SET status='deferred',due_at=clock_timestamp()+interval '15 minutes',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=job.id RETURNING * INTO job;
    RETURN job;
  END IF;
 END IF;
 IF job.status = 'running' THEN$patch$);
 IF old=revised THEN RAISE EXCEPTION 'volume_start_patch_missing'; END IF;
 EXECUTE revised;
END;
$lease$;
INSERT INTO app.schema_migrations(version) VALUES('038_deliverability_decisions') ON CONFLICT(version) DO NOTHING;
