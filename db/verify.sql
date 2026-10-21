-- Vérifications non destructives à lancer après toutes les migrations.
-- Chaque ligne doit retourner true ou la valeur documentée.

SELECT to_regnamespace('app') IS NOT NULL
   AND to_regnamespace('vault') IS NOT NULL
   AND to_regnamespace('agent_api') IS NOT NULL
   AND to_regnamespace('audit') IS NOT NULL AS all_schemas_exist;

SELECT count(*) = 9 AS all_migrations_registered
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
  '009_campaign_sender_contract'
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

SELECT outbound_enabled = false AND emergency_stop = true AS outbound_is_safe_by_default
FROM app.settings WHERE singleton;

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

SELECT NOT has_table_privilege(
         'prospection95_agent', 'app.agent_prospect_registrations', 'SELECT'
       )
   AND has_function_privilege(
         'prospection95_agent',
         'agent_api.raise_incident(uuid,app.incident_severity,text,jsonb,timestamptz,boolean,uuid,text)',
         'EXECUTE'
       ) AS agent_extensions_are_limited;
