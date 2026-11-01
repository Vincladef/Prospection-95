ALTER TABLE app.outbox_jobs ADD COLUMN precommit_abort_count integer NOT NULL DEFAULT 0 CHECK(precommit_abort_count>=0);

-- One sequence clock shared by automatic and manual scheduling and final dispatch.
CREATE FUNCTION app.prospection_earliest_at(p_message uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT CASE WHEN m.step='J0' THEN c.created_at ELSE
   (SELECT max(coalesce(prev.smtp_accepted_at,prev.sent_at)) FROM app.email_messages prev
    WHERE prev.conversation_id=m.conversation_id AND prev.direction='outbound' AND prev.kind='prospection'
      AND prev.technical_confirmation AND prev.step=CASE m.step
        WHEN 'R1' THEN 'J0'::app.sequence_step WHEN 'R2' THEN 'R1'::app.sequence_step
        WHEN 'R3' THEN 'R2'::app.sequence_step WHEN 'R4' THEN 'R3'::app.sequence_step WHEN 'R5' THEN 'R4'::app.sequence_step END)
   + CASE m.step WHEN 'R1' THEN interval '3 days' WHEN 'R2' THEN interval '7 days'
       WHEN 'R3' THEN interval '7 days' ELSE interval '14 days' END END
 FROM app.email_messages m JOIN app.conversations c ON c.id=m.conversation_id
 WHERE m.id=p_message AND m.direction='outbound' AND m.kind='prospection';
$$;
CREATE FUNCTION app.prospection_message_is_eligible(p_message uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.email_messages m JOIN app.conversations c ON c.id=m.conversation_id
 JOIN app.campaigns campaign ON campaign.id=c.campaign_id JOIN app.prospects p ON p.id=c.prospect_id
 WHERE m.id=p_message AND m.direction='outbound' AND m.kind='prospection' AND NOT m.technical_confirmation
 AND c.state IN ('prepared','active') AND c.followups_stopped_at IS NULL
 AND campaign.status IN ('active','existing_only') AND campaign.archived_at IS NULL AND NOT campaign.imported_disabled
 AND p.deleted_at IS NULL AND p.normalized_email IS NOT NULL AND NOT app.is_excluded(p.normalized_email)
 AND app.prospection_earliest_at(m.id) IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM app.email_messages sent WHERE sent.conversation_id=c.id AND sent.step=m.step AND sent.technical_confirmation)
 AND NOT EXISTS(SELECT 1 FROM app.email_messages reply WHERE reply.conversation_id=c.id AND reply.direction='inbound' AND reply.kind='reply')
 AND NOT EXISTS(SELECT 1 FROM app.email_messages newer WHERE newer.conversation_id=c.id AND newer.step=m.step AND newer.direction='outbound' AND newer.content_version>m.content_version)
 AND (m.step<>'J0' OR NOT EXISTS(SELECT 1 FROM app.contact_history h WHERE h.normalized_email=p.normalized_email)));
$$;
REVOKE ALL ON FUNCTION app.prospection_earliest_at(uuid),app.prospection_message_is_eligible(uuid) FROM PUBLIC,prospection95_agent,prospection95_crm;
GRANT EXECUTE ON FUNCTION app.prospection_earliest_at(uuid),app.prospection_message_is_eligible(uuid) TO prospection95_app;

CREATE FUNCTION app.guard_prospection_schedule() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NEW.job_kind='prospection' AND NEW.status IN ('pending','scheduled','deferred','reserved','running') THEN
  IF NOT app.prospection_message_is_eligible(NEW.message_id) THEN
   NEW.status:='cancelled'; NEW.cancel_reason:='conversation_no_longer_eligible';NEW.cancelled_at:=clock_timestamp();
   NEW.lease_expires_at:=NULL;
  ELSE
   NEW.due_at:=greatest(NEW.due_at,app.prospection_earliest_at(NEW.message_id));
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.guard_prospection_schedule() FROM PUBLIC,prospection95_agent,prospection95_crm;
CREATE TRIGGER guard_prospection_schedule BEFORE INSERT OR UPDATE OF status,due_at ON app.outbox_jobs
FOR EACH ROW EXECUTE FUNCTION app.guard_prospection_schedule();

