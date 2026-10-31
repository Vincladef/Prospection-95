-- A fresh Sent pass is required before automatically answering, including on
-- initial rollout while the independent historical cursor is still catching up.
ALTER TABLE app.imap_cursors ADD COLUMN caught_up_at timestamptz;
CREATE OR REPLACE FUNCTION app.reply_job_is_ready(p_job_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $ready$
 SELECT EXISTS(SELECT 1 FROM app.outbox_jobs j JOIN app.reply_workflows w ON w.output_message_id=j.message_id
 JOIN app.campaigns c ON c.id=w.campaign_id JOIN app.gmail_accounts sender ON sender.id=j.account_id
 WHERE j.id=p_job_id AND w.state='queued' AND w.mode='automatic' AND c.reply_mode='automatic'
 AND sender.status='active' AND sender.paused_at IS NULL AND sender.deleted_at IS NULL AND sender.credential_id IS NOT NULL
 AND w.completed_iterations=cardinality(w.instructions) AND w.due_at<=clock_timestamp()
 AND app.reply_source_is_current(w.source_message_id)
 AND EXISTS(SELECT 1 FROM app.imap_cursors sync WHERE sync.account_id=j.account_id AND sync.mailbox_name='__LIVE_SENT__'
   AND sync.caught_up_at>=greatest(w.created_at,w.due_at) AND sync.caught_up_at>=clock_timestamp()-interval '5 minutes'));
$ready$;
INSERT INTO app.schema_migrations(version) VALUES('035_live_sent_reply_safety') ON CONFLICT(version) DO NOTHING;
