ALTER TABLE app.outbox_jobs DROP CONSTRAINT outbox_jobs_job_kind_check;
ALTER TABLE app.outbox_jobs ADD CONSTRAINT outbox_jobs_job_kind_check CHECK(job_kind IN ('prospection','diagnostic','draft_sync','reply'));
CREATE FUNCTION app.reply_job_is_ready(p_job_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $ready$
 SELECT EXISTS(SELECT 1 FROM app.outbox_jobs j JOIN app.reply_workflows w ON w.output_message_id=j.message_id
 JOIN app.campaigns c ON c.id=w.campaign_id
 WHERE j.id=p_job_id AND w.state='queued' AND w.mode='automatic' AND c.reply_mode='automatic'
 AND w.completed_iterations=cardinality(w.instructions) AND w.due_at<=clock_timestamp()
 AND app.reply_source_is_current(w.source_message_id));
$ready$;
REVOKE ALL ON FUNCTION app.reply_job_is_ready(uuid) FROM PUBLIC,prospection95_agent,prospection95_crm;
GRANT EXECUTE ON FUNCTION app.reply_job_is_ready(uuid) TO prospection95_app;

DO $guards$
DECLARE original text; changed text;
BEGIN
 original:=pg_get_functiondef('app.lease_outbox_jobs(text,integer,integer)'::regprocedure);
 changed:=replace(original,'ORDER BY CASE WHEN j.step',
   'AND (j.job_kind <> ''reply'' OR app.reply_job_is_ready(j.id)) ORDER BY CASE WHEN j.step');
 IF changed=original THEN RAISE EXCEPTION 'reply_lease_guard_target_missing'; END IF;
 EXECUTE changed;
 original:=pg_get_functiondef('app.start_outbox_attempt(uuid,uuid)'::regprocedure);
 changed:=replace(original,'IF job.status = ''running'' THEN',
 $patch$IF job.job_kind='reply' AND job.status='reserved' AND NOT app.reply_job_is_ready(job.id) THEN
   UPDATE app.outbox_jobs SET status='cancelled',cancel_reason='reply_no_longer_eligible',cancelled_at=clock_timestamp(),lease_expires_at=NULL WHERE id=job.id RETURNING * INTO job;
   UPDATE app.email_messages SET status='cancelled',updated_at=clock_timestamp() WHERE id=job.message_id AND NOT technical_confirmation;
   RETURN job;
 END IF;
 IF job.status = 'running' THEN$patch$);
 IF changed=original THEN RAISE EXCEPTION 'reply_start_guard_target_missing'; END IF;
 EXECUTE changed;
 original:=pg_get_functiondef('app.confirm_smtp_acceptance(uuid,uuid,text,timestamp with time zone)'::regprocedure);
 changed:=replace(original,'(''prospection'',''diagnostic'')','(''prospection'',''diagnostic'',''reply'')');
 changed:=replace(changed,'IF job.prospect_id IS NOT NULL THEN','IF job.prospect_id IS NOT NULL AND job.job_kind <> ''reply'' THEN');
 changed:=replace(changed,'WHERE id = job.conversation_id;', 'WHERE id = job.conversation_id AND job.job_kind <> ''reply'';');
 changed:=replace(changed,'RETURN job;'||chr(10)||'END;',
 $patch$IF job.job_kind='reply' THEN
   UPDATE app.reply_workflows SET state='sent',updated_at=clock_timestamp() WHERE output_message_id=job.message_id;
   UPDATE app.conversations SET last_outbound_at=p_sent_at,updated_at=clock_timestamp(),version=version+1 WHERE id=job.conversation_id;
 END IF;
 RETURN job;
END;$patch$);
 IF changed=original OR position('UPDATE app.reply_workflows' IN changed)=0 THEN RAISE EXCEPTION 'reply_confirmation_target_missing'; END IF;
 EXECUTE changed;
 original:=pg_get_functiondef('app.stop_followups_on_inbound()'::regprocedure);
 changed:=replace(original,'WHERE id = NEW.conversation_id AND followups_stopped_at IS NULL;', 'WHERE id = NEW.conversation_id;');
 IF changed=original THEN RAISE EXCEPTION 'reply_inbound_tracking_target_missing'; END IF;
 EXECUTE changed;
END;
$guards$;
INSERT INTO app.schema_migrations(version) VALUES('033_reply_dispatch_guards') ON CONFLICT(version) DO NOTHING;

-- Reply sends must not inflate the prospection A/B exposure counters.
DO $metrics$
DECLARE original text; changed text;
BEGIN
 original:=pg_get_viewdef('agent_api.experiment_metrics'::regclass,true);
 changed:=replace(original, 'm.direction = ''outbound''::text', 'm.direction = ''outbound''::text AND m.kind <> ''reply''::text');
 IF changed=original THEN RAISE EXCEPTION 'reply_metrics_guard_target_missing'; END IF;
 EXECUTE 'CREATE OR REPLACE VIEW agent_api.experiment_metrics WITH(security_barrier=true) AS '||changed;
END;
$metrics$;
