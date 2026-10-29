-- 027: Révision CRM contrôlée des séquences individuelles en attente.
-- L'historique est conservé : de nouvelles versions sont insérées, aucun message n'est réécrit.
-- Aucune autorisation d'envoi, de validation ou d'accès direct aux tables métier.

CREATE OR REPLACE VIEW crm_api.pending_sequences
WITH (security_barrier = true)
AS
WITH latest AS (
  SELECT DISTINCT ON (m.conversation_id, m.step)
    m.conversation_id, m.id AS message_id, m.step, m.subject, m.body_text,
    m.status, m.content_version
  FROM app.email_messages m
  WHERE m.direction='outbound' AND m.kind='prospection'
    AND NOT m.technical_confirmation AND m.step IS NOT NULL
  ORDER BY m.conversation_id, m.step, m.content_version DESC, m.created_at DESC, m.id DESC
)
SELECT c.id AS campaign_id, c.name AS campaign_name, c.status AS campaign_status,
       conv.id AS conversation_id, conv.experiment_assignment_id,
       p.id AS prospect_id, p.version AS prospect_version,
       p.full_name, p.job_title, p.email, p.website_url,
       p.source_label, p.source_url, p.source_evidence,
       o.name AS organization_name,
       min(l.subject) FILTER (WHERE l.step='J0') AS subject,
       jsonb_agg(jsonb_build_object(
         'step',l.step,'messageId',l.message_id,'contentVersion',l.content_version,
         'status',l.status,'body',l.body_text
       ) ORDER BY array_position(ARRAY['J0','R1','R2','R3','R4','R5']::app.sequence_step[], l.step)) AS messages
FROM latest l
JOIN app.conversations conv ON conv.id=l.conversation_id
JOIN app.campaigns c ON c.id=conv.campaign_id
JOIN app.prospects p ON p.id=conv.prospect_id AND p.deleted_at IS NULL
LEFT JOIN app.organizations o ON o.id=p.organization_id
WHERE c.validation_policy='manual'
  AND conv.followups_stopped_at IS NULL
  AND conv.state NOT IN ('opposition','replied','cancelled','unresolved')
  AND p.contact_kind='email'
  AND p.normalized_email IS NOT NULL
  AND p.contact_state <> 'do_not_contact'
  AND NOT app.is_excluded(p.normalized_email)
  AND l.status IN ('draft','prepared','pending_approval')
  AND NOT EXISTS (
    SELECT 1 FROM app.email_messages old
    WHERE old.conversation_id=conv.id AND old.direction='outbound'
      AND old.kind='prospection'
      AND (old.technical_confirmation OR old.sent_at IS NOT NULL
        OR old.smtp_accepted_at IS NOT NULL OR old.internet_message_id IS NOT NULL
        OR old.status IN ('reserved','sending','smtp_accepted','sent_manually','uncertain'))
  )
  AND NOT EXISTS (
    SELECT 1 FROM app.message_approvals approval
    JOIN app.email_messages old ON old.id=approval.message_id
    WHERE old.conversation_id=conv.id AND approval.approved
  )
  AND NOT EXISTS (
    SELECT 1 FROM app.outbox_jobs job
    WHERE job.conversation_id=conv.id AND job.status NOT IN ('cancelled','failed')
  )
  AND EXISTS (
    SELECT 1 FROM app.prospect_iteration_states s
    WHERE s.campaign_id=conv.campaign_id AND s.prospect_id=conv.prospect_id
      AND s.experiment_assignment_id IS NOT DISTINCT FROM conv.experiment_assignment_id
      AND s.status='completed' AND s.completed_iterations=s.total_iterations
  )
GROUP BY c.id,c.name,c.status,conv.id,conv.experiment_assignment_id,
         p.id,p.version,p.full_name,p.job_title,p.email,p.website_url,
         p.source_label,p.source_url,p.source_evidence,o.name
HAVING count(*)=6 AND count(DISTINCT l.step)=6;

REVOKE ALL ON crm_api.pending_sequences FROM PUBLIC;
GRANT SELECT ON crm_api.pending_sequences TO prospection95_crm;

