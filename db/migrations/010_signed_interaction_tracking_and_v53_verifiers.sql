-- Prospection 95 · suivi signé des interactions et catalogue V53 de délivrabilité.

-- La structure de base existe depuis la migration 003. Ces colonnes permettent
-- de consolider les appels répétés sans conserver l'adresse IP ni l'agent brut.
ALTER TABLE app.tracking_events
  ADD COLUMN IF NOT EXISTS last_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS observation_count integer NOT NULL DEFAULT 1 CHECK (observation_count > 0),
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object');

UPDATE app.tracking_events
SET last_observed_at = observed_at
WHERE last_observed_at IS NULL;

ALTER TABLE app.tracking_events
  ALTER COLUMN last_observed_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN last_observed_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS tracking_events_message_observed_idx
  ON app.tracking_events (message_id, event_type, observed_at);

REVOKE ALL ON TABLE app.tracking_events FROM PUBLIC, prospection95_agent;
GRANT SELECT, INSERT, UPDATE ON TABLE app.tracking_events TO prospection95_app;

INSERT INTO app.deliverability_providers
  (name, base_url, enabled, test_type, requires_test_email, capabilities, quota_description)
VALUES
  ('Mail-Tester', 'https://mail-tester.com/', true, 'content', true,
   '{"builtIn":true,"catalogOrder":1,"uiCapability":"Antispam · 3 tests gratuits / 24 h"}'::jsonb,
   '3 tests gratuits / 24 h'),
  ('Unspam.email', 'https://unspam.email/', true, 'placement', true,
   '{"builtIn":true,"catalogOrder":2,"uiCapability":"Antispam + placement · quotas mensuels"}'::jsonb,
   'Quotas mensuels'),
  ('MailGenius', 'https://www.mailgenius.com/', true, 'content', true,
   '{"builtIn":true,"catalogOrder":3,"uiCapability":"Antispam · 3 essais gratuits annoncés"}'::jsonb,
   '3 essais gratuits annoncés'),
  ('EXPERTE / IsNotSpam', 'https://www.experte.com/spam-checker', true, 'content', true,
   '{"builtIn":true,"catalogOrder":4,"uiCapability":"Antispam · accès gratuit sans inscription"}'::jsonb,
   'Accès gratuit sans inscription'),
  ('AboutMy.email', 'https://aboutmy.email/', true, 'authentication', true,
   '{"builtIn":true,"catalogOrder":5,"uiCapability":"Authentification et structure · sans compte"}'::jsonb,
   'Sans compte'),
  ('MxToolbox', 'https://mxtoolbox.com/deliverability', true, 'headers', false,
   '{"builtIn":true,"catalogOrder":6,"uiCapability":"Entêtes, SPF, DKIM, listes noires"}'::jsonb,
   'Accès selon les outils publics disponibles'),
  ('InboxAlly · spam', 'https://www.inboxally.com/email-spam-checker', true, 'content', true,
   '{"builtIn":true,"catalogOrder":7,"uiCapability":"Antispam · accès gratuit sans compte"}'::jsonb,
   'Accès gratuit sans compte'),
  ('InboxAlly · placement', 'https://www.inboxally.com/email-placement-tester', true, 'placement', true,
   '{"builtIn":true,"catalogOrder":8,"uiCapability":"Placement · 1 test gratuit / jour annoncé"}'::jsonb,
   '1 test gratuit / jour annoncé'),
  ('Warmup Inbox · placement', 'https://www.warmupinbox.com/tools/email-deliverability-test/', true, 'placement', true,
   '{"builtIn":true,"catalogOrder":9,"uiCapability":"Placement · test gratuit sans compte"}'::jsonb,
   'Test gratuit sans compte'),
  ('EasyDMARC · placement', 'https://easydmarc.com/tools/email-deliverability-test', true, 'placement', true,
   '{"builtIn":true,"catalogOrder":10,"uiCapability":"Placement · essai gratuit"}'::jsonb,
   'Essai gratuit'),
  ('GlockApps', 'https://glockapps.com/', true, 'placement', true,
   '{"builtIn":true,"catalogOrder":11,"uiCapability":"Placement · essais gratuits initiaux, compte requis"}'::jsonb,
   'Essais gratuits initiaux, compte requis'),
  ('Postmark Spamcheck', 'https://spamcheck.postmarkapp.com/', true, 'content', false,
   '{"builtIn":true,"catalogOrder":12,"uiCapability":"Analyse SpamAssassin · API gratuite"}'::jsonb,
   'API gratuite'),
  ('Mailtest.me', 'https://mailtest.me/', true, 'content', true,
   '{"builtIn":true,"catalogOrder":13,"uiCapability":"Délivrabilité · 1 test gratuit / jour annoncé"}'::jsonb,
   '1 test gratuit / jour annoncé'),
  ('MailReach', 'https://www.mailreach.co/email-spam-test', true, 'placement', true,
   '{"builtIn":true,"catalogOrder":14,"uiCapability":"Placement, authentification · accès à qualifier"}'::jsonb,
   'Accès à qualifier lors de l’utilisation'),
  ('BillionVerify', 'https://billionverify.com/email-deliverability-test', true, 'content', true,
   '{"builtIn":true,"catalogOrder":15,"uiCapability":"Antispam, DNS, liens · essai gratuit"}'::jsonb,
   'Essai gratuit'),
  ('CaptainDNS', 'https://www.captaindns.com/en/tools/email-authentication/mail-tester', true, 'authentication', true,
   '{"builtIn":true,"catalogOrder":16,"uiCapability":"Authentification et score · sans compte"}'::jsonb,
   'Sans compte')
ON CONFLICT (name) DO UPDATE SET
  base_url = EXCLUDED.base_url,
  enabled = true,
  test_type = EXCLUDED.test_type,
  requires_test_email = EXCLUDED.requires_test_email,
  capabilities = app.deliverability_providers.capabilities || EXCLUDED.capabilities,
  quota_description = EXCLUDED.quota_description,
  updated_at = clock_timestamp();

INSERT INTO app.schema_migrations (version)
VALUES ('010_signed_interaction_tracking_and_v53_verifiers')
ON CONFLICT (version) DO NOTHING;
