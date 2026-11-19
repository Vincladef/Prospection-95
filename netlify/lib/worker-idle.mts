import { getDeployStore } from "@netlify/blobs";

export const IDLE_CHECK_MS = 15 * 60_000;
const ACTIVE_MS = 3 * 60_000;
export type IdleWorker = "dispatch" | "mailboxes" | "unified" | "drafts";
type Hint = { kind: "quiet" | "active" | "quota"; until: number; at: number };
interface HintStore {
  get(key: string, options: { type: "json" }): Promise<unknown>;
  setJSON(key: string, value: Hint): Promise<unknown>;
}

/** Hints control polling only. They never authorize an operation or replace a DB lease. */
export function createWorkerGovernor(store: () => HintStore, now = Date.now) {
  function valid(value: unknown, maxAge: number): value is Hint {
    if (!value || typeof value !== "object") return false;
    const hint = value as Partial<Hint>;
    return ["quiet", "active", "quota"].includes(hint.kind ?? "")
      && Number.isFinite(hint.at) && Number.isFinite(hint.until)
      && hint.at! <= now() && now() - hint.at! <= maxAge
      && hint.until! <= hint.at! + maxAge;
  }
  const warning = () => console.warn("worker_idle_cache_unavailable");
  async function write(key: string, kind: Hint["kind"], until: number) {
    try { await store().setJSON(key, { kind, until, at: now() }); }
    catch { warning(); }
  }
  return {
    async shouldRun(worker: IdleWorker): Promise<boolean> {
      try {
        const state = await store().get(worker, { type: "json" });
        if (!valid(state, IDLE_CHECK_MS) || state.until <= now()) return true;
        if (state.kind === "active") return true;
        if (state.kind === "quota") return false;
        // Separate key: publishing an idle hint cannot overwrite a concurrent UI wake-up.
        const activity = await store().get("interactive", { type: "json" });
        return valid(activity, ACTIVE_MS) && activity.kind === "active" && activity.until > now();
      } catch { warning(); return true; }
    },
    async isInteractive(): Promise<boolean> {
      try {
        const value = await store().get("interactive", { type: "json" });
        return valid(value, ACTIVE_MS) && value.kind === "active" && value.until > now();
      } catch { warning(); return true; }
    },
    rest(worker: IdleWorker) {
      return write(worker, "quiet", (Math.floor(now() / IDLE_CHECK_MS) + 1) * IDLE_CHECK_MS);
    },
    keepActive(worker: IdleWorker) { return write(worker, "active", now() + ACTIVE_MS); },
    noteActivity() { return write("interactive", "active", now() + ACTIVE_MS); },
    async quotaFailure(worker: IdleWorker, error: unknown) {
      const detail = error as { code?: unknown; message?: unknown };
      if (detail?.code === "53000" || /exceeded.*quota|quota.*exceeded/i.test(String(detail?.message ?? ""))) {
        await write(worker, "quota", now() + IDLE_CHECK_MS);
      }
    },
  };
}

// Per-deploy scope isolates previews and naturally discards hints when deploying or rolling back.
// No CRM data, account settings, credentials or commercial eligibility is cached here.
export const workerGovernor = createWorkerGovernor(() => getDeployStore({
  name: "prospection95-worker-idle",
  consistency: "strong",
  region: "eu-central-1",
}));
