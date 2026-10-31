-- Vérifications non destructives à lancer après toutes les migrations.
-- Chaque ligne doit retourner true ou la valeur documentée.

SELECT to_regprocedure('app.reply_source_is_first_exchange(uuid)') IS NOT NULL
  AND to_regprocedure('app.reply_attachment_context(uuid,uuid)') IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM app.campaigns WHERE reply_instructions<>'')
  AND position('reply_auto_scope' IN pg_get_functiondef('app.reply_job_is_ready(uuid)'::regprocedure))>0
  AS reply_scope_and_unified_instructions_available;

SELECT EXISTS(SELECT 1 FROM pg_enum WHERE enumtypid='app.campaign_status'::regtype AND enumlabel='existing_only')
  AND position('existing_only' IN pg_get_functiondef('app.schedule_due_messages(integer)'::regprocedure)) > 0
  AND position('existing_only' IN pg_get_functiondef('app.lease_outbox_jobs(text,integer,integer)'::regprocedure)) > 0
  AND position('existing_only' IN pg_get_functiondef('agent_api.claim_prospect_iteration(uuid,uuid,uuid,uuid,text)'::regprocedure)) > 0
  AND position('existing_only' IN pg_get_functiondef('agent_api.register_prospect(uuid,text,text,text,text,text,text,text,jsonb,numeric,text,uuid,text)'::regprocedure)) = 0
  AS existing_only_keeps_workflow_without_registration;

SELECT to_regnamespace('app') IS NOT NULL
   AND to_regnamespace('vault') IS NOT NULL
   AND to_regnamespace('agent_api') IS NOT NULL
   AND to_regnamespace('audit') IS NOT NULL AS all_schemas_exist;

SELECT count(*) = 38 AS all_migrations_registered
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
  '019_prospect_variant_iteration_workflow',
  '020_register_prospect_conflict_target',
  '021_targeted_reliability_fixes',
  '022_sequence_validation_and_send_distribution',
  '023_final_prospecting_cycle',
  '024_structured_campaign_editing',
  '025_extended_writing_iterations',
  '026_flexible_experiment_populations',
  '027_crm_pending_sequence_revisions',
  '028_crm_sequence_view_permissions',
  '029_crm_general_writing_instructions',
  '030_existing_only_campaign_status',
  '031_existing_only_campaign_workflow',
  '032_reply_iteration_workflow',
  '033_reply_dispatch_guards',
  '034_reply_campaign_settings',
  '035_live_sent_reply_safety',
  '036_reply_scope_and_unified_instructions',
  '037_gmail_bobwork_setup_confirmation',
  '038_deliverability_decisions'
);

SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema='app' AND table_name='campaigns'
           AND column_name='writing_iteration_instructions'
       )
   AND has_function_privilege('prospection95_crm','crm_api.crm_campaign_create_v2(jsonb,text)','EXECUTE')
   AND has_function_privilege('prospection95_crm','crm_api.crm_campaign_update(uuid,bigint,jsonb)','EXECUTE')
   AND has_function_privilege('prospection95_crm','crm_api.crm_experiment_save(uuid,bigint,uuid,jsonb,text)','EXECUTE')
   AND has_table_privilege('prospection95_crm','crm_api.campaigns','SELECT')
   AND has_table_privilege('prospection95_crm','crm_api.experiments','SELECT')
   AND has_function_privilege('prospection95_runtime','agent_api.assign_prospect_variant_v2(uuid,uuid,uuid,uuid,text)','EXECUTE')
   AS structured_campaign_editor_is_available;

SELECT (
         SELECT pg_get_constraintdef(oid)
         FROM pg_constraint
         WHERE conrelid='app.campaigns'::regclass
           AND conname='campaigns_writing_iterations_check'
       ) LIKE '%<= 100%'
   AND pg_get_functiondef('app.effective_variant_sequence(uuid,uuid)'::regprocedure)
         ILIKE '%between 1 and 100%'
   AND pg_get_functiondef('crm_api.crm_campaign_create_v2(jsonb,text)'::regprocedure)
         ILIKE '%between 1 and 100%'
   AND pg_get_functiondef('crm_api.crm_campaign_update(uuid,bigint,jsonb)'::regprocedure)
         ILIKE '%between 1 and 100%'
   AS extended_writing_iterations_are_available;

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

SELECT position(
         'ON CONFLICT ON CONSTRAINT campaign_prospects_pkey'
         IN pg_get_functiondef(
           'agent_api.register_prospect(uuid,text,text,text,text,text,text,text,jsonb,numeric,text,uuid,text)'::regprocedure
         )
       ) > 0
   AND has_function_privilege(
         'prospection95_runtime',
         'agent_api.register_prospect(uuid,text,text,text,text,text,text,text,jsonb,numeric,text,uuid,text)',
         'EXECUTE'
       )
   AS prospect_registration_conflict_target_is_unambiguous;

SELECT to_regclass('app.campaign_prospects_one_active_campaign_uq') IS NOT NULL
   AND to_regclass('app.outbox_one_active_j0_per_prospect_uq') IS NOT NULL
   AS cross_campaign_j0_guards_are_installed;

SELECT attnotnull
   AND atttypid = 'text'::regtype
   AS writing_input_hash_is_persistent
FROM pg_attribute
WHERE attrelid = 'app.prospect_iteration_states'::regclass
  AND attname = 'writing_input_hash'
  AND NOT attisdropped;

