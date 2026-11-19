import type { Config, Context } from "@netlify/functions";
import { randomUUID } from "node:crypto";
import { processMailboxJob, refreshMailboxThread } from "../lib/unified-mailbox-sync.mts";
import { workerFailure, workerResult } from "../lib/worker-response.mts";
import { workerGovernor } from "../lib/worker-idle.mts";

export default async function syncUnifiedMailbox(_request: Request, _context: Context): Promise<Response> {
  const worker = `netlify-unified-mail-${randomUUID()}`;
  if (!await workerGovernor.shouldRun("unified")) return workerResult(worker, { ok: true, skipped: "idle" });
  const started = Date.now();
  try {
    const interactive = await workerGovernor.isInteractive();
    const jobLimit = interactive ? 3 : 45;
    const threadLimit = interactive ? 1 : 15;
    let operations = 0;
    let queueExhausted = false;
    // Preserve the old 3 jobs/minute and 1 thread/minute capacity across an idle
    // interval, while user activity still wakes the existing minute schedule.
    for (let i = 0; i < jobLimit && Date.now() - started < 120_000; i++) {
      if (!await processMailboxJob()) { queueExhausted = true; break; }
      operations++;
    }
    let refreshed = 0;
    let historyPending = false;
    let threadsExhausted = false;
    for (let i = 0; i < threadLimit && Date.now() - started < 150_000; i++) {
      if (!await refreshMailboxThread(() => { historyPending = true; })) { threadsExhausted = true; break; }
      refreshed++;
    }
    if (!queueExhausted || !threadsExhausted || historyPending) await workerGovernor.keepActive("unified");
    else await workerGovernor.rest("unified");
    return workerResult(worker, { ok: true, operations, refreshed, historyPending });
  } catch (error) {
    await workerGovernor.quotaFailure("unified", error);
    return workerFailure(worker, error);
  }
}
export const config: Config = { schedule: "* * * * *", background: true };
