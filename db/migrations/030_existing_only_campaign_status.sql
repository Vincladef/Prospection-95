-- Commit this migration before using the new enum value in migration 031.
ALTER TYPE app.campaign_status ADD VALUE IF NOT EXISTS 'existing_only';
INSERT INTO app.schema_migrations(version) VALUES ('030_existing_only_campaign_status')
ON CONFLICT (version) DO NOTHING;
