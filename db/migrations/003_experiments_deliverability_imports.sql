-- Prospection 95 · expériences, délivrabilité, audit et import historique.

CREATE TABLE IF NOT EXISTS app.experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES app.campaigns(id) ON DELETE CASCADE,
  name text NOT NULL,
  status app.experiment_status NOT NULL DEFAULT 'draft',
  scope text NOT NULL DEFAULT 'sequence' CHECK (scope IN ('population','subject','step','sequence','instructions','combined')),
  target_step app.sequence_step,
  comparable_population boolean NOT NULL DEFAULT true,
  allocation_method text NOT NULL DEFAULT 'balanced_random' CHECK (allocation_method IN ('balanced_random','descriptive_groups')),
  primary_metric text NOT NULL DEFAULT 'positive_reply' CHECK (primary_metric IN ('human_reply','positive_reply','confirmed_meeting','open','click')),
  contacts_per_variant_threshold integer NOT NULL DEFAULT 40 CHECK (contacts_per_variant_threshold > 0),
  total_responses_threshold integer NOT NULL DEFAULT 20 CHECK (total_responses_threshold > 0),
  maturity_delay interval NOT NULL DEFAULT interval '14 days' CHECK (maturity_delay > interval '0'),
  started_at timestamptz,
  threshold_reached_at timestamptz,
  mature_at timestamptz,
  analyzed_at timestamptz,
  closed_at timestamptz,
  decision text,
  limitations text,
  created_by_run_id uuid,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (campaign_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS app.experiment_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES app.experiments(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-Z]{1,3}$'),
  name text,
  weight numeric(8,4) NOT NULL DEFAULT 1 CHECK (weight > 0),
  base_variant_id uuid REFERENCES app.experiment_variants(id) ON DELETE RESTRICT,
  overrides jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(overrides) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  exposed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (experiment_id, code),
  UNIQUE (experiment_id, id)
);

CREATE TABLE IF NOT EXISTS app.experiment_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES app.experiments(id) ON DELETE RESTRICT,
  variant_id uuid NOT NULL,
  prospect_id uuid NOT NULL REFERENCES app.prospects(id) ON DELETE RESTRICT,
  campaign_id uuid NOT NULL REFERENCES app.campaigns(id) ON DELETE RESTRICT,
  assigned_for_step app.sequence_step,
  assignment_key text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  exposed_at timestamptz,
  FOREIGN KEY (experiment_id, variant_id)
    REFERENCES app.experiment_variants(experiment_id, id) ON DELETE RESTRICT,
  UNIQUE (experiment_id, prospect_id, assigned_for_step),
  UNIQUE (id, experiment_id, variant_id, prospect_id),
  UNIQUE (assignment_key)
);

CREATE OR REPLACE FUNCTION app.prevent_assignment_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF ROW(NEW.experiment_id, NEW.variant_id, NEW.prospect_id, NEW.campaign_id, NEW.assigned_for_step)
     IS DISTINCT FROM ROW(OLD.experiment_id, OLD.variant_id, OLD.prospect_id, OLD.campaign_id, OLD.assigned_for_step) THEN
    RAISE EXCEPTION 'experiment_assignment_is_immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS immutable_experiment_assignment ON app.experiment_assignments;
