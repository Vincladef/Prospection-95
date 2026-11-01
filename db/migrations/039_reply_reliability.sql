-- Mailbox safety checks belong to the leased operation, never to a bulk cursor.
ALTER TABLE app.outbox_jobs ADD COLUMN mailbox_checked_at timestamptz;
ALTER TABLE app.outbox_jobs ADD COLUMN mailbox_check_token uuid;
ALTER TABLE app.reply_draft_requests ADD COLUMN lease_token uuid;
ALTER TABLE app.reply_draft_requests ADD COLUMN lease_expires_at timestamptz;
ALTER TABLE app.reply_draft_requests ADD COLUMN attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE app.reply_draft_requests ADD COLUMN last_error_code text;
ALTER TABLE app.reply_draft_requests ADD COLUMN gmail_account_id uuid REFERENCES app.gmail_accounts(id);

-- Never display unsent cancelled work as scheduled. This also covers withdrawal
-- after a new reply, manual Gmail send, exclusion or campaign configuration change.
CREATE FUNCTION app.sync_cancelled_outbox_message() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NEW.status='cancelled' AND OLD.status IS DISTINCT FROM NEW.status THEN
  UPDATE app.email_messages SET status='cancelled',updated_at=clock_timestamp()
  WHERE id=NEW.message_id AND NOT technical_confirmation;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.sync_cancelled_outbox_message() FROM PUBLIC,prospection95_agent,prospection95_crm;
CREATE TRIGGER sync_cancelled_outbox_message AFTER UPDATE OF status ON app.outbox_jobs
FOR EACH ROW EXECUTE FUNCTION app.sync_cancelled_outbox_message();

-- Existing Sent freshness was a coarse queue gate. A targeted Gmail read now
-- happens after leasing; the final SMTP gate requires proof tied to that lease.
DO $patch$
DECLARE original text; changed text;
BEGIN
 original:=pg_get_functiondef('app.reply_job_is_ready(uuid)'::regprocedure);
 changed:=regexp_replace(original,
   'AND EXISTS\(SELECT 1 FROM app.imap_cursors sync.*interval ''5 minutes''\)\)', ')', 's');
 IF changed=original THEN RAISE EXCEPTION 'reply_freshness_patch_missing'; END IF;
 EXECUTE changed;
 original:=pg_get_functiondef('app.start_outbox_attempt(uuid,uuid)'::regprocedure);
 changed:=replace(original,'IF job.job_kind=''reply'' AND job.status=''reserved''', $guard$
 IF job.status='reserved' AND (job.job_kind='reply' OR (job.job_kind='prospection' AND job.step<>'J0'))
   AND (job.mailbox_check_token IS DISTINCT FROM p_lease_token OR job.mailbox_checked_at IS NULL
        OR job.mailbox_checked_at<clock_timestamp()-interval '2 minutes') THEN
  UPDATE app.outbox_jobs SET status='deferred',due_at=clock_timestamp()+interval '2 minutes',
    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,attempt_count=greatest(0,attempt_count-1),
    last_error_code='mailbox_check_required',updated_at=clock_timestamp() WHERE id=job.id RETURNING * INTO job;
  RETURN job;
 END IF;
 IF job.status='reserved' AND job.job_kind='prospection' AND NOT EXISTS(
   SELECT 1 FROM app.conversations conv JOIN app.campaigns c ON c.id=conv.campaign_id
   JOIN app.prospects p ON p.id=conv.prospect_id WHERE conv.id=job.conversation_id
   AND conv.followups_stopped_at IS NULL AND c.status IN ('active','existing_only')
   AND NOT c.imported_disabled AND c.archived_at IS NULL AND p.deleted_at IS NULL
   AND NOT app.is_excluded(p.normalized_email)
   AND NOT EXISTS(SELECT 1 FROM app.email_messages inbound WHERE inbound.conversation_id=conv.id
     AND inbound.direction='inbound' AND inbound.kind='reply')) THEN
  UPDATE app.outbox_jobs SET status='cancelled',cancel_reason='conversation_no_longer_eligible',
    cancelled_at=clock_timestamp(),lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE id=job.id RETURNING * INTO job;
  RETURN job;
 END IF;
 IF job.job_kind='reply' AND job.status='reserved'$guard$);
 IF changed=original THEN RAISE EXCEPTION 'smtp_mailbox_guard_patch_missing'; END IF;
 EXECUTE changed;
 -- A per-message cursor commit can skip other messages if a later write fails.
 -- Only the bulk worker commits a cursor after the entire ordered batch succeeds.
 original:=pg_get_functiondef('app.record_inbound_message(uuid,uuid,text,text,text[],text,text,text,text[],text,text,text[],text,text,text,bigint,bigint,numeric,timestamptz,jsonb)'::regprocedure);
 changed:=regexp_replace(original,'  IF p_imap_uid IS NOT NULL THEN\n    INSERT INTO app.imap_cursors.*?  END IF;\n  RETURN result;', '  RETURN result;', 's');
 IF changed=original THEN RAISE EXCEPTION 'inbound_cursor_patch_missing'; END IF;
 changed:=replace(changed,'ORDER BY m.created_at',
   'ORDER BY CASE WHEN m.internet_message_id=p_internet_message_id THEN 0 ELSE 1 END,m.created_at');
 -- A message first seen before its thread was known can be attached on replay.
 changed:=replace(changed,'  RETURN result;', $attach$
 IF result.gmail_thread_id IS NULL AND p_gmail_thread_id IS NOT NULL THEN
  UPDATE app.email_messages SET gmail_thread_id=p_gmail_thread_id WHERE id=result.id RETURNING * INTO result;
 END IF;
 IF result.conversation_id IS NULL AND p_conversation_id IS NOT NULL AND result.direction='inbound' THEN
  UPDATE app.email_messages SET conversation_id=p_conversation_id,kind=p_kind,updated_at=clock_timestamp()
  WHERE id=result.id RETURNING * INTO result;
 END IF;
 RETURN result;$attach$);
 EXECUTE changed;
