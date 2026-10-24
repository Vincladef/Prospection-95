import { useEffect, useState } from "react";
import { authClient } from "./lib/auth";
import { api } from "./lib/api";
import { useAppData } from "./hooks/useAppData";
import { LoginScreen } from "./components/LoginScreen";
import { Shell, type Page } from "./components/Shell";
import { MessagesView } from "./components/MessagesView";
import { CampaignsView } from "./components/CampaignsView";
import { SettingsView } from "./components/SettingsView";

function LoadingWindow({ label = "Chargement de Prospection 95…" }: { label?: string }) {
  return (
    <main className="login-desktop">
      <section className="win-window loading-window" role="status">
        <header className="win-titlebar"><strong>Prospection 95</strong></header>
        <div><span className="hourglass" aria-hidden="true">⌛</span><p>{label}</p></div>
        <div className="progress-track"><span /></div>
      </section>
    </main>
  );
}

export default function App() {
  const session = authClient.useSession();
  const [page, setPage] = useState<Page>("messages");
  const [campaignToOpen, setCampaignToOpen] = useState<string | null>(null);
  const { data, loading, error, refresh } = useAppData(Boolean(session.data?.user));

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      document.querySelectorAll<HTMLDetailsElement>("details.v16-more[open]").forEach((details) => {
        if (!details.contains(event.target as Node)) details.open = false;
      });
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") document.querySelectorAll<HTMLDetailsElement>("details.v16-more[open]").forEach((details) => { details.open = false; });
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  if (session.isPending) return <LoadingWindow label="Vérification de la session…" />;
  if (!session.data?.user) return <LoginScreen />;
  if (loading && !data) return <LoadingWindow />;

  if (!data) {
    return (
      <main className="login-desktop">
        <section className="win-window error-window">
          <header className="win-titlebar"><strong>Erreur de connexion</strong></header>
          <div className="error-dialog"><span aria-hidden="true">⚠</span><div><h1>Impossible d’ouvrir l’application</h1><p>{error || "Réponse serveur invalide"}</p></div></div>
          <footer className="dialog-actions"><button className="win-button" onClick={() => void authClient.signOut().then(() => window.location.reload())}>Se déconnecter</button><button className="win-button primary" onClick={() => void refresh()}>Réessayer</button></footer>
        </section>
      </main>
    );
  }

  async function toggleEmergencyStop() {
    const enable = !data!.settings.emergencyStop;
    const reason = enable
      ? window.prompt("Motif de la mise en pause", "Mise en pause manuelle")
      : "Campagnes autorisées par le propriétaire";
    if (enable && reason === null) return;
    await api.setEmergencyStop(enable, reason || "Mise en pause manuelle");
    await refresh();
  }

  return (
    <Shell
      page={page}
      onPageChange={setPage}
      userEmail={session.data.user.email}
      hasActiveSender={data.gmailAccounts.some((account) =>
        account.role === "sender" && account.hasCredential && account.status === "active"
      )}
      emergencyStop={data.settings.emergencyStop}
      emergencyReason={data.settings.emergencyStopReason}
      onEmergencyToggle={() => void toggleEmergencyStop()}
    >
      {error ? <div className="floating-error" role="alert">⚠ {error} <button onClick={() => void refresh()}>Réessayer</button></div> : null}
      {page === "messages" ? <MessagesView campaigns={data.campaigns} prospects={data.prospects} totals={data.totals} onOpenCampaign={(campaignId) => { setCampaignToOpen(campaignId); setPage("campaigns"); }} onMutated={refresh} /> : null}
      {page === "campaigns" ? <CampaignsView campaigns={data.campaigns} folders={data.folders} accounts={data.gmailAccounts} experiments={data.experiments} attachments={data.attachments} prospects={data.prospects} totals={data.totals} selectedCampaignId={campaignToOpen} onOpenSettings={() => setPage("settings")} onMutated={refresh} /> : null}
      {page === "settings" ? <SettingsView settings={data.settings} accounts={data.gmailAccounts} providers={data.providers} attachments={data.attachments} prospects={data.prospects} onMutated={refresh} /> : null}
    </Shell>
  );
}
