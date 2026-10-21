-- Retour de sécurité non destructif : bloque tout envoi sans supprimer de donnée.
BEGIN;
UPDATE app.settings
SET outbound_enabled = false,
    emergency_stop = true,
    emergency_stop_reason = 'Retour de sécurité administrateur',
    emergency_stop_changed_at = clock_timestamp(),
    emergency_stop_changed_by = 'rollback-script',
    version = version + 1,
    updated_at = clock_timestamp()
WHERE singleton;

UPDATE app.outbox_jobs
SET status = 'deferred',
    last_error_code = 'GLOBAL_SAFETY_STOP',
    last_error_detail = 'Traitement différé par le script de retour de sécurité',
    lease_owner = NULL,
    lease_token = NULL,
    lease_expires_at = NULL,
    updated_at = clock_timestamp()
WHERE status IN ('pending','scheduled','reserved','running');
COMMIT;