CREATE TRIGGER immutable_experiment_assignment
BEFORE UPDATE ON app.experiment_assignments
FOR EACH ROW EXECUTE FUNCTION app.prevent_assignment_mutation();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'app.conversations'::regclass
       AND conname = 'conversations_experiment_assignment_fk'
  ) THEN
    ALTER TABLE app.conversations
      ADD CONSTRAINT conversations_experiment_assignment_fk
      FOREIGN KEY (experiment_assignment_id) REFERENCES app.experiment_assignments(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS app.experiment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id uuid NOT NULL REFERENCES app.experiments(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES app.experiment_variants(id) ON DELETE RESTRICT,
  assignment_id uuid NOT NULL,
  prospect_id uuid NOT NULL REFERENCES app.prospects(id) ON DELETE RESTRICT,
  message_id uuid REFERENCES app.email_messages(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN ('assigned','smtp_accepted','human_reply','positive_reply','confirmed_meeting','open','click')),
  event_at timestamptz NOT NULL,
  measured boolean NOT NULL DEFAULT true,
  confidence text NOT NULL DEFAULT 'confirmed' CHECK (confidence IN ('confirmed','probable','noisy','unknown')),
  source text NOT NULL,
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (assignment_id, experiment_id, variant_id, prospect_id)
    REFERENCES app.experiment_assignments(id, experiment_id, variant_id, prospect_id) ON DELETE RESTRICT,
  UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS experiment_events_rollup_idx
  ON app.experiment_events (experiment_id, variant_id, event_type, event_at);

CREATE OR REPLACE FUNCTION app.assign_experiment_variant(
  p_experiment_id uuid,
  p_prospect_id uuid,
  p_step app.sequence_step,
  p_assignment_key text
)
RETURNS app.experiment_assignments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  chosen app.experiment_variants;
  experiment_row app.experiments;
  result app.experiment_assignments;
BEGIN
  IF length(coalesce(p_assignment_key, '')) < 8 THEN
    RAISE EXCEPTION 'invalid_assignment_key' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO experiment_row FROM app.experiments
    WHERE id = p_experiment_id AND status IN ('recruiting','threshold_reached') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'experiment_not_recruiting' USING ERRCODE = 'P0001'; END IF;
  IF NOT EXISTS (SELECT 1 FROM app.campaign_prospects WHERE campaign_id = experiment_row.campaign_id AND prospect_id = p_prospect_id) THEN
    RAISE EXCEPTION 'prospect_not_in_campaign' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_experiment_id::text || coalesce(p_step::text, ''), 95));
  SELECT v.* INTO chosen
  FROM app.experiment_variants v
  LEFT JOIN LATERAL (
    SELECT count(*) AS allocation_count
    FROM app.experiment_assignments a
    WHERE a.variant_id = v.id AND a.assigned_for_step IS NOT DISTINCT FROM p_step
  ) count_by_variant ON true
  WHERE v.experiment_id = p_experiment_id
  ORDER BY (count_by_variant.allocation_count / v.weight) ASC, random()
  LIMIT 1;
  IF chosen.id IS NULL THEN RAISE EXCEPTION 'experiment_has_no_variants' USING ERRCODE = 'P0001'; END IF;

  INSERT INTO app.experiment_assignments
    (experiment_id, variant_id, prospect_id, campaign_id, assigned_for_step, assignment_key)
  VALUES
    (p_experiment_id, chosen.id, p_prospect_id, experiment_row.campaign_id, p_step, p_assignment_key)
  ON CONFLICT (assignment_key) DO NOTHING
  RETURNING * INTO result;
  IF result.id IS NULL THEN SELECT * INTO result FROM app.experiment_assignments WHERE assignment_key = p_assignment_key; END IF;
  RETURN result;
END;
$$;

CREATE TABLE IF NOT EXISTS app.deliverability_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  base_url text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  test_type text NOT NULL CHECK (test_type IN ('authentication','content','placement','blacklist','headers','other')),
  requires_test_email boolean NOT NULL DEFAULT false,
  capabilities jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(capabilities) = 'object'),
  documentation_url text,
  quota_description text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS app.test_inboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  normalized_email text GENERATED ALWAYS AS (app.canonical_email(email)) STORED,
  provider text NOT NULL CHECK (provider IN ('gmail','outlook','yahoo','icloud','custom')),
  enabled boolean NOT NULL DEFAULT true,
  credential_id uuid REFERENCES vault.credentials(id) ON DELETE SET NULL,
  access_verified_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (normalized_email)
);

CREATE TABLE IF NOT EXISTS app.provider_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES app.deliverability_providers(id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('account','address','session','ip','service','period','unknown')),
  scope_value text,
  evidence_level text NOT NULL CHECK (evidence_level IN ('documented','observed','estimated','unknown')),
  limit_count integer CHECK (limit_count IS NULL OR limit_count >= 0),
  window_interval interval,
  refusal_text text,
  blocked_until timestamptz,
  source_url text,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS provider_limits_eligibility_idx
  ON app.provider_limits (provider_id, blocked_until DESC);

