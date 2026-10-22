import { useEffect, useState, type ReactNode } from "react";
import { authClient } from "../lib/auth";

export type Page = "messages" | "campaigns" | "settings";

interface ShellProps {
  children: ReactNode;
  page: Page;
  onPageChange: (page: Page) => void;
  userEmail: string;
  hasActiveSender: boolean;
  emergencyStop: boolean;
  emergencyReason?: string | null;
  onEmergencyToggle: () => void;
}

const pages: Array<{ id: Page; label: string; icon: string }> = [
  { id: "messages", label: "Messages", icon: "▦" },
  { id: "campaigns", label: "Campagnes", icon: "📁" },
  { id: "settings", label: "Paramètres", icon: "⚙" },
];

export function Shell({
  children,
  page,
  onPageChange,
  userEmail,
  hasActiveSender,
  emergencyStop,
  emergencyReason,
  onEmergencyToggle,
}: ShellProps) {
  const [clock, setClock] = useState(() => new Date());
  const [startOpen, setStartOpen] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const close = () => setStartOpen(false);
    window.addEventListener("blur", close);
    return () => window.removeEventListener("blur", close);
  }, []);

  async function signOut() {
    await authClient.signOut();
    window.location.reload();
  }

  return (
    <div className="app-desktop page">
      <header className="app-header masthead">
        <div className="brand-block identity">
          <span className="brand-icon logo" aria-hidden="true">
            <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
          </span>
          <div>
            <strong className="app-name">Prospection 95 <span className="win-version">V53</span></strong>
            <small className="tagline">Gestionnaire de correspondance</small>
          </div>
        </div>
        <div className="header-actions mast-right">
          <span className={`server-state offline ${hasActiveSender && emergencyStop ? "stopped" : "guarded"}`}>
            {!hasActiveSender
              ? "○ AUCUN EXPÉDITEUR ACTIF"
              : emergencyStop
                ? "■ ENVOIS ARRÊTÉS"
                : "● SYSTÈME SOUS CONTRÔLE"}
          </span>
          <button
            className={`win-button stop-button stop-btn ${!hasActiveSender || emergencyStop ? "resume pause" : "stop"}`}
            onClick={hasActiveSender ? onEmergencyToggle : () => onPageChange("settings")}
          >
            {!hasActiveSender ? "⚙ Configurer Gmail" : emergencyStop ? "▶ Préparer la reprise" : "■ Arrêt d’urgence"}
          </button>
        </div>
      </header>

      <nav className="main-tabs nav" aria-label="Rubriques principales">
        {pages.map((item) => (
          <button
            key={item.id}
            className={`nav-btn ${page === item.id ? "active" : ""}`}
            aria-current={page === item.id ? "page" : undefined}
            onClick={() => onPageChange(item.id)}
          >
            <span aria-hidden="true">{item.icon}</span> {item.label}
          </button>
        ))}
      </nav>

      {hasActiveSender && emergencyStop ? (
        <div className="emergency-banner" role="status">
          <strong>Arrêt serveur actif.</strong> Aucun email SMTP ne peut partir.
          {emergencyReason ? <span> Motif : {emergencyReason}</span> : null}
        </div>
      ) : null}

      <main className="app-content main">
        {children}
        <div className="private-note">✦ PROSPECTION 95 · Document privé.</div>
      </main>

      {startOpen ? (
        <div className="start-menu retro-start-menu open" role="menu">
          <div className="start-side retro-start-side">Prospection 95</div>
          <div className="start-items retro-start-links">
            {pages.map((item) => (
              <button
                key={item.id}
                role="menuitem"
                onClick={() => {
                  onPageChange(item.id);
                  setStartOpen(false);
                }}
              >
                <span>{item.icon}</span> {item.label}
              </button>
            ))}
            <hr />
            <div className="start-user" title={userEmail}>{userEmail}</div>
            <button role="menuitem" onClick={() => void signOut()}><span>↪</span> Se déconnecter</button>
          </div>
        </div>
      ) : null}

      <footer className="taskbar retro-taskbar">
        <button
          className={`start-button retro-start ${startOpen ? "pressed open" : ""}`}
          aria-expanded={startOpen}
          onClick={() => setStartOpen((open) => !open)}
        >
          <span className="mini-logo pixel-window" aria-hidden="true"><span /><span /><span /><span /></span> Démarrer
        </button>
        <button className="task-button retro-running" onClick={() => onPageChange(page)}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
          <span>Prospection 95</span>
        </button>
        <div className="tray retro-tray">
          <span className="retro-led" title="Connexion sécurisée" aria-hidden="true" />
          <span className="tray-label">Connecté à Neon</span>
          <time className="retro-time" dateTime={clock.toISOString()}>
            {clock.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
          </time>
        </div>
      </footer>
    </div>
  );
}
