-- Vérifications non destructives à lancer après toutes les migrations.
-- Chaque ligne doit retourner true ou la valeur documentée.

SELECT to_regnamespace('app') IS NOT NULL
   AND to_regnamespace('vault') IS NOT NULL
   AND to_regnamespace('agent_api') IS NOT NULL
   AND to_regnamespace('audit') IS NOT NULL AS all_schemas_exist;

SELECT count(*) = 19 AS all_migrations_registered
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
  '013_application_role_new_resources',
  '014_sequence_progression_and_diagnostics',
  '015_crm_plugin_contract',
  '016_crm_campaign_update',
  '017_crm_campaign_ai_instructions',
  '018_campaign_iteration_workflow',
  '019_prospect_variant_iteration_workflow'
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

SELECT outbound_enabled IS NOT NULL AS outbound_authorization_is_explicit
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

SELECT (
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
   ) AS v53_tracking_defaults_are_enabled;

SELECT NOT has_table_privilege(
         'prospection95_agent', 'app.agent_prospect_registrations', 'SELECT'
       )
   AND has_function_privilege(
         'prospection95_agent',
         'agent_api.raise_incident(uuid,app.incident_severity,text,jsonb,timestamptz,boolean,uuid,text)',
         'EXECUTE'
       ) AS agent_extensions_are_limited;

SELECT to_regclass('app.campaign_iteration_states') IS NOT NULL
   AND to_regclass('app.campaign_iteration_runs') IS NOT NULL
   AND has_table_privilege('prospection95_app', 'app.campaign_iteration_states', 'SELECT')
   AND NOT has_table_privilege('prospection95_app', 'app.campaign_iteration_runs', 'UPDATE')
   AND NOT has_table_privilege('prospection95_agent', 'app.campaign_iteration_runs', 'SELECT')
   AND has_table_privilege('prospection95_agent', 'agent_api.pending_campaign_iterations', 'SELECT')
   AND has_table_privilege('prospection95_agent', 'agent_api.campaign_iteration_history', 'SELECT')
   AS campaign_iteration_storage_is_private;

SELECT NOT has_function_privilege(
         'prospection95_agent',
         'agent_api.claim_campaign_iteration(uuid,uuid,text)',
         'EXECUTE'
       )
   AND NOT has_function_privilege(
         'prospection95_agent',
         'agent_api.complete_campaign_iteration(uuid,uuid,jsonb,text)',
         'EXECUTE'
       )
   AND NOT has_function_privilege(
         'prospection95_agent',
         'agent_api.fail_campaign_iteration(uuid,uuid,text)',
         'EXECUTE'
       ) AS campaign_iteration_agent_contract_is_retired;

SELECT NOT EXISTS (SELECT 1 FROM agent_api.pending_campaign_iterations)
   AS campaign_level_iteration_queue_is_retired;

SELECT to_regclass('app.prospect_iteration_states') IS NOT NULL
   AND to_regclass('app.prospect_iteration_runs') IS NOT NULL
   AND has_table_privilege('prospection95_app', 'app.prospect_iteration_states', 'SELECT')
   AND NOT has_table_privilege('prospection95_app', 'app.prospect_iteration_runs', 'UPDATE')
   AND NOT has_table_privilege('prospection95_agent', 'app.prospect_iteration_runs', 'SELECT')
   AND has_table_privilege('prospection95_agent', 'agent_api.prospect_iteration_progress', 'SELECT')
   AND has_table_privilege('prospection95_agent', 'agent_api.prospect_iteration_history', 'SELECT')
   AS prospect_variant_iteration_storage_is_private;

SELECT has_function_privilege(
         'prospection95_runtime',
         'agent_api.assign_prospect_variant(uuid,uuid,uuid,text)',
         'EXECUTE'
       )
   AND has_function_privilege(
         'prospection95_runtime',
         'agent_api.claim_prospect_iteration(uuid,uuid,uuid,uuid,text)',
         'EXECUTE'
       )
   AND has_function_privilege(
         'prospection95_runtime',
         'agent_api.complete_prospect_iteration(uuid,uuid,jsonb,text)',
         'EXECUTE'
       )
   AND has_function_privilege(
         'prospection95_runtime',
         'agent_api.fail_prospect_iteration(uuid,uuid,text)',
         'EXECUTE'
       )
   AND has_function_privilege(
         'prospection95_runtime',
         'agent_api.propose_completed_sequence(uuid,uuid,uuid,text)',
         'EXECUTE'
       )
   AND NOT has_function_privilege(
         'prospection95_runtime',
         'agent_api.propose_sequence(uuid,uuid,uuid,text,jsonb,uuid,text)',
         'EXECUTE'
       )
   AND pg_has_role('prospection95_runtime', 'prospection95_agent', 'member')
   AS runtime_has_controlled_commercial_agent_contract;
