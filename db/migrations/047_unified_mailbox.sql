-- Unified correspondence reuses email_messages, Gmail credentials and the outbox.
-- No change to campaign configuration, authorisation, cadence or existing content.
CREATE TABLE app.mailbox_threads (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES app.gmail_accounts(id),
 conversation_id uuid UNIQUE REFERENCES app.conversations(id),
 prospect_id uuid REFERENCES app.prospects(id),
 remote_key text NOT NULL,
 correspondent text NOT NULL,
 subject text NOT NULL DEFAULT '',
 category text NOT NULL DEFAULT 'normal' CHECK(category IN ('normal','automatic','warmup')),
 archived boolean NOT NULL DEFAULT false,
 unread boolean NOT NULL DEFAULT false,
 priority boolean NOT NULL DEFAULT false,
 needs_reply boolean NOT NULL DEFAULT false,
 last_message_id uuid REFERENCES app.email_messages(id),
 last_message_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 draft_body text NOT NULL DEFAULT '' CHECK(length(draft_body)<=100000),
 draft_version bigint NOT NULL DEFAULT 1,
 draft_updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 draft_synced_version bigint NOT NULL DEFAULT 0,
 gmail_draft_message_id text,
 gmail_draft_hash text,
 draft_remote_body text,
 version bigint NOT NULL DEFAULT 1,
 last_synced_at timestamptz,
 last_error_code text,
 refresh_requested_at timestamptz,
 refresh_attempt_at timestamptz,
 history_uid bigint NOT NULL DEFAULT 0,
 history_uidvalidity text,
 history_complete boolean NOT NULL DEFAULT false,
 sync_lease_token uuid,
 sync_lease_expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(account_id,remote_key)
);
ALTER TABLE app.email_messages ADD COLUMN mailbox_thread_id uuid REFERENCES app.mailbox_threads(id);
CREATE INDEX mailbox_messages_history_idx ON app.email_messages(mailbox_thread_id,coalesce(received_at,smtp_accepted_at,sent_at,created_at),id);
CREATE INDEX mailbox_threads_list_idx ON app.mailbox_threads(account_id,category,archived,last_message_at DESC,id);
CREATE TABLE app.mailbox_sync_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 thread_id uuid NOT NULL REFERENCES app.mailbox_threads(id),
 kind text NOT NULL CHECK(kind IN ('read','archive','draft','refresh')),
 payload jsonb NOT NULL DEFAULT '{}',
 idempotency_key text NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')),
 lease_token uuid,
 lease_expires_at timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 error_code text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz
);
CREATE INDEX mailbox_sync_due_idx ON app.mailbox_sync_jobs(due_at,created_at) WHERE status IN ('pending','running');
REVOKE ALL ON app.mailbox_threads,app.mailbox_sync_jobs FROM PUBLIC,prospection95_agent,prospection95_crm;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.mailbox_threads,app.mailbox_sync_jobs TO prospection95_app;

-- Called for new confirmed CRM messages only; sequence drafts stay in Messages.
CREATE FUNCTION app.mailbox_attach_message() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE t uuid; a uuid; p uuid; address text; stamp timestamptz; cat text;
BEGIN
 IF NEW.conversation_id IS NULL OR NEW.mailbox_thread_id IS NOT NULL OR NOT
   (NEW.technical_confirmation OR NEW.status IN ('received','smtp_accepted','sent_manually')) THEN RETURN NEW; END IF;
 SELECT sender_account_id,prospect_id INTO a,p FROM app.conversations WHERE id=NEW.conversation_id;
 SELECT email INTO address FROM app.prospects WHERE id=p;
 cat:=CASE WHEN NEW.raw_headers->>'warmup'='true' THEN 'warmup'
   WHEN NEW.kind IN ('automatic_reply','out_of_office','bounce') THEN 'automatic' ELSE 'normal' END;
 stamp:=coalesce(NEW.received_at,NEW.smtp_accepted_at,NEW.sent_at,NEW.created_at);
 INSERT INTO app.mailbox_threads(account_id,conversation_id,prospect_id,remote_key,correspondent,subject,category,last_message_at)
 VALUES(a,NEW.conversation_id,p,'crm:'||NEW.conversation_id,address,NEW.subject,cat,stamp)
 ON CONFLICT(conversation_id) DO UPDATE SET prospect_id=excluded.prospect_id RETURNING id INTO t;
 NEW.mailbox_thread_id:=t;
 RETURN NEW;
END; $$;
CREATE TRIGGER mailbox_attach_message BEFORE INSERT OR UPDATE OF technical_confirmation,conversation_id ON app.email_messages
FOR EACH ROW EXECUTE FUNCTION app.mailbox_attach_message();

