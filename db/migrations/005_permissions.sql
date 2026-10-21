-- Prospection 95 · séparation des responsabilités et privilèges minimaux.

CREATE OR REPLACE FUNCTION audit.log_event(
  p_actor_type text,
  p_actor_id text,
  p_correlation_id uuid,
  p_event_type text,
  p_entity_type text,
  p_entity_id text,
  p_before_state jsonb,
  p_after_state jsonb,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, audit
AS $$
DECLARE event_id bigint;
BEGIN
  INSERT INTO audit.event_log
    (actor_type, actor_id, correlation_id, event_type, entity_type, entity_id, before_state, after_state, metadata)
  VALUES
    (p_actor_type, p_actor_id, p_correlation_id, p_event_type, p_entity_type, p_entity_id,
     p_before_state, p_after_state, coalesce(p_metadata, '{}'::jsonb))
  RETURNING id INTO event_id;
  RETURN event_id;
END;
$$;

CREATE OR REPLACE FUNCTION app.set_emergency_stop(
  p_stopped boolean,
  p_reason text,
  p_actor text
)
RETURNS app.settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit
AS $$
DECLARE before_row app.settings; after_row app.settings;
BEGIN
  SELECT * INTO before_row FROM app.settings WHERE singleton FOR UPDATE;
  IF NOT p_stopped AND coalesce(length(btrim(p_reason)), 0) = 0 THEN
    RAISE EXCEPTION 'resume_reason_required' USING ERRCODE = '22023';
  END IF;
  UPDATE app.settings
  SET emergency_stop = p_stopped,
      emergency_stop_reason = nullif(btrim(p_reason), ''),
      emergency_stop_changed_at = clock_timestamp(),
      emergency_stop_changed_by = p_actor,
      version = version + 1,
      updated_at = clock_timestamp()
  WHERE singleton
  RETURNING * INTO after_row;
  PERFORM audit.log_event('user', p_actor, gen_random_uuid(),
    CASE WHEN p_stopped THEN 'emergency_stop_enabled' ELSE 'emergency_stop_disabled' END,
    'settings', 'global', to_jsonb(before_row), to_jsonb(after_row), '{}'::jsonb);
  RETURN after_row;
END;
$$;

REVOKE ALL ON SCHEMA app, vault, agent_api, audit FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA app, vault, agent_api, audit FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app, vault, agent_api, audit FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app, vault, agent_api, audit FROM PUBLIC;

GRANT USAGE ON SCHEMA app, vault, audit TO prospection95_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO prospection95_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA vault TO prospection95_app;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA audit TO prospection95_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app, vault, audit TO prospection95_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app, audit TO prospection95_app;

REVOKE UPDATE, DELETE ON audit.event_log FROM prospection95_app;
REVOKE UPDATE, DELETE ON audit.agent_runs FROM prospection95_app;

GRANT USAGE ON SCHEMA app, agent_api TO prospection95_agent;
GRANT SELECT ON ALL TABLES IN SCHEMA agent_api TO prospection95_agent;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA agent_api TO prospection95_agent;

REVOKE ALL ON SCHEMA vault FROM prospection95_agent;
REVOKE ALL ON ALL TABLES IN SCHEMA app, vault, audit FROM prospection95_agent;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app, vault, audit FROM prospection95_agent;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app, vault, audit FROM prospection95_agent;

-- L'agent doit appeler uniquement les wrappers agent_api. Les fonctions app qui
-- confirment SMTP, louent les jobs ou manipulent le coffre restent backend-only.
GRANT EXECUTE ON FUNCTION agent_api.begin_run(text, text, text) TO prospection95_agent;
GRANT EXECUTE ON FUNCTION agent_api.complete_run(uuid, text, jsonb, text) TO prospection95_agent;
GRANT EXECUTE ON FUNCTION agent_api.reserve_prospect(uuid, uuid, uuid, text) TO prospection95_agent;
GRANT EXECUTE ON FUNCTION agent_api.propose_sequence(uuid, uuid, uuid, text, jsonb, uuid, text) TO prospection95_agent;
GRANT EXECUTE ON FUNCTION agent_api.classify_response(uuid, app.response_classification, text, boolean, numeric, text, uuid, text) TO prospection95_agent;
GRANT EXECUTE ON FUNCTION agent_api.propose_reply_draft(uuid, text, text, text) TO prospection95_agent;
GRANT EXECUTE ON FUNCTION agent_api.propose_experiment(uuid, text, text, text, jsonb, uuid, text) TO prospection95_agent;
GRANT EXECUTE ON FUNCTION agent_api.request_diagnostic(uuid, uuid, uuid, text, uuid, text, integer) TO prospection95_agent;
GRANT EXECUTE ON FUNCTION agent_api.submit_diagnostic_report(uuid, text, text, timestamptz, text, jsonb, jsonb, jsonb, text) TO prospection95_agent;

ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA vault REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA vault REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA agent_api REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA agent_api REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit REVOKE ALL ON FUNCTIONS FROM PUBLIC;

INSERT INTO app.schema_migrations (version)
VALUES ('005_permissions')
ON CONFLICT (version) DO NOTHING;
