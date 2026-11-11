-- Resume persisted writing work, preserve A/B context and support explicitly
-- short template sequences without inventing extra follow-ups. No data reset,
-- campaign activation, approval, scheduling or SMTP operation occurs here.
BEGIN;

CREATE OR REPLACE FUNCTION app.prospect_sequence_step_count(p_state_id uuid)
RETURNS integer LANGUAGE sql STABLE SET search_path=pg_catalog,app AS $$
  SELECT coalesce(nullif((SELECT max(item.ordinality)::int
    FROM (SELECT coalesce(
            (SELECT r.output_sequence FROM app.prospect_iteration_runs r
             WHERE r.state_id=p_state_id AND r.status='completed' ORDER BY r.started_at,r.id LIMIT 1),
            (SELECT r.input_sequence FROM app.prospect_iteration_runs r
             WHERE r.state_id=p_state_id ORDER BY r.started_at,r.id LIMIT 1)) AS input_sequence) initial
    CROSS JOIN LATERAL jsonb_array_elements_text(initial.input_sequence->'steps')
      WITH ORDINALITY item(body,ordinality)
    WHERE btrim(item.body)<>''),0),6)
$$;

CREATE OR REPLACE FUNCTION app.prospect_sequence_errors(p_sequence jsonb,p_state_id uuid)
RETURNS text[] LANGUAGE plpgsql STABLE SET search_path=pg_catalog,app AS $$
DECLARE errors text[]:='{}'; i int; required_count int;
BEGIN
  IF jsonb_typeof(p_sequence) IS DISTINCT FROM 'object' THEN RETURN ARRAY['sequence_object_required']; END IF;
  IF jsonb_typeof(p_sequence->'subject') IS DISTINCT FROM 'string'
    OR length(btrim(p_sequence->>'subject')) NOT BETWEEN 1 AND 998 THEN errors:=array_append(errors,'subject'); END IF;
  IF jsonb_typeof(p_sequence->'subjectInstructions') IS DISTINCT FROM 'string'
    OR length(p_sequence->>'subjectInstructions')>100000 THEN errors:=array_append(errors,'subjectInstructions'); END IF;
  IF jsonb_typeof(p_sequence->'steps') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_sequence->'stepInstructions') IS DISTINCT FROM 'array' THEN
    RETURN errors||ARRAY['six_string_slots_required']; END IF;
  IF jsonb_array_length(p_sequence->'steps')<>6 OR jsonb_array_length(p_sequence->'stepInstructions')<>6 THEN
    RETURN errors||ARRAY['six_string_slots_required']; END IF;
  required_count:=app.prospect_sequence_step_count(p_state_id);
  FOR i IN 0..5 LOOP
    IF jsonb_typeof(p_sequence->'steps'->i) IS DISTINCT FROM 'string'
      OR length(p_sequence->'steps'->>i)>100000 THEN errors:=array_append(errors,'steps['||i||']');
    ELSIF i<required_count AND btrim(p_sequence->'steps'->>i)='' THEN errors:=array_append(errors,'active_body_missing['||i||']');
    ELSIF i>=required_count AND btrim(p_sequence->'steps'->>i)<>'' THEN errors:=array_append(errors,'disabled_body_present['||i||']'); END IF;
    IF jsonb_typeof(p_sequence->'stepInstructions'->i) IS DISTINCT FROM 'string'
      OR length(p_sequence->'stepInstructions'->>i)>100000 THEN errors:=array_append(errors,'stepInstructions['||i||']'); END IF;
  END LOOP;
  RETURN errors;
END $$;

