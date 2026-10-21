-- Prospection 95 · séquences, conversations, SMTP/IMAP et brouillons.

CREATE TABLE IF NOT EXISTS app.message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES app.campaigns(id) ON DELETE CASCADE,
  step app.sequence_step NOT NULL CHECK (step IN ('J0','R1','R2','R3','R4','R5')),
  iteration smallint NOT NULL DEFAULT 1 CHECK (iteration BETWEEN 1 AND 12),
  version integer NOT NULL CHECK (version > 0),
  subject text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  instructions text NOT NULL DEFAULT '',
  supersedes_id uuid REFERENCES app.message_templates(id) ON DELETE SET NULL,
  exposed_at timestamptz,
  created_by text NOT NULL DEFAULT 'user',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (campaign_id, step, iteration, version)
);
CREATE INDEX IF NOT EXISTS message_templates_latest_idx
  ON app.message_templates (campaign_id, step, iteration, version DESC);

CREATE OR REPLACE FUNCTION app.prevent_exposed_template_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF OLD.exposed_at IS NOT NULL AND ROW(NEW.subject, NEW.body, NEW.instructions, NEW.step, NEW.iteration)
    IS DISTINCT FROM ROW(OLD.subject, OLD.body, OLD.instructions, OLD.step, OLD.iteration) THEN
    RAISE EXCEPTION 'exposed_message_version_is_immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS immutable_exposed_template ON app.message_templates;
CREATE TRIGGER immutable_exposed_template
BEFORE UPDATE ON app.message_templates
FOR EACH ROW EXECUTE FUNCTION app.prevent_exposed_template_mutation();

CREATE TABLE IF NOT EXISTS app.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES app.campaigns(id) ON DELETE RESTRICT,
  prospect_id uuid NOT NULL REFERENCES app.prospects(id) ON DELETE RESTRICT,
  sender_account_id uuid NOT NULL REFERENCES app.gmail_accounts(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','active','paused','replied','opposition','completed','cancelled','unresolved')),
  current_step app.sequence_step NOT NULL DEFAULT 'J0' CHECK (current_step IN ('J0','R1','R2','R3','R4','R5')),
  experiment_assignment_id uuid,
  root_message_id text,
  latest_references text[] NOT NULL DEFAULT '{}'::text[],
  last_outbound_at timestamptz,
  last_inbound_at timestamptz,
  next_step_due_at timestamptz,
  followups_stopped_at timestamptz,
  followups_stop_reason text,
  imap_reconciled_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (campaign_id, prospect_id)
);
CREATE INDEX IF NOT EXISTS conversations_due_idx
  ON app.conversations (next_step_due_at, state)
  WHERE state = 'active' AND followups_stopped_at IS NULL;

CREATE TABLE IF NOT EXISTS app.email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES app.conversations(id) ON DELETE RESTRICT,
  diagnostic_request_id uuid,
  direction text NOT NULL CHECK (direction IN ('outbound','inbound')),
  kind text NOT NULL CHECK (kind IN ('prospection','reply','diagnostic','manual','automatic_reply','out_of_office','bounce','unrelated')),
  step app.sequence_step,
  sender_account_id uuid REFERENCES app.gmail_accounts(id) ON DELETE RESTRICT,
  mailbox_account_id uuid REFERENCES app.gmail_accounts(id) ON DELETE RESTRICT,
  from_address text NOT NULL,
  to_addresses text[] NOT NULL CHECK (cardinality(to_addresses) > 0),
  cc_addresses text[] NOT NULL DEFAULT '{}'::text[],
  subject text NOT NULL DEFAULT '',
  body_text text NOT NULL DEFAULT '',
  body_html text,
  content_version integer NOT NULL DEFAULT 1 CHECK (content_version > 0),
  template_id uuid REFERENCES app.message_templates(id) ON DELETE SET NULL,
  internet_message_id text,
  in_reply_to text,
  references_header text[] NOT NULL DEFAULT '{}'::text[],
  gmail_thread_id text,
  gmail_message_id text,
  legacy_gmail_id text,
  imap_uid bigint,
  imap_uidvalidity bigint,
  imap_mailbox text,
  status app.message_status NOT NULL DEFAULT 'draft',
  smtp_accepted_at timestamptz,
  received_at timestamptz,
  sent_at timestamptz,
  technical_confirmation boolean NOT NULL DEFAULT false,
  imported_declared_sent boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'application' CHECK (source IN ('application','imap','gmail_sent_sync','import','agent')),
  raw_headers jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(raw_headers) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (step IS NOT NULL OR kind IN ('reply','manual','automatic_reply','out_of_office','bounce','unrelated')),
  CHECK (NOT technical_confirmation OR status IN ('smtp_accepted','received','sent_manually')),
  CHECK (NOT imported_declared_sent OR source = 'import')
);
CREATE UNIQUE INDEX IF NOT EXISTS email_messages_internet_id_uq
  ON app.email_messages (mailbox_account_id, internet_message_id)
  WHERE internet_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS email_messages_imap_uid_uq
  ON app.email_messages (mailbox_account_id, imap_mailbox, imap_uidvalidity, imap_uid)
  WHERE imap_uid IS NOT NULL AND imap_uidvalidity IS NOT NULL;
