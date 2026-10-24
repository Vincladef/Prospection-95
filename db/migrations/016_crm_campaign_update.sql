-- Prospection 95, migration 016: controlled edit of existing inactive campaigns, versioned templates and unexposed draft test variants.
CREATE OR REPLACE FUNCTION crm_api.crm_campaign_update(p_campaign_id uuid, p_expected_version bigint, p_patch jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  c app.campaigns%ROWTYPE; s jsonb; e jsonb; v jsonb;
  st text; old_t app.message_templates%ROWTYPE;
  new_body text; new_instr text; new_subject text;
  eid uuid; vid uuid; i int; j int; changed int:=0; variants_changed int:=0;
  fields text[]:=ARRAY['J0','R1','R2','R3','R4','R5']; f text;
BEGIN
  IF jsonb_typeof(p_patch) IS DISTINCT FROM 'object' OR length(p_patch::text)>1000000
    OR p_patch='{}'::jsonb THEN RAISE EXCEPTION 'crm_invalid_patch'; END IF;
  SELECT * INTO c FROM app.campaigns WHERE id=p_campaign_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'crm_campaign_not_found'; END IF;
  IF c.status::text <> 'inactive' THEN RAISE EXCEPTION 'crm_requires_inactive'; END IF;
  IF c.version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'crm_version_conflict: %',c.version; END IF;
  FOR f IN SELECT jsonb_object_keys(p_patch) LOOP
    IF f NOT IN ('name','targetDescription','aiInstructions','replyInstructions',
       'nextTestInstructions','sequence','experiments') THEN RAISE EXCEPTION 'crm_unsupported_field: %',f; END IF;
  END LOOP;
  IF p_patch ? 'name' AND length(btrim(coalesce(p_patch->>'name',''))) NOT BETWEEN 1 AND 180 THEN
    RAISE EXCEPTION 'crm_invalid_name';
  END IF;
  IF p_patch ? 'sequence' THEN
    s:=p_patch->'sequence';
    IF jsonb_typeof(s) <> 'object' OR jsonb_typeof(s->'steps') <> 'array'
       OR jsonb_typeof(s->'stepInstructions') <> 'array'
       OR jsonb_array_length(s->'steps')<>6 OR jsonb_array_length(s->'stepInstructions')<>6 THEN
      RAISE EXCEPTION 'crm_invalid_sequence';
    END IF;
  END IF;
  IF p_patch ? 'experiments' AND jsonb_typeof(p_patch->'experiments')<>'array' THEN
    RAISE EXCEPTION 'crm_invalid_experiments';
  END IF;
  UPDATE app.campaigns SET
    name=CASE WHEN p_patch ? 'name' THEN btrim(p_patch->>'name') ELSE name END,
    target_description=CASE WHEN p_patch ? 'targetDescription' THEN p_patch->>'targetDescription' ELSE target_description END,
    ai_instructions=CASE WHEN p_patch ? 'aiInstructions' THEN p_patch->>'aiInstructions' ELSE ai_instructions END,
    reply_instructions=CASE WHEN p_patch ? 'replyInstructions' THEN p_patch->>'replyInstructions' ELSE reply_instructions END,
    next_test_instructions=CASE WHEN p_patch ? 'nextTestInstructions' THEN p_patch->>'nextTestInstructions' ELSE next_test_instructions END,
    version=version+1,updated_at=clock_timestamp() WHERE id=p_campaign_id;
  IF s IS NOT NULL THEN
    FOR i IN 0..5 LOOP
      st:=fields[i+1];
      SELECT * INTO old_t FROM app.message_templates
        WHERE campaign_id=p_campaign_id AND step=st::app.sequence_step AND iteration=1
        ORDER BY version DESC LIMIT 1;
      new_subject:=coalesce(s->>'subject','');
      new_body:=coalesce((s->'steps')->>i,'');
      new_instr:=CASE WHEN i=0 THEN jsonb_build_object('subject',coalesce(s->>'subjectInstructions',''),
        'body',coalesce((s->'stepInstructions')->>i,''))::text
        ELSE coalesce((s->'stepInstructions')->>i,'') END;
      IF length(new_body)>100000 OR length(new_instr)>100000 THEN RAISE EXCEPTION 'crm_message_too_long'; END IF;
      IF old_t.id IS NULL OR (old_t.subject,old_t.body,old_t.instructions)
        IS DISTINCT FROM (new_subject,new_body,new_instr) THEN
        INSERT INTO app.message_templates(campaign_id,step,iteration,version,subject,body,instructions,supersedes_id,created_by)
        VALUES(p_campaign_id,st::app.sequence_step,1,coalesce(old_t.version,0)+1,
          new_subject,new_body,new_instr,old_t.id,'user');
        changed:=changed+1;
      END IF;
    END LOOP;
  END IF;
  IF p_patch ? 'experiments' THEN
    FOR i IN 0..jsonb_array_length(p_patch->'experiments')-1 LOOP
      e:=(p_patch->'experiments')->i;
      eid:=(e->>'id')::uuid;
      PERFORM 1 FROM app.experiments WHERE id=eid AND campaign_id=p_campaign_id AND status='draft' FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'crm_experiment_not_editable'; END IF;
      IF e ? 'name' AND length(btrim(coalesce(e->>'name',''))) NOT BETWEEN 1 AND 180 THEN RAISE EXCEPTION 'crm_invalid_experiment_name'; END IF;
      UPDATE app.experiments SET
        name=CASE WHEN e ? 'name' THEN btrim(e->>'name') ELSE name END,
        contacts_per_variant_threshold=CASE WHEN e ? 'thresholdContactsPerVariant'
          THEN (e->>'thresholdContactsPerVariant')::integer ELSE contacts_per_variant_threshold END,
        total_responses_threshold=CASE WHEN e ? 'thresholdReplies'
          THEN (e->>'thresholdReplies')::integer ELSE total_responses_threshold END,
        updated_at=clock_timestamp() WHERE id=eid;
      IF e ? 'variants' THEN
        IF jsonb_typeof(e->'variants')<>'array' THEN RAISE EXCEPTION 'crm_invalid_variants'; END IF;
        FOR j IN 0..jsonb_array_length(e->'variants')-1 LOOP
          v:=(e->'variants')->j;
          vid:=(v->>'id')::uuid;
          PERFORM 1 FROM app.experiment_variants WHERE id=vid AND experiment_id=eid AND exposed_at IS NULL FOR UPDATE;
          IF NOT FOUND THEN RAISE EXCEPTION 'crm_variant_not_editable'; END IF;
          IF v ? 'overrides' AND jsonb_typeof(v->'overrides')<>'object' THEN RAISE EXCEPTION 'crm_invalid_overrides'; END IF;
          UPDATE app.experiment_variants SET
            name=CASE WHEN v ? 'name' THEN v->>'name' ELSE name END,
            overrides=CASE WHEN v ? 'overrides' THEN v->'overrides' ELSE overrides END,
            weight=CASE WHEN v ? 'allocationWeight' THEN (v->>'allocationWeight')::numeric ELSE weight END,
            version=version+1 WHERE id=vid;
          variants_changed:=variants_changed+1;
        END LOOP;
      END IF;
    END LOOP;
  END IF;
  INSERT INTO audit.event_log(actor_type,actor_id,event_type,entity_type,entity_id,after_state,metadata)
  VALUES('user','prospection-95','crm_campaign_updated','campaign',p_campaign_id::text,
   jsonb_build_object('previousVersion',c.version,'version',c.version+1,'status','inactive'),
   jsonb_build_object('templateVersionsAdded',changed,'variantsChanged',variants_changed));
  RETURN jsonb_build_object('campaignId',p_campaign_id,'previousVersion',c.version,
    'version',c.version+1,'status','inactive','templatesUpdated',changed,'variantsUpdated',variants_changed);
END;
$function$
;
REVOKE ALL ON FUNCTION crm_api.crm_campaign_update(uuid,bigint,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_api.crm_campaign_update(uuid,bigint,jsonb) TO prospection95_crm;
