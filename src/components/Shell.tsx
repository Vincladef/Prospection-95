import { useEffect, useState, type ReactNode } from "react";
import { authClient } from "../lib/auth";

export type Page = "messages" | "campaigns" | "settings";

interface ShellProps {
  children: ReactNode;
  page: Page;
  onPageChange: (page: Page) => void;
  userEmail: string;
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
    <div className="app-desktop">
      <header className="app-header">
        <div className="brand-block">
          <span className="brand-icon" aria-hidden="true">✉</span>
          <div>
            <strong>Prospection 95</strong>
            <small>Gestionnaire de correspondance</small>
          </div>
        </div>
        <div className="header-actions">
          <span className={`server-state ${emergencyStop ? "stopped" : "guarded"}`}>
            {emergencyStop ? "■ ENVOIS ARRÊTÉS" : "● SYSTÈME SOUS CONTRÔLE"}
          </span>
          <button className={`win-button stop-button ${emergencyStop ? "resume" : "stop"}`} onClick={onEmergencyToggle}>
            {emergencyStop ? "▶ Préparer la reprise" : "■ Arrêt d’urgence"}
          </button>
        </div>
      </header>

      <nav className="main-tabs" aria-label="Rubriques principales">
        {pages.map((item) => (
          <button
            key={item.id}
            className={page === item.id ? "active" : ""}
            aria-current={page === item.id ? "page" : undefined}
            onClick={() => onPageChange(item.id)}
          >
            <span aria-hidden="true">{item.icon}</span> {item.label}
          </button>
        ))}
      </nav>

      {emergencyStop ? (
        <div className="emergency-banner" role="status">
          <strong>Arrêt serveur actif.</strong> Aucun email SMTP ne peut partir.
          {emergencyReason ? <span> Motif : {emergencyReason}</span> : null}
        </div>
      ) : null}

      <div className="app-content">{children}</div>

      {startOpen ? (
        <div className="start-menu win-window" role="menu">
          <div className="start-side">PROSPECTION 95</div>
          <div className="start-items">
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

      <footer className="taskbar">
        <button
          className={`start-button ${startOpen ? "pressed" : ""}`}
          aria-expanded={startOpen}
          onClick={() => setStartOpen((open) => !open)}
        >
          <span className="mini-logo" aria-hidden="true">▦</span> Démarrer
        </button>
        <button className="task-button" onClick={() => onPageChange(page)}>✉ Prospection 95</button>
        <div className="tray">
          <span title="Connexion sécurisée">🔒</span>
          <time dateTime={clock.toISOString()}>
            {clock.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}
          </time>
        </div>
      </footer>
    </div>
  );
}
