-- Each inbound message owns an immutable reply-writing cycle. Defaults never send.
ALTER TABLE app.campaigns ADD COLUMN reply_mode text NOT NULL DEFAULT 'draft'
  CHECK(reply_mode IN ('draft','automatic'));
ALTER TABLE app.campaigns ADD COLUMN reply_iteration_instructions text[] NOT NULL DEFAULT ARRAY['']::text[]
  CHECK(cardinality(reply_iteration_instructions) BETWEEN 1 AND 100);
CREATE TABLE app.reply_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_message_id uuid NOT NULL UNIQUE REFERENCES app.email_messages(id),
  conversation_id uuid NOT NULL REFERENCES app.conversations(id),
  campaign_id uuid NOT NULL REFERENCES app.campaigns(id),
  mode text NOT NULL CHECK(mode IN ('draft','automatic')),
  instructions text[] NOT NULL CHECK(cardinality(instructions) BETWEEN 1 AND 100),
  completed_iterations integer NOT NULL DEFAULT 0 CHECK(completed_iterations>=0),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','draft_requested','queued','sent','superseded','cancelled')),
  subject text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
  output_message_id uuid REFERENCES app.email_messages(id),
  draft_request_id uuid REFERENCES app.reply_draft_requests(id),
  due_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(completed_iterations <= cardinality(instructions))
);
CREATE TABLE app.reply_iteration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES app.reply_workflows(id),
  iteration integer NOT NULL CHECK(iteration BETWEEN 1 AND 100),
  agent_run_id uuid NOT NULL REFERENCES audit.agent_runs(id),
  claim_key text NOT NULL UNIQUE CHECK(length(claim_key) BETWEEN 8 AND 200),
  status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
  subject text, body text, completion_key text,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '2 hours',
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz, error_code text,
  UNIQUE(workflow_id,agent_run_id)
);
CREATE UNIQUE INDEX reply_iteration_one_live_pass ON app.reply_iteration_runs(workflow_id,iteration) WHERE status IN ('running','completed');
CREATE INDEX reply_workflows_conversation_idx ON app.reply_workflows(conversation_id,created_at DESC);
REVOKE ALL ON app.reply_workflows,app.reply_iteration_runs FROM PUBLIC,prospection95_agent,prospection95_crm;
GRANT SELECT,INSERT,UPDATE ON app.reply_workflows,app.reply_iteration_runs TO prospection95_app;

