-- Prospection 95 · expose les comptes autorisés et fige l'attribution d'une conversation.

CREATE OR REPLACE VIEW agent_api.campaign_parameters
WITH (security_barrier = true)
AS
SELECT
  c.id AS campaign_id,
  c.name,
  c.status,
  c.target_description,
  c.qualification_criteria,
  c.daily_new_contact_goal,
  c.validation_policy,
  c.sender_strategy,
  c.fixed_sender_account_id,
  c.ai_instructions,
  c.reply_instructions,
  c.tracking_opens_enabled,
  c.tracking_clicks_enabled,
  c.experiment_policy,
  c.next_test_instructions,
  c.version,
  c.updated_at,
  CASE
    WHEN c.sender_strategy = 'fixed' THEN ARRAY[c.fixed_sender_account_id]::uuid[]
    ELSE coalesce((
      SELECT array_agg(csa.account_id ORDER BY csa.account_id)
      FROM app.campaign_sender_accounts csa
      JOIN app.gmail_accounts a ON a.id = csa.account_id
      WHERE csa.campaign_id = c.id AND csa.enabled
        AND a.status = 'active' AND a.paused_at IS NULL AND a.deleted_at IS NULL
    ), '{}'::uuid[])
  END AS allowed_sender_account_ids
FROM app.campaigns c
WHERE c.archived_at IS NULL;

CREATE OR REPLACE FUNCTION app.persist_conversation_sender()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
BEGIN
  UPDATE app.campaign_prospects
     SET assigned_sender_account_id = NEW.sender_account_id,
         updated_at = clock_timestamp()
   WHERE campaign_id = NEW.campaign_id AND prospect_id = NEW.prospect_id
     AND assigned_sender_account_id IS NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS persist_conversation_sender ON app.conversations;
CREATE TRIGGER persist_conversation_sender
AFTER INSERT ON app.conversations
FOR EACH ROW EXECUTE FUNCTION app.persist_conversation_sender();

REVOKE ALL ON FUNCTION app.persist_conversation_sender() FROM PUBLIC, prospection95_agent;
GRANT EXECUTE ON FUNCTION app.persist_conversation_sender() TO prospection95_app;

INSERT INTO app.schema_migrations (version)
VALUES ('009_campaign_sender_contract')
ON CONFLICT (version) DO NOTHING;
