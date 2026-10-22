import { useState } from "react";
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
  const { data, loading, error, refresh } = useAppData(Boolean(session.data?.user));

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
    if (!enable && !window.confirm("Préparer la reprise ? OUTBOUND_ENABLED restera désactivé tant que la production n’est pas explicitement autorisée.")) return;
    const reason = window.prompt(enable ? "Motif de l’arrêt d’urgence" : "Motif de la reprise contrôlée", enable ? "Arrêt manuel depuis l’interface" : "Reprise manuelle après vérification") || "Action manuelle";
    await api.setEmergencyStop(enable, reason);
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
      {page === "messages" ? <MessagesView campaigns={data.campaigns} prospects={data.prospects} totals={data.totals} onMutated={refresh} /> : null}
      {page === "campaigns" ? <CampaignsView campaigns={data.campaigns} folders={data.folders} accounts={data.gmailAccounts} experiments={data.experiments} onMutated={refresh} /> : null}
      {page === "settings" ? <SettingsView settings={data.settings} accounts={data.gmailAccounts} providers={data.providers} prospects={data.prospects} onMutated={refresh} /> : null}
    </Shell>
  );
}
