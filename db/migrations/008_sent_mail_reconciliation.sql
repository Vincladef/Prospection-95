-- Prospection 95 · réconciliation incrémentale des messages envoyés depuis Gmail.

CREATE OR REPLACE FUNCTION app.record_sent_message(
  p_mailbox_account_id uuid,
  p_conversation_id uuid,
  p_from_address text,
  p_to_addresses text[],
  p_subject text DEFAULT '',
  p_body_text text DEFAULT '',
  p_body_html text DEFAULT NULL,
  p_internet_message_id text DEFAULT NULL,
  p_in_reply_to text DEFAULT NULL,
  p_references_header text[] DEFAULT '{}'::text[],
  p_imap_mailbox text DEFAULT '__SENT__',
  p_imap_uidvalidity bigint DEFAULT NULL,
  p_imap_uid bigint DEFAULT NULL,
  p_sent_at timestamptz DEFAULT clock_timestamp(),
  p_raw_headers jsonb DEFAULT '{}'::jsonb
)
RETURNS app.email_messages
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
  result app.email_messages;
  target_prospect_id uuid;
  target_email text;
BEGIN
  IF p_conversation_id IS NULL
     OR cardinality(p_to_addresses) < 1
     OR coalesce(btrim(p_from_address), '') = ''
     OR jsonb_typeof(coalesce(p_raw_headers, '{}'::jsonb)) <> 'object'
     OR (p_internet_message_id IS NULL
         AND (p_imap_mailbox IS NULL OR p_imap_uidvalidity IS NULL OR p_imap_uid IS NULL))
     OR ((p_imap_uidvalidity IS NULL) <> (p_imap_uid IS NULL)) THEN
    RAISE EXCEPTION 'invalid_sent_message' USING ERRCODE = '22023';
  END IF;

  SELECT m.* INTO result
    FROM app.email_messages m
   WHERE (p_internet_message_id IS NOT NULL
          AND m.sender_account_id = p_mailbox_account_id
          AND m.internet_message_id = p_internet_message_id)
      OR (m.mailbox_account_id = p_mailbox_account_id
          AND p_imap_uid IS NOT NULL
          AND m.imap_mailbox = p_imap_mailbox
          AND m.imap_uidvalidity = p_imap_uidvalidity
          AND m.imap_uid = p_imap_uid)
   ORDER BY m.created_at LIMIT 1;

  IF result.id IS NOT NULL THEN
    UPDATE app.email_messages
       SET mailbox_account_id = coalesce(mailbox_account_id, p_mailbox_account_id),
           imap_mailbox = coalesce(imap_mailbox, p_imap_mailbox),
           imap_uidvalidity = coalesce(imap_uidvalidity, p_imap_uidvalidity),
           imap_uid = coalesce(imap_uid, p_imap_uid),
           sent_at = coalesce(sent_at, p_sent_at),
           updated_at = clock_timestamp()
     WHERE id = result.id
     RETURNING * INTO result;
  ELSE
    INSERT INTO app.email_messages (
      conversation_id, direction, kind, sender_account_id, mailbox_account_id,
      from_address, to_addresses, subject, body_text, body_html,
      internet_message_id, in_reply_to, references_header,
      imap_mailbox, imap_uidvalidity, imap_uid,
      status, sent_at, technical_confirmation, source, raw_headers
    ) VALUES (
      p_conversation_id, 'outbound', 'manual', p_mailbox_account_id,
      p_mailbox_account_id, p_from_address, p_to_addresses,
      coalesce(p_subject, ''), coalesce(p_body_text, ''), p_body_html,
      p_internet_message_id, p_in_reply_to, coalesce(p_references_header, '{}'::text[]),
      p_imap_mailbox, p_imap_uidvalidity, p_imap_uid,
      'sent_manually', p_sent_at, true, 'gmail_sent_sync',
      coalesce(p_raw_headers, '{}'::jsonb)
    ) RETURNING * INTO result;
  END IF;

  SELECT c.prospect_id, p.normalized_email
    INTO target_prospect_id, target_email
    FROM app.conversations c
    JOIN app.prospects p ON p.id = c.prospect_id
   WHERE c.id = p_conversation_id;

  UPDATE app.conversations
     SET state = 'active', last_outbound_at = greatest(coalesce(last_outbound_at, p_sent_at), p_sent_at),
         followups_stopped_at = coalesce(followups_stopped_at, clock_timestamp()),
         followups_stop_reason = coalesce(followups_stop_reason, 'manual_outbound'),
         next_step_due_at = NULL, updated_at = clock_timestamp(), version = version + 1
   WHERE id = p_conversation_id;

  UPDATE app.outbox_jobs
     SET status = 'cancelled', cancelled_at = clock_timestamp(),
         cancel_reason = 'manual_outbound', updated_at = clock_timestamp()
   WHERE conversation_id = p_conversation_id
     AND status IN ('requested','pending','scheduled','deferred','reserved');

  IF target_email IS NOT NULL THEN
    INSERT INTO app.contact_history (
      normalized_email, prospect_id, first_contact_at, confirmation_source,
      technically_confirmed, conversation_id, source_reference
    ) VALUES (
      target_email, target_prospect_id, p_sent_at, 'gmail_sent_sync', true,
      p_conversation_id, p_internet_message_id
    ) ON CONFLICT (normalized_email) DO UPDATE
      SET technically_confirmed = true,
          confirmation_source = CASE
            WHEN app.contact_history.confirmation_source = 'smtp_confirmed'
              THEN app.contact_history.confirmation_source
            ELSE 'gmail_sent_sync'
          END,
          first_contact_at = coalesce(app.contact_history.first_contact_at, EXCLUDED.first_contact_at),
          conversation_id = coalesce(app.contact_history.conversation_id, EXCLUDED.conversation_id),
          source_reference = coalesce(app.contact_history.source_reference, EXCLUDED.source_reference);
    UPDATE app.prospects
       SET contact_state = CASE WHEN contact_state = 'never_contacted'
                                THEN 'conversation_in_progress' ELSE contact_state END,
           updated_at = clock_timestamp()
     WHERE id = target_prospect_id;
  END IF;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION app.record_sent_message(uuid,uuid,text,text[],text,text,text,text,text,text[],text,bigint,bigint,timestamptz,jsonb)
  FROM PUBLIC, prospection95_agent;
GRANT EXECUTE ON FUNCTION app.record_sent_message(uuid,uuid,text,text[],text,text,text,text,text,text[],text,bigint,bigint,timestamptz,jsonb)
  TO prospection95_app;

INSERT INTO app.schema_migrations (version)
VALUES ('008_sent_mail_reconciliation')
ON CONFLICT (version) DO NOTHING;
