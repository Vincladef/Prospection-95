import { sqlQuery } from "./db.mts";

export async function auditEvent(input: {
  actor: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  requestId?: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await sqlQuery(
    `select audit.log_event(
       'user', $1, $2::uuid, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb
     )`,
    [
      input.actor,
      input.requestId ?? null,
      input.action,
      input.entityType,
      input.entityId ?? null,
      JSON.stringify(input.before ?? null),
      JSON.stringify(input.after ?? null),
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}