CREATE TABLE IF NOT EXISTS app.diagnostic_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES app.deliverability_providers(id) ON DELETE RESTRICT,
  sender_account_id uuid NOT NULL REFERENCES app.gmail_accounts(id) ON DELETE RESTRICT,
  test_inbox_id uuid REFERENCES app.test_inboxes(id) ON DELETE SET NULL,
  status app.diagnostic_status NOT NULL DEFAULT 'requested',
  priority integer NOT NULL DEFAULT 100,
  requested_by_run_id uuid,
  destination_address text,
  requires_email boolean NOT NULL,
  outbox_job_id uuid REFERENCES app.outbox_jobs(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  next_eligible_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  failure_code text,
  failure_detail text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (idempotency_key)
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'app.email_messages'::regclass
       AND conname = 'email_messages_diagnostic_request_fk'
  ) THEN
    ALTER TABLE app.email_messages
      ADD CONSTRAINT email_messages_diagnostic_request_fk
      FOREIGN KEY (diagnostic_request_id) REFERENCES app.diagnostic_requests(id) ON DELETE SET NULL;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS app.diagnostic_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES app.diagnostic_requests(id) ON DELETE CASCADE,
  report_url text,
  source text NOT NULL,
  observed_at timestamptz NOT NULL,
  overall_state text NOT NULL DEFAULT 'insufficient_data' CHECK (overall_state IN ('favorable','normal','watch','confirmed_problem','insufficient_data')),
  raw_summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(raw_summary) = 'object'),
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance) = 'object'),
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (request_id),
  UNIQUE (idempotency_key)
);

CREATE TABLE IF NOT EXISTS app.diagnostic_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES app.diagnostic_reports(id) ON DELETE CASCADE,
  dimension text NOT NULL CHECK (dimension IN ('spf','dkim','dmarc','alignment','content','blacklist','placement','bounce','restriction','warmup','other')),
  status text NOT NULL CHECK (status IN ('pass','warn','fail','unknown','not_applicable')),
  value_text text,
  value_numeric numeric,
  unit text,
  confidence text NOT NULL DEFAULT 'unknown' CHECK (confidence IN ('confirmed','observed','estimated','unknown')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  UNIQUE (report_id, dimension)
);

CREATE TABLE IF NOT EXISTS app.bobwork_connections (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  credential_id uuid REFERENCES vault.credentials(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'unconfigured' CHECK (status IN ('unconfigured','configured','connected','error')),
  last_sync_at timestamptz,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO app.bobwork_connections (singleton) VALUES (true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS app.bobwork_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES app.gmail_accounts(id) ON DELETE CASCADE,
  remote_account_ref text,
  connected boolean,
  warmup_state text NOT NULL DEFAULT 'unknown' CHECK (warmup_state IN ('active','paused','interrupted','inactive','unknown')),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object'),
  anomalies jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(anomalies) = 'array'),
  source text NOT NULL DEFAULT 'bobwork_api',
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS bobwork_snapshots_latest_idx
  ON app.bobwork_snapshots (account_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS app.incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES app.gmail_accounts(id) ON DELETE CASCADE,
  severity app.incident_severity NOT NULL,
  title text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
  source text NOT NULL CHECK (source IN ('manual','automatic','agent')),
  protective_pause_applied boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  review_at timestamptz,
  resolved_at timestamptz,
  resolution text,
  created_by_run_id uuid
);
CREATE INDEX IF NOT EXISTS incidents_open_idx ON app.incidents (severity, started_at DESC) WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS app.tracking_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES app.email_messages(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('open','click')),
  target_url text,
  observed_at timestamptz NOT NULL,
  scanner_likelihood numeric(5,4) CHECK (scanner_likelihood IS NULL OR scanner_likelihood BETWEEN 0 AND 1),
  counted boolean NOT NULL DEFAULT false,
  request_fingerprint text,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (idempotency_key)
);

CREATE TABLE IF NOT EXISTS audit.agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_type text NOT NULL CHECK (agent_type IN ('prospection','deliverability')),
  external_run_id text,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','partial','failed')),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  idempotency_key text NOT NULL,
  error_code text,
  UNIQUE (agent_type, idempotency_key)
);

