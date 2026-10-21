import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { requireEnv } from "./env.mts";

let client: NeonQueryFunction<false, false> | undefined;

export function database(): NeonQueryFunction<false, false> {
  if (!client) {
    client = neon(requireEnv("DATABASE_URL"), {
      fetchOptions: { cache: "no-store" },
    });
  }
  return client;
}

export async function sqlQuery<T extends object = Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const rows = await database().query(text, [...params]);
  return rows as T[];
}

export async function sqlOne<T extends object = Record<string, unknown>>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await sqlQuery<T>(text, params);
  return rows[0] ?? null;
}

export async function pingDatabase(): Promise<boolean> {
  const row = await sqlOne<{ ok: number }>("select 1::int as ok");
  return row?.ok === 1;
}

export async function sqlTransaction(
  statements: ReadonlyArray<{ text: string; params?: readonly unknown[] }>,
): Promise<Record<string, unknown>[][]> {
  if (!statements.length) return [];
  const results = await database().transaction((transaction) =>
    statements.map((statement) =>
      transaction.query(statement.text, [...(statement.params ?? [])]),
    ),
  );
  return results as Record<string, unknown>[][];
}

export function resetDatabaseForTests(): void {
  client = undefined;
}
