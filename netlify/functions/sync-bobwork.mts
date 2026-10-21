import { randomUUID } from "node:crypto";
import type { Config, Context } from "@netlify/functions";
import { fetchBobworkAccounts } from "../lib/bobwork.mts";
import { sqlOne, sqlQuery } from "../lib/db.mts";
import { workerFailure, workerResult } from "../lib/worker-response.mts";

function safeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value: String(value) };
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !/secret|password|token|api.?key|credential|authorization/i.test(key))
    .slice(0, 50));
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) if (typeof record[key] === "string" && record[key]) return record[key] as string;
  return null;
}

export default async function syncBobwork(_request: Request, _context: Context): Promise<Response> {
  const worker = `netlify-bobwork-${randomUUID()}`;
  let credentialId: string | null = null;
  try {
    const connection = await sqlOne<{ credential_id: string }>(`
      update app.bobwork_connections set last_sync_at = clock_timestamp(), last_error_code = null
      where singleton and credential_id is not null
        and status in ('configured','connected','error')
        and (last_sync_at is null or last_sync_at < clock_timestamp() - interval '5 hours')
      returning credential_id::text
    `);
    if (!connection) return workerResult(worker, { ok: true, claimed: 0 });
    credentialId = connection.credential_id;
    const result = await fetchBobworkAccounts(credentialId);
    const records = result.records.slice(0, 100);
    for (const raw of records) {
      const record = safeRecord(raw);
      const email = stringField(record, "email", "emailAddress", "address")?.toLowerCase() ?? null;
      const account = email ? await sqlOne<{ id: string }>(`select id::text from app.gmail_accounts where normalized_email = app.canonical_email($1) and deleted_at is null`, [email]) : null;
      const explicitState = stringField(record, "warmupState", "warmup_state", "status");
      const warmupState = explicitState && ["active", "paused", "interrupted", "inactive", "unknown"].includes(explicitState)
        ? explicitState : "unknown";
      const connected = typeof record.connected === "boolean" ? record.connected : null;
      await sqlQuery(`
        insert into app.bobwork_snapshots
          (account_id, remote_account_ref, connected, warmup_state, metrics, anomalies, observed_at)
        values ($1::uuid, $2, $3, $4, $5::jsonb, '[]'::jsonb, $6::timestamptz)
      `, [account?.id ?? null, stringField(record, "id", "accountId", "account_id", "email"), connected,
        warmupState, JSON.stringify(record), result.observedAt]);
    }
    await sqlQuery(`update app.bobwork_connections set status = 'connected', last_sync_at = $1::timestamptz, last_error_code = null where singleton`, [result.observedAt]);
    return workerResult(worker, { ok: true, records: records.length, sourceUrl: result.sourceUrl });
  } catch (error) {
    if (credentialId) {
      const code = String((error as { code?: unknown }).code ?? (error as Error).name ?? "bobwork_sync_failed").slice(0, 120);
      await sqlQuery(`update app.bobwork_connections set status = 'error', last_error_code = $1 where singleton`, [code]).catch(() => undefined);
    }
    return workerFailure(worker, error);
  }
}

export const config: Config = { schedule: "17 */6 * * *" };
