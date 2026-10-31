-- Manual onboarding acknowledgement, independent from observed BobWork data.
ALTER TABLE app.gmail_accounts ADD COLUMN bobwork_setup_confirmed boolean NOT NULL DEFAULT false;
INSERT INTO app.schema_migrations(version) VALUES('037_gmail_bobwork_setup_confirmation') ON CONFLICT(version) DO NOTHING;
