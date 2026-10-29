import type { BlacklistPage } from "../../src/types.js";
import { sqlOne } from "./db.mts";

export const BLACKLIST_PAGE_SIZE = 50;

// Read the existing active exclusions directly: no prospect creation or joins
// that could multiply rows. The active unique index already prevents duplicates.
export async function loadBlacklist(query: string, page: number): Promise<BlacklistPage> {
  const result = await sqlOne<BlacklistPage>(`
    with filtered as (
      select id, match_type, match_value, reason, created_at
      from app.exclusions
      where revoked_at is null
        and ($1 = '' or strpos(lower(match_value || ' ' || coalesce(reason, '')), lower($1)) > 0)
    ), page_entries as (
      select id::text, match_type as "matchType", match_value as "matchValue",
             reason, created_at as "createdAt"
      from filtered
      order by created_at desc, id desc
      limit $2 offset $3
    )
    select (select count(*)::int from filtered) as total,
           coalesce((select jsonb_agg(to_jsonb(entry) order by "createdAt" desc, id desc)
                     from page_entries entry), '[]'::jsonb) as entries
  `, [query.trim(), BLACKLIST_PAGE_SIZE, (page - 1) * BLACKLIST_PAGE_SIZE]);
  return result ?? { entries: [], total: 0 };
}
