-- Prospection 95 · validation complète des séquences et répartition des envois.

BEGIN;

-- Calcule un instant d'envoi dans la prochaine plage autorisée du compte.
-- L'offset est pseudo-aléatoire mais stable pour une même clé : un rejeu ne
-- déplace donc pas continuellement le même message.
CREATE OR REPLACE FUNCTION app.next_account_send_at(
  p_account_id uuid,
  p_not_before timestamptz,
  p_random_key text
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $next_account_send_at$
DECLARE
  account_row app.gmail_accounts;
  not_before timestamptz := coalesce(p_not_before, clock_timestamp());
  local_not_before timestamp;
  day_value date;
  window_start timestamp;
  window_end timestamp;
  earliest_local timestamp;
  span_seconds integer;
  offset_seconds integer;
  hash_value numeric;
  day_offset integer;
BEGIN
  SELECT * INTO account_row
    FROM app.gmail_accounts
   WHERE id = p_account_id
     AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gmail_account_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names tz
     WHERE tz.name = account_row.timezone
  ) THEN
    RAISE EXCEPTION 'invalid_account_timezone' USING ERRCODE = '22023';
  END IF;

  local_not_before := not_before AT TIME ZONE account_row.timezone;
  hash_value := abs(pg_catalog.hashtextextended(coalesce(p_random_key, ''), 0)::numeric);

  FOR day_offset IN 0..14 LOOP
    day_value := local_not_before::date + day_offset;
    IF extract(isodow FROM day_value)::smallint = ANY(account_row.send_days) THEN
      window_start := day_value + account_row.send_start;
      window_end := day_value + account_row.send_end;
      earliest_local := CASE
        WHEN day_offset = 0 THEN greatest(local_not_before, window_start)
        ELSE window_start
      END;

      IF earliest_local < window_end THEN
        IF account_row.randomize_send_times THEN
          span_seconds := floor(extract(epoch FROM window_end - earliest_local))::integer;
          offset_seconds := CASE
            WHEN span_seconds > 0 THEN mod(hash_value, span_seconds)::integer
            ELSE 0
          END;
          earliest_local := earliest_local + make_interval(secs => offset_seconds);
        END IF;
        RETURN earliest_local AT TIME ZONE account_row.timezone;
      END IF;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'no_allowed_send_window' USING ERRCODE = '22023';
END;
$next_account_send_at$;

REVOKE ALL ON FUNCTION app.next_account_send_at(uuid,timestamptz,text)
  FROM PUBLIC, prospection95_agent;
GRANT EXECUTE ON FUNCTION app.next_account_send_at(uuid,timestamptz,text)
  TO prospection95_app;

-- Le prochain contenu validé est matérialisé au moment où il devient dû. La
-- date du job respecte désormais les jours, le fuseau et la plage du compte ;
-- le lease existant continue d'imposer les quotas et de revérifier la plage.
CREATE OR REPLACE FUNCTION app.schedule_due_messages(p_limit integer DEFAULT 50)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $schedule_due_messages$
DECLARE scheduled_count integer;
BEGIN
  IF p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_schedule_limit' USING ERRCODE = '22023';
  END IF;

  WITH next_messages AS (
    SELECT conv.id AS conversation_id, conv.campaign_id, conv.prospect_id,
           conv.sender_account_id, c.validation_policy, m.id AS message_id,
           m.step,
           app.next_account_send_at(
             conv.sender_account_id,
             clock_timestamp(),
             m.id::text
           ) AS job_due_at
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
           AND candidate.status IN ('prepared','pending_approval','approved','scheduled')
           AND NOT EXISTS (
             SELECT 1 FROM app.email_messages newer
              WHERE newer.conversation_id = candidate.conversation_id
                AND newer.step = candidate.step
                AND newer.direction = 'outbound'
                AND newer.content_version > candidate.content_version
           )
         ORDER BY array_position(
           ARRAY['J0','R1','R2','R3','R4','R5']::app.sequence_step[],
           candidate.step
         )
         LIMIT 1
      ) m ON true
     WHERE c.status = 'active' AND NOT c.imported_disabled
       AND conv.followups_stopped_at IS NULL
       AND p.deleted_at IS NULL AND p.normalized_email IS NOT NULL
       AND NOT app.is_excluded(p.normalized_email)
       AND a.status = 'active' AND a.paused_at IS NULL AND a.credential_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM pg_catalog.pg_timezone_names tz WHERE tz.name = a.timezone
       )
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
           n.job_due_at, 'sequence:' || n.message_id::text
      FROM next_messages n
    ON CONFLICT (idempotency_key) DO UPDATE
      SET status = 'scheduled',
          approval_required = EXCLUDED.approval_required,
          approved_at = EXCLUDED.approved_at,
          due_at = EXCLUDED.due_at,
          cancelled_at = NULL,
          cancel_reason = NULL,
          lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          updated_at = clock_timestamp()
      WHERE app.outbox_jobs.status = 'cancelled'
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
$schedule_due_messages$;

REVOKE ALL ON FUNCTION app.schedule_due_messages(integer)
  FROM PUBLIC, prospection95_agent;
GRANT EXECUTE ON FUNCTION app.schedule_due_messages(integer)
  TO prospection95_app;

INSERT INTO app.schema_migrations (version)
VALUES ('022_sequence_validation_and_send_distribution')
ON CONFLICT (version) DO NOTHING;

COMMIT;
