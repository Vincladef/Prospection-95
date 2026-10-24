-- Prospection 95 · désambiguïsation de l'enregistrement des prospects.
--
-- `campaign_id` est aussi le nom d'une colonne de sortie de la fonction
-- PL/pgSQL. La cible historique `ON CONFLICT (campaign_id, prospect_id)` était
-- donc ambiguë. Cibler explicitement la clé primaire conserve exactement le
-- même comportement de déduplication sans modifier les données existantes.

CREATE OR REPLACE FUNCTION agent_api.register_prospect(
  p_campaign_id uuid,
  p_full_name text,
  p_email text,
  p_organization_name text,
  p_job_title text,
  p_website_url text,
  p_source_label text,
  p_source_url text,
  p_source_evidence jsonb,
  p_qualification_score numeric,
  p_qualification_reason text,
  p_run_id uuid,
  p_idempotency_key text
)
RETURNS TABLE(prospect_id uuid, campaign_id uuid, state text, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit
AS $register_prospect$
DECLARE
  normalized text := app.canonical_email(p_email);
  organization_uuid uuid;
  prospect_uuid uuid;
  registration_uuid uuid;
  link_state text;
  was_created boolean := false;
BEGIN
  IF length(coalesce(p_idempotency_key, '')) NOT BETWEEN 8 AND 200
     OR normalized !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     OR jsonb_typeof(coalesce(p_source_evidence, '{}'::jsonb)) <> 'object'
     OR p_qualification_score IS NULL OR p_qualification_score NOT BETWEEN 0 AND 1
     OR coalesce(length(btrim(p_qualification_reason)), 0) = 0 THEN
    RAISE EXCEPTION 'invalid_prospect_registration' USING ERRCODE = '22023';
  END IF;

  SELECT r.prospect_id INTO prospect_uuid
    FROM app.agent_prospect_registrations r
   WHERE r.idempotency_key = p_idempotency_key;
  IF prospect_uuid IS NOT NULL THEN
    RETURN QUERY
      SELECT prospect_uuid, r.campaign_id, cp.state, false
      FROM app.agent_prospect_registrations r
      JOIN app.campaign_prospects cp
        ON cp.campaign_id = r.campaign_id AND cp.prospect_id = r.prospect_id
      WHERE r.idempotency_key = p_idempotency_key;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app.campaigns c
     WHERE c.id = p_campaign_id AND c.status = 'active' AND NOT c.imported_disabled
  ) THEN
    RAISE EXCEPTION 'campaign_not_active' USING ERRCODE = 'P0001';
  END IF;

  IF nullif(btrim(p_organization_name), '') IS NOT NULL THEN
    SELECT o.id INTO organization_uuid
      FROM app.organizations o
     WHERE lower(o.name) = lower(btrim(p_organization_name))
     ORDER BY o.created_at LIMIT 1;
    IF organization_uuid IS NULL THEN
      INSERT INTO app.organizations (name, website_url)
      VALUES (btrim(p_organization_name), nullif(btrim(p_website_url), ''))
      RETURNING id INTO organization_uuid;
    END IF;
  END IF;

  SELECT p.id INTO prospect_uuid
    FROM app.prospects p
   WHERE p.normalized_email = normalized AND p.deleted_at IS NULL;
  IF prospect_uuid IS NULL THEN
    INSERT INTO app.prospects (
      organization_id, full_name, job_title, email, contact_raw, contact_kind,
      website_url, source_label, source_url, source_evidence,
      qualification_state, qualification_score, qualification_reason
    ) VALUES (
      organization_uuid, coalesce(btrim(p_full_name), ''), nullif(btrim(p_job_title), ''),
      normalized, normalized, 'email', nullif(btrim(p_website_url), ''),
      nullif(btrim(p_source_label), ''), nullif(btrim(p_source_url), ''),
      coalesce(p_source_evidence, '{}'::jsonb), 'qualified',
      p_qualification_score, btrim(p_qualification_reason)
    ) RETURNING id INTO prospect_uuid;
    was_created := true;
  END IF;

  link_state := CASE
    WHEN app.is_excluded(normalized) THEN 'excluded'
    WHEN EXISTS (SELECT 1 FROM app.contact_history h WHERE h.normalized_email = normalized) THEN 'rejected'
    ELSE 'candidate'
  END;

  INSERT INTO app.campaign_prospects (campaign_id, prospect_id, state, notes)
  VALUES (p_campaign_id, prospect_uuid, link_state,
          CASE WHEN link_state = 'rejected' THEN 'Déjà contacté globalement' ELSE NULL END)
  ON CONFLICT ON CONSTRAINT campaign_prospects_pkey DO NOTHING;

  INSERT INTO app.agent_prospect_registrations
    (campaign_id, prospect_id, agent_run_id, idempotency_key)
  VALUES (p_campaign_id, prospect_uuid, p_run_id, p_idempotency_key)
  RETURNING id INTO registration_uuid;

  INSERT INTO audit.event_log
    (actor_type, actor_id, event_type, entity_type, entity_id, metadata)
  VALUES ('prospection_agent', p_run_id::text, 'prospect_registered', 'prospect',
          prospect_uuid::text,
          jsonb_build_object('campaign_id', p_campaign_id,
                             'registration_id', registration_uuid,
                             'state', link_state,
                             'created', was_created));

  RETURN QUERY SELECT prospect_uuid, p_campaign_id, link_state, was_created;
END;
$register_prospect$;

REVOKE ALL ON FUNCTION agent_api.register_prospect(
  uuid,text,text,text,text,text,text,text,jsonb,numeric,text,uuid,text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_api.register_prospect(
  uuid,text,text,text,text,text,text,text,jsonb,numeric,text,uuid,text
) TO prospection95_agent;

INSERT INTO app.schema_migrations (version)
VALUES ('020_register_prospect_conflict_target')
ON CONFLICT (version) DO NOTHING;