CREATE TABLE IF NOT EXISTS audit.event_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type text NOT NULL CHECK (actor_type IN ('user','backend','prospection_agent','deliverability_agent','system')),
  actor_id text,
  correlation_id uuid,
  event_type text NOT NULL,
  entity_type text,
  entity_id text,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  CHECK (before_state IS NULL OR jsonb_typeof(before_state) = 'object'),
  CHECK (after_state IS NULL OR jsonb_typeof(after_state) = 'object')
);
CREATE INDEX IF NOT EXISTS event_log_entity_idx ON audit.event_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS event_log_correlation_idx ON audit.event_log (correlation_id) WHERE correlation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION audit.forbid_event_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'audit_log_is_append_only' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS immutable_event_log ON audit.event_log;
CREATE TRIGGER immutable_event_log BEFORE UPDATE OR DELETE ON audit.event_log
FOR EACH ROW EXECUTE FUNCTION audit.forbid_event_mutation();

CREATE TABLE IF NOT EXISTS app.import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_filename text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  source_kind text NOT NULL DEFAULT 'v53_csv' CHECK (source_kind IN ('v53_csv','v53_localstorage_json')),
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','previewed','committing','completed','failed','rolled_back')),
  row_count integer NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  valid_row_count integer NOT NULL DEFAULT 0 CHECK (valid_row_count >= 0),
  invalid_row_count integer NOT NULL DEFAULT 0 CHECK (invalid_row_count >= 0),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  committed_at timestamptz,
  UNIQUE (source_sha256)
);

CREATE TABLE IF NOT EXISTS app.import_campaign_mappings (
  batch_id uuid NOT NULL REFERENCES app.import_batches(id) ON DELETE RESTRICT,
  source_target text NOT NULL,
  campaign_id uuid NOT NULL REFERENCES app.campaigns(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (batch_id, source_target),
  UNIQUE (campaign_id)
);

CREATE TABLE IF NOT EXISTS app.import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES app.import_batches(id) ON DELETE RESTRICT,
  row_number integer NOT NULL CHECK (row_number > 0),
  row_sha256 text NOT NULL CHECK (row_sha256 ~ '^[a-f0-9]{64}$'),
  -- Les vingt colonnes de l'export historique sont conservées sans perte.
  cible text,
  prospect text,
  site_internet text,
  contact_ou_lien_envoi text,
  statut text,
  date_heure_dernier_envoi text,
  id_gmail text,
  etape text,
  objet_personnalise text,
  message_personnalise text,
  r1_j3 text,
  r2_j7 text,
  r3_j7 text,
  r4_j14 text,
  r5_j14 text,
  cle_contact text,
  nb_meme_contact text,
  dans_blacklist text,
  deja_contacte text,
  controle_anti_doublon text,
  parsed_last_sent_at timestamptz,
  parsed_duplicate_count integer,
  parsed_blacklisted boolean,
  parsed_already_contacted boolean,
  normalized_contact text,
  contact_kind text CHECK (contact_kind IN ('email','url','other')),
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(validation_errors) = 'array'),
  mapped_campaign_id uuid REFERENCES app.campaigns(id) ON DELETE SET NULL,
  mapped_prospect_id uuid REFERENCES app.prospects(id) ON DELETE SET NULL,
  committed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (batch_id, row_number),
  UNIQUE (batch_id, row_sha256)
);
CREATE INDEX IF NOT EXISTS import_rows_batch_validation_idx ON app.import_rows (batch_id, committed_at) INCLUDE (validation_errors);

CREATE TABLE IF NOT EXISTS app.historical_sequence_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_row_id uuid NOT NULL REFERENCES app.import_rows(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES app.import_batches(id) ON DELETE RESTRICT,
  campaign_id uuid NOT NULL REFERENCES app.campaigns(id) ON DELETE RESTRICT,
  prospect_id uuid NOT NULL REFERENCES app.prospects(id) ON DELETE RESTRICT,
  legacy_gmail_id text,
  declared_status text,
  declared_step text,
  declared_last_sent_at timestamptz,
  subject text,
  j0_body text,
  r1_body text,
  r2_body text,
  r3_body text,
  r4_body text,
  r5_body text,
  declared_already_contacted boolean,
  declared_blacklisted boolean,
  duplicate_key text,
  duplicate_count integer,
  anti_duplicate_control text,
  technically_confirmed boolean NOT NULL DEFAULT false CHECK (NOT technically_confirmed),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (import_row_id)
);

