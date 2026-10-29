-- Expose only writing instructions and their shared settings version to the CRM.
CREATE OR REPLACE VIEW crm_api.writing_settings WITH (security_barrier=true) AS
SELECT general_writing_instructions, version, updated_at FROM app.settings WHERE singleton;
REVOKE ALL ON crm_api.writing_settings FROM PUBLIC;
GRANT SELECT ON crm_api.writing_settings TO prospection95_crm;

CREATE OR REPLACE FUNCTION crm_api.crm_writing_instructions_update(p_expected_version bigint, p_instructions text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $fn$
DECLARE previous app.settings%ROWTYPE; next_version bigint;
BEGIN
  IF p_instructions IS NULL OR length(p_instructions)>500000 OR p_expected_version IS NULL THEN
    RAISE EXCEPTION 'crm_invalid_writing_instructions' USING ERRCODE='22023';
  END IF;
  SELECT * INTO previous FROM app.settings WHERE singleton FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'crm_settings_not_found'; END IF;
  IF previous.version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'crm_settings_version_conflict: %',previous.version;
  END IF;
  UPDATE app.settings SET general_writing_instructions=p_instructions,
    version=version+1, updated_at=clock_timestamp() WHERE singleton RETURNING version INTO next_version;
  INSERT INTO audit.event_log(actor_type,actor_id,event_type,entity_type,entity_id,before_state,after_state)
  VALUES ('user',session_user,'crm_writing_instructions_updated','settings','singleton',
    jsonb_build_object('generalWritingInstructions',previous.general_writing_instructions,'version',previous.version),
    jsonb_build_object('generalWritingInstructions',p_instructions,'version',next_version));
  RETURN jsonb_build_object('version',next_version);
END;
$fn$;
REVOKE ALL ON FUNCTION crm_api.crm_writing_instructions_update(bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_api.crm_writing_instructions_update(bigint,text) TO prospection95_crm;
INSERT INTO app.schema_migrations(version) VALUES ('029_crm_general_writing_instructions') ON CONFLICT DO NOTHING;