END;
$patch$;

-- Reply triggers must handle repaired associations as well as first ingestion.
DROP TRIGGER stop_followups_on_inbound ON app.email_messages;
CREATE TRIGGER stop_followups_on_inbound AFTER INSERT OR UPDATE OF conversation_id,kind ON app.email_messages
FOR EACH ROW EXECUTE FUNCTION app.stop_followups_on_inbound();
DROP TRIGGER supersede_reply_workflows ON app.email_messages;
CREATE TRIGGER supersede_reply_workflows AFTER INSERT OR UPDATE OF conversation_id,kind ON app.email_messages
FOR EACH ROW EXECUTE FUNCTION app.supersede_reply_workflows();
DO $patch$
DECLARE original text; changed text;
BEGIN
 original:=pg_get_functiondef('app.stop_followups_on_inbound()'::regprocedure);
 changed:=replace(original,'last_inbound_at = coalesce(NEW.received_at, clock_timestamp())',
   'last_inbound_at = greatest(last_inbound_at, coalesce(NEW.received_at, clock_timestamp()))');
 changed:=replace(changed, 'AND status IN (''requested'',''pending'',''scheduled'',''deferred'',''reserved'');',
 $late$AND status IN ('requested','pending','scheduled','deferred','reserved')
 AND (job_kind<>'reply' OR EXISTS(SELECT 1 FROM app.reply_workflows w JOIN app.email_messages src ON src.id=w.source_message_id
   WHERE w.output_message_id=app.outbox_jobs.message_id
   AND (coalesce(src.received_at,src.created_at),src.created_at,src.id)<=(coalesce(NEW.received_at,NEW.created_at),NEW.created_at,NEW.id)));$late$);
 EXECUTE changed;
 original:=pg_get_functiondef('app.supersede_reply_workflows()'::regprocedure);
 changed:=replace(original, 'd.state IN (''proposed'',''requested'')','d.state IN (''proposed'',''requested'',''created'',''failed'')');
 EXECUTE changed;
END;
$patch$;

-- A Gmail send settles matching drafts/workflows even when Gmail rewrites the
-- draft Message-ID. Preserve completed AI passes and all sent content.
CREATE FUNCTION app.settle_manual_reply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NEW.direction='outbound' AND NEW.kind='manual' AND NEW.technical_confirmation AND NEW.conversation_id IS NOT NULL THEN
  PERFORM 1 FROM app.conversations WHERE id=NEW.conversation_id FOR UPDATE;
  UPDATE app.reply_iteration_runs r SET status='failed',error_code='answered_manually'
  FROM app.reply_workflows w,app.email_messages src WHERE r.workflow_id=w.id AND src.id=w.source_message_id
   AND w.conversation_id=NEW.conversation_id AND r.status='running'
   AND coalesce(src.received_at,src.created_at)<=coalesce(NEW.sent_at,NEW.created_at);
  UPDATE app.reply_draft_requests d SET state='sent_manually',lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
  FROM app.email_messages src WHERE src.id=d.source_message_id AND d.conversation_id=NEW.conversation_id
   AND d.state NOT IN ('dismissed','sent_manually')
   AND coalesce(src.received_at,src.created_at)<=coalesce(NEW.sent_at,NEW.created_at);
  UPDATE app.outbox_jobs j SET status='cancelled',cancel_reason='answered_manually',cancelled_at=clock_timestamp(),
    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
  FROM app.reply_workflows w,app.email_messages src WHERE src.id=w.source_message_id AND w.output_message_id=j.message_id
    AND w.conversation_id=NEW.conversation_id AND j.status IN ('pending','scheduled','deferred','reserved')
    AND coalesce(src.received_at,src.created_at)<=coalesce(NEW.sent_at,NEW.created_at);
  UPDATE app.reply_workflows w SET state='sent',output_message_id=NEW.id,updated_at=clock_timestamp()
  FROM app.email_messages src WHERE src.id=w.source_message_id AND w.conversation_id=NEW.conversation_id
   AND w.state IN ('pending','running','draft_requested','queued')
   AND coalesce(src.received_at,src.created_at)<=coalesce(NEW.sent_at,NEW.created_at);
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.settle_manual_reply() FROM PUBLIC,prospection95_agent,prospection95_crm;
CREATE TRIGGER settle_manual_reply AFTER INSERT ON app.email_messages
FOR EACH ROW EXECUTE FUNCTION app.settle_manual_reply();

