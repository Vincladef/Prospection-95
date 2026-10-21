import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { DashboardData } from "../types";

export function useAppData(enabled: boolean) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
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
      setData(dashboard);
      setError(warning);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Chargement impossible");
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, setData, loading, error, refresh };
}
