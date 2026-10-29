-- Views use their owner's table privileges, but scalar function calls require
-- caller EXECUTE. Keep CRM isolated from app functions by reading exclusions
-- through the view owner's privileges, with the same email/domain matching.
CREATE OR REPLACE VIEW crm_api.pending_sequences
WITH (security_barrier = true)
AS
WITH latest AS (
  SELECT DISTINCT ON (m.conversation_id, m.step)
    m.conversation_id, m.id AS message_id, m.step, m.subject, m.body_text,
    m.status, m.content_version
  FROM app.email_messages m
  WHERE m.direction='outbound' AND m.kind='prospection'
    AND NOT m.technical_confirmation AND m.step IS NOT NULL
  ORDER BY m.conversation_id, m.step, m.content_version DESC, m.created_at DESC, m.id DESC
)
SELECT c.id AS campaign_id, c.name AS campaign_name, c.status AS campaign_status,
       conv.id AS conversation_id, conv.experiment_assignment_id,
       p.id AS prospect_id, p.version AS prospect_version,
       p.full_name, p.job_title, p.email, p.website_url,
       p.source_label, p.source_url, p.source_evidence,
       o.name AS organization_name,
       min(l.subject) FILTER (WHERE l.step='J0') AS subject,
       jsonb_agg(jsonb_build_object(
         'step',l.step,'messageId',l.message_id,'contentVersion',l.content_version,
         'status',l.status,'body',l.body_text
       ) ORDER BY array_position(ARRAY['J0','R1','R2','R3','R4','R5']::app.sequence_step[], l.step)) AS messages
FROM latest l
JOIN app.conversations conv ON conv.id=l.conversation_id
JOIN app.campaigns c ON c.id=conv.campaign_id
JOIN app.prospects p ON p.id=conv.prospect_id AND p.deleted_at IS NULL
LEFT JOIN app.organizations o ON o.id=p.organization_id
WHERE c.validation_policy='manual'
  AND conv.followups_stopped_at IS NULL
  AND conv.state NOT IN ('opposition','replied','cancelled','unresolved')
  AND p.contact_kind='email'
  AND p.normalized_email IS NOT NULL
  AND p.contact_state <> 'do_not_contact'
  AND NOT EXISTS (
    SELECT 1 FROM app.exclusions e
    WHERE e.revoked_at IS NULL AND (
      (e.match_type='email' AND e.normalized_value=p.normalized_email)
      OR (e.match_type='domain' AND e.normalized_value=split_part(p.normalized_email,'@',2))
    )
  )
  AND l.status IN ('draft','prepared','pending_approval')
  AND NOT EXISTS (
    SELECT 1 FROM app.email_messages old
    WHERE old.conversation_id=conv.id AND old.direction='outbound'
      AND old.kind='prospection'
      AND (old.technical_confirmation OR old.sent_at IS NOT NULL
        OR old.smtp_accepted_at IS NOT NULL OR old.internet_message_id IS NOT NULL
        OR old.status IN ('reserved','sending','smtp_accepted','sent_manually','uncertain'))
  )
  AND NOT EXISTS (
    SELECT 1 FROM app.message_approvals approval
    JOIN app.email_messages old ON old.id=approval.message_id
    WHERE old.conversation_id=conv.id AND approval.approved
  )
  AND NOT EXISTS (
    SELECT 1 FROM app.outbox_jobs job
    WHERE job.conversation_id=conv.id AND job.status NOT IN ('cancelled','failed')
  )
  AND EXISTS (
    SELECT 1 FROM app.prospect_iteration_states s
    WHERE s.campaign_id=conv.campaign_id AND s.prospect_id=conv.prospect_id
      AND s.experiment_assignment_id IS NOT DISTINCT FROM conv.experiment_assignment_id
      AND s.status='completed' AND s.completed_iterations=s.total_iterations
  )
GROUP BY c.id,c.name,c.status,conv.id,conv.experiment_assignment_id,
         p.id,p.version,p.full_name,p.job_title,p.email,p.website_url,
         p.source_label,p.source_url,p.source_evidence,o.name
HAVING count(*)=6 AND count(DISTINCT l.step)=6;

INSERT INTO app.schema_migrations(version)
VALUES ('028_crm_sequence_view_permissions') ON CONFLICT DO NOTHING;