SELECT has_table_privilege(
         'prospection95_agent',
         'agent_api.experiment_metrics',
         'SELECT'
       )
   AND has_table_privilege(
         'prospection95_app',
         'agent_api.experiment_metrics',
         'SELECT'
       )
   AS direct_experiment_metrics_are_available;

SELECT has_function_privilege(
         'prospection95_app',
         'app.next_account_send_at(uuid,timestamptz,text)',
         'EXECUTE'
       )
   AND NOT has_function_privilege(
         'prospection95_agent',
         'app.next_account_send_at(uuid,timestamptz,text)',
         'EXECUTE'
       )
   AND position(
         'app.next_account_send_at'
         IN pg_get_functiondef('app.schedule_due_messages(integer)'::regprocedure)
       ) > 0
   AS variable_send_distribution_is_active;

SELECT has_function_privilege('prospection95_runtime', 'agent_api.activate_experiment(uuid,uuid,text)', 'EXECUTE')
   AND has_function_privilege('prospection95_runtime', 'agent_api.advance_experiment(uuid,uuid,text)', 'EXECUTE')
   AND has_function_privilege('prospection95_runtime', 'agent_api.conclude_experiment(uuid,uuid,text,text,uuid,text)', 'EXECUTE')
   AND NOT has_function_privilege('prospection95_agent', 'app.select_campaign_sender(uuid,uuid,uuid)', 'EXECUTE')
   AND has_function_privilege('prospection95_app', 'app.select_campaign_sender(uuid,uuid,uuid)', 'EXECUTE')
   AS autonomous_experiment_and_sender_contract_is_available;

SELECT has_function_privilege(
         'prospection95_runtime',
         'agent_api.assign_prospect_variant_v2(uuid,uuid,uuid,uuid,text)',
         'EXECUTE'
       )
   AND pg_get_functiondef(
         'agent_api.assign_prospect_variant_v2(uuid,uuid,uuid,uuid,text)'::regprocedure
       ) NOT ILIKE '%requested_variant_not_allowed_for_random_test%'
   AND pg_get_functiondef(
         'agent_api.assign_prospect_variant_v2(uuid,uuid,uuid,uuid,text)'::regprocedure
       ) ILIKE '%selectionMode%'
   AS experiment_population_metadata_is_non_blocking;

SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'app' AND table_name = 'experiments'
            AND column_name = 'winner_variant_id'
       )
   AND position('permanentBounce' IN pg_get_functiondef('app.stop_followups_on_inbound()'::regprocedure)) > 0
   AND position('permanent_bounce' IN pg_get_functiondef('app.stop_followups_on_inbound()'::regprocedure)) > 0
   AS permanent_bounce_and_experiment_winner_are_persistent;

SELECT to_regclass('app.experiments_one_open_per_campaign_uq') IS NOT NULL
   AND NOT EXISTS (
     SELECT campaign_id FROM app.experiments
      WHERE status IN ('recruiting','threshold_reached','awaiting_observations','mature')
      GROUP BY campaign_id HAVING count(*) > 1
   ) AS one_open_experiment_per_campaign_is_enforced;

SELECT has_table_privilege('prospection95_crm','crm_api.pending_sequences','SELECT')
   AND has_function_privilege('prospection95_crm','crm_api.crm_pending_sequence_revise(uuid,uuid,bigint,jsonb)','EXECUTE')
   AND has_function_privilege('prospection95_app','crm_api.crm_pending_sequence_revise(uuid,uuid,bigint,jsonb)','EXECUTE')
   AND NOT has_table_privilege('prospection95_crm','app.email_messages','UPDATE')
   AS individual_sequence_editor_is_available;

SET LOCAL ROLE prospection95_crm;
SELECT count(*) >= 0 AS crm_can_read_pending_sequences FROM crm_api.pending_sequences;
RESET ROLE;

SET LOCAL ROLE prospection95_crm;
SELECT count(*)=1 AS crm_can_read_writing_settings FROM crm_api.writing_settings;
RESET ROLE;
SELECT has_function_privilege('prospection95_crm','crm_api.crm_writing_instructions_update(bigint,text)','EXECUTE')
 AND NOT has_table_privilege('prospection95_crm','app.settings','UPDATE') AS crm_writing_access_is_limited;

SELECT to_regclass('agent_api.pending_reply_iterations') IS NOT NULL
 AND to_regprocedure('agent_api.claim_reply_iteration(uuid,uuid,text)') IS NOT NULL
 AND has_function_privilege('prospection95_agent','agent_api.complete_reply_iteration(uuid,uuid,text,text,text)','EXECUTE')
 AND NOT has_function_privilege('prospection95_agent','agent_api.propose_reply_draft(uuid,text,text,text)','EXECUTE')
 AND NOT has_table_privilege('prospection95_agent','app.reply_workflows','INSERT') AS reply_iteration_contract_is_guarded;

SELECT to_regclass('agent_api.account_volume_policy') IS NOT NULL AND
 has_function_privilege('prospection95_agent','agent_api.decide_account_volume(uuid,uuid,text,integer,numeric,text,jsonb,uuid,text)','EXECUTE') AND
 NOT has_table_privilege('prospection95_agent','app.deliverability_decisions','INSERT') AS deliverability_decisions_are_guarded;