CREATE OR REPLACE FUNCTION app.valid_prospect_sequence_payload(p_sequence jsonb,p_state_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,app AS $$
 SELECT cardinality(app.prospect_sequence_errors(p_sequence,p_state_id))=0
$$;

CREATE OR REPLACE FUNCTION app.conversation_sequence_step_count(p_conversation_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $$
 SELECT coalesce((SELECT app.prospect_sequence_step_count(s.id)
   FROM app.conversations c JOIN app.prospect_iteration_states s
     ON s.campaign_id=c.campaign_id AND s.prospect_id=c.prospect_id
    AND s.experiment_assignment_id IS NOT DISTINCT FROM c.experiment_assignment_id
   WHERE c.id=p_conversation_id),6)
$$;

CREATE OR REPLACE FUNCTION app.existing_prospect_sequence_proposal(p_state_id uuid,p_key text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,app AS $$
 SELECT jsonb_build_object('conversationId',c.id,'iterationStateId',s.id,
   'campaignId',s.campaign_id,'prospectId',s.prospect_id,'experimentAssignmentId',s.experiment_assignment_id,
   'variantId',s.variant_id,'senderAccountId',c.sender_account_id)
 FROM app.prospect_iteration_states s JOIN app.conversations c
   ON c.campaign_id=s.campaign_id AND c.prospect_id=s.prospect_id
  AND c.experiment_assignment_id IS NOT DISTINCT FROM s.experiment_assignment_id
 WHERE s.id=p_state_id AND s.status='completed'
   AND EXISTS(SELECT 1 FROM app.email_messages m WHERE m.conversation_id=c.id AND m.proposal_key=p_key||':J0')
   AND (SELECT count(*) FROM app.email_messages m WHERE m.conversation_id=c.id
       AND m.proposal_key=ANY(ARRAY[p_key||':J0',p_key||':R1',p_key||':R2',p_key||':R3',p_key||':R4',p_key||':R5']))
       =app.prospect_sequence_step_count(s.id)
$$;

CREATE OR REPLACE FUNCTION agent_api.validate_prospect_iteration_sequence(
 p_iteration_run_id uuid,p_run_id uuid,p_sequence jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app,audit AS $$
DECLARE state_id uuid; errors text[];
BEGIN
 SELECT r.state_id INTO state_id FROM app.prospect_iteration_runs r
 WHERE r.id=p_iteration_run_id AND r.agent_run_id=p_run_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'prospect_iteration_run_mismatch' USING ERRCODE='P0001'; END IF;
 errors:=app.prospect_sequence_errors(p_sequence,state_id);
 RETURN jsonb_build_object('valid',cardinality(errors)=0,'errors',to_jsonb(errors),
   'requiredMessages',app.prospect_sequence_step_count(state_id));
END $$;
REVOKE ALL ON FUNCTION app.prospect_sequence_step_count(uuid),app.prospect_sequence_errors(jsonb,uuid),
 app.valid_prospect_sequence_payload(jsonb,uuid),app.conversation_sequence_step_count(uuid),app.existing_prospect_sequence_proposal(uuid,text),
 agent_api.validate_prospect_iteration_sequence(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_api.validate_prospect_iteration_sequence(uuid,uuid,jsonb) TO prospection95_agent;
-- The CRM view invokes this read-only helper with the caller's privileges.
GRANT EXECUTE ON FUNCTION app.conversation_sequence_step_count(uuid) TO prospection95_app,prospection95_crm;

-- Preserve the deployed functions, signatures, ownership and grants. Every
-- replacement is guarded so schema drift cannot silently skip a safety check.
DO $patch$
DECLARE original text; changed text; routine regprocedure;
BEGIN
 routine:='agent_api.complete_prospect_iteration(uuid,uuid,jsonb,text)'::regprocedure;
 original:=pg_get_functiondef(routine);
 changed:=replace(original,'OR NOT app.valid_sequence_payload(p_sequence)',
  'OR NOT coalesce((agent_api.validate_prospect_iteration_sequence(p_iteration_run_id,p_run_id,p_sequence)->>''valid'')::boolean,false)');
 IF changed=original THEN RAISE EXCEPTION 'writing_validation_patch_not_found'; END IF;
 EXECUTE changed;
 routine:='agent_api.propose_completed_sequence(uuid,uuid,uuid,text)'::regprocedure;
 original:=pg_get_functiondef(routine);
 changed:=replace(original,'NOT app.valid_sequence_payload(final_sequence)',
  'NOT app.valid_prospect_sequence_payload(final_sequence,state_row.id)');
 changed:=replace(changed,'  IF NOT EXISTS (SELECT 1 FROM app.campaign_prospects cp',
  '  IF app.existing_prospect_sequence_proposal(state_row.id,p_idempotency_key) IS NOT NULL THEN
    RETURN app.existing_prospect_sequence_proposal(state_row.id,p_idempotency_key);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.campaign_prospects cp');
 IF changed=original THEN RAISE EXCEPTION 'writing_finalization_patch_not_found'; END IF;
 EXECUTE changed;
 routine:='agent_api.propose_sequence(uuid,uuid,uuid,text,jsonb,uuid,text)'::regprocedure;
 original:=pg_get_functiondef(routine);
 changed:=replace(original,'IF existing_message_count = 6 THEN',
  'IF existing_message_count = (SELECT count(*) FROM jsonb_array_elements(p_messages) item WHERE btrim(coalesce(item->>''body'',''''))<>'''') THEN');
 changed:=replace(changed,'IF coalesce(message_item->>''body'', '''') = '''' THEN RAISE EXCEPTION ''message_body_missing_%'', step_value USING ERRCODE = ''22023''; END IF;',
  'IF btrim(coalesce(message_item->>''body'',''''))='''' THEN index_value:=index_value+1; CONTINUE; END IF;');
 IF changed=original OR position('message_body_missing_%' IN changed)>0 THEN RAISE EXCEPTION 'writing_proposal_patch_not_found'; END IF;
 EXECUTE changed;
 routine:='app.confirm_smtp_acceptance(uuid,uuid,text,timestamptz)'::regprocedure;
 original:=pg_get_functiondef(routine);
 changed:=replace(original,'WHEN followups_stopped_at IS NOT NULL THEN NULL ELSE CASE job.step',
  'WHEN followups_stopped_at IS NOT NULL OR (job.job_kind=''prospection'' AND
    array_position(ARRAY[''J0'',''R1'',''R2'',''R3'',''R4'',''R5'']::app.sequence_step[],job.step)
      >=app.conversation_sequence_step_count(job.conversation_id)) THEN NULL ELSE CASE job.step');
 IF changed=original THEN RAISE EXCEPTION 'writing_terminal_step_patch_not_found'; END IF;
 EXECUTE changed;
END $patch$;

-- Keep manual/plugin editing available for the actual number of prepared
-- messages. Missing messages in a six-message cycle still fail the old guard.
DO $crm$
DECLARE original text; changed text; validation_block text;
BEGIN
 original:=pg_get_viewdef('crm_api.pending_sequences'::regclass,true);
 changed:=replace(original,'count(*) = 6','count(*) = app.conversation_sequence_step_count(conv.id)');
 changed:=replace(changed,'count(DISTINCT l.step) = 6','count(DISTINCT l.step) = app.conversation_sequence_step_count(conv.id)');
 IF changed=original THEN RAISE EXCEPTION 'writing_crm_view_patch_not_found'; END IF;
 EXECUTE 'CREATE OR REPLACE VIEW crm_api.pending_sequences WITH (security_barrier=true) AS '||changed;
 original:=pg_get_functiondef('crm_api.crm_pending_sequence_revise(uuid,uuid,bigint,jsonb)'::regprocedure);
 validation_block:=substring(original FROM '  FOR v_index IN 0\.\.5 LOOP[\s\S]*?  END LOOP;');
 IF validation_block IS NULL THEN RAISE EXCEPTION 'writing_crm_validation_patch_not_found'; END IF;
 changed:=replace(original,validation_block,'');
 changed:=replace(changed,'  PERFORM 1 FROM app.email_messages',
  '  FOR v_index IN 0..5 LOOP
    IF jsonb_typeof(p_payload->''steps''->v_index) IS DISTINCT FROM ''string''
       OR length(p_payload->''steps''->>v_index)>100000
       OR (v_index<app.conversation_sequence_step_count(v_conversation.id) AND btrim(p_payload->''steps''->>v_index)='''')
       OR (v_index>=app.conversation_sequence_step_count(v_conversation.id) AND btrim(p_payload->''steps''->>v_index)<>'''') THEN
      RAISE EXCEPTION ''crm_invalid_body_at_step_%'',v_index USING ERRCODE=''22023'';
    END IF;
  END LOOP;
  PERFORM 1 FROM app.email_messages');
 changed:=replace(changed,'v_added<>6','v_added<>app.conversation_sequence_step_count(v_conversation.id)');
 IF changed=original THEN RAISE EXCEPTION 'writing_crm_revision_patch_not_found'; END IF;
 EXECUTE changed;
END $crm$;

CREATE OR REPLACE VIEW agent_api.pending_prospect_writing WITH (security_barrier=true) AS
SELECT ep.*,s.id AS iteration_state_id,a.id AS experiment_assignment_id,a.experiment_id,a.variant_id,v.code AS variant_code,
 coalesce(s.status,'not_started') AS iteration_status,coalesce(s.completed_iterations,0) AS completed_iterations,
 coalesce(s.total_iterations,case when jsonb_typeof(v.overrides#>'{iterations,draftPasses}')='array'
   then nullif(jsonb_array_length(v.overrides#>'{iterations,draftPasses}'),0) end,
   cardinality(c.writing_iteration_instructions)) AS total_iterations,
 s.last_error_code,s.claim_expires_at,coalesce(s.updated_at,ep.created_at) AS last_progress_at,
 CASE WHEN s.status='completed' THEN 'finalize'
   WHEN s.status='running' AND s.claim_expires_at>clock_timestamp() THEN 'wait' ELSE 'write' END AS next_action
FROM agent_api.eligible_prospects ep JOIN app.campaigns c ON c.id=ep.campaign_id
LEFT JOIN LATERAL (SELECT assignment.* FROM app.experiment_assignments assignment
 WHERE assignment.campaign_id=ep.campaign_id AND assignment.prospect_id=ep.prospect_id
 ORDER BY assignment.assigned_at DESC,assignment.id DESC LIMIT 1) a ON true
LEFT JOIN app.experiment_variants v ON v.id=a.variant_id
LEFT JOIN app.prospect_iteration_states s ON s.campaign_id=ep.campaign_id AND s.prospect_id=ep.prospect_id
 AND s.experiment_assignment_id IS NOT DISTINCT FROM a.id;
REVOKE ALL ON agent_api.pending_prospect_writing FROM PUBLIC;
GRANT SELECT ON agent_api.pending_prospect_writing TO prospection95_agent,prospection95_app;

INSERT INTO app.schema_migrations(version) VALUES('049_prospect_writing_recovery') ON CONFLICT DO NOTHING;
COMMIT;
