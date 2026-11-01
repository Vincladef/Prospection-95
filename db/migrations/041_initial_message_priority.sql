-- Eligible initial prospecting messages take the available quota before follow-ups.
-- Dates, quotas, account balancing and the final SMTP safety checks are preserved.
DO $priority$
DECLARE original text; changed text;
BEGIN
 original:=pg_get_functiondef('app.schedule_due_messages(integer)'::regprocedure);
 changed:=replace(original,'ORDER BY CASE WHEN m.step = ''J0'' THEN 1 ELSE 0 END,',
   'ORDER BY CASE WHEN m.step = ''J0'' THEN 0 ELSE 1 END,');
 IF changed=original THEN RAISE EXCEPTION 'initial_schedule_priority_target_missing'; END IF;
 EXECUTE changed;
 original:=pg_get_functiondef('app.lease_outbox_jobs(text,integer,integer)'::regprocedure);
 changed:=replace(original,'j.job_kind=''prospection'' AND j.step<>''J0''',
   'j.job_kind=''prospection'' AND j.step=''J0''');
 IF changed=original THEN RAISE EXCEPTION 'initial_account_priority_target_missing'; END IF;
 original:=changed;
 changed:=replace(original,'ORDER BY CASE WHEN j.step IN (''R1'',''R2'',''R3'',''R4'',''R5'') THEN 0 ELSE 1 END,',
   'ORDER BY CASE WHEN j.job_kind=''prospection'' AND j.step=''J0'' THEN 0 WHEN j.step IN (''R1'',''R2'',''R3'',''R4'',''R5'') THEN 1 ELSE 2 END,');
 IF changed=original THEN RAISE EXCEPTION 'initial_job_priority_target_missing'; END IF;
 EXECUTE changed;
END;
$priority$;
INSERT INTO app.schema_migrations(version) VALUES('041_initial_message_priority') ON CONFLICT(version) DO NOTHING;
