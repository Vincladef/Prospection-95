-- Prospection 95 · fondations relationnelles
-- PostgreSQL 17 / Neon. Migration additive et rejouable.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prospection95_app') THEN
    CREATE ROLE prospection95_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prospection95_agent') THEN
    CREATE ROLE prospection95_agent NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS vault;
CREATE SCHEMA IF NOT EXISTS agent_api;
CREATE SCHEMA IF NOT EXISTS audit;

REVOKE ALL ON SCHEMA app, vault, agent_api, audit FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA app, vault, agent_api, audit FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app, vault, agent_api, audit FROM PUBLIC;

DO $$ BEGIN
  CREATE TYPE app.campaign_status AS ENUM ('inactive', 'active', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE app.validation_policy AS ENUM ('manual', 'automatic');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE app.sender_strategy AS ENUM ('fixed', 'pool');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE app.account_status AS ENUM ('configuring', 'active', 'suspended', 'error', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE app.pause_source AS ENUM ('manual', 'automatic', 'system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE app.contact_state AS ENUM ('never_contacted', 'contacted', 'conversation_in_progress', 'replied', 'do_not_contact', 'unsubscribed', 'opposition');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE app.sequence_step AS ENUM ('J0', 'R1', 'R2', 'R3', 'R4', 'R5', 'reply', 'diagnostic');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE app.message_status AS ENUM ('draft', 'prepared', 'pending_approval', 'approved', 'scheduled', 'reserved', 'sending', 'smtp_accepted', 'uncertain', 'failed', 'cancelled', 'received', 'sent_manually');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE app.job_status AS ENUM ('requested', 'pending', 'scheduled', 'reserved', 'running', 'completed', 'failed', 'deferred', 'uncertain', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE app.response_classification AS ENUM ('positive', 'negative', 'information', 'meeting', 'ambiguous', 'opposition', 'automatic_reply', 'out_of_office', 'bounce', 'unrelated');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE app.experiment_status AS ENUM ('draft', 'recruiting', 'threshold_reached', 'awaiting_observations', 'mature', 'analyzed', 'closed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE app.diagnostic_status AS ENUM ('requested', 'reserved', 'awaiting_destination', 'send_requested', 'sent', 'awaiting_report', 'reported', 'failed', 'deferred', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE app.incident_severity AS ENUM ('normal', 'watch', 'serious');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE vault.credential_kind AS ENUM ('gmail_sender', 'gmail_primary', 'test_inbox', 'bobwork');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE OR REPLACE FUNCTION app.canonical_email(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT lower(btrim(value));
$$;

CREATE OR REPLACE FUNCTION app.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS app.schema_migrations (
  version text PRIMARY KEY,
  checksum text,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS app.settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  timezone text NOT NULL DEFAULT 'Europe/Paris',
  outbound_enabled boolean NOT NULL DEFAULT false,
  emergency_stop boolean NOT NULL DEFAULT true,
  emergency_stop_reason text,
  emergency_stop_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  emergency_stop_changed_by text NOT NULL DEFAULT 'system',
  default_send_days smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5]::smallint[],
  default_send_start time NOT NULL DEFAULT '08:00',
  default_send_end time NOT NULL DEFAULT '18:00',
  general_writing_instructions text NOT NULL DEFAULT '',
  retention_days integer NOT NULL DEFAULT 730 CHECK (retention_days BETWEEN 30 AND 3650),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (default_send_start < default_send_end),
  CHECK (default_send_days <@ ARRAY[1,2,3,4,5,6,7]::smallint[])
);

INSERT INTO app.settings (singleton)
VALUES (true)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS app.campaign_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS vault.credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind vault.credential_kind NOT NULL,
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 180),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) > 0),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag bytea NOT NULL CHECK (octet_length(auth_tag) = 16),
  key_version smallint NOT NULL CHECK (key_version > 0),
  algorithm text NOT NULL DEFAULT 'AES-256-GCM' CHECK (algorithm = 'AES-256-GCM'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  last_verified_at timestamptz,
  verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified', 'verified', 'failed')),
  verification_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz
);

COMMENT ON TABLE vault.credentials IS 'Ciphertext only. Plaintext is encrypted/decrypted inside authenticated Netlify Functions.';

CREATE TABLE IF NOT EXISTS app.gmail_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  normalized_email text GENERATED ALWAYS AS (app.canonical_email(email)) STORED,
  display_name text,
  role text NOT NULL DEFAULT 'sender' CHECK (role IN ('sender', 'primary', 'test_inbox')),
  status app.account_status NOT NULL DEFAULT 'configuring',
  credential_id uuid REFERENCES vault.credentials(id) ON DELETE SET NULL,
  daily_limit integer NOT NULL DEFAULT 20 CHECK (daily_limit BETWEEN 0 AND 2000),
  warmup_daily_limit integer CHECK (warmup_daily_limit IS NULL OR warmup_daily_limit BETWEEN 0 AND 2000),
  send_days smallint[] NOT NULL DEFAULT ARRAY[1,2,3,4,5]::smallint[],
  send_start time NOT NULL DEFAULT '08:00',
  send_end time NOT NULL DEFAULT '18:00',
  timezone text NOT NULL DEFAULT 'Europe/Paris',
  randomize_send_times boolean NOT NULL DEFAULT true,
  progressive_ramp_enabled boolean NOT NULL DEFAULT true,
  progressive_ramp_started_at date,
  paused_at timestamptz,
  pause_source app.pause_source,
  pause_reason text,
  review_at timestamptz,
  smtp_verified_at timestamptz,
  imap_verified_at timestamptz,
  last_sync_at timestamptz,
  last_error_code text,
  last_error_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  CHECK (send_start < send_end),
  CHECK (send_days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),
  CHECK ((paused_at IS NULL AND pause_source IS NULL) OR (paused_at IS NOT NULL AND pause_source IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS gmail_accounts_email_active_uq
  ON app.gmail_accounts (normalized_email)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS gmail_accounts_single_primary_uq
  ON app.gmail_accounts ((role))
  WHERE role = 'primary' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS app.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id uuid REFERENCES app.campaign_folders(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 180),
  status app.campaign_status NOT NULL DEFAULT 'inactive',
  target_description text NOT NULL DEFAULT '',
  qualification_criteria jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(qualification_criteria) = 'object'),
  daily_new_contact_goal integer NOT NULL DEFAULT 0 CHECK (daily_new_contact_goal BETWEEN 0 AND 10000),
  validation_policy app.validation_policy NOT NULL DEFAULT 'manual',
  sender_strategy app.sender_strategy NOT NULL DEFAULT 'fixed',
  fixed_sender_account_id uuid REFERENCES app.gmail_accounts(id) ON DELETE SET NULL,
  ai_instructions text NOT NULL DEFAULT '',
  reply_instructions text NOT NULL DEFAULT '',
  tracking_opens_enabled boolean NOT NULL DEFAULT false,
  tracking_clicks_enabled boolean NOT NULL DEFAULT false,
  experiment_policy text NOT NULL DEFAULT 'continue' CHECK (experiment_policy IN ('continue', 'stabilize')),
  next_test_instructions text NOT NULL DEFAULT '',
  imported_disabled boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (sender_strategy <> 'fixed' OR fixed_sender_account_id IS NOT NULL OR status <> 'active'),
  CHECK (NOT imported_disabled OR status <> 'active')
);

CREATE UNIQUE INDEX IF NOT EXISTS campaigns_name_uq
  ON app.campaigns (lower(name));
CREATE INDEX IF NOT EXISTS campaigns_status_idx ON app.campaigns (status, created_at DESC);

CREATE TABLE IF NOT EXISTS app.campaign_sender_accounts (
  campaign_id uuid NOT NULL REFERENCES app.campaigns(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES app.gmail_accounts(id) ON DELETE RESTRICT,
  weight numeric(8,4) NOT NULL DEFAULT 1 CHECK (weight > 0),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (campaign_id, account_id)
);

CREATE TABLE IF NOT EXISTS app.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 240),
  domain text,
  website_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS organizations_domain_uq
  ON app.organizations (lower(domain)) WHERE domain IS NOT NULL;

CREATE TABLE IF NOT EXISTS app.prospects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES app.organizations(id) ON DELETE SET NULL,
  full_name text NOT NULL DEFAULT '',
  job_title text,
  email text,
  normalized_email text GENERATED ALWAYS AS (app.canonical_email(email)) STORED,
  contact_raw text NOT NULL,
  contact_kind text NOT NULL DEFAULT 'email' CHECK (contact_kind IN ('email', 'url', 'other')),
  website_url text,
  source_label text,
  source_url text,
  source_evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_evidence) = 'object'),
  qualification_state text NOT NULL DEFAULT 'unreviewed' CHECK (qualification_state IN ('unreviewed', 'qualified', 'rejected', 'needs_review')),
  qualification_score numeric(6,3),
  qualification_reason text,
  contact_state app.contact_state NOT NULL DEFAULT 'never_contacted',
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  CHECK (
    (contact_kind = 'email' AND normalized_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') OR
    (contact_kind <> 'email' AND email IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS prospects_email_active_uq
  ON app.prospects (normalized_email) WHERE deleted_at IS NULL AND normalized_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS prospects_state_idx
  ON app.prospects (contact_state, qualification_state, created_at DESC);

CREATE TABLE IF NOT EXISTS app.campaign_prospects (
  campaign_id uuid NOT NULL REFERENCES app.campaigns(id) ON DELETE CASCADE,
  prospect_id uuid NOT NULL REFERENCES app.prospects(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'candidate' CHECK (state IN ('candidate', 'reserved', 'prepared', 'engaged', 'replied', 'excluded', 'rejected')),
  assigned_sender_account_id uuid REFERENCES app.gmail_accounts(id) ON DELETE SET NULL,
  reserved_by_run_id uuid,
  reserved_at timestamptz,
  reservation_key text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (campaign_id, prospect_id),
  UNIQUE (reservation_key)
);
CREATE INDEX IF NOT EXISTS campaign_prospects_queue_idx
  ON app.campaign_prospects (campaign_id, state, created_at);

CREATE TABLE IF NOT EXISTS app.contact_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_email text NOT NULL CHECK (normalized_email = app.canonical_email(normalized_email)),
  prospect_id uuid REFERENCES app.prospects(id) ON DELETE SET NULL,
  first_contact_at timestamptz,
  confirmation_source text NOT NULL CHECK (confirmation_source IN ('smtp_confirmed', 'gmail_sent_sync', 'import_declared', 'manual_declared')),
  technically_confirmed boolean NOT NULL DEFAULT false,
  conversation_id uuid,
  source_reference text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (normalized_email)
);
CREATE INDEX IF NOT EXISTS contact_history_confirmation_idx
  ON app.contact_history (technically_confirmed, first_contact_at DESC);

CREATE TABLE IF NOT EXISTS app.exclusions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_type text NOT NULL CHECK (match_type IN ('email', 'domain')),
  match_value text NOT NULL,
  normalized_value text GENERATED ALWAYS AS (lower(trim(leading '@' from btrim(match_value)))) STORED,
  reason text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'reply', 'import', 'agent')),
  permanent boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by text NOT NULL DEFAULT 'system',
  revoked_at timestamptz,
  revoked_by text,
  CHECK (length(normalized_value) > 2)
);
CREATE UNIQUE INDEX IF NOT EXISTS exclusions_active_uq
  ON app.exclusions (match_type, normalized_value) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION app.is_excluded(candidate_email text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM app.exclusions e
    WHERE e.revoked_at IS NULL
      AND (
        (e.match_type = 'email' AND e.normalized_value = app.canonical_email(candidate_email)) OR
        (e.match_type = 'domain' AND split_part(app.canonical_email(candidate_email), '@', 2) = e.normalized_value)
      )
  );
