-- Prospection 95 · valeurs de suivi par défaut identiques à la maquette V53.

ALTER TABLE app.campaigns
  ALTER COLUMN tracking_opens_enabled SET DEFAULT true,
  ALTER COLUMN tracking_clicks_enabled SET DEFAULT true;

UPDATE app.campaigns
SET tracking_opens_enabled = true,
    tracking_clicks_enabled = true,
    version = version + 1,
    updated_at = clock_timestamp()
WHERE NOT tracking_opens_enabled OR NOT tracking_clicks_enabled;

INSERT INTO app.schema_migrations (version)
VALUES ('011_v53_tracking_defaults')
ON CONFLICT (version) DO NOTHING;
