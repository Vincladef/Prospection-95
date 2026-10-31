-- Preserve current automatic campaigns, use the safer scope for new campaigns.
ALTER TABLE app.campaigns ADD COLUMN reply_auto_scope text NOT NULL DEFAULT 'all' CHECK(reply_auto_scope IN ('first','all'));
UPDATE app.campaigns SET reply_auto_scope='first' WHERE reply_mode='draft';
ALTER TABLE app.campaigns ALTER COLUMN reply_auto_scope SET DEFAULT 'first';
ALTER TABLE app.reply_workflows ADD COLUMN base_instructions text NOT NULL DEFAULT '';
ALTER TABLE app.reply_workflows ADD COLUMN attachment_context jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE FUNCTION app.reply_source_is_first_exchange(p_source uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $first$
 SELECT EXISTS(SELECT 1 FROM app.email_messages source WHERE source.id=p_source AND source.direction='inbound' AND source.kind='reply'
 AND NOT EXISTS(SELECT 1 FROM app.email_messages prior LEFT JOIN app.inbound_analyses a ON a.message_id=prior.id
   WHERE prior.conversation_id=source.conversation_id AND prior.direction='inbound' AND prior.kind='reply'
   AND (a.classification IS NULL OR a.classification NOT IN ('automatic_reply','out_of_office','bounce','unrelated'))
   AND (coalesce(prior.received_at,prior.created_at),prior.created_at,prior.id)<(coalesce(source.received_at,source.created_at),source.created_at,source.id)));
$first$;
CREATE FUNCTION app.reply_attachment_context(p_campaign uuid,p_assignment uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,app AS $attachments$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'filename',a.filename,'contentType',a.content_type,'text',a.extracted_text) ORDER BY a.created_at,a.id),'[]'::jsonb)
 FROM app.instruction_attachments a WHERE a.deleted_at IS NULL AND (a.scope_type='global' OR
 (a.campaign_id=p_campaign AND (a.field_key='reply' OR a.field_key=(SELECT 'variant:'||variant_id||':reply' FROM app.experiment_assignments WHERE id=p_assignment))));
$attachments$;
REVOKE ALL ON FUNCTION app.reply_source_is_first_exchange(uuid),app.reply_attachment_context(uuid,uuid) FROM PUBLIC,prospection95_agent,prospection95_crm;
GRANT EXECUTE ON FUNCTION app.reply_source_is_first_exchange(uuid),app.reply_attachment_context(uuid,uuid) TO prospection95_app;

-- Freeze the context of cycles already started before moving the legacy text.
UPDATE app.reply_workflows w SET
 base_instructions=coalesce(v.overrides->'reply'->>'replyInstructions',c.reply_instructions),
 attachment_context=app.reply_attachment_context(w.campaign_id,conv.experiment_assignment_id)
 FROM app.conversations conv JOIN app.campaigns c ON c.id=conv.campaign_id
 LEFT JOIN app.experiment_assignments a ON a.id=conv.experiment_assignment_id
 LEFT JOIN app.experiment_variants v ON v.id=a.variant_id WHERE conv.id=w.conversation_id;

-- One visible list of steps: combine general reply instructions with pass one,
-- preserving the number/order of passes and the meaning of A/B overrides.
UPDATE app.experiment_variants v SET overrides=jsonb_set(v.overrides,'{reply}',
 ((v.overrides->'reply')-'replyInstructions')||jsonb_build_object('replyIterations',
   to_jsonb(ARRAY[concat_ws(E'\n\n',nullif(v.overrides->'reply'->>'replyInstructions',''),nullif(c.reply_iteration_instructions[1],''))]||coalesce(c.reply_iteration_instructions[2:cardinality(c.reply_iteration_instructions)],'{}'::text[])))),
 version=v.version+1 FROM app.experiments e JOIN app.campaigns c ON c.id=e.campaign_id
 WHERE v.experiment_id=e.id AND jsonb_typeof(v.overrides->'reply'->'replyInstructions')='string'
 AND NOT (v.overrides->'reply'?'replyIterations');
