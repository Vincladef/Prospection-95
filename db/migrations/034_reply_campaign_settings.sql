-- Extend the existing editing contract; keep compare-and-swap, audits and grants.
DO $settings$
DECLARE original text; changed text;
BEGIN
 original:=pg_get_functiondef('crm_api.crm_campaign_update(uuid,bigint,jsonb)'::regprocedure);
 changed:=replace(original,'''replyInstructions'',','''replyInstructions'',''replyMode'',''replyIterations'',');
 changed:=replace(changed,'UPDATE app.campaigns SET',
 $patch$IF p_patch?'replyMode' AND coalesce(p_patch->>'replyMode','') NOT IN ('draft','automatic') THEN RAISE EXCEPTION 'crm_invalid_reply_mode'; END IF;
 IF p_patch?'replyIterations' THEN
   IF jsonb_typeof(p_patch->'replyIterations') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'crm_invalid_reply_iterations'; END IF;
   IF jsonb_array_length(p_patch->'replyIterations') NOT BETWEEN 1 AND 100
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_patch->'replyIterations') v WHERE jsonb_typeof(v)<>'string' OR length(v#>>'{}')>200000)
      THEN RAISE EXCEPTION 'crm_invalid_reply_iterations'; END IF;
 END IF;
 UPDATE app.campaigns SET
   reply_mode=CASE WHEN p_patch?'replyMode' THEN p_patch->>'replyMode' ELSE reply_mode END,
   reply_iteration_instructions=CASE WHEN p_patch?'replyIterations' THEN ARRAY(SELECT jsonb_array_elements_text(p_patch->'replyIterations')) ELSE reply_iteration_instructions END,$patch$);
 IF changed=original OR position('crm_invalid_reply_mode' IN changed)=0 THEN RAISE EXCEPTION 'reply_settings_target_missing'; END IF;
 EXECUTE changed;
 -- New settings are appended so existing view column contracts remain intact.
 EXECUTE 'CREATE OR REPLACE VIEW crm_api.campaigns WITH(security_barrier=true) AS '||
   replace(pg_get_viewdef('crm_api.campaigns'::regclass,true),'FROM app.campaigns c;',', c.reply_mode, c.reply_iteration_instructions FROM app.campaigns c;');
 EXECUTE 'CREATE OR REPLACE VIEW agent_api.campaign_parameters WITH(security_barrier=true) AS '||
   replace(pg_get_viewdef('agent_api.campaign_parameters'::regclass,true),'FROM app.campaigns c',', c.reply_mode, c.reply_iteration_instructions FROM app.campaigns c');
END;
$settings$;
INSERT INTO app.schema_migrations(version) VALUES('034_reply_campaign_settings') ON CONFLICT(version) DO NOTHING;

-- Switching automatic replies back to drafts also withdraws queued, unsent work.
CREATE FUNCTION app.switch_queued_replies_to_drafts() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $mode$
DECLARE w app.reply_workflows; source app.email_messages; sender_id uuid; request_id uuid;
BEGIN
 IF OLD.reply_mode='automatic' AND NEW.reply_mode='draft' THEN
  FOR w IN SELECT rw.* FROM app.reply_workflows rw WHERE rw.campaign_id=NEW.id AND rw.state='queued'
    AND EXISTS(SELECT 1 FROM app.outbox_jobs j WHERE j.message_id=rw.output_message_id AND j.status IN ('scheduled','pending','deferred','reserved')) FOR UPDATE LOOP
   UPDATE app.outbox_jobs SET status='cancelled',cancel_reason='reply_mode_draft',cancelled_at=clock_timestamp() WHERE message_id=w.output_message_id AND status IN ('scheduled','pending','deferred','reserved');
   UPDATE app.email_messages SET status='cancelled' WHERE id=w.output_message_id AND NOT technical_confirmation;
   SELECT * INTO source FROM app.email_messages WHERE id=w.source_message_id;
   SELECT sender_account_id INTO sender_id FROM app.conversations WHERE id=w.conversation_id;
   INSERT INTO app.reply_draft_requests(source_message_id,conversation_id,sender_account_id,proposed_subject,proposed_body,state,idempotency_key)
   VALUES(source.id,w.conversation_id,sender_id,w.subject,w.body,'requested','reply:'||w.id)
   ON CONFLICT(source_message_id) DO UPDATE SET source_message_id=EXCLUDED.source_message_id RETURNING id INTO request_id;
   UPDATE app.reply_workflows SET state='draft_requested',draft_request_id=request_id,updated_at=clock_timestamp() WHERE id=w.id;
  END LOOP;
 END IF;
 RETURN NEW;
END;
$mode$;
REVOKE ALL ON FUNCTION app.switch_queued_replies_to_drafts() FROM PUBLIC,prospection95_agent,prospection95_crm;
CREATE TRIGGER switch_queued_replies_to_drafts AFTER UPDATE OF reply_mode ON app.campaigns FOR EACH ROW EXECUTE FUNCTION app.switch_queued_replies_to_drafts();