CREATE INDEX IF NOT EXISTS email_messages_conversation_idx
  ON app.email_messages (conversation_id, coalesce(received_at, sent_at, created_at));

CREATE TABLE IF NOT EXISTS app.message_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES app.email_messages(id) ON DELETE CASCADE,
  approved boolean NOT NULL,
  actor text NOT NULL,
  message_content_hash text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS message_approvals_latest_idx
  ON app.message_approvals (message_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app.outbox_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES app.email_messages(id) ON DELETE RESTRICT,
  conversation_id uuid REFERENCES app.conversations(id) ON DELETE RESTRICT,
  campaign_id uuid REFERENCES app.campaigns(id) ON DELETE RESTRICT,
  prospect_id uuid REFERENCES app.prospects(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES app.gmail_accounts(id) ON DELETE RESTRICT,
  step app.sequence_step NOT NULL,
  job_kind text NOT NULL DEFAULT 'prospection' CHECK (job_kind IN ('prospection','diagnostic','draft_sync')),
  status app.job_status NOT NULL DEFAULT 'pending',
  approval_required boolean NOT NULL DEFAULT true,
  approved_at timestamptz,
  due_at timestamptz NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 240),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  last_error_code text,
  last_error_detail text,
  smtp_response_id text,
  uncertain_since timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (idempotency_key),
  CHECK (NOT approval_required OR approved_at IS NOT NULL OR status IN ('requested','pending','cancelled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS outbox_one_step_per_conversation_uq
  ON app.outbox_jobs (conversation_id, step)
  WHERE conversation_id IS NOT NULL AND job_kind = 'prospection' AND status NOT IN ('failed','cancelled');
CREATE INDEX IF NOT EXISTS outbox_due_idx
  ON app.outbox_jobs (due_at, created_at)
  WHERE status IN ('pending','scheduled','deferred');
CREATE INDEX IF NOT EXISTS outbox_active_lease_idx
  ON app.outbox_jobs (lease_expires_at)
  WHERE status IN ('reserved','running');

CREATE TABLE IF NOT EXISTS app.outbox_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES app.outbox_jobs(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  lease_token uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('smtp_accepted','failed','uncertain','cancelled')), 
  provider_response_code text,
  provider_response_id text,
  error_code text,
  error_detail text,
  UNIQUE (job_id, attempt_number)
);

CREATE TABLE IF NOT EXISTS app.imap_cursors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES app.gmail_accounts(id) ON DELETE CASCADE,
  mailbox_name text NOT NULL,
  uidvalidity bigint,
  last_uid bigint,
  highest_modseq numeric,
  last_success_at timestamptz,
  last_attempt_at timestamptz,
  last_error_code text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id, mailbox_name)
);

CREATE TABLE IF NOT EXISTS app.inbound_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES app.email_messages(id) ON DELETE CASCADE,
  classification app.response_classification NOT NULL,
  commercial_sentiment text CHECK (commercial_sentiment IN ('positive','negative','neutral','unknown')),
  meeting_confirmed boolean NOT NULL DEFAULT false,
  confidence numeric(5,4) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  rationale text,
  agent_run_id uuid,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (message_id),
  UNIQUE (idempotency_key),
  CHECK (NOT meeting_confirmed OR classification = 'meeting')
);

