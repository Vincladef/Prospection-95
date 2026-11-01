-- Reuse the hourly observations for either analysis, independently.
DO $migration$
DECLARE src text;
BEGIN
 src:=pg_get_functiondef('app.record_interaction_bucket(uuid,text,text)'::regprocedure);
 src:=replace(src,'m.advanced_interactions_enabled AND c.advanced_interactions_enabled',
 '( (m.advanced_interactions_enabled AND c.advanced_interactions_enabled) OR (m.read_delay_enabled AND c.read_delay_enabled AND m.tracking_opens_enabled AND c.tracking_opens_enabled AND m.tracking_clicks_enabled AND c.tracking_clicks_enabled) )');
 IF position('OR (m.read_delay_enabled' IN src)=0 THEN RAISE EXCEPTION 'independent_collection_patch_failed'; END IF;
 EXECUTE src;
 src:=pg_get_viewdef('app.message_engagement'::regclass,true);
 IF position(' AND m.advanced_interactions_enabled' IN src)=0 THEN RAISE EXCEPTION 'independent_delay_view_patch_failed'; END IF;
 src:=replace(src,' AND m.advanced_interactions_enabled','');
 EXECUTE 'CREATE OR REPLACE VIEW app.message_engagement WITH(security_barrier=true) AS '||src;
END;
$migration$;
INSERT INTO app.schema_migrations(version) VALUES('044_independent_interaction_analyses') ON CONFLICT(version) DO NOTHING;