UPDATE app.campaigns SET reply_iteration_instructions=ARRAY[concat_ws(E'\n\n',nullif(reply_instructions,''),nullif(reply_iteration_instructions[1],''))]||coalesce(reply_iteration_instructions[2:cardinality(reply_iteration_instructions)],'{}'::text[]),
 reply_instructions='',version=version+1 WHERE reply_instructions<>'';

-- Older clients may still write replyInstructions: normalize without losing it.
CREATE FUNCTION app.normalize_reply_instructions() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $normalize$
BEGIN
 IF coalesce(NEW.reply_instructions,'')<>'' THEN
  IF TG_OP='UPDATE' AND NEW.reply_iteration_instructions IS NOT DISTINCT FROM OLD.reply_iteration_instructions THEN
   NEW.reply_iteration_instructions[1]:=NEW.reply_instructions;
  ELSE
   NEW.reply_iteration_instructions[1]:=concat_ws(E'\n\n',nullif(NEW.reply_instructions,''),nullif(NEW.reply_iteration_instructions[1],''));
  END IF;
  NEW.reply_instructions:='';
 END IF;
 RETURN NEW;
END;
$normalize$;
REVOKE ALL ON FUNCTION app.normalize_reply_instructions() FROM PUBLIC,prospection95_agent,prospection95_crm;
CREATE TRIGGER normalize_reply_instructions BEFORE INSERT OR UPDATE OF reply_instructions,reply_iteration_instructions ON app.campaigns FOR EACH ROW EXECUTE FUNCTION app.normalize_reply_instructions();

DO $workflow$
DECLARE old text; revised text;
BEGIN
 old:=pg_get_functiondef('agent_api.claim_reply_iteration(uuid,uuid,text)'::regprocedure);
 revised:=replace(old,'campaign_id,mode,instructions)', 'campaign_id,mode,instructions,base_instructions,attachment_context)');
 revised:=replace(revised,'VALUES(p_source_message_id,conv.id,c.id,c.reply_mode,c.reply_iteration_instructions)',
 $patch$VALUES(p_source_message_id,conv.id,c.id,
 CASE WHEN c.reply_mode='automatic' AND c.reply_auto_scope='first' AND NOT app.reply_source_is_first_exchange(p_source_message_id) THEN 'draft' ELSE c.reply_mode END,
 coalesce((SELECT ARRAY(SELECT jsonb_array_elements_text(v.overrides->'reply'->'replyIterations')) FROM app.experiment_assignments a JOIN app.experiment_variants v ON v.id=a.variant_id
   WHERE a.id=conv.experiment_assignment_id AND jsonb_typeof(v.overrides->'reply'->'replyIterations')='array'),c.reply_iteration_instructions),
 coalesce((SELECT CASE WHEN v.overrides->'reply'?'replyIterations' THEN '' ELSE v.overrides->'reply'->>'replyInstructions' END
   FROM app.experiment_assignments a JOIN app.experiment_variants v ON v.id=a.variant_id WHERE a.id=conv.experiment_assignment_id),c.reply_instructions),
 app.reply_attachment_context(c.id,conv.experiment_assignment_id))$patch$);
 revised:=replace(revised,
 $old$'replyInstructions',coalesce((SELECT v.overrides->'reply'->>'replyInstructions' FROM app.experiment_assignments a
      JOIN app.experiment_variants v ON v.id=a.variant_id WHERE a.id=conv.experiment_assignment_id),c.reply_instructions),$old$,
 $new$'replyInstructions',w.base_instructions,'replyAttachments',w.attachment_context,'replyMode',w.mode,$new$);
 IF revised=old OR position('replyAttachments' IN revised)=0 THEN RAISE EXCEPTION 'reply_claim_patch_missing'; END IF;
 EXECUTE revised;
 old:=pg_get_functiondef('agent_api.complete_reply_iteration(uuid,uuid,text,text,text)'::regprocedure);
 revised:=replace(old,'IF w.mode=''automatic'' AND c.reply_mode=''automatic'' THEN',
   'IF w.mode=''automatic'' AND c.reply_mode=''automatic'' AND (c.reply_auto_scope=''all'' OR app.reply_source_is_first_exchange(w.source_message_id)) THEN');
 IF revised=old THEN RAISE EXCEPTION 'reply_completion_scope_patch_missing'; END IF;
 EXECUTE revised;
 old:=pg_get_functiondef('app.reply_job_is_ready(uuid)'::regprocedure);
 revised:=replace(old,'AND app.reply_source_is_current(w.source_message_id)',
   'AND (c.reply_auto_scope=''all'' OR app.reply_source_is_first_exchange(w.source_message_id)) AND app.reply_source_is_current(w.source_message_id)');
 IF revised=old THEN RAISE EXCEPTION 'reply_dispatch_scope_patch_missing'; END IF;
 EXECUTE revised;
 old:=pg_get_functiondef('app.switch_queued_replies_to_drafts()'::regprocedure);
 revised:=replace(old,'IF OLD.reply_mode=''automatic'' AND NEW.reply_mode=''draft'' THEN',
   'IF (OLD.reply_mode=''automatic'' AND NEW.reply_mode=''draft'') OR (OLD.reply_auto_scope=''all'' AND NEW.reply_auto_scope=''first'') THEN');
 revised:=replace(revised,'rw.state=''queued''', 'rw.state=''queued'' AND (NEW.reply_mode=''draft'' OR NOT app.reply_source_is_first_exchange(rw.source_message_id))');
 IF revised=old THEN RAISE EXCEPTION 'reply_queued_scope_patch_missing'; END IF;
 EXECUTE revised;
