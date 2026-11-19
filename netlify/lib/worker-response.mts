import { json } from "./http.mts";

export function workerResult(worker: string, detail: Record<string, unknown> = {}): Response {
  if (detail.skipped === "idle") console.info("worker_idle_skip", { worker });
  return json({ worker, at: new Date().toISOString(), ...detail });
}

export function workerFailure(worker: string, error: unknown): Response {
  const code = typeof (error as { code?: unknown })?.code === "string"
    ? String((error as { code: string }).code).slice(0, 120)
    : (error as Error)?.name || "worker_error";
  console.error("worker_failure", { worker, code });
  return workerResult(worker, { ok: false, code });
}