CREATE TABLE IF NOT EXISTS app.reply_draft_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_message_id uuid NOT NULL REFERENCES app.email_messages(id) ON DELETE RESTRICT,
  conversation_id uuid NOT NULL REFERENCES app.conversations(id) ON DELETE RESTRICT,
  sender_account_id uuid NOT NULL REFERENCES app.gmail_accounts(id) ON DELETE RESTRICT,
  proposed_subject text NOT NULL,
  proposed_body text NOT NULL,
  state text NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed','requested','created','failed','stale','sent_manually','dismissed')),
  idempotency_key text NOT NULL,
  gmail_draft_id text,
  gmail_thread_id text,
  manual_content_hash text,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (source_message_id),
  UNIQUE (idempotency_key)
);

CREATE OR REPLACE FUNCTION app.lease_outbox_jobs(
  p_worker text,
  p_limit integer DEFAULT 10,
  p_lease_seconds integer DEFAULT 45
)
RETURNS SETOF app.outbox_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  account_row app.gmail_accounts;
  local_now timestamp;
  local_day_start timestamptz;
  local_day_end timestamptz;
  effective_limit integer;
  accepted_today integer;
  protected_slots integer;
  available_slots integer;
  leased_now integer;
  leased_total integer := 0;
BEGIN
  IF length(coalesce(p_worker, '')) < 3 OR p_limit NOT BETWEEN 1 AND 50 OR p_lease_seconds NOT BETWEEN 10 AND 300 THEN
    RAISE EXCEPTION 'invalid_lease_parameters' USING ERRCODE = '22023';
  END IF;

  -- Un worker qui a commence SMTP mais a perdu son bail est ambigu : il doit
  -- etre rapproche avec le dossier Envoyes, jamais reloue automatiquement.
  WITH expired AS (
    UPDATE app.outbox_jobs j
       SET status = 'uncertain', uncertain_since = coalesce(j.uncertain_since, clock_timestamp()),
           last_error_code = coalesce(j.last_error_code, 'lease_expired_while_running'),
           lease_expires_at = NULL, updated_at = clock_timestamp()
     WHERE j.status = 'running' AND j.lease_expires_at < clock_timestamp()
    RETURNING j.id, j.message_id, j.attempt_count
  ), marked_messages AS (
    UPDATE app.email_messages m
       SET status = 'uncertain', updated_at = clock_timestamp()
      FROM expired e
     WHERE m.id = e.message_id AND m.status <> 'smtp_accepted'
    RETURNING m.id
  )
  UPDATE app.outbox_attempts a
     SET finished_at = coalesce(a.finished_at, clock_timestamp()),
         outcome = coalesce(a.outcome, 'uncertain'),
         error_code = coalesce(a.error_code, 'lease_expired_while_running')
    FROM expired e
   WHERE a.job_id = e.id AND a.attempt_number = e.attempt_count;

  IF NOT EXISTS (
    SELECT 1 FROM app.settings s
    WHERE s.singleton AND s.outbound_enabled AND NOT s.emergency_stop
  ) THEN
    RETURN;
  END IF;

  -- Le verrou de la ligne compte serialise le calcul du quota entre workers.
  FOR account_row IN
    SELECT a.*
      FROM app.gmail_accounts a
     WHERE a.status = 'active'
       AND a.paused_at IS NULL
       AND EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names tz WHERE tz.name = a.timezone)
       AND EXISTS (
         SELECT 1 FROM app.outbox_jobs j
          WHERE j.account_id = a.id
            AND j.due_at <= clock_timestamp()
            AND (
              j.status IN ('pending','scheduled','deferred') OR
              (j.status = 'reserved' AND j.lease_expires_at < clock_timestamp())
            )
       )
     ORDER BY (
       SELECT min(j.due_at) FROM app.outbox_jobs j
        WHERE j.account_id = a.id
          AND (
            j.status IN ('pending','scheduled','deferred') OR
            (j.status = 'reserved' AND j.lease_expires_at < clock_timestamp())
          )
     )
     FOR UPDATE OF a SKIP LOCKED
  LOOP
    EXIT WHEN leased_total >= p_limit;

    local_now := clock_timestamp() AT TIME ZONE account_row.timezone;
    IF NOT (extract(isodow FROM local_now)::smallint = ANY(account_row.send_days))
       OR local_now::time < account_row.send_start
       OR local_now::time >= account_row.send_end THEN
      CONTINUE;
    END IF;

    local_day_start := date_trunc('day', local_now) AT TIME ZONE account_row.timezone;
    local_day_end := (date_trunc('day', local_now) + interval '1 day') AT TIME ZONE account_row.timezone;
    effective_limit := LEAST(account_row.daily_limit,
                             coalesce(account_row.warmup_daily_limit, account_row.daily_limit));

    SELECT count(*)::integer INTO accepted_today
      FROM app.email_messages m
     WHERE m.direction = 'outbound'
       AND m.sender_account_id = account_row.id
       AND m.technical_confirmation
       AND coalesce(m.smtp_accepted_at, m.sent_at) >= local_day_start
       AND coalesce(m.smtp_accepted_at, m.sent_at) < local_day_end;

    -- Les baux actifs et les resultats incertains consomment une place de
    -- securite jusqu'a confirmation ou rapprochement.
    SELECT count(*)::integer INTO protected_slots
      FROM app.outbox_jobs j
     WHERE j.account_id = account_row.id
       AND (
         (j.status IN ('reserved','running') AND j.lease_expires_at >= clock_timestamp()) OR
         (j.status = 'uncertain' AND j.uncertain_since >= local_day_start AND j.uncertain_since < local_day_end)
       );

    available_slots := GREATEST(0, effective_limit - accepted_today - protected_slots);
    available_slots := LEAST(available_slots, p_limit - leased_total);
    IF available_slots = 0 THEN CONTINUE; END IF;

    RETURN QUERY
    WITH candidates AS (
      SELECT j.id
        FROM app.outbox_jobs j
        LEFT JOIN app.campaigns c ON c.id = j.campaign_id
        LEFT JOIN app.prospects p ON p.id = j.prospect_id
        LEFT JOIN app.conversations conv ON conv.id = j.conversation_id
       WHERE j.account_id = account_row.id
         AND j.due_at <= clock_timestamp()
         AND j.attempt_count < j.max_attempts
         AND (
           j.status IN ('pending','scheduled','deferred') OR
           (j.status = 'reserved' AND j.lease_expires_at < clock_timestamp())
         )
         AND (j.job_kind <> 'prospection' OR (
           c.status = 'active'
           AND NOT c.imported_disabled
           AND conv.followups_stopped_at IS NULL
           AND NOT app.is_excluded(p.normalized_email)
           AND (NOT j.approval_required OR j.approved_at IS NOT NULL)
         ))
       ORDER BY CASE WHEN j.step IN ('R1','R2','R3','R4','R5') THEN 0 ELSE 1 END,
                j.due_at, j.created_at
       FOR UPDATE OF j SKIP LOCKED
       LIMIT available_slots
    )
    UPDATE app.outbox_jobs j
       SET status = 'reserved', lease_owner = p_worker, lease_token = gen_random_uuid(),
           lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
           attempt_count = j.attempt_count + 1, updated_at = clock_timestamp()
      FROM candidates c
     WHERE j.id = c.id
    RETURNING j.*;

    GET DIAGNOSTICS leased_now = ROW_COUNT;
    leased_total := leased_total + leased_now;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION app.start_outbox_attempt(
  p_job_id uuid,
  p_lease_token uuid
)
RETURNS app.outbox_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE job app.outbox_jobs;
BEGIN
  SELECT * INTO job
    FROM app.outbox_jobs
   WHERE id = p_job_id
     AND lease_token = p_lease_token
     AND status IN ('reserved','running')
     AND lease_expires_at >= clock_timestamp()
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lease_not_owned_or_expired' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO app.outbox_attempts (job_id, attempt_number, lease_token)
  VALUES (job.id, job.attempt_count, p_lease_token)
  ON CONFLICT (job_id, attempt_number) DO NOTHING;

  IF job.status = 'reserved' THEN
    UPDATE app.outbox_jobs
       SET status = 'running', updated_at = clock_timestamp()
     WHERE id = job.id
    RETURNING * INTO job;
    UPDATE app.email_messages
       SET status = 'sending', updated_at = clock_timestamp()
     WHERE id = job.message_id AND status NOT IN ('smtp_accepted','cancelled');
  END IF;
  RETURN job;
