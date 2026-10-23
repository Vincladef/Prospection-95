import { randomUUID } from "node:crypto";
import type { Config, Context } from "@netlify/functions";
import { syncBobworkAccounts } from "../lib/bobwork-sync.mts";
import { workerFailure, workerResult } from "../lib/worker-response.mts";

export default async function syncBobwork(_request: Request, _context: Context): Promise<Response> {
  const worker = `netlify-bobwork-${randomUUID()}`;
  try {
    const result = await syncBobworkAccounts(false);
    return workerResult(worker, { ok: true, claimed: result.claimed ? 1 : 0, records: result.records, sourceUrl: result.sourceUrl });
  } catch (error) {
    return workerFailure(worker, error);
  }
}

export const config: Config = { schedule: "* * * * *" };