-- Serialise Sent reconciliation with reply-writing and other folder ingestions.
DO $patch$
DECLARE original text; changed text;
BEGIN
 original:=pg_get_functiondef('app.record_sent_message(uuid,uuid,text,text[],text,text,text,text,text,text[],text,bigint,bigint,timestamptz,jsonb)'::regprocedure);
 changed:=replace(original,'  SELECT m.* INTO result',
   '  PERFORM 1 FROM app.conversations WHERE id=p_conversation_id FOR UPDATE;'||chr(10)||'  SELECT m.* INTO result');
 changed:=replace(changed,'ORDER BY m.created_at',
   'ORDER BY CASE WHEN m.internet_message_id=p_internet_message_id THEN 0 ELSE 1 END,m.created_at');
 changed:=replace(changed,'m.internet_message_id = p_internet_message_id)',
   '(m.internet_message_id = p_internet_message_id OR m.internet_message_id=p_raw_headers->>''prospectionMessageId''))');
 changed:=replace(changed,'m.sender_account_id = p_mailbox_account_id',
   '(m.sender_account_id = p_mailbox_account_id OR m.conversation_id = p_conversation_id)');
 changed:=replace(changed,'  IF manual_outbound THEN',
 $sent$  IF NOT manual_outbound AND NOT result.technical_confirmation AND result.kind IN ('prospection','reply') THEN
   PERFORM app.confirm_smtp_acceptance(j.id,j.lease_token,'gmail_sent_sync:'||coalesce(p_internet_message_id,result.id::text),p_sent_at)
   FROM app.outbox_jobs j WHERE j.message_id=result.id AND j.status IN ('running','uncertain') AND j.lease_token IS NOT NULL;
   SELECT * INTO result FROM app.email_messages WHERE id=result.id;
 END IF;
 IF manual_outbound THEN$sent$);
 -- Replayed manual Sent copies must not cancel a reply to a more recent inbound.
 -- Only first insertion has this side effect, just as before this migration.
 changed:=replace(changed, 'SET state = ''active'',', 'SET state = CASE WHEN last_inbound_at>p_sent_at THEN state ELSE ''active'' END,');
 changed:=replace(changed, 'AND status IN (''requested'',''pending'',''scheduled'',''deferred'',''reserved'');',
 $manual$AND status IN ('requested','pending','scheduled','deferred','reserved')
 AND (job_kind<>'reply' OR EXISTS(SELECT 1 FROM app.reply_workflows w JOIN app.email_messages src ON src.id=w.source_message_id
   WHERE w.output_message_id=app.outbox_jobs.message_id AND coalesce(src.received_at,src.created_at)<=p_sent_at));$manual$);
 EXECUTE changed;
END;
$patch$;

-- A confirmed Sent copy can resolve an ambiguous SMTP attempt. A reply observed
-- during an SMTP flight must still keep the prospect sequence stopped.
DO $confirmation$
DECLARE original text; changed text;
BEGIN
 original:=pg_get_functiondef('app.confirm_smtp_acceptance(uuid,uuid,text,timestamptz)'::regprocedure);
 changed:=replace(original,'status IN (''reserved'',''running'',''completed'')','status IN (''reserved'',''running'',''completed'',''uncertain'')');
 changed:=replace(changed,'SET state = ''active'', current_step = job.step,',
   'SET state = CASE WHEN followups_stopped_at IS NULL THEN ''active'' ELSE state END, current_step = job.step,');
 changed:=replace(changed,'last_outbound_at = p_sent_at, next_step_due_at = CASE job.step',
   'last_outbound_at = greatest(last_outbound_at,p_sent_at), next_step_due_at = CASE WHEN followups_stopped_at IS NOT NULL THEN NULL ELSE CASE job.step');
 changed:=replace(changed,'ELSE NULL END,','ELSE NULL END END,');
 changed:=replace(changed,'SET last_outbound_at=p_sent_at,','SET last_outbound_at=greatest(last_outbound_at,p_sent_at),');
 IF changed=original THEN RAISE EXCEPTION 'sent_confirmation_patch_missing'; END IF;
 EXECUTE changed;
END;
$confirmation$;

-- Repair historical database statuses; no SMTP work is created by this migration.
UPDATE app.email_messages m SET status='cancelled',updated_at=clock_timestamp()
FROM app.outbox_jobs j WHERE j.message_id=m.id AND j.status='cancelled' AND NOT m.technical_confirmation AND m.status<>'cancelled';
UPDATE app.reply_draft_requests d SET state='stale',updated_at=clock_timestamp()
WHERE d.state IN ('requested','failed','created') AND NOT app.reply_source_is_current(d.source_message_id);
INSERT INTO app.schema_migrations(version) VALUES('039_reply_reliability') ON CONFLICT(version) DO NOTHING;
