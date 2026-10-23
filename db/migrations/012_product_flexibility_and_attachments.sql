-- Prospection 95 · pièces jointes d'instructions et lecture BobWork étendue.

CREATE TABLE IF NOT EXISTS app.instruction_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL CHECK (scope_type IN ('global', 'campaign')),
  campaign_id uuid REFERENCES app.campaigns(id) ON DELETE CASCADE,
  field_key text NOT NULL CHECK (field_key ~ '^[a-z0-9:_/-]{1,180}$'),
  filename text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 0 AND 8388608),
  blob_key text NOT NULL UNIQUE,
  extracted_text text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  CHECK (
    (scope_type = 'global' AND campaign_id IS NULL)
    OR (scope_type = 'campaign' AND campaign_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS instruction_attachments_lookup_idx
  ON app.instruction_attachments (scope_type, campaign_id, field_key, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS app.bobwork_api_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  resource text NOT NULL CHECK (resource IN ('stats', 'domains')),
  payload jsonb NOT NULL,
  source_url text NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (resource, observed_at)
);

CREATE INDEX IF NOT EXISTS bobwork_api_snapshots_latest_idx
  ON app.bobwork_api_snapshots (resource, observed_at DESC);

CREATE OR REPLACE VIEW agent_api.instruction_attachments
WITH (security_barrier = true)
AS
SELECT
  a.id AS attachment_id,
  a.scope_type,
  a.campaign_id,
  c.name AS campaign_name,
  a.field_key,
  a.filename,
  a.content_type,
  a.size_bytes,
  a.extracted_text,
  a.created_at
FROM app.instruction_attachments a
LEFT JOIN app.campaigns c ON c.id = a.campaign_id
WHERE a.deleted_at IS NULL;

CREATE OR REPLACE VIEW agent_api.bobwork_latest_resources
WITH (security_barrier = true)
AS
SELECT DISTINCT ON (s.resource)
  s.resource,
  s.payload,
  s.source_url,
  s.observed_at
FROM app.bobwork_api_snapshots s
ORDER BY s.resource, s.observed_at DESC;

CREATE OR REPLACE VIEW agent_api.account_restrictions
WITH (security_barrier = true)
AS
SELECT
  a.id AS account_id,
  a.email,
  a.status,
  a.daily_limit,
  a.warmup_daily_limit,
  a.send_days,
  a.send_start,
  a.send_end,
  a.timezone,
  a.paused_at,
  a.pause_source,
  a.pause_reason,
  a.review_at,
  a.smtp_verified_at,
  a.imap_verified_at,
  bw.warmup_state,
  bw.observed_at AS bobwork_observed_at,
  incident.severity AS active_incident_severity,
  incident.title AS active_incident_title,
  bw.connected AS bobwork_connected,
  bw.metrics AS bobwork_metrics
FROM app.gmail_accounts a
LEFT JOIN LATERAL (
  SELECT b.warmup_state, b.observed_at, b.connected, b.metrics
  FROM app.bobwork_snapshots b
  WHERE b.account_id = a.id ORDER BY b.observed_at DESC LIMIT 1
) bw ON true
LEFT JOIN LATERAL (
  SELECT i.severity, i.title
  FROM app.incidents i
  WHERE i.account_id = a.id AND i.resolved_at IS NULL
  ORDER BY i.severity DESC, i.started_at DESC LIMIT 1
) incident ON true
WHERE a.deleted_at IS NULL;

GRANT SELECT ON agent_api.instruction_attachments TO prospection95_agent;
GRANT SELECT ON agent_api.bobwork_latest_resources TO prospection95_agent;

INSERT INTO app.schema_migrations (version)
VALUES ('012_product_flexibility_and_attachments')
ON CONFLICT (version) DO NOTHING;