CREATE FUNCTION app.mailbox_update_summary() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE stamp timestamptz;
BEGIN
 IF NEW.mailbox_thread_id IS NULL OR NOT (NEW.technical_confirmation OR NEW.status IN ('received','smtp_accepted','sent_manually')) THEN RETURN NEW; END IF;
 stamp:=coalesce(NEW.received_at,NEW.smtp_accepted_at,NEW.sent_at,NEW.created_at);
 UPDATE app.mailbox_threads SET subject=NEW.subject,last_message_at=stamp,last_message_id=NEW.id,
   needs_reply=NEW.direction='inbound' AND NEW.kind NOT IN ('automatic_reply','out_of_office','bounce'),
   category=CASE WHEN NEW.raw_headers->>'warmup'='true' THEN 'warmup'
     WHEN NEW.kind IN ('automatic_reply','out_of_office','bounce') THEN 'automatic' ELSE 'normal' END,
   unread=CASE WHEN NEW.direction='inbound' THEN coalesce((NEW.raw_headers->>'unread')::boolean,false) ELSE unread END,
   archived=CASE WHEN NEW.direction='inbound' THEN coalesce((NEW.raw_headers->>'archived')::boolean,false) ELSE archived END,
   version=version+1
 WHERE id=NEW.mailbox_thread_id AND (last_message_id IS NULL OR (last_message_at,last_message_id)<(stamp,NEW.id));
 RETURN NEW;
END; $$;
CREATE TRIGGER mailbox_update_summary AFTER INSERT OR UPDATE OF technical_confirmation,mailbox_thread_id ON app.email_messages
FOR EACH ROW EXECUTE FUNCTION app.mailbox_update_summary();

-- Backfill real exchanges without interpreting imported declarations as proof.
INSERT INTO app.mailbox_threads(account_id,conversation_id,prospect_id,remote_key,correspondent,subject)
 SELECT c.sender_account_id,c.id,c.prospect_id,'crm:'||c.id,p.email,''
 FROM app.conversations c JOIN app.prospects p ON p.id=c.prospect_id
 WHERE EXISTS(SELECT 1 FROM app.email_messages m WHERE m.conversation_id=c.id
   AND (m.technical_confirmation OR m.status='received'));
UPDATE app.email_messages m SET mailbox_thread_id=t.id FROM app.mailbox_threads t
 WHERE t.conversation_id=m.conversation_id AND (m.technical_confirmation OR m.status='received');

ALTER TABLE app.outbox_jobs DROP CONSTRAINT outbox_jobs_job_kind_check;
ALTER TABLE app.outbox_jobs ADD CONSTRAINT outbox_jobs_job_kind_check
 CHECK(job_kind IN ('prospection','diagnostic','draft_sync','reply','mailbox_reply'));

CREATE FUNCTION app.mailbox_reply_is_current(p_job uuid) RETURNS boolean LANGUAGE sql STABLE
SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT EXISTS(SELECT 1 FROM app.outbox_jobs j JOIN app.email_messages m ON m.id=j.message_id
 JOIN app.mailbox_threads t ON t.id=m.mailbox_thread_id JOIN app.gmail_accounts a ON a.id=t.account_id
 WHERE j.id=p_job AND j.job_kind='mailbox_reply' AND t.account_id=j.account_id
 AND a.credential_id IS NOT NULL AND a.deleted_at IS NULL AND a.status='active' AND a.paused_at IS NULL
 AND t.category='normal' AND NOT app.is_excluded(t.correspondent)
 AND m.raw_headers->>'replyToMessageId'=t.last_message_id::text
 AND NOT EXISTS(SELECT 1 FROM app.outbox_jobs other WHERE other.conversation_id=j.conversation_id
   AND other.id<>j.id AND other.status IN ('reserved','running','uncertain')));
$$;