CREATE OR REPLACE FUNCTION app.commit_import_batch(p_batch_id uuid, p_actor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  source_row app.import_rows;
  batch_uuid uuid;
  campaign_uuid uuid;
  prospect_uuid uuid;
  target_key text;
  generated_campaign_name text;
  imported_count integer := 0;
  rejected_count integer := 0;
BEGIN
  UPDATE app.import_batches
    SET status = 'committing'
    WHERE id = p_batch_id AND status IN ('uploaded','previewed')
    RETURNING id INTO batch_uuid;
  IF batch_uuid IS NULL THEN
    IF EXISTS (SELECT 1 FROM app.import_batches WHERE id = p_batch_id AND status = 'completed') THEN
      RETURN (SELECT summary FROM app.import_batches WHERE id = p_batch_id);
    END IF;
    RAISE EXCEPTION 'import_batch_not_committable' USING ERRCODE = 'P0001';
  END IF;

  FOR source_row IN SELECT * FROM app.import_rows WHERE batch_id = p_batch_id ORDER BY row_number FOR UPDATE
  LOOP
    IF jsonb_array_length(source_row.validation_errors) > 0 OR coalesce(btrim(source_row.contact_ou_lien_envoi), '') = '' THEN
      rejected_count := rejected_count + 1;
      CONTINUE;
    END IF;

    target_key := coalesce(nullif(btrim(source_row.cible), ''), 'Import sans cible');
    SELECT m.campaign_id INTO campaign_uuid
      FROM app.import_campaign_mappings m
     WHERE m.batch_id = p_batch_id AND m.source_target = target_key;
    IF campaign_uuid IS NULL THEN
      generated_campaign_name := left(target_key, 140) || ' · import ' ||
        left(p_batch_id::text, 8) || '-' || left(md5(target_key), 8);
      INSERT INTO app.campaigns (name, status, target_description, imported_disabled)
      VALUES (generated_campaign_name, 'inactive', coalesce(source_row.cible, ''), true)
      ON CONFLICT ((lower(name))) DO NOTHING
      RETURNING id INTO campaign_uuid;
      IF campaign_uuid IS NULL THEN
        SELECT c.id INTO campaign_uuid FROM app.campaigns c
         WHERE lower(c.name) = lower(generated_campaign_name)
           AND c.status = 'inactive' AND c.imported_disabled;
      END IF;
      IF campaign_uuid IS NULL THEN
        RAISE EXCEPTION 'import_campaign_name_conflict' USING ERRCODE = '23505';
      END IF;
      INSERT INTO app.import_campaign_mappings (batch_id, source_target, campaign_id)
      VALUES (p_batch_id, target_key, campaign_uuid)
      ON CONFLICT (batch_id, source_target) DO NOTHING;
    END IF;

    IF source_row.contact_kind = 'email' THEN
      INSERT INTO app.prospects
        (full_name, email, contact_raw, contact_kind, website_url, source_label, source_evidence,
         qualification_state, contact_state)
      VALUES
        (coalesce(source_row.prospect, ''), source_row.normalized_contact, source_row.contact_ou_lien_envoi, 'email',
         source_row.site_internet, 'Import V53', jsonb_build_object('batch_id', p_batch_id, 'row', source_row.row_number),
         'needs_review', CASE WHEN source_row.parsed_blacklisted THEN 'do_not_contact'::app.contact_state
                              WHEN source_row.parsed_already_contacted THEN 'contacted'::app.contact_state
                              ELSE 'never_contacted'::app.contact_state END)
      ON CONFLICT (normalized_email) WHERE deleted_at IS NULL AND normalized_email IS NOT NULL
      DO UPDATE SET source_evidence = app.prospects.source_evidence || EXCLUDED.source_evidence
      RETURNING id INTO prospect_uuid;
    ELSE
      INSERT INTO app.prospects
        (full_name, email, contact_raw, contact_kind, website_url, source_label, source_evidence, qualification_state)
      VALUES
        (coalesce(source_row.prospect, ''), NULL, source_row.contact_ou_lien_envoi,
         coalesce(source_row.contact_kind, 'other'), source_row.site_internet, 'Import V53',
         jsonb_build_object('batch_id', p_batch_id, 'row', source_row.row_number), 'needs_review')
      RETURNING id INTO prospect_uuid;
    END IF;

    INSERT INTO app.campaign_prospects (campaign_id, prospect_id, state, notes)
    VALUES (campaign_uuid, prospect_uuid,
      CASE WHEN source_row.parsed_blacklisted THEN 'excluded'
           WHEN source_row.parsed_already_contacted THEN 'engaged'
           ELSE 'candidate' END,
      'Import historique : activation manuelle obligatoire')
    ON CONFLICT (campaign_id, prospect_id) DO NOTHING;

    INSERT INTO app.historical_sequence_snapshots
      (import_row_id, batch_id, campaign_id, prospect_id, legacy_gmail_id,
       declared_status, declared_step, declared_last_sent_at, subject,
       j0_body, r1_body, r2_body, r3_body, r4_body, r5_body,
       declared_already_contacted, declared_blacklisted, duplicate_key,
       duplicate_count, anti_duplicate_control)
    VALUES
      (source_row.id, p_batch_id, campaign_uuid, prospect_uuid, source_row.id_gmail,
       source_row.statut, source_row.etape, source_row.parsed_last_sent_at,
       source_row.objet_personnalise, source_row.message_personnalise,
       source_row.r1_j3, source_row.r2_j7, source_row.r3_j7,
       source_row.r4_j14, source_row.r5_j14,
       source_row.parsed_already_contacted, source_row.parsed_blacklisted,
       source_row.cle_contact, source_row.parsed_duplicate_count,
       source_row.controle_anti_doublon)
    ON CONFLICT (import_row_id) DO NOTHING;

    IF source_row.parsed_already_contacted AND source_row.contact_kind = 'email' THEN
      INSERT INTO app.contact_history
        (normalized_email, prospect_id, first_contact_at, confirmation_source, technically_confirmed, source_reference)
      VALUES
        (source_row.normalized_contact, prospect_uuid, source_row.parsed_last_sent_at, 'import_declared', false, source_row.id_gmail)
      ON CONFLICT (normalized_email) DO NOTHING;
    END IF;
    IF source_row.parsed_blacklisted AND source_row.contact_kind = 'email' THEN
      INSERT INTO app.exclusions (match_type, match_value, reason, source, created_by)
      VALUES ('email', source_row.normalized_contact, 'Blacklist historique importée', 'import', p_actor)
      ON CONFLICT (match_type, normalized_value) WHERE revoked_at IS NULL DO NOTHING;
    END IF;

    UPDATE app.import_rows SET mapped_campaign_id = campaign_uuid, mapped_prospect_id = prospect_uuid,
      committed_at = clock_timestamp() WHERE id = source_row.id;
    imported_count := imported_count + 1;
  END LOOP;

  UPDATE app.import_batches
  SET status = 'completed', committed_at = clock_timestamp(),
      summary = jsonb_build_object('imported_rows', imported_count, 'rejected_rows', rejected_count,
        'campaigns_forced_inactive', true, 'outbox_jobs_created', 0)
  WHERE id = p_batch_id;
  RETURN jsonb_build_object('imported_rows', imported_count, 'rejected_rows', rejected_count,
    'campaigns_forced_inactive', true, 'outbox_jobs_created', 0);
END;
$$;

DO $$
DECLARE target regclass;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'app.experiments'::regclass,
    'app.deliverability_providers'::regclass,
    'app.test_inboxes'::regclass,
    'app.diagnostic_requests'::regclass
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS touch_updated_at ON %s', target);
    EXECUTE format('CREATE TRIGGER touch_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', target);
  END LOOP;
END
$$;

INSERT INTO app.schema_migrations (version)
VALUES ('003_experiments_deliverability_imports')
ON CONFLICT (version) DO NOTHING;
