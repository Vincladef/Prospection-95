-- Prospection 95 · allow long editorial workflows without changing their
-- one-pass-per-run semantics. One hundred is a product safety ceiling, not a
-- scheduling batch size: every prospect/variant still advances one pass at a time.

ALTER TABLE app.campaigns
  DROP CONSTRAINT IF EXISTS campaigns_writing_iterations_check,
  ADD CONSTRAINT campaigns_writing_iterations_check
    CHECK (cardinality(writing_iteration_instructions) BETWEEN 1 AND 100);

ALTER TABLE app.campaign_iteration_states
  DROP CONSTRAINT IF EXISTS campaign_iteration_states_iteration_instructions_check,
  DROP CONSTRAINT IF EXISTS campaign_iteration_states_total_iterations_check,
  ADD CONSTRAINT campaign_iteration_states_iteration_instructions_check
    CHECK (cardinality(iteration_instructions) BETWEEN 1 AND 100),
  ADD CONSTRAINT campaign_iteration_states_total_iterations_check
    CHECK (total_iterations BETWEEN 1 AND 100);

ALTER TABLE app.campaign_iteration_runs
  DROP CONSTRAINT IF EXISTS campaign_iteration_runs_iteration_number_check,
  DROP CONSTRAINT IF EXISTS campaign_iteration_runs_total_iterations_check,
  ADD CONSTRAINT campaign_iteration_runs_iteration_number_check
    CHECK (iteration_number BETWEEN 1 AND 100),
  ADD CONSTRAINT campaign_iteration_runs_total_iterations_check
    CHECK (total_iterations BETWEEN 1 AND 100);

ALTER TABLE app.prospect_iteration_states
  DROP CONSTRAINT IF EXISTS prospect_iteration_states_iteration_instructions_check,
  DROP CONSTRAINT IF EXISTS prospect_iteration_states_total_iterations_check,
  ADD CONSTRAINT prospect_iteration_states_iteration_instructions_check
    CHECK (cardinality(iteration_instructions) BETWEEN 1 AND 100),
  ADD CONSTRAINT prospect_iteration_states_total_iterations_check
    CHECK (total_iterations BETWEEN 1 AND 100);

ALTER TABLE app.prospect_iteration_runs
  DROP CONSTRAINT IF EXISTS prospect_iteration_runs_iteration_number_check,
  DROP CONSTRAINT IF EXISTS prospect_iteration_runs_total_iterations_check,
  ADD CONSTRAINT prospect_iteration_runs_iteration_number_check
    CHECK (iteration_number BETWEEN 1 AND 100),
  ADD CONSTRAINT prospect_iteration_runs_total_iterations_check
    CHECK (total_iterations BETWEEN 1 AND 100);

-- These four routines contain the same product limit in their validation
-- branches. Recreate their current definitions with only that literal changed;
-- this preserves the audited v24 behavior and all grants/signatures.
DO $extend_writing_iteration_functions$
DECLARE
  routine regprocedure;
  old_definition text;
  new_definition text;
BEGIN
  FOREACH routine IN ARRAY ARRAY[
    'app.extract_campaign_iteration_instructions(text)'::regprocedure,
    'app.effective_variant_sequence(uuid,uuid)'::regprocedure,
    'crm_api.crm_campaign_create_v2(jsonb,text)'::regprocedure,
    'crm_api.crm_campaign_update(uuid,bigint,jsonb)'::regprocedure
  ] LOOP
    old_definition := pg_get_functiondef(routine);
    new_definition := replace(
      replace(old_definition, 'BETWEEN 1 AND 10', 'BETWEEN 1 AND 100'),
      'between 1 and 10', 'between 1 and 100'
    );
    IF new_definition = old_definition THEN
      RAISE EXCEPTION 'writing_iteration_limit_not_found_in_%', routine::text;
    END IF;
    EXECUTE new_definition;
  END LOOP;
END;
$extend_writing_iteration_functions$;

INSERT INTO app.schema_migrations(version)
VALUES('025_extended_writing_iterations')
ON CONFLICT(version) DO NOTHING;
