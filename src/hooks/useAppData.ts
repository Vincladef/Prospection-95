import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { DashboardData } from "../types";

export function useAppData(enabled: boolean) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const requestId = useRef(0);
  const activeRequests = useRef(0);
  const refresh = useCallback(async (background = false) => {
    if (!enabled || (background && activeRequests.current > 0)) return;
    const current = ++requestId.current;
    activeRequests.current++;
    if (!background) setLoading(true);
    setError(null);
    try {
      let dashboard = await api.dashboard();
      let warning: string | null = null;
      if (!dashboard.settings.vaultConfigured) {
        try {
          await api.initializeVault();
          dashboard = await api.dashboard();
        } catch (caught) {
          warning = caught instanceof Error
            ? `Application chargée, mais le coffre privé n’a pas pu être initialisé : ${caught.message}`
            : "Application chargée, mais le coffre privé n’a pas pu être initialisé.";
        }
      }
      if (current === requestId.current) {
        setData(dashboard);
        setError(warning);
      }
    } catch (caught) {
      if (current === requestId.current) setError(caught instanceof Error ? caught.message : "Chargement impossible");
    } finally {
      activeRequests.current--;
      if (current === requestId.current) setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
    if (!enabled) return;
    const update = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    const timer = window.setInterval(update, 30_000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      requestId.current++;
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, [enabled, refresh]);

  return { data, setData, loading, error, refresh };
}
