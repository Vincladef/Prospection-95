-- Test on an isolated branch; all fixture changes roll back.
DO $test$
DECLARE original jsonb; actual jsonb; v bigint; result jsonb; refused boolean;
BEGIN
 SELECT to_jsonb(s),version INTO original,v FROM app.settings s WHERE singleton;
 BEGIN
  SET LOCAL ROLE prospection95_crm;
  PERFORM 1 FROM crm_api.writing_settings;
  result:=crm_api.crm_writing_instructions_update(v,'Consignes de test');
  IF (result->>'version')::bigint<>v+1 THEN RAISE EXCEPTION 'Wrong version'; END IF;
  refused:=false;
  BEGIN
   PERFORM crm_api.crm_writing_instructions_update(v,'Concurrent');
  EXCEPTION WHEN raise_exception THEN
   IF SQLERRM NOT LIKE 'crm_settings_version_conflict%' THEN RAISE; END IF;
   refused:=true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'Stale version accepted'; END IF;
  BEGIN
   PERFORM crm_api.crm_writing_instructions_update(v+1,NULL);
   RAISE EXCEPTION 'Null accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  RESET ROLE;
  SELECT to_jsonb(s) INTO actual FROM app.settings s WHERE singleton;
  IF actual->>'general_writing_instructions'<>'Consignes de test' THEN RAISE EXCEPTION 'Text not saved'; END IF;
  IF actual - 'general_writing_instructions' - 'version' - 'updated_at' IS DISTINCT FROM original - 'general_writing_instructions' - 'version' - 'updated_at' THEN RAISE EXCEPTION 'Other settings changed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM audit.event_log WHERE event_type='crm_writing_instructions_updated' AND after_state->>'version'=(v+1)::text) THEN RAISE EXCEPTION 'Missing audit'; END IF;
  RAISE EXCEPTION 'test_rollback_success';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'test_rollback_success' THEN RAISE; END IF;
 END;
 IF (SELECT to_jsonb(s) FROM app.settings s WHERE singleton) IS DISTINCT FROM original THEN RAISE EXCEPTION 'Rollback failed'; END IF;
END;
$test$;
