-- Prospection 95 · accès backend aux ressources créées après la migration 005.

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE app.instruction_attachments, app.bobwork_api_snapshots
  TO prospection95_app;

GRANT USAGE, SELECT
  ON SEQUENCE app.bobwork_api_snapshots_id_seq
  TO prospection95_app;

-- Les prochaines tables applicatives doivent être immédiatement utilisables par
-- le backend Netlify, sans réexécuter manuellement la migration des permissions.
ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO prospection95_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO prospection95_app;

INSERT INTO app.schema_migrations (version)
VALUES ('013_application_role_new_resources')
ON CONFLICT (version) DO NOTHING;