CREATE FUNCTION app.mailbox_queue_reply(p_thread uuid,p_version bigint,p_last uuid,p_key text) RETURNS app.outbox_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $$
DECLARE t app.mailbox_threads; a app.gmail_accounts; m app.email_messages; j app.outbox_jobs; parent app.email_messages;
BEGIN
 IF length(coalesce(p_key,'')) NOT BETWEEN 8 AND 200 THEN RAISE EXCEPTION 'invalid_idempotency_key'; END IF;
 SELECT * INTO t FROM app.mailbox_threads WHERE id=p_thread FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'mailbox_thread_not_found'; END IF;
 SELECT * INTO j FROM app.outbox_jobs WHERE idempotency_key='mailbox:'||p_key;
 IF FOUND THEN
  IF NOT EXISTS(SELECT 1 FROM app.email_messages WHERE id=j.message_id AND mailbox_thread_id=t.id
    AND raw_headers->>'draftVersion'=p_version::text) THEN RAISE EXCEPTION 'mailbox_idempotency_conflict'; END IF;
  RETURN j;
 END IF;
 IF t.draft_version<>p_version OR t.last_message_id IS DISTINCT FROM p_last THEN RAISE EXCEPTION 'mailbox_version_conflict'; END IF;
 IF length(btrim(t.draft_body))=0 OR t.category<>'normal' OR app.is_excluded(t.correspondent) THEN RAISE EXCEPTION 'mailbox_reply_not_allowed'; END IF;
 IF EXISTS(SELECT 1 FROM app.email_messages e JOIN app.outbox_jobs o ON o.message_id=e.id
   WHERE e.mailbox_thread_id=t.id AND o.status NOT IN ('completed','cancelled','failed')) THEN RAISE EXCEPTION 'mailbox_send_in_progress'; END IF;
 SELECT * INTO a FROM app.gmail_accounts WHERE id=t.account_id FOR UPDATE;
 IF a.deleted_at IS NOT NULL OR a.status<>'active' OR a.paused_at IS NOT NULL OR a.credential_id IS NULL
   OR NOT EXISTS(SELECT 1 FROM app.settings WHERE singleton AND outbound_enabled AND NOT emergency_stop)
 THEN RAISE EXCEPTION 'mailbox_outbound_paused'; END IF;
 IF EXISTS(SELECT 1 FROM app.outbox_jobs WHERE conversation_id=t.conversation_id AND status IN ('reserved','running','uncertain'))
 THEN RAISE EXCEPTION 'mailbox_send_in_progress'; END IF;
 SELECT * INTO parent FROM app.email_messages WHERE id=t.last_message_id;
 INSERT INTO app.email_messages(conversation_id,mailbox_thread_id,direction,kind,step,sender_account_id,from_address,to_addresses,
  subject,body_text,status,in_reply_to,references_header,raw_headers)
 VALUES(t.conversation_id,t.id,'outbound','manual','reply',a.id,a.email,ARRAY[t.correspondent],
  CASE WHEN t.subject~*'^re:' THEN t.subject ELSE 'Re: '||t.subject END,t.draft_body,'scheduled',parent.internet_message_id,
  CASE WHEN parent.internet_message_id IS NULL THEN parent.references_header ELSE array_append(parent.references_header,parent.internet_message_id) END,
  jsonb_build_object('replyToMessageId',t.last_message_id,'draftVersion',p_version)) RETURNING * INTO m;
 UPDATE app.email_messages SET internet_message_id='<'||m.id||'@mail.prospection95.local>' WHERE id=m.id;
 -- Manual control supersedes queued AI work, but never an in-flight SMTP attempt.
 UPDATE app.outbox_jobs SET status='cancelled',cancelled_at=clock_timestamp(),cancel_reason='manual_mailbox_reply'
 WHERE conversation_id=t.conversation_id AND status IN ('requested','pending','scheduled','deferred');
 UPDATE app.reply_workflows SET state='cancelled',updated_at=clock_timestamp()
 WHERE conversation_id=t.conversation_id AND state IN ('pending','running','draft_requested','queued');
 INSERT INTO app.outbox_jobs(message_id,conversation_id,campaign_id,prospect_id,account_id,step,job_kind,status,
  approval_required,approved_at,due_at,idempotency_key)
 VALUES(m.id,t.conversation_id,(SELECT campaign_id FROM app.conversations WHERE id=t.conversation_id),t.prospect_id,a.id,
  'reply','mailbox_reply','pending',false,clock_timestamp(),clock_timestamp(),'mailbox:'||p_key) RETURNING * INTO j;
 UPDATE app.conversations SET followups_stopped_at=coalesce(followups_stopped_at,clock_timestamp()),
  followups_stop_reason=coalesce(followups_stop_reason,'manual_mailbox_reply'),next_step_due_at=NULL WHERE id=t.conversation_id;
 RETURN j;
END; $$;