$$;

CREATE OR REPLACE FUNCTION app.reserve_campaign_prospect(
  p_campaign_id uuid,
  p_prospect_id uuid,
  p_run_id uuid,
  p_idempotency_key text
)
RETURNS app.campaign_prospects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  result app.campaign_prospects;
  candidate_email text;
  current_state text;
  current_reservation_key text;
BEGIN
  IF length(coalesce(p_idempotency_key, '')) < 8 THEN
    RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE = '22023';
  END IF;

  SELECT p.normalized_email, cp.state, cp.reservation_key
    INTO candidate_email, current_state, current_reservation_key
  FROM app.prospects p
  JOIN app.campaign_prospects cp ON cp.prospect_id = p.id
  JOIN app.campaigns c ON c.id = cp.campaign_id
  WHERE p.id = p_prospect_id
    AND cp.campaign_id = p_campaign_id
    AND p.deleted_at IS NULL
    AND p.qualification_state = 'qualified'
    AND c.status = 'active'
    AND NOT c.imported_disabled
  FOR UPDATE OF p, cp;

  IF candidate_email IS NULL THEN
    RAISE EXCEPTION 'prospect_not_eligible' USING ERRCODE = 'P0001';
  END IF;
  IF current_reservation_key = p_idempotency_key
     AND current_state IN ('reserved','prepared','engaged','replied') THEN
    SELECT * INTO result FROM app.campaign_prospects
     WHERE campaign_id = p_campaign_id AND prospect_id = p_prospect_id;
    RETURN result;
  END IF;
  IF current_state = 'reserved' AND current_reservation_key IS DISTINCT FROM p_idempotency_key THEN
    RAISE EXCEPTION 'prospect_reserved_by_another_run' USING ERRCODE = '55P03';
  END IF;
  IF current_state <> 'candidate' THEN
    RAISE EXCEPTION 'prospect_not_reservable' USING ERRCODE = 'P0001';
  END IF;
  IF app.is_excluded(candidate_email) THEN
    RAISE EXCEPTION 'prospect_excluded' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM app.contact_history h WHERE h.normalized_email = candidate_email) THEN
    RAISE EXCEPTION 'already_contacted' USING ERRCODE = '23505';
  END IF;

  UPDATE app.campaign_prospects
  SET state = 'reserved', reserved_by_run_id = p_run_id,
      reserved_at = clock_timestamp(), reservation_key = p_idempotency_key,
      updated_at = clock_timestamp()
  WHERE campaign_id = p_campaign_id AND prospect_id = p_prospect_id
    AND state = 'candidate'
  RETURNING * INTO result;

  RETURN result;
END;
$$;

DO $$
DECLARE target regclass;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'app.settings'::regclass,
    'app.campaign_folders'::regclass,
    'vault.credentials'::regclass,
    'app.gmail_accounts'::regclass,
    'app.campaigns'::regclass,
    'app.organizations'::regclass,
    'app.prospects'::regclass,
    'app.campaign_prospects'::regclass
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS touch_updated_at ON %s', target);
    EXECUTE format('CREATE TRIGGER touch_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', target);
  END LOOP;
END
$$;

INSERT INTO app.schema_migrations (version)
VALUES ('001_foundation')
ON CONFLICT (version) DO NOTHING;
