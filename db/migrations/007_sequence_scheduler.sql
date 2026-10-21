-- Prospection 95 · matérialisation déterministe de la prochaine étape J0–R5.

CREATE OR REPLACE FUNCTION app.schedule_due_messages(p_limit integer DEFAULT 50)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE scheduled_count integer;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_schedule_limit' USING ERRCODE = '22023';
  END IF;

  WITH next_messages AS (
    SELECT conv.id AS conversation_id, conv.campaign_id, conv.prospect_id,
           conv.sender_account_id, c.validation_policy, m.id AS message_id, m.step
      FROM app.conversations conv
      JOIN app.campaigns c ON c.id = conv.campaign_id
      JOIN app.prospects p ON p.id = conv.prospect_id
      JOIN app.gmail_accounts a ON a.id = conv.sender_account_id
      JOIN LATERAL (
        SELECT candidate.id, candidate.step, candidate.status
          FROM app.email_messages candidate
         WHERE candidate.conversation_id = conv.id
           AND candidate.direction = 'outbound'
           AND candidate.kind = 'prospection'
           AND NOT candidate.technical_confirmation
           AND candidate.status NOT IN ('cancelled','failed','uncertain')
           AND NOT EXISTS (
             SELECT 1 FROM app.email_messages newer
              WHERE newer.conversation_id = candidate.conversation_id
                AND newer.step = candidate.step
                AND newer.direction = 'outbound'
                AND newer.content_version > candidate.content_version
           )
         ORDER BY array_position(ARRAY['J0','R1','R2','R3','R4','R5']::app.sequence_step[], candidate.step)
         LIMIT 1
      ) m ON true
     WHERE c.status = 'active' AND NOT c.imported_disabled
       AND conv.followups_stopped_at IS NULL
       AND p.deleted_at IS NULL AND p.normalized_email IS NOT NULL
       AND NOT app.is_excluded(p.normalized_email)
       AND a.status = 'active' AND a.paused_at IS NULL AND a.credential_id IS NOT NULL
       AND (
         (m.step = 'J0' AND NOT EXISTS (
            SELECT 1 FROM app.contact_history h WHERE h.normalized_email = p.normalized_email
          ))
         OR
         (m.step <> 'J0' AND conv.next_step_due_at IS NOT NULL
                         AND conv.next_step_due_at <= clock_timestamp())
       )
       AND (
         (c.validation_policy = 'automatic' AND m.status IN ('prepared','approved','scheduled'))
         OR
         (c.validation_policy = 'manual' AND m.status IN ('approved','scheduled'))
       )
       AND NOT EXISTS (
         SELECT 1 FROM app.outbox_jobs existing
          WHERE existing.message_id = m.id
            AND existing.status NOT IN ('failed','cancelled')
       )
     ORDER BY CASE WHEN m.step = 'J0' THEN 1 ELSE 0 END,
              coalesce(conv.next_step_due_at, conv.created_at), conv.created_at
     FOR UPDATE OF conv SKIP LOCKED
     LIMIT p_limit
  ), inserted AS (
    INSERT INTO app.outbox_jobs (
      message_id, conversation_id, campaign_id, prospect_id, account_id, step,
      job_kind, status, approval_required, approved_at, due_at, idempotency_key
    )
    SELECT n.message_id, n.conversation_id, n.campaign_id, n.prospect_id,
           n.sender_account_id, n.step, 'prospection', 'scheduled',
           n.validation_policy = 'manual',
           CASE WHEN n.validation_policy = 'manual' THEN clock_timestamp() ELSE NULL END,
           clock_timestamp(), 'sequence:' || n.message_id::text
      FROM next_messages n
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING message_id, conversation_id
  ), changed_messages AS (
    UPDATE app.email_messages m
       SET status = 'scheduled', updated_at = clock_timestamp()
      FROM inserted i WHERE m.id = i.message_id
    RETURNING m.id
  ), changed_conversations AS (
    UPDATE app.conversations c
       SET state = 'active', updated_at = clock_timestamp(), version = version + 1
      FROM inserted i WHERE c.id = i.conversation_id
    RETURNING c.id
  )
  SELECT count(*)::integer INTO scheduled_count FROM inserted;

  RETURN coalesce(scheduled_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION app.schedule_due_messages(integer) FROM PUBLIC, prospection95_agent;
GRANT EXECUTE ON FUNCTION app.schedule_due_messages(integer) TO prospection95_app;

GRANT USAGE ON SCHEMA agent_api TO prospection95_app;
GRANT EXECUTE ON FUNCTION agent_api.request_diagnostic(uuid,uuid,uuid,text,uuid,text,integer)
  TO prospection95_app;

INSERT INTO app.schema_migrations (version)
VALUES ('007_sequence_scheduler')
ON CONFLICT (version) DO NOTHING;