-- Preserve all existing quota, pacing and SMTP guards; add one guarded job kind.
DO $patch$
DECLARE original text; changed text;
BEGIN
 original:=pg_get_functiondef('app.lease_outbox_jobs(text,integer,integer)'::regprocedure);
 changed:=replace(original,'AND (j.job_kind <> ''reply'' OR app.reply_job_is_ready(j.id))',
   'AND (j.job_kind <> ''reply'' OR app.reply_job_is_ready(j.id)) AND (j.job_kind<>''mailbox_reply'' OR app.mailbox_reply_is_current(j.id))');
 IF changed=original THEN RAISE EXCEPTION 'mailbox_lease_patch_missing'; END IF; EXECUTE changed;
 original:=pg_get_functiondef('app.start_outbox_attempt(uuid,uuid)'::regprocedure);
 changed:=replace(original,'IF job.status = ''running'' THEN',
 $guard$IF job.job_kind='mailbox_reply' AND NOT app.mailbox_reply_is_current(job.id) THEN
  UPDATE app.outbox_jobs SET status='cancelled',cancel_reason='mailbox_conversation_changed',cancelled_at=clock_timestamp(),lease_expires_at=NULL
  WHERE id=job.id RETURNING * INTO job; RETURN job;
 END IF;
 IF job.status = 'running' THEN$guard$);
 IF changed=original THEN RAISE EXCEPTION 'mailbox_start_patch_missing'; END IF; EXECUTE changed;
 original:=pg_get_functiondef('app.outbox_commit_is_ready(uuid,uuid)'::regprocedure);
 changed:=replace(original,'ELSE true END','WHEN j.job_kind=''mailbox_reply'' THEN app.mailbox_reply_is_current(j.id) ELSE true END');
 IF changed=original THEN RAISE EXCEPTION 'mailbox_commit_patch_missing'; END IF; EXECUTE changed;
 original:=pg_get_functiondef('app.confirm_smtp_acceptance(uuid,uuid,text,timestamptz)'::regprocedure);
 changed:=replace(original,'(''prospection'',''diagnostic'',''reply'')','(''prospection'',''diagnostic'',''reply'',''mailbox_reply'')');
 changed:=replace(changed,'job.job_kind <> ''reply''','job.job_kind NOT IN (''reply'',''mailbox_reply'')');
 IF changed=original THEN RAISE EXCEPTION 'mailbox_confirmation_patch_missing'; END IF; EXECUTE changed;
 original:=pg_get_functiondef('app.record_sent_message(uuid,uuid,text,text[],text,text,text,text,text,text[],text,bigint,bigint,timestamptz,jsonb)'::regprocedure);
 changed:=replace(original,'result.kind IN (''prospection'',''reply'')','result.kind IN (''prospection'',''reply'',''manual'')');
 changed:=replace(changed,'IF p_conversation_id IS NULL',
   'IF (p_conversation_id IS NULL AND NOT EXISTS(SELECT 1 FROM app.mailbox_threads t WHERE t.account_id=p_mailbox_account_id AND t.correspondent=ANY(p_to_addresses)))');
 IF changed=original THEN RAISE EXCEPTION 'mailbox_sent_reconciliation_patch_missing'; END IF; EXECUTE changed;
END; $patch$;

CREATE FUNCTION app.mailbox_settle_reply() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path=pg_catalog,app AS $$
BEGIN
 IF NEW.kind='manual' AND NEW.technical_confirmation AND NOT OLD.technical_confirmation THEN
  UPDATE app.conversations SET last_outbound_at=greatest(last_outbound_at,NEW.smtp_accepted_at),
   followups_stopped_at=coalesce(followups_stopped_at,clock_timestamp()),
   followups_stop_reason=coalesce(followups_stop_reason,'manual_mailbox_reply'),next_step_due_at=NULL WHERE id=NEW.conversation_id;
  UPDATE app.outbox_jobs SET status='cancelled',cancelled_at=clock_timestamp(),cancel_reason='manual_mailbox_reply'
   WHERE conversation_id=NEW.conversation_id AND message_id<>NEW.id AND status IN ('requested','pending','scheduled','deferred','reserved');
  UPDATE app.mailbox_threads SET draft_body='',draft_version=draft_version+1,version=version+1
   WHERE id=NEW.mailbox_thread_id AND draft_version=(NEW.raw_headers->>'draftVersion')::bigint;
  INSERT INTO app.mailbox_sync_jobs(thread_id,kind,payload,idempotency_key)
   SELECT id,'draft',jsonb_build_object('version',draft_version),'sent-draft:'||NEW.id FROM app.mailbox_threads WHERE id=NEW.mailbox_thread_id
   ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER mailbox_settle_reply AFTER UPDATE OF technical_confirmation ON app.email_messages
FOR EACH ROW EXECUTE FUNCTION app.mailbox_settle_reply();
CREATE TRIGGER mailbox_settle_ai_reply AFTER UPDATE OF technical_confirmation ON app.email_messages
FOR EACH ROW WHEN(NEW.kind='manual' AND NEW.technical_confirmation AND NOT OLD.technical_confirmation)
EXECUTE FUNCTION app.settle_manual_reply();

REVOKE ALL ON FUNCTION app.mailbox_attach_message(),app.mailbox_update_summary(),app.mailbox_reply_is_current(uuid),
 app.mailbox_queue_reply(uuid,bigint,uuid,text),app.mailbox_settle_reply() FROM PUBLIC,prospection95_agent,prospection95_crm;
GRANT EXECUTE ON FUNCTION app.mailbox_reply_is_current(uuid),app.mailbox_queue_reply(uuid,bigint,uuid,text) TO prospection95_app;
INSERT INTO app.schema_migrations(version) VALUES('047_unified_mailbox');