CREATE FUNCTION app.reply_source_is_current(p_source uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $current$
 SELECT EXISTS(
  SELECT 1 FROM app.email_messages m JOIN app.conversations conv ON conv.id=m.conversation_id
  JOIN app.campaigns c ON c.id=conv.campaign_id JOIN app.prospects p ON p.id=conv.prospect_id
  JOIN app.inbound_analyses a ON a.message_id=m.id
  WHERE m.id=p_source AND m.direction='inbound' AND m.kind='reply'
    AND a.classification IN ('positive','information','meeting','ambiguous')
    AND c.status IN ('active','existing_only') AND c.archived_at IS NULL AND NOT c.imported_disabled
    AND p.deleted_at IS NULL AND NOT app.is_excluded(p.normalized_email) AND NOT app.is_excluded(m.from_address)
    AND NOT EXISTS(SELECT 1 FROM app.email_messages newer WHERE newer.conversation_id=conv.id
      AND newer.direction='inbound' AND newer.kind='reply'
      AND (coalesce(newer.received_at,newer.created_at),newer.created_at,newer.id)>(coalesce(m.received_at,m.created_at),m.created_at,m.id))
    AND NOT EXISTS(SELECT 1 FROM app.email_messages manual WHERE manual.conversation_id=conv.id
      AND manual.direction='outbound' AND manual.kind='manual' AND manual.technical_confirmation
      AND coalesce(manual.sent_at,manual.created_at)>=coalesce(m.received_at,m.created_at))
 );
$current$;
REVOKE ALL ON FUNCTION app.reply_source_is_current(uuid) FROM PUBLIC,prospection95_agent,prospection95_crm;
GRANT EXECUTE ON FUNCTION app.reply_source_is_current(uuid) TO prospection95_app;

CREATE VIEW agent_api.pending_reply_iterations WITH(security_barrier=true) AS
 SELECT m.id AS source_message_id,m.conversation_id,conv.campaign_id,conv.prospect_id,
   c.reply_mode,c.reply_instructions,c.reply_iteration_instructions,
   coalesce(w.completed_iterations,0) AS completed_iterations,
   coalesce(cardinality(w.instructions),cardinality(c.reply_iteration_instructions)) AS total_iterations,
   w.state,w.subject AS latest_subject,w.body AS latest_body
 FROM app.email_messages m JOIN app.conversations conv ON conv.id=m.conversation_id
 JOIN app.campaigns c ON c.id=conv.campaign_id
 LEFT JOIN app.reply_workflows w ON w.source_message_id=m.id
 WHERE m.direction='inbound' AND m.kind='reply' AND app.reply_source_is_current(m.id) AND (w.id IS NULL OR w.state IN ('pending','running'))
   AND NOT EXISTS(SELECT 1 FROM app.reply_draft_requests d WHERE d.source_message_id=m.id);
-- View expressions execute as the view owner; callers need this safe boolean only.
GRANT EXECUTE ON FUNCTION app.reply_source_is_current(uuid) TO prospection95_agent;
CREATE VIEW agent_api.reply_iteration_history WITH(security_barrier=true) AS
 SELECT w.source_message_id,w.conversation_id,r.* FROM app.reply_iteration_runs r JOIN app.reply_workflows w ON w.id=r.workflow_id;
CREATE VIEW agent_api.reply_conversation_messages WITH(security_barrier=true) AS
 SELECT m.id,m.conversation_id,conv.campaign_id,m.direction,m.kind,m.subject,m.body_text,
   m.status,m.received_at,m.sent_at,m.created_at,m.technical_confirmation,m.in_reply_to
 FROM app.email_messages m JOIN app.conversations conv ON conv.id=m.conversation_id
 WHERE m.kind IN ('reply','manual') OR (m.kind='prospection' AND m.technical_confirmation);
GRANT SELECT ON agent_api.pending_reply_iterations,agent_api.reply_iteration_history,agent_api.reply_conversation_messages TO prospection95_agent;

CREATE FUNCTION agent_api.claim_reply_iteration(p_source_message_id uuid,p_run_id uuid,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app,audit AS $claim$
DECLARE w app.reply_workflows; r app.reply_iteration_runs; conv app.conversations; c app.campaigns;
BEGIN
 IF length(coalesce(p_idempotency_key,'')) NOT BETWEEN 8 AND 200 THEN RAISE EXCEPTION 'invalid_reply_key'; END IF;
 IF NOT EXISTS(SELECT 1 FROM audit.agent_runs WHERE id=p_run_id AND agent_type='prospection' AND status='running') THEN RAISE EXCEPTION 'run_not_active'; END IF;
 SELECT conv0.* INTO conv FROM app.conversations conv0 JOIN app.email_messages m ON m.conversation_id=conv0.id WHERE m.id=p_source_message_id FOR UPDATE OF conv0;
 IF NOT FOUND THEN RAISE EXCEPTION 'reply_source_not_found'; END IF;
 SELECT * INTO c FROM app.campaigns WHERE id=conv.campaign_id FOR SHARE;
 IF NOT app.reply_source_is_current(p_source_message_id) THEN RAISE EXCEPTION 'reply_source_not_eligible'; END IF;
 IF EXISTS(SELECT 1 FROM app.reply_draft_requests WHERE source_message_id=p_source_message_id) THEN RAISE EXCEPTION 'reply_already_proposed'; END IF;
 INSERT INTO app.reply_workflows(source_message_id,conversation_id,campaign_id,mode,instructions)
 VALUES(p_source_message_id,conv.id,c.id,c.reply_mode,c.reply_iteration_instructions) ON CONFLICT(source_message_id) DO NOTHING;
 SELECT * INTO w FROM app.reply_workflows WHERE source_message_id=p_source_message_id FOR UPDATE;
 SELECT * INTO r FROM app.reply_iteration_runs WHERE workflow_id=w.id AND agent_run_id=p_run_id;
 IF r.id IS NULL THEN
   IF EXISTS(SELECT 1 FROM app.reply_iteration_runs WHERE claim_key=p_idempotency_key) THEN RAISE EXCEPTION 'reply_idempotency_conflict'; END IF;
   IF w.state NOT IN ('pending','running') THEN RAISE EXCEPTION 'reply_already_finalized'; END IF;
   UPDATE app.reply_iteration_runs SET status='failed',error_code='claim_expired' WHERE workflow_id=w.id AND status='running' AND expires_at<=clock_timestamp();
   IF EXISTS(SELECT 1 FROM app.reply_iteration_runs WHERE workflow_id=w.id AND status='running') THEN RAISE EXCEPTION 'reply_iteration_already_claimed'; END IF;
   INSERT INTO app.reply_iteration_runs(workflow_id,iteration,agent_run_id,claim_key)
   VALUES(w.id,w.completed_iterations+1,p_run_id,p_idempotency_key) RETURNING * INTO r;
   UPDATE app.reply_workflows SET state='running',updated_at=clock_timestamp() WHERE id=w.id;
 END IF;
 RETURN jsonb_build_object('iterationRunId',r.id,'workflowId',w.id,'iteration',r.iteration,'total',cardinality(w.instructions),
   'status',r.status,'instruction',w.instructions[r.iteration],'subject',w.subject,'body',w.body,
   'replyInstructions',coalesce((SELECT v.overrides->'reply'->>'replyInstructions' FROM app.experiment_assignments a
      JOIN app.experiment_variants v ON v.id=a.variant_id WHERE a.id=conv.experiment_assignment_id),c.reply_instructions),
   'generalWritingInstructions',(SELECT general_writing_instructions FROM app.settings WHERE singleton),
   'conversationId',conv.id,'sourceMessageId',p_source_message_id);
END;
$claim$;

CREATE FUNCTION agent_api.complete_reply_iteration(p_iteration_run_id uuid,p_run_id uuid,p_subject text,p_body text,p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app,audit AS $complete$
DECLARE w app.reply_workflows; r app.reply_iteration_runs; conv app.conversations; c app.campaigns;
  src app.email_messages; sender app.gmail_accounts; message_id uuid; request_id uuid; send_at timestamptz; not_before timestamptz;
BEGIN
 IF length(coalesce(p_subject,'')) NOT BETWEEN 1 AND 998 OR length(btrim(coalesce(p_body,''))) NOT BETWEEN 1 AND 100000
   OR length(coalesce(p_idempotency_key,'')) NOT BETWEEN 8 AND 200 THEN RAISE EXCEPTION 'invalid_reply_content'; END IF;
 -- Same lock order as claiming and inbound cancellation: conversation, campaign, workflow, run.
 SELECT conv0.* INTO conv FROM app.conversations conv0 JOIN app.reply_workflows w0 ON w0.conversation_id=conv0.id
 JOIN app.reply_iteration_runs r0 ON r0.workflow_id=w0.id WHERE r0.id=p_iteration_run_id FOR UPDATE OF conv0;
 SELECT * INTO c FROM app.campaigns WHERE id=conv.campaign_id FOR SHARE;
 SELECT w0.* INTO w FROM app.reply_workflows w0 JOIN app.reply_iteration_runs r0 ON r0.workflow_id=w0.id WHERE r0.id=p_iteration_run_id FOR UPDATE OF w0;
 SELECT * INTO r FROM app.reply_iteration_runs WHERE id=p_iteration_run_id FOR UPDATE;
 IF r.id IS NULL OR r.agent_run_id IS DISTINCT FROM p_run_id THEN RAISE EXCEPTION 'reply_run_mismatch'; END IF;
 IF r.status='completed' THEN
   IF r.completion_key IS DISTINCT FROM p_idempotency_key OR r.subject IS DISTINCT FROM p_subject OR r.body IS DISTINCT FROM p_body THEN RAISE EXCEPTION 'reply_idempotency_conflict'; END IF;
   RETURN jsonb_build_object('workflowId',w.id,'completed',w.completed_iterations,'state',w.state);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM audit.agent_runs WHERE id=p_run_id AND agent_type='prospection' AND status='running')
   OR r.status<>'running' OR r.expires_at<=clock_timestamp() OR w.state<>'running' THEN RAISE EXCEPTION 'reply_iteration_not_running'; END IF;
 IF NOT app.reply_source_is_current(w.source_message_id) THEN RAISE EXCEPTION 'reply_source_not_eligible'; END IF;
 UPDATE app.reply_iteration_runs SET status='completed',subject=p_subject,body=p_body,completion_key=p_idempotency_key,completed_at=clock_timestamp() WHERE id=r.id;
 UPDATE app.reply_workflows SET completed_iterations=r.iteration,subject=p_subject,body=p_body,state='pending',updated_at=clock_timestamp() WHERE id=w.id RETURNING * INTO w;
 IF w.completed_iterations=cardinality(w.instructions) THEN
   SELECT * INTO src FROM app.email_messages WHERE id=w.source_message_id;
   SELECT * INTO sender FROM app.gmail_accounts WHERE id=conv.sender_account_id;
   IF w.mode='automatic' AND c.reply_mode='automatic' THEN
     INSERT INTO app.email_messages(conversation_id,direction,kind,sender_account_id,from_address,to_addresses,subject,body_text,status,source,in_reply_to,references_header)
     VALUES(conv.id,'outbound','reply',sender.id,sender.email,ARRAY[src.from_address],p_subject,p_body,'scheduled','agent',src.internet_message_id,
       CASE WHEN src.internet_message_id IS NULL THEN src.references_header ELSE array_append(src.references_header,src.internet_message_id) END)
     RETURNING id INTO message_id;
     -- At least ten minutes after the final writing pass; randomness is persisted once.
     not_before := clock_timestamp()+make_interval(secs=>600+floor(random()*1201)::integer);
     send_at := greatest(not_before,app.next_account_send_at(sender.id,not_before,message_id::text));
     INSERT INTO app.outbox_jobs(message_id,conversation_id,campaign_id,prospect_id,account_id,step,job_kind,status,approval_required,due_at,idempotency_key)
     VALUES(message_id,conv.id,c.id,conv.prospect_id,sender.id,'J0','reply','scheduled',false,send_at,'reply:'||w.id);
     UPDATE app.reply_workflows SET state='queued',output_message_id=message_id,due_at=send_at WHERE id=w.id;
   ELSE
     INSERT INTO app.reply_draft_requests(source_message_id,conversation_id,sender_account_id,proposed_subject,proposed_body,state,idempotency_key)
     VALUES(src.id,conv.id,sender.id,p_subject,p_body,'requested','reply:'||w.id) RETURNING id INTO request_id;
     UPDATE app.reply_workflows SET state='draft_requested',draft_request_id=request_id WHERE id=w.id;
   END IF;
 END IF;
 RETURN jsonb_build_object('workflowId',w.id,'completed',w.completed_iterations,'total',cardinality(w.instructions),
   'state',(SELECT state FROM app.reply_workflows WHERE id=w.id));
END;
$complete$;

CREATE FUNCTION agent_api.fail_reply_iteration(p_iteration_run_id uuid,p_run_id uuid,p_error_code text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app,audit AS $fail$
DECLARE work_id uuid;
BEGIN
 UPDATE app.reply_iteration_runs SET status='failed',error_code=left(p_error_code,120)
 WHERE id=p_iteration_run_id AND agent_run_id=p_run_id AND status='running' RETURNING workflow_id INTO work_id;
 UPDATE app.reply_workflows SET state='pending',updated_at=clock_timestamp() WHERE id=work_id AND state='running';
END;
$fail$;
REVOKE ALL ON FUNCTION agent_api.claim_reply_iteration(uuid,uuid,text),agent_api.complete_reply_iteration(uuid,uuid,text,text,text),agent_api.fail_reply_iteration(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_api.claim_reply_iteration(uuid,uuid,text),agent_api.complete_reply_iteration(uuid,uuid,text,text,text),agent_api.fail_reply_iteration(uuid,uuid,text) TO prospection95_agent;
-- The legacy single-shot path must not bypass configured iterations.
REVOKE EXECUTE ON FUNCTION agent_api.propose_reply_draft(uuid,text,text,text) FROM prospection95_agent;

CREATE FUNCTION app.supersede_reply_workflows() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,app AS $supersede$
BEGIN
 IF NEW.direction='inbound' AND NEW.kind='reply' AND NEW.conversation_id IS NOT NULL THEN
   PERFORM 1 FROM app.conversations WHERE id=NEW.conversation_id FOR UPDATE;
   UPDATE app.reply_workflows w SET state='superseded',updated_at=clock_timestamp()
   WHERE conversation_id=NEW.conversation_id AND source_message_id<>NEW.id AND state IN ('pending','running','queued','draft_requested')
     AND NOT EXISTS(SELECT 1 FROM app.email_messages src WHERE src.id=w.source_message_id
       AND (coalesce(src.received_at,src.created_at),src.created_at,src.id)>(coalesce(NEW.received_at,NEW.created_at),NEW.created_at,NEW.id));
   UPDATE app.reply_iteration_runs r SET status='failed',error_code='source_superseded' FROM app.reply_workflows w
     WHERE r.workflow_id=w.id AND w.conversation_id=NEW.conversation_id AND w.state='superseded' AND r.status='running';
   UPDATE app.reply_draft_requests d SET state='stale' FROM app.reply_workflows w
     WHERE w.draft_request_id=d.id AND w.conversation_id=NEW.conversation_id AND w.state='superseded' AND d.state IN ('proposed','requested');
   UPDATE app.outbox_jobs j SET status='cancelled',cancel_reason='new_inbound_reply',cancelled_at=clock_timestamp()
     FROM app.reply_workflows w WHERE w.output_message_id=j.message_id AND w.conversation_id=NEW.conversation_id AND w.state='superseded' AND j.status IN ('pending','scheduled','deferred','reserved');
 END IF;
 RETURN NEW;
END;
$supersede$;
REVOKE ALL ON FUNCTION app.supersede_reply_workflows() FROM PUBLIC,prospection95_agent,prospection95_crm;
CREATE TRIGGER supersede_reply_workflows AFTER INSERT ON app.email_messages FOR EACH ROW EXECUTE FUNCTION app.supersede_reply_workflows();
CREATE TRIGGER immutable_completed_reply_iteration BEFORE UPDATE OR DELETE ON app.reply_iteration_runs
FOR EACH ROW EXECUTE FUNCTION app.prevent_completed_prospect_iteration_mutation();
INSERT INTO app.schema_migrations(version) VALUES('032_reply_iteration_workflow') ON CONFLICT(version) DO NOTHING;
