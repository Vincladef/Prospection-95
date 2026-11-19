/** Stop background reads when an open tab is no longer being used. */
export function pollWhileActive(
  refresh: () => void,
  intervalMs: number,
  idleMs = 120_000,
): () => void {
  let lastActivity = Date.now();
  let lastRefresh = Date.now();
  let lastResume = Number.NEGATIVE_INFINITY;
  const visible = () => document.visibilityState === "visible";
  const active = () => visible() && Date.now() - lastActivity < idleMs;
  const update = (force = false) => {
    if (!active() || Date.now() - lastRefresh < (force ? 1_000 : intervalMs)) return;
    lastRefresh = Date.now();
    refresh();
  };
  const activity = () => {
    const wasIdle = !active();
    lastActivity = Date.now();
    if (wasIdle) update(true);
  };
  const resume = () => {
    if (!visible() || Date.now() - lastResume < 1_000) return;
    lastResume = lastActivity = lastRefresh = Date.now();
    refresh();
  };
  const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
  for (const event of events) window.addEventListener(event, activity, { passive: true });
  window.addEventListener("focus", resume);
  document.addEventListener("visibilitychange", resume);
  const timer = window.setInterval(() => update(), intervalMs);
  return () => {
    window.clearInterval(timer);
    for (const event of events) window.removeEventListener(event, activity);
    window.removeEventListener("focus", resume);
    document.removeEventListener("visibilitychange", resume);
  };
}
