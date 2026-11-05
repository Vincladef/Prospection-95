-- Allow the normal reply workflow to acknowledge a simple refusal once.
-- All opt-out, exclusion, campaign, freshness and manual-reply guards remain.
DO $migration$
DECLARE original text; revised text;
BEGIN
 original:=pg_get_functiondef('app.reply_source_is_current(uuid)'::regprocedure);
 revised:=replace(original,
  'a.classification IN (''positive'',''information'',''meeting'',''ambiguous'')',
  'a.classification IN (''positive'',''information'',''meeting'',''ambiguous'',''negative'')');
 IF revised=original THEN RAISE EXCEPTION 'refusal_eligibility_patch_missing'; END IF;
 EXECUTE revised;
END;
$migration$;
INSERT INTO app.schema_migrations(version) VALUES('048_polite_refusal_acknowledgement') ON CONFLICT DO NOTHING;