DO $patch$
DECLARE original text; changed text;
BEGIN
 original:=pg_get_functiondef('app.lease_outbox_jobs(text,integer,integer)'::regprocedure);
 changed:=replace(original,'AND conv.followups_stopped_at IS NULL',
 'AND app.prospection_message_is_eligible(j.message_id) AND app.prospection_earliest_at(j.message_id)<=clock_timestamp() AND conv.followups_stopped_at IS NULL');
 changed:=replace(changed,'j.attempt_count < j.max_attempts','j.attempt_count-j.precommit_abort_count < j.max_attempts');
 -- Keep follow-ups first across accounts, then share capacity by daily use and
 -- rotate equal loads using their last actual send / active reservation.
 changed:=replace(changed,'     ORDER BY (', $fair$     ORDER BY
       CASE WHEN EXISTS(SELECT 1 FROM app.outbox_jobs j WHERE j.account_id=a.id AND j.job_kind='prospection' AND j.step<>'J0'
         AND j.status IN ('pending','scheduled','deferred') AND j.due_at<=clock_timestamp()
         AND app.prospection_message_is_eligible(j.message_id) AND app.prospection_earliest_at(j.message_id)<=clock_timestamp()) THEN 0 ELSE 1 END,
       ((SELECT count(*)::numeric FROM app.email_messages m WHERE m.sender_account_id=a.id AND m.technical_confirmation
           AND coalesce(m.smtp_accepted_at,m.sent_at)>=date_trunc('day',clock_timestamp() AT TIME ZONE a.timezone) AT TIME ZONE a.timezone)
         +(SELECT count(*) FROM app.outbox_jobs j WHERE j.account_id=a.id AND j.status IN ('reserved','running') AND j.lease_expires_at>=clock_timestamp()))
         /greatest(1,app.account_volume_limit(a.id)),
       greatest((SELECT max(coalesce(m.smtp_accepted_at,m.sent_at)) FROM app.email_messages m WHERE m.sender_account_id=a.id AND m.technical_confirmation),
         (SELECT max(j.updated_at) FROM app.outbox_jobs j WHERE j.account_id=a.id AND j.status IN ('reserved','running') AND j.lease_expires_at>=clock_timestamp())) NULLS FIRST,
       ($fair$);
 IF changed=original THEN RAISE EXCEPTION 'lease_clock_patch_missing'; END IF;
 EXECUTE changed;
 original:=pg_get_functiondef('app.start_outbox_attempt(uuid,uuid)'::regprocedure);
 changed:=replace(original, 'IF job.job_kind=''reply''', $clock$  IF job.job_kind='prospection' AND job.status='reserved' AND app.prospection_message_is_eligible(job.message_id)
   AND app.prospection_earliest_at(job.message_id)>clock_timestamp() THEN
   UPDATE app.outbox_jobs SET status='deferred',due_at=app.prospection_earliest_at(message_id),lease_expires_at=NULL,
    lease_owner=NULL,lease_token=NULL,last_error_code='sequence_delay_not_elapsed' WHERE id=job.id RETURNING * INTO job;
   RETURN job;
  END IF;
  IF job.job_kind='reply'$clock$);
 -- The conversation check is authoritative even if a stale/manual job survived.
 changed:=replace(changed,'AND job.job_kind=''prospection'' AND NOT EXISTS(','AND job.job_kind=''prospection'' AND (NOT app.prospection_message_is_eligible(job.message_id) OR NOT EXISTS(');
 changed:=replace(changed,'AND inbound.direction=''inbound'' AND inbound.kind=''reply'')) THEN', 'AND inbound.direction=''inbound'' AND inbound.kind=''reply''))) THEN');
 IF changed=original THEN RAISE EXCEPTION 'start_clock_patch_missing'; END IF;
 EXECUTE changed;
 original:=pg_get_functiondef('app.schedule_due_messages(integer)'::regprocedure);
 changed:=replace(original,'AND conv.followups_stopped_at IS NULL','AND app.prospection_message_is_eligible(m.id) AND conv.followups_stopped_at IS NULL');
 changed:=replace(changed,'             clock_timestamp(),','             greatest(clock_timestamp(),app.prospection_earliest_at(m.id)),');
 EXECUTE changed;
 -- Assignments remain drafts until a real confirmed send, including step tests.
 original:=pg_get_functiondef('agent_api.propose_completed_sequence(uuid,uuid,uuid,text)'::regprocedure);
 changed:=regexp_replace(original,'    UPDATE app.experiment_assignments SET exposed_at[^;]*;','');
 changed:=regexp_replace(changed,'    UPDATE app.experiment_variants SET exposed_at[^;]*;','');
 IF changed=original THEN RAISE EXCEPTION 'exposure_patch_missing'; END IF;
 EXECUTE changed;
END;
$patch$;

ALTER TABLE app.email_messages ADD COLUMN tracking_opens_enabled boolean;
ALTER TABLE app.email_messages ADD COLUMN tracking_clicks_enabled boolean;
-- Historical measurements establish tracking for those messages only.
UPDATE app.email_messages m SET tracking_opens_enabled=true WHERE EXISTS(SELECT 1 FROM app.tracking_events t WHERE t.message_id=m.id AND t.event_type='open');
UPDATE app.email_messages m SET tracking_clicks_enabled=true WHERE EXISTS(SELECT 1 FROM app.tracking_events t WHERE t.message_id=m.id AND t.event_type='click');

CREATE FUNCTION app.mark_variant_exposure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE assignment app.experiment_assignments; at_time timestamptz;
BEGIN
 IF NEW.direction='outbound' AND NEW.kind='prospection' AND NEW.technical_confirmation THEN
  SELECT a.* INTO assignment FROM app.experiment_assignments a JOIN app.conversations c ON c.experiment_assignment_id=a.id
    WHERE c.id=NEW.conversation_id AND (a.assigned_for_step IS NULL OR a.assigned_for_step=NEW.step);
  at_time:=coalesce(NEW.smtp_accepted_at,NEW.sent_at);
  IF assignment.id IS NOT NULL AND at_time IS NOT NULL THEN
   UPDATE app.experiment_assignments SET exposed_at=least(exposed_at,at_time) WHERE id=assignment.id;
   UPDATE app.experiment_variants SET exposed_at=least(exposed_at,at_time) WHERE id=assignment.variant_id;
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.mark_variant_exposure() FROM PUBLIC,prospection95_agent,prospection95_crm;
CREATE TRIGGER mark_variant_exposure AFTER INSERT OR UPDATE OF technical_confirmation ON app.email_messages
FOR EACH ROW EXECUTE FUNCTION app.mark_variant_exposure();
UPDATE app.experiment_assignments a SET exposed_at=(SELECT min(coalesce(m.smtp_accepted_at,m.sent_at))
 FROM app.conversations c JOIN app.email_messages m ON m.conversation_id=c.id
 WHERE c.experiment_assignment_id=a.id AND m.kind='prospection' AND m.direction='outbound' AND m.technical_confirmation
 AND (a.assigned_for_step IS NULL OR a.assigned_for_step=m.step));
UPDATE app.experiment_variants v SET exposed_at=(SELECT min(a.exposed_at) FROM app.experiment_assignments a WHERE a.variant_id=v.id);

CREATE OR REPLACE VIEW agent_api.experiment_metrics WITH(security_barrier=true) AS
WITH assignments AS (
 SELECT a.experiment_id,a.variant_id,count(DISTINCT a.prospect_id) AS assigned_prospects,min(a.assigned_at) AS first_assignment_at
 FROM app.experiment_assignments a GROUP BY a.experiment_id,a.variant_id
), sent AS (
 SELECT a.experiment_id,a.variant_id,count(DISTINCT m.id) AS smtp_accepted,count(DISTINCT a.prospect_id) AS contacted_prospects,
 max(coalesce(m.smtp_accepted_at,m.sent_at)) AS last_sent_at,
 count(DISTINCT m.id) FILTER(WHERE m.tracking_opens_enabled) AS tracked_open_sends,
 count(DISTINCT m.id) FILTER(WHERE m.tracking_clicks_enabled) AS tracked_click_sends
 FROM app.experiment_assignments a JOIN app.conversations c ON c.experiment_assignment_id=a.id
 JOIN app.email_messages m ON m.conversation_id=c.id AND m.direction='outbound' AND m.kind='prospection' AND m.technical_confirmation
 WHERE a.assigned_for_step IS NULL OR a.assigned_for_step=m.step GROUP BY a.experiment_id,a.variant_id
), responses AS (
 SELECT a.experiment_id,a.variant_id,
 count(DISTINCT m.id) FILTER(WHERE analysis.classification IN ('positive','negative','information','meeting','ambiguous','opposition')) AS human_replies,
 count(DISTINCT m.id) FILTER(WHERE analysis.classification='positive' OR analysis.commercial_sentiment='positive') AS positive_replies,
 count(DISTINCT m.id) FILTER(WHERE analysis.meeting_confirmed) AS confirmed_meetings,
 count(DISTINCT m.id) FILTER(WHERE analysis.id IS NULL) AS unclassified_responses,
 count(DISTINCT a.prospect_id) FILTER(WHERE analysis.classification IN ('positive','negative','information','meeting','ambiguous','opposition')) AS replied_prospects,
 count(DISTINCT a.prospect_id) FILTER(WHERE analysis.classification='positive' OR analysis.commercial_sentiment='positive') AS positive_prospects,
 count(DISTINCT a.prospect_id) FILTER(WHERE analysis.meeting_confirmed) AS meeting_prospects,
 max(coalesce(analysis.created_at,m.received_at)) AS last_response_at
 FROM app.experiment_assignments a JOIN app.conversations c ON c.experiment_assignment_id=a.id
 JOIN app.email_messages m ON m.conversation_id=c.id AND m.direction='inbound' AND m.kind='reply' AND m.status='received'
 LEFT JOIN app.inbound_analyses analysis ON analysis.message_id=m.id
 WHERE a.exposed_at IS NOT NULL AND coalesce(m.received_at,m.created_at)>=a.exposed_at GROUP BY a.experiment_id,a.variant_id
), tracking AS (
 SELECT a.experiment_id,a.variant_id,count(DISTINCT t.message_id) FILTER(WHERE t.event_type='open') AS measured_opens,
 count(DISTINCT t.message_id) FILTER(WHERE t.event_type='click') AS measured_clicks,max(t.observed_at) AS last_tracking_at
 FROM app.experiment_assignments a JOIN app.conversations c ON c.experiment_assignment_id=a.id
 JOIN app.email_messages m ON m.conversation_id=c.id AND m.direction='outbound' AND m.kind='prospection' AND m.technical_confirmation
 JOIN app.tracking_events t ON t.message_id=m.id
 WHERE a.assigned_for_step IS NULL OR a.assigned_for_step=m.step GROUP BY a.experiment_id,a.variant_id
)
SELECT a.experiment_id,a.variant_id,a.assigned_prospects,coalesce(s.smtp_accepted,0) AS smtp_accepted,
 coalesce(r.human_replies,0) AS human_replies,coalesce(r.positive_replies,0) AS positive_replies,coalesce(r.confirmed_meetings,0) AS confirmed_meetings,
 coalesce(t.measured_opens,0) AS measured_opens,coalesce(t.measured_clicks,0) AS measured_clicks,a.first_assignment_at,
 greatest(s.last_sent_at,r.last_response_at,t.last_tracking_at) AS last_event_at,coalesce(r.unclassified_responses,0) AS unclassified_responses,
 coalesce(s.contacted_prospects,0) AS contacted_prospects,coalesce(r.replied_prospects,0) AS replied_prospects,
 coalesce(r.positive_prospects,0) AS positive_prospects,coalesce(r.meeting_prospects,0) AS meeting_prospects,
 coalesce(s.tracked_open_sends,0) AS tracked_open_sends,coalesce(s.tracked_click_sends,0) AS tracked_click_sends
FROM assignments a LEFT JOIN sent s USING(experiment_id,variant_id) LEFT JOIN responses r USING(experiment_id,variant_id) LEFT JOIN tracking t USING(experiment_id,variant_id);
DO $metrics$
DECLARE original text;
BEGIN
 original:=pg_get_functiondef('agent_api.advance_experiment(uuid,uuid,text)'::regprocedure);
 EXECUTE replace(replace(original,'metrics.smtp_accepted','metrics.contacted_prospects'),'metrics.human_replies','metrics.replied_prospects');
 original:=pg_get_functiondef('app.select_campaign_sender(uuid,uuid,uuid)'::regprocedure);
 EXECUTE replace(original,'AND cp.state IN (''reserved'',''prepared'',''engaged'',''replied'')','');
END;
$metrics$;

-- Keep stopped conversations coherent, including old manual outbound updates.
CREATE FUNCTION app.normalize_stopped_conversation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.followups_stopped_at IS NOT NULL THEN
  NEW.next_step_due_at:=NULL;
  IF NEW.state IN ('active','prepared') THEN
   NEW.state:=CASE WHEN NEW.last_inbound_at IS NOT NULL OR NEW.followups_stop_reason='relevant_inbound' THEN 'replied' ELSE 'paused' END;
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.normalize_stopped_conversation() FROM PUBLIC,prospection95_agent,prospection95_crm;
CREATE TRIGGER normalize_stopped_conversation BEFORE INSERT OR UPDATE ON app.conversations
FOR EACH ROW EXECUTE FUNCTION app.normalize_stopped_conversation();
UPDATE app.conversations SET next_step_due_at=NULL WHERE followups_stopped_at IS NOT NULL;
-- Re-evaluate queued work through the same clock. Sent history is preserved.
UPDATE app.outbox_jobs SET due_at=due_at WHERE job_kind='prospection' AND status IN ('pending','scheduled','deferred','reserved');
INSERT INTO app.schema_migrations(version) VALUES('040_sequence_safety_and_metrics') ON CONFLICT(version) DO NOTHING;

CREATE FUNCTION app.outbox_commit_is_ready(p_job uuid,p_token uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.outbox_jobs j JOIN app.gmail_accounts a ON a.id=j.account_id
 JOIN app.settings s ON s.singleton
 WHERE j.id=p_job AND j.lease_token=p_token AND j.status='running' AND j.lease_expires_at>clock_timestamp()
 AND s.outbound_enabled AND NOT s.emergency_stop AND a.status='active' AND a.paused_at IS NULL AND a.deleted_at IS NULL
 AND extract(isodow FROM clock_timestamp() AT TIME ZONE a.timezone)::smallint=ANY(a.send_days)
 AND (clock_timestamp() AT TIME ZONE a.timezone)::time>=a.send_start AND (clock_timestamp() AT TIME ZONE a.timezone)::time<a.send_end
 AND j.due_at<=clock_timestamp()
 AND (SELECT count(*) FROM app.email_messages m WHERE m.sender_account_id=a.id AND m.technical_confirmation
   AND coalesce(m.smtp_accepted_at,m.sent_at)>=date_trunc('day',clock_timestamp() AT TIME ZONE a.timezone) AT TIME ZONE a.timezone)
   +(SELECT count(*) FROM app.outbox_jobs other WHERE other.account_id=a.id AND other.id<>j.id AND
     (other.status IN ('reserved','running') AND other.lease_expires_at>=clock_timestamp() OR other.status='uncertain'
       AND other.uncertain_since>=date_trunc('day',clock_timestamp() AT TIME ZONE a.timezone) AT TIME ZONE a.timezone))<app.account_volume_limit(a.id)
 AND CASE WHEN j.job_kind='reply' THEN app.reply_job_is_ready(j.id)
   WHEN j.job_kind='prospection' THEN app.prospection_message_is_eligible(j.message_id) AND app.prospection_earliest_at(j.message_id)<=clock_timestamp() ELSE true END);
$$;
REVOKE ALL ON FUNCTION app.outbox_commit_is_ready(uuid,uuid) FROM PUBLIC,prospection95_agent,prospection95_crm;
GRANT EXECUTE ON FUNCTION app.outbox_commit_is_ready(uuid,uuid) TO prospection95_app;
