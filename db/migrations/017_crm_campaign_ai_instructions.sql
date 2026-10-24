-- Prospection 95: limited writing-instructions patch for existing active or inactive campaigns.
-- This deliberately does not change campaign status, send jobs, message templates or experiment assignments.
CREATE OR REPLACE FUNCTION crm_api.crm_campaign_update_ai_instructions(
 p_campaign_id uuid, p_expected_version bigint, p_instructions text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='pg_catalog'
AS $fn$
DECLARE c record; new_version bigint;
BEGIN
 IF p_instructions IS NULL OR length(p_instructions) NOT BETWEEN 1 AND 200000 THEN
   RAISE EXCEPTION 'crm_invalid_writing_instructions';
 END IF;
 SELECT version,status::text AS status INTO c FROM app.campaigns
 WHERE id=p_campaign_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'crm_campaign_not_found'; END IF;
 IF c.status NOT IN ('inactive','active') THEN
   RAISE EXCEPTION 'crm_campaign_not_editable';
 END IF;
 IF c.version IS DISTINCT FROM p_expected_version THEN
   RAISE EXCEPTION 'crm_version_conflict: %',c.version;
 END IF;
 UPDATE app.campaigns
 SET ai_instructions=p_instructions,version=version+1,updated_at=clock_timestamp()
 WHERE id=p_campaign_id RETURNING version INTO new_version;
 INSERT INTO audit.event_log(actor_type,actor_id,event_type,entity_type,entity_id,after_state,metadata)
 VALUES('user','prospection-95','crm_writing_instructions_updated','campaign',p_campaign_id::text,
 jsonb_build_object('status',c.status,'previousVersion',c.version,'version',new_version),
 jsonb_build_object('fields',jsonb_build_array('ai_instructions')));
 RETURN jsonb_build_object('campaignId',p_campaign_id,'status',c.status,
     'previousVersion',c.version,'version',new_version);
END;
$fn$;
REVOKE ALL ON FUNCTION crm_api.crm_campaign_update_ai_instructions(uuid,bigint,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_api.crm_campaign_update_ai_instructions(uuid,bigint,text) TO prospection95_crm;