END;
$$;

CREATE OR REPLACE FUNCTION app.confirm_smtp_acceptance(
  p_job_id uuid,
  p_lease_token uuid,
  p_provider_response_id text,
  p_sent_at timestamptz DEFAULT clock_timestamp()
)
RETURNS app.outbox_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  job app.outbox_jobs;
  prospect_email text;
BEGIN
  SELECT * INTO job FROM app.outbox_jobs
  WHERE id = p_job_id AND lease_token = p_lease_token AND status IN ('reserved','running','completed')
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'lease_not_owned' USING ERRCODE = 'P0001'; END IF;
  IF job.status = 'completed' THEN RETURN job; END IF;
  IF job.job_kind NOT IN ('prospection','diagnostic') OR coalesce(btrim(p_provider_response_id), '') = '' THEN
    RAISE EXCEPTION 'invalid_smtp_confirmation' USING ERRCODE = '22023';
  END IF;

  UPDATE app.email_messages
  SET status = 'smtp_accepted', smtp_accepted_at = p_sent_at, sent_at = p_sent_at,
      technical_confirmation = true, updated_at = clock_timestamp()
  WHERE id = job.message_id;

  UPDATE app.outbox_jobs
  SET status = 'completed', smtp_response_id = p_provider_response_id,
      completed_at = p_sent_at, lease_expires_at = NULL, updated_at = clock_timestamp()
  WHERE id = p_job_id
  RETURNING * INTO job;

  IF job.prospect_id IS NOT NULL THEN
    SELECT normalized_email INTO prospect_email FROM app.prospects WHERE id = job.prospect_id;
    IF prospect_email IS NOT NULL THEN
      INSERT INTO app.contact_history
        (normalized_email, prospect_id, first_contact_at, confirmation_source, technically_confirmed, conversation_id, source_reference)
      VALUES
        (prospect_email, job.prospect_id, p_sent_at, 'smtp_confirmed', true, job.conversation_id, p_provider_response_id)
      ON CONFLICT (normalized_email) DO UPDATE
        SET technically_confirmed = true,
            confirmation_source = 'smtp_confirmed',
            first_contact_at = coalesce(app.contact_history.first_contact_at, EXCLUDED.first_contact_at),
            conversation_id = coalesce(app.contact_history.conversation_id, EXCLUDED.conversation_id),
            source_reference = coalesce(EXCLUDED.source_reference, app.contact_history.source_reference);
    END IF;
    UPDATE app.prospects SET contact_state = 'conversation_in_progress', updated_at = clock_timestamp()
      WHERE id = job.prospect_id AND contact_state = 'never_contacted';
  END IF;

  UPDATE app.conversations
  SET state = 'active', current_step = job.step,
      last_outbound_at = p_sent_at, next_step_due_at = CASE job.step
        WHEN 'J0' THEN p_sent_at + interval '3 days'
        WHEN 'R1' THEN p_sent_at + interval '7 days'
        WHEN 'R2' THEN p_sent_at + interval '7 days'
        WHEN 'R3' THEN p_sent_at + interval '14 days'
        WHEN 'R4' THEN p_sent_at + interval '14 days'
        ELSE NULL END,
      updated_at = clock_timestamp(), version = version + 1
  WHERE id = job.conversation_id;

  UPDATE app.outbox_attempts
     SET finished_at = coalesce(finished_at, p_sent_at), outcome = 'smtp_accepted',
         provider_response_id = p_provider_response_id
   WHERE job_id = job.id AND attempt_number = job.attempt_count;

  RETURN job;