END;
$workflow$;
DROP TRIGGER switch_queued_replies_to_drafts ON app.campaigns;
CREATE TRIGGER switch_queued_replies_to_drafts AFTER UPDATE OF reply_mode,reply_auto_scope ON app.campaigns FOR EACH ROW EXECUTE FUNCTION app.switch_queued_replies_to_drafts();

DO $settings$
DECLARE old text; revised text;
BEGIN
 old:=pg_get_functiondef('crm_api.crm_campaign_update(uuid,bigint,jsonb)'::regprocedure);
 revised:=replace(old,'''replyMode'',','''replyMode'',''replyAutoScope'',');
 revised:=replace(revised,'UPDATE app.campaigns SET',
 $patch$IF p_patch?'replyAutoScope' AND coalesce(p_patch->>'replyAutoScope','') NOT IN ('first','all') THEN RAISE EXCEPTION 'crm_invalid_reply_scope'; END IF;
 UPDATE app.campaigns SET reply_auto_scope=CASE WHEN p_patch?'replyAutoScope' THEN p_patch->>'replyAutoScope' ELSE reply_auto_scope END,$patch$);
 revised:=replace(revised,'length(v#>>''{}'')>200000','length(v#>>''{}'')>400000');
 IF revised=old THEN RAISE EXCEPTION 'crm_reply_scope_patch_missing'; END IF;
 EXECUTE revised;
 old:=pg_get_functiondef('crm_api.crm_campaign_create(jsonb,text)'::regprocedure);
 revised:=replace(replace(old,'coalesce((c->>''trackingOpensEnabled'')::boolean,false)','coalesce((c->>''trackingOpensEnabled'')::boolean,true)'),
   'coalesce((c->>''trackingClicksEnabled'')::boolean,false)','coalesce((c->>''trackingClicksEnabled'')::boolean,true)');
 IF revised=old THEN RAISE EXCEPTION 'crm_tracking_defaults_patch_missing'; END IF;
 EXECUTE revised;
 EXECUTE 'CREATE OR REPLACE VIEW crm_api.campaigns WITH(security_barrier=true) AS '||replace(pg_get_viewdef('crm_api.campaigns'::regclass,true),'FROM app.campaigns c;',', c.reply_auto_scope FROM app.campaigns c;');
 EXECUTE 'CREATE OR REPLACE VIEW agent_api.campaign_parameters WITH(security_barrier=true) AS '||replace(pg_get_viewdef('agent_api.campaign_parameters'::regclass,true),'FROM app.campaigns c',', c.reply_auto_scope FROM app.campaigns c');
END;
$settings$;
INSERT INTO app.schema_migrations(version) VALUES('036_reply_scope_and_unified_instructions') ON CONFLICT(version) DO NOTHING;
