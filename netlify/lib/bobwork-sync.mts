import { fetchBobworkAccounts } from "./bobwork.mts";
import { sqlOne, sqlQuery } from "./db.mts";

function safeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value: String(value) };
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/secret|password|token|api.?key|credential|authorization/i.test(key))
    .slice(0, 50));
}

function scalarField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if ((typeof value === "string" || typeof value === "number") && String(value).trim()) return String(value).trim();
  }
  return null;
}

function booleanField(record: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) if (typeof record[key] === "boolean") return record[key] as boolean;
  return null;
}

export interface BobworkSyncResult {
  claimed: boolean;
  records: number;
  observedAt: string | null;
  sourceUrl: string | null;
}

export async function syncBobworkAccounts(force = false): Promise<BobworkSyncResult> {
  let claimed = false;
  try {
    const connection = await sqlOne<{ singleton: boolean }>(`
      update app.bobwork_connections
      set status = 'configured', last_sync_at = clock_timestamp(), last_error_code = null, updated_at = clock_timestamp()
      where singleton
        and ($1::boolean or last_sync_at is null or last_sync_at < clock_timestamp() - interval '5 hours')
      returning singleton
    `, [force]);
    if (!connection) return { claimed: false, records: 0, observedAt: null, sourceUrl: null };
    claimed = true;

    const result = await fetchBobworkAccounts();
    const records = result.records.slice(0, 100);
    for (const raw of records) {
      const record = safeRecord(raw);
      const email = scalarField(record, "email", "emailAddress", "email_address", "address")?.toLowerCase() ?? null;
      const account = email
        ? await sqlOne<{ id: string }>(
            `select id::text from app.gmail_accounts where normalized_email = app.canonical_email($1) and deleted_at is null`,
            [email],
          )
        : null;
      const explicitState = scalarField(record, "warmupState", "warmup_state", "warmupStatus", "warmup_status", "status")?.toLowerCase();
      const warmupState = explicitState && ["active", "paused", "interrupted", "inactive", "unknown"].includes(explicitState)
        ? explicitState
        : "unknown";
      const connected = booleanField(record, "connected", "isConnected", "is_connected");
      await sqlQuery(`
        insert into app.bobwork_snapshots
          (account_id, remote_account_ref, connected, warmup_state, metrics, anomalies, observed_at)
        values ($1::uuid, $2, $3, $4, $5::jsonb, '[]'::jsonb, $6::timestamptz)
      `, [account?.id ?? null, scalarField(record, "id", "accountId", "account_id", "mailboxId", "mailbox_id", "email"),
        connected, warmupState, JSON.stringify(record), result.observedAt]);
    }
    await sqlQuery(`
      update app.bobwork_connections
      set status = 'connected', last_sync_at = $1::timestamptz, last_error_code = null, updated_at = clock_timestamp()
      where singleton
    `, [result.observedAt]);
    return { claimed: true, records: records.length, observedAt: result.observedAt, sourceUrl: result.sourceUrl };
  } catch (error) {
    if (claimed) {
      const code = String((error as { code?: unknown }).code ?? (error as Error).name ?? "bobwork_sync_failed").slice(0, 120);
      await sqlQuery(`
        update app.bobwork_connections
        set status = 'error', last_error_code = $1, updated_at = clock_timestamp()
        where singleton
      `, [code]).catch(() => undefined);
    }
    throw error;
  }
}