END;
$$;

CREATE OR REPLACE FUNCTION app.mark_smtp_uncertain(
  p_job_id uuid,
  p_lease_token uuid,
  p_error_code text,
  p_detail text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.outbox_jobs
     WHERE id = p_job_id AND lease_token = p_lease_token AND status = 'uncertain'
  ) THEN
    RETURN;
  END IF;
  UPDATE app.outbox_jobs
  SET status = 'uncertain', uncertain_since = clock_timestamp(), last_error_code = p_error_code,
      last_error_detail = left(p_detail, 2000), lease_expires_at = NULL, updated_at = clock_timestamp()
  WHERE id = p_job_id AND lease_token = p_lease_token AND status IN ('reserved','running');
  IF NOT FOUND THEN RAISE EXCEPTION 'lease_not_owned' USING ERRCODE = 'P0001'; END IF;
  UPDATE app.email_messages SET status = 'uncertain', updated_at = clock_timestamp()
  WHERE id = (SELECT message_id FROM app.outbox_jobs WHERE id = p_job_id);
  UPDATE app.outbox_attempts
     SET finished_at = coalesce(finished_at, clock_timestamp()), outcome = 'uncertain',
         error_code = p_error_code, error_detail = left(p_detail, 2000)
   WHERE job_id = p_job_id
     AND attempt_number = (SELECT attempt_count FROM app.outbox_jobs WHERE id = p_job_id);
