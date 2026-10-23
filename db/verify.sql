-- Vérifications non destructives à lancer après toutes les migrations.
-- Chaque ligne doit retourner true ou la valeur documentée.

SELECT to_regnamespace('app') IS NOT NULL
   AND to_regnamespace('vault') IS NOT NULL
   AND to_regnamespace('agent_api') IS NOT NULL
   AND to_regnamespace('audit') IS NOT NULL AS all_schemas_exist;

SELECT count(*) = 13 AS all_migrations_registered
FROM app.schema_migrations
WHERE version IN (
  '001_foundation',
  '002_messaging',
  '003_experiments_deliverability_imports',
  '004_agent_contract',
  '005_permissions',
  '006_agent_operations',
  '007_sequence_scheduler',
  '008_sent_mail_reconciliation',
  '009_campaign_sender_contract',
  '010_signed_interaction_tracking_and_v53_verifiers',
  '011_v53_tracking_defaults',
  '012_product_flexibility_and_attachments',
  '013_application_role_new_resources'
);

SELECT NOT has_schema_privilege('prospection95_agent', 'vault', 'USAGE')
   AND NOT has_table_privilege('prospection95_agent', 'vault.credentials', 'SELECT')
   AND NOT has_table_privilege('prospection95_agent', 'app.outbox_jobs', 'UPDATE')
   AND NOT has_function_privilege(
     'prospection95_agent',
     'app.confirm_smtp_acceptance(uuid,uuid,text,timestamptz)',
     'EXECUTE'
   ) AS agent_cannot_reach_privileged_state;

SELECT has_table_privilege('prospection95_agent', 'agent_api.campaign_parameters', 'SELECT')
   AND has_table_privilege('prospection95_agent', 'agent_api.unanalyzed_responses', 'SELECT')
   AND has_function_privilege(
     'prospection95_agent',
     'agent_api.reserve_prospect(uuid,uuid,uuid,text)',
     'EXECUTE'
   )
   AND has_function_privilege(
     'prospection95_agent',
     'agent_api.register_prospect(uuid,text,text,text,text,text,text,text,jsonb,numeric,text,uuid,text)',
     'EXECUTE'
   ) AS agent_contract_is_available;

SELECT outbound_enabled = false AS outbound_is_guarded_by_server_configuration
FROM app.settings WHERE singleton;

SELECT to_regclass('app.instruction_attachments') IS NOT NULL
   AND to_regclass('app.bobwork_api_snapshots') IS NOT NULL
   AND has_table_privilege('prospection95_agent', 'agent_api.instruction_attachments', 'SELECT')
   AND has_table_privilege('prospection95_agent', 'agent_api.bobwork_latest_resources', 'SELECT')
   AND NOT has_table_privilege('prospection95_agent', 'app.instruction_attachments', 'SELECT')
   AS product_flexibility_contract_is_available;

SELECT has_table_privilege('prospection95_app', 'app.instruction_attachments', 'SELECT,INSERT,UPDATE,DELETE')
   AND has_table_privilege('prospection95_app', 'app.bobwork_api_snapshots', 'SELECT,INSERT,UPDATE,DELETE')
   AND has_sequence_privilege('prospection95_app', 'app.bobwork_api_snapshots_id_seq', 'USAGE,SELECT')
   AS application_role_can_use_product_flexibility_objects;

SELECT NOT EXISTS (
  SELECT 1
  FROM information_schema.columns
  WHERE table_schema = 'agent_api'
    AND column_name IN ('ciphertext','nonce','auth_tag','credential_id')
) AS agent_views_do_not_expose_vault_material;

SELECT count(*) = 20 AS v53_csv_columns_are_preserved
FROM information_schema.columns
WHERE table_schema = 'app'
  AND table_name = 'import_rows'
  AND column_name IN (
    'cible','prospect','site_internet','contact_ou_lien_envoi','statut',
    'date_heure_dernier_envoi','id_gmail','etape','objet_personnalise',
    'message_personnalise','r1_j3','r2_j7','r3_j7','r4_j14','r5_j14',
    'cle_contact','nb_meme_contact','dans_blacklist','deja_contacte',
    'controle_anti_doublon'
  );

SELECT NOT EXISTS (
  SELECT 1 FROM app.outbox_jobs
  WHERE status IN ('pending','scheduled','reserved','running')
) AS migration_created_no_outbound_work;

SELECT to_regclass('app.tracking_events') IS NOT NULL
   AND has_table_privilege('prospection95_app', 'app.tracking_events', 'INSERT')
   AND NOT has_table_privilege('prospection95_agent', 'app.tracking_events', 'SELECT')
   AND EXISTS (
     SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'tracking_events'
       AND column_name = 'observation_count' AND is_nullable = 'NO'
   )
   AS signed_tracking_storage_is_private;

SELECT count(*) = 16
   AND bool_and(enabled)
   AS v53_deliverability_catalog_is_present
FROM app.deliverability_providers
WHERE coalesce((capabilities ->> 'builtIn')::boolean, false);

SELECT coalesce(bool_and(tracking_opens_enabled AND tracking_clicks_enabled), true)
   AND (
     SELECT column_default = 'true'
     FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'campaigns'
       AND column_name = 'tracking_opens_enabled'
   )
   AND (
     SELECT column_default = 'true'
     FROM information_schema.columns
     WHERE table_schema = 'app' AND table_name = 'campaigns'
       AND column_name = 'tracking_clicks_enabled'
   ) AS v53_tracking_defaults_are_enabled
FROM app.campaigns;

SELECT NOT has_table_privilege(
         'prospection95_agent', 'app.agent_prospect_registrations', 'SELECT'
       )
   AND has_function_privilege(
         'prospection95_agent',
         'agent_api.raise_incident(uuid,app.incident_severity,text,jsonb,timestamptz,boolean,uuid,text)',
         'EXECUTE'
       ) AS agent_extensions_are_limited;