CREATE OR REPLACE FUNCTION crm_api.crm_pending_sequence_revise(
  p_campaign_id uuid, p_prospect_id uuid, p_expected_prospect_version bigint,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $crm_pending_sequence_revise$
DECLARE
  v_conversation app.conversations%ROWTYPE;
  v_prospect app.prospects%ROWTYPE;
  v_campaign app.campaigns%ROWTYPE;
  v_message app.email_messages%ROWTYPE;
  v_subject text;
  v_body text;
  v_index integer;
  v_added integer:=0;
  v_previous_ids jsonb:='[]'::jsonb;
  v_new_ids jsonb:='[]'::jsonb;
  v_id uuid;
BEGIN
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
    OR p_payload - 'subject' - 'steps' <> '{}'::jsonb
    OR jsonb_typeof(p_payload->'subject') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_payload->'steps') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_payload->'steps')<>6
    OR length(p_payload::text)>700000 THEN
    RAISE EXCEPTION 'crm_invalid_sequence_payload' USING ERRCODE='22023';
  END IF;

  v_subject := btrim(p_payload->>'subject');
  IF length(v_subject) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'crm_invalid_subject' USING ERRCODE='22023';
  END IF;
  FOR v_index IN 0..5 LOOP
    IF jsonb_typeof(p_payload->'steps'->v_index) IS DISTINCT FROM 'string'
       OR length(btrim(p_payload->'steps'->>v_index)) NOT BETWEEN 1 AND 100000 THEN
      RAISE EXCEPTION 'crm_invalid_body_at_step_%',v_index USING ERRCODE='22023';
    END IF;
  END LOOP;

  SELECT * INTO v_campaign FROM app.campaigns WHERE id=p_campaign_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'crm_campaign_not_found' USING ERRCODE='P0001'; END IF;
  IF v_campaign.validation_policy <> 'manual' THEN
    RAISE EXCEPTION 'crm_manual_validation_required' USING ERRCODE='P0001';
  END IF;

  SELECT * INTO v_conversation FROM app.conversations
  WHERE campaign_id=p_campaign_id AND prospect_id=p_prospect_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'crm_conversation_not_found' USING ERRCODE='P0001'; END IF;
  SELECT * INTO v_prospect FROM app.prospects WHERE id=p_prospect_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'crm_prospect_not_found' USING ERRCODE='P0001'; END IF;
  IF v_prospect.version IS DISTINCT FROM p_expected_prospect_version THEN
    RAISE EXCEPTION 'crm_prospect_version_conflict: %',v_prospect.version USING ERRCODE='P0001';
  END IF;

  -- Même périmètre que la vue, relu sous verrou pour éviter une révision périmée.
  PERFORM 1 FROM crm_api.pending_sequences s
  WHERE s.campaign_id=p_campaign_id AND s.prospect_id=p_prospect_id
    AND s.prospect_version=p_expected_prospect_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'crm_sequence_not_pending_or_not_editable' USING ERRCODE='P0001';
  END IF;

  FOR v_message IN
    SELECT DISTINCT ON (m.step) m.*
    FROM app.email_messages m
    WHERE m.conversation_id=v_conversation.id AND m.direction='outbound'
      AND m.kind='prospection' AND NOT m.technical_confirmation AND m.step IS NOT NULL
    ORDER BY m.step, m.content_version DESC, m.created_at DESC, m.id DESC
  LOOP
    v_index := array_position(ARRAY['J0','R1','R2','R3','R4','R5']::app.sequence_step[],
                              v_message.step) - 1;
    IF v_index NOT BETWEEN 0 AND 5 OR v_message.status NOT IN ('draft','prepared','pending_approval') THEN
      RAISE EXCEPTION 'crm_sequence_changed_during_revision' USING ERRCODE='P0001';
    END IF;
    v_body := p_payload->'steps'->>v_index;
    v_previous_ids := v_previous_ids || to_jsonb(v_message.id::text);
    INSERT INTO app.email_messages (
      conversation_id,direction,kind,step,sender_account_id,from_address,
      to_addresses,cc_addresses,subject,body_text,content_version,
      template_id,status,source
    )
    VALUES (
      v_message.conversation_id,'outbound','prospection',v_message.step,
      v_message.sender_account_id,v_message.from_address,
      v_message.to_addresses,v_message.cc_addresses,
      v_subject,v_body,v_message.content_version+1,
      v_message.template_id,'pending_approval','agent'
    ) RETURNING id INTO v_id;
    v_new_ids := v_new_ids || to_jsonb(v_id::text);
    v_added := v_added+1;
  END LOOP;
  IF v_added<>6 THEN RAISE EXCEPTION 'crm_incomplete_sequence' USING ERRCODE='P0001'; END IF;
  UPDATE app.prospects SET version=version+1, updated_at=clock_timestamp()
  WHERE id=p_prospect_id;
  UPDATE app.conversations SET version=version+1, updated_at=clock_timestamp()
  WHERE id=v_conversation.id;
  INSERT INTO audit.event_log (
    actor_type,actor_id,event_type,entity_type,entity_id,after_state,metadata
  ) VALUES (
    'user','prospection-95-plugin','crm_pending_sequence_revised','prospect',
    p_prospect_id::text,
    jsonb_build_object('previousProspectVersion',p_expected_prospect_version,
      'prospectVersion',p_expected_prospect_version+1),
    jsonb_build_object('campaignId',p_campaign_id,'conversationId',v_conversation.id,
      'experimentAssignmentId',v_conversation.experiment_assignment_id,
      'previousMessageIds',v_previous_ids,'newMessageIds',v_new_ids)
  );
  RETURN jsonb_build_object('campaignId',p_campaign_id,'prospectId',p_prospect_id,
    'prospectVersion',p_expected_prospect_version+1,'messagesRevised',v_added,
    'newMessageIds',v_new_ids,'status','pending_approval');
END;
$crm_pending_sequence_revise$;

REVOKE ALL ON FUNCTION crm_api.crm_pending_sequence_revise(uuid,uuid,bigint,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION crm_api.crm_pending_sequence_revise(uuid,uuid,bigint,jsonb)
 TO prospection95_crm;
INSERT INTO app.schema_migrations(version)
VALUES ('027_crm_pending_sequence_revisions')
ON CONFLICT (version) DO NOTHING;