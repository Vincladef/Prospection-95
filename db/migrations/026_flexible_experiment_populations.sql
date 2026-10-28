-- Prospection 95 · population comparability is analytical metadata, never an
-- operational gate. Explicit variant targeting is allowed whenever an agent
-- has evidence that a prospect matches variant-specific search criteria.

CREATE OR REPLACE FUNCTION agent_api.assign_prospect_variant_v2(
  p_experiment_id uuid,
  p_prospect_id uuid,
  p_requested_variant_id uuid,
  p_run_id uuid,
  p_idempotency_key text
)
RETURNS TABLE(
  assignment_id uuid,
  campaign_id uuid,
  experiment_id uuid,
  variant_id uuid,
  variant_code text,
  assigned_for_step app.sequence_step
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app, audit
AS $assign_prospect_variant_v2$
DECLARE
  experiment_row app.experiments%ROWTYPE;
  assignment_row app.experiment_assignments%ROWTYPE;
  chosen_step app.sequence_step;
BEGIN
  IF length(coalesce(p_idempotency_key,'')) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'invalid_idempotency_key' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audit.agent_runs ar
    WHERE ar.id=p_run_id AND ar.agent_type='prospection' AND ar.status='running'
  ) THEN
    RAISE EXCEPTION 'run_not_active' USING ERRCODE='P0001';
  END IF;
  SELECT * INTO experiment_row
  FROM app.experiments e
  WHERE e.id=p_experiment_id AND e.status IN ('recruiting','threshold_reached')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'experiment_not_recruiting' USING ERRCODE='P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app.campaign_prospects cp
    WHERE cp.campaign_id=experiment_row.campaign_id
      AND cp.prospect_id=p_prospect_id AND cp.state='reserved'
  ) THEN
    RAISE EXCEPTION 'prospect_not_reserved' USING ERRCODE='P0001';
  END IF;
  chosen_step:=CASE WHEN experiment_row.scope='step' THEN experiment_row.target_step ELSE NULL END;

  IF p_requested_variant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.experiment_variants v
    WHERE v.id=p_requested_variant_id AND v.experiment_id=p_experiment_id
  ) THEN
    RAISE EXCEPTION 'requested_variant_not_in_experiment' USING ERRCODE='P0001';
  END IF;
  IF experiment_row.allocation_method='descriptive_groups'
     AND p_requested_variant_id IS NULL THEN
    RAISE EXCEPTION 'descriptive_variant_required' USING ERRCODE='P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_experiment_id::text||':'||p_prospect_id::text||':'||coalesce(chosen_step::text,'sequence'),95
  ));
  SELECT * INTO assignment_row
  FROM app.experiment_assignments a
  WHERE a.experiment_id=p_experiment_id AND a.prospect_id=p_prospect_id
    AND a.assigned_for_step IS NOT DISTINCT FROM chosen_step
  ORDER BY a.assigned_at LIMIT 1;

  IF FOUND AND p_requested_variant_id IS NOT NULL
     AND assignment_row.variant_id IS DISTINCT FROM p_requested_variant_id THEN
    RAISE EXCEPTION 'existing_variant_assignment_mismatch' USING ERRCODE='P0001';
  END IF;
  IF NOT FOUND THEN
    IF p_requested_variant_id IS NOT NULL THEN
      INSERT INTO app.experiment_assignments(
        experiment_id,variant_id,prospect_id,campaign_id,assigned_for_step,assignment_key
      ) VALUES(
        p_experiment_id,p_requested_variant_id,p_prospect_id,
        experiment_row.campaign_id,chosen_step,p_idempotency_key
      )
      ON CONFLICT(assignment_key) DO NOTHING RETURNING * INTO assignment_row;
      IF assignment_row.id IS NULL THEN
        SELECT * INTO assignment_row
        FROM app.experiment_assignments WHERE assignment_key=p_idempotency_key;
      END IF;
    ELSE
      assignment_row:=app.assign_experiment_variant(
        p_experiment_id,p_prospect_id,chosen_step,p_idempotency_key
      );
    END IF;
  END IF;

  INSERT INTO app.experiment_events(
    experiment_id,variant_id,assignment_id,prospect_id,event_type,event_at,
    measured,confidence,source,idempotency_key,metadata
  ) VALUES(
    assignment_row.experiment_id,assignment_row.variant_id,assignment_row.id,
    assignment_row.prospect_id,'assigned',assignment_row.assigned_at,true,'confirmed',
    'prospection_agent','assignment:'||assignment_row.id::text,
    jsonb_build_object('runId',p_run_id)
  ) ON CONFLICT(idempotency_key) DO NOTHING;

  INSERT INTO audit.event_log(
    actor_type,actor_id,correlation_id,event_type,entity_type,entity_id,metadata
  ) VALUES(
    'prospection_agent',p_run_id::text,p_run_id,'experiment_variant_assigned',
    'prospect',p_prospect_id::text,
    jsonb_build_object(
      'assignmentId',assignment_row.id,'experimentId',assignment_row.experiment_id,
      'variantId',assignment_row.variant_id,'allocationMethod',experiment_row.allocation_method,
      'selectionMode',CASE WHEN p_requested_variant_id IS NULL THEN 'balanced' ELSE 'explicit' END,
      'comparablePopulation',experiment_row.comparable_population,
      'idempotencyKey',p_idempotency_key
    )
  );
  RETURN QUERY
  SELECT assignment_row.id,assignment_row.campaign_id,assignment_row.experiment_id,
         assignment_row.variant_id,v.code,assignment_row.assigned_for_step
  FROM app.experiment_variants v WHERE v.id=assignment_row.variant_id;
END;
$assign_prospect_variant_v2$;

REVOKE ALL ON FUNCTION agent_api.assign_prospect_variant_v2(uuid,uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_api.assign_prospect_variant_v2(uuid,uuid,uuid,uuid,text)
  TO prospection95_agent;

INSERT INTO app.schema_migrations(version)
VALUES('026_flexible_experiment_populations')
ON CONFLICT(version) DO NOTHING;