END;
$$;

CREATE OR REPLACE FUNCTION app.record_inbound_message(
  p_mailbox_account_id uuid,
  p_conversation_id uuid,
  p_kind text,
  p_from_address text,
  p_to_addresses text[],
  p_subject text DEFAULT '',
  p_body_text text DEFAULT '',
  p_body_html text DEFAULT NULL,
  p_cc_addresses text[] DEFAULT '{}'::text[],
  p_internet_message_id text DEFAULT NULL,
  p_in_reply_to text DEFAULT NULL,
  p_references_header text[] DEFAULT '{}'::text[],
  p_gmail_thread_id text DEFAULT NULL,
  p_gmail_message_id text DEFAULT NULL,
  p_imap_mailbox text DEFAULT 'INBOX',
  p_imap_uidvalidity bigint DEFAULT NULL,
  p_imap_uid bigint DEFAULT NULL,
  p_highest_modseq numeric DEFAULT NULL,
  p_received_at timestamptz DEFAULT clock_timestamp(),
  p_raw_headers jsonb DEFAULT '{}'::jsonb
)
RETURNS app.email_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE result app.email_messages;
BEGIN
  IF p_kind NOT IN ('reply','automatic_reply','out_of_office','bounce','unrelated')
     OR cardinality(p_to_addresses) < 1
     OR coalesce(btrim(p_from_address), '') = ''
     OR jsonb_typeof(coalesce(p_raw_headers, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'invalid_inbound_message' USING ERRCODE = '22023';
  END IF;
  IF p_internet_message_id IS NULL
     AND (p_imap_mailbox IS NULL OR p_imap_uidvalidity IS NULL OR p_imap_uid IS NULL) THEN
    RAISE EXCEPTION 'inbound_message_identity_required' USING ERRCODE = '22023';
  END IF;
  IF (p_imap_uidvalidity IS NULL) <> (p_imap_uid IS NULL) THEN
    RAISE EXCEPTION 'imap_uid_pair_required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO app.email_messages
    (conversation_id, direction, kind, mailbox_account_id, from_address, to_addresses,
     cc_addresses, subject, body_text, body_html, internet_message_id, in_reply_to,
     references_header, gmail_thread_id, gmail_message_id, imap_uid, imap_uidvalidity,
     imap_mailbox, status, received_at, source, raw_headers)
  VALUES
    (p_conversation_id, 'inbound', p_kind, p_mailbox_account_id, p_from_address,
     p_to_addresses, coalesce(p_cc_addresses, '{}'::text[]), coalesce(p_subject, ''),
     coalesce(p_body_text, ''), p_body_html, p_internet_message_id, p_in_reply_to,
     coalesce(p_references_header, '{}'::text[]), p_gmail_thread_id, p_gmail_message_id,
     p_imap_uid, p_imap_uidvalidity, p_imap_mailbox, 'received', p_received_at, 'imap',
     coalesce(p_raw_headers, '{}'::jsonb))
  ON CONFLICT DO NOTHING
  RETURNING * INTO result;

  IF result.id IS NULL THEN
    SELECT m.* INTO result
      FROM app.email_messages m
     WHERE m.mailbox_account_id = p_mailbox_account_id
       AND (
         (p_internet_message_id IS NOT NULL AND m.internet_message_id = p_internet_message_id) OR
         (p_imap_uid IS NOT NULL AND m.imap_mailbox = p_imap_mailbox
          AND m.imap_uidvalidity = p_imap_uidvalidity AND m.imap_uid = p_imap_uid)
       )
     ORDER BY m.created_at
     LIMIT 1;
  END IF;
  IF result.id IS NULL THEN
    RAISE EXCEPTION 'inbound_identity_conflict' USING ERRCODE = '23505';
  END IF;

  IF p_imap_uid IS NOT NULL THEN
    INSERT INTO app.imap_cursors
      (account_id, mailbox_name, uidvalidity, last_uid, highest_modseq,
       last_success_at, last_attempt_at, consecutive_failures)
    VALUES
      (p_mailbox_account_id, p_imap_mailbox, p_imap_uidvalidity, p_imap_uid,
       p_highest_modseq, clock_timestamp(), clock_timestamp(), 0)
    ON CONFLICT (account_id, mailbox_name) DO UPDATE
      SET last_uid = CASE
            WHEN app.imap_cursors.uidvalidity IS DISTINCT FROM EXCLUDED.uidvalidity THEN EXCLUDED.last_uid
            ELSE GREATEST(app.imap_cursors.last_uid, EXCLUDED.last_uid)
          END,
          uidvalidity = EXCLUDED.uidvalidity,
          highest_modseq = CASE
            WHEN app.imap_cursors.uidvalidity IS DISTINCT FROM EXCLUDED.uidvalidity THEN EXCLUDED.highest_modseq
            ELSE GREATEST(app.imap_cursors.highest_modseq, EXCLUDED.highest_modseq)
          END,
          last_success_at = clock_timestamp(), last_attempt_at = clock_timestamp(),
          last_error_code = NULL, consecutive_failures = 0,
          version = app.imap_cursors.version + 1, updated_at = clock_timestamp();
  END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION app.stop_followups_on_inbound()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
  IF NEW.direction = 'inbound' AND NEW.kind NOT IN ('automatic_reply','out_of_office','bounce','unrelated') AND NEW.conversation_id IS NOT NULL THEN
    UPDATE app.conversations
      SET state = 'replied', last_inbound_at = coalesce(NEW.received_at, clock_timestamp()),
          followups_stopped_at = clock_timestamp(), followups_stop_reason = 'relevant_inbound',
          next_step_due_at = NULL, updated_at = clock_timestamp(), version = version + 1
      WHERE id = NEW.conversation_id AND followups_stopped_at IS NULL;
    UPDATE app.outbox_jobs
      SET status = 'cancelled', cancelled_at = clock_timestamp(), cancel_reason = 'relevant_inbound', updated_at = clock_timestamp()
      WHERE conversation_id = NEW.conversation_id
        AND status IN ('requested','pending','scheduled','deferred','reserved');
    UPDATE app.prospects SET contact_state = 'replied', updated_at = clock_timestamp()
      WHERE id = (SELECT prospect_id FROM app.conversations WHERE id = NEW.conversation_id);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS stop_followups_on_inbound ON app.email_messages;
CREATE TRIGGER stop_followups_on_inbound
AFTER INSERT ON app.email_messages
FOR EACH ROW EXECUTE FUNCTION app.stop_followups_on_inbound();

DO $$
DECLARE target regclass;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'app.conversations'::regclass,
    'app.email_messages'::regclass,
    'app.outbox_jobs'::regclass,
    'app.reply_draft_requests'::regclass
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS touch_updated_at ON %s', target);
    EXECUTE format('CREATE TRIGGER touch_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', target);
  END LOOP;
END
$$;

INSERT INTO app.schema_migrations (version)
VALUES ('002_messaging')
ON CONFLICT (version) DO NOTHING;
