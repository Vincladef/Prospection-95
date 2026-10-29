-- Run on an isolated branch after migration 027. All fixture changes roll back.
DO $test$
DECLARE
  sample record;
  payload jsonb;
  result jsonb;
  original_count bigint;
  iteration_hash text;
  assignment_hash text;
  outbox_count bigint;
  sent_hash text;
  rejected boolean;
BEGIN
  SELECT * INTO sample FROM crm_api.pending_sequences LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Test requires one eligible six-message sequence'; END IF;
  SET LOCAL ROLE prospection95_crm;
  PERFORM 1 FROM crm_api.pending_sequences LIMIT 1;
  RESET ROLE;
  payload := jsonb_build_object('subject',sample.subject,
    'steps',(SELECT jsonb_agg(value->>'body' ORDER BY ordinality)
             FROM jsonb_array_elements(sample.messages) WITH ORDINALITY));
  SELECT count(*) INTO original_count FROM app.email_messages WHERE conversation_id=sample.conversation_id;
  SELECT md5(coalesce(jsonb_agg(to_jsonb(s) ORDER BY id)::text,'')) INTO iteration_hash FROM app.prospect_iteration_states s;
  SELECT md5(coalesce(jsonb_agg(to_jsonb(a) ORDER BY id)::text,'')) INTO assignment_hash FROM app.experiment_assignments a;
  SELECT count(*) INTO outbox_count FROM app.outbox_jobs;
  SELECT md5(coalesce(jsonb_agg(to_jsonb(m) ORDER BY id)::text,'')) INTO sent_hash FROM app.email_messages m WHERE technical_confirmation;
  BEGIN
    SET LOCAL ROLE prospection95_crm;
    SELECT crm_api.crm_pending_sequence_revise(sample.campaign_id,sample.prospect_id,sample.prospect_version,payload) INTO result;
    RESET ROLE;
    IF result->>'status'<>'draft' OR (result->>'messagesRevised')::int<>6 THEN RAISE EXCEPTION 'Wrong revision result'; END IF;
    IF (SELECT count(*) FROM app.email_messages WHERE conversation_id=sample.conversation_id)<>original_count+6 THEN RAISE EXCEPTION 'History lost'; END IF;
    IF EXISTS (SELECT 1 FROM crm_api.pending_sequences s, jsonb_array_elements(s.messages) m
               WHERE s.prospect_id=sample.prospect_id AND m->>'status'<>'draft') THEN RAISE EXCEPTION 'Not all drafts'; END IF;
    IF (SELECT md5(coalesce(jsonb_agg(to_jsonb(s) ORDER BY id)::text,'')) FROM app.prospect_iteration_states s)<>iteration_hash THEN RAISE EXCEPTION 'Iterations changed'; END IF;
    IF (SELECT md5(coalesce(jsonb_agg(to_jsonb(a) ORDER BY id)::text,'')) FROM app.experiment_assignments a)<>assignment_hash THEN RAISE EXCEPTION 'Variants changed'; END IF;
    IF (SELECT count(*) FROM app.outbox_jobs)<>outbox_count THEN RAISE EXCEPTION 'Outbound job created'; END IF;
    IF (SELECT md5(coalesce(jsonb_agg(to_jsonb(m) ORDER BY id)::text,'')) FROM app.email_messages m WHERE technical_confirmation)<>sent_hash THEN RAISE EXCEPTION 'Sent messages changed'; END IF;
    rejected:=false;
    BEGIN
      PERFORM crm_api.crm_pending_sequence_revise(sample.campaign_id,sample.prospect_id,sample.prospect_version,payload);
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM NOT LIKE 'crm_prospect_version_conflict%' THEN RAISE; END IF;
      rejected:=true;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'Stale version accepted'; END IF;
    RAISE EXCEPTION 'test_rollback_success';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM<>'test_rollback_success' THEN RAISE; END IF;
  END;
  -- Each disallowed latest status must reject the entire sequence atomically.
  FOR result IN SELECT to_jsonb(status) FROM unnest(ARRAY['approved','scheduled','sending','smtp_accepted','uncertain']) status LOOP
    BEGIN
      UPDATE app.email_messages SET status=(result#>>'{}')::app.message_status
      WHERE id=(sample.messages->0->>'messageId')::uuid;
      rejected:=false;
      BEGIN
        PERFORM crm_api.crm_pending_sequence_revise(sample.campaign_id,sample.prospect_id,sample.prospect_version,payload);
      EXCEPTION WHEN raise_exception THEN
        IF SQLERRM<>'crm_sequence_not_pending_or_not_editable' THEN RAISE; END IF;
        rejected:=true;
      END;
      IF NOT rejected THEN RAISE EXCEPTION 'Unsafe status accepted'; END IF;
      RAISE EXCEPTION 'test_rollback_success';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM<>'test_rollback_success' THEN RAISE; END IF;
    END;
  END LOOP;
  IF has_table_privilege('prospection95_crm','app.email_messages','SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'CRM direct access'; END IF;
  IF has_function_privilege('prospection95_crm','app.confirm_smtp_acceptance(uuid,uuid,text,timestamptz)','EXECUTE') THEN RAISE EXCEPTION 'CRM SMTP access'; END IF;
  RAISE NOTICE 'PASS: draft revision, history, AI iterations, variants, no send, concurrency version and unsafe statuses';
END;
$test$;
