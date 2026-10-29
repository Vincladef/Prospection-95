import { FormEvent, useEffect, useState } from "react";
import type { Prospect } from "../types";
import { StatusBadge } from "./StatusBadge";

interface SequenceDrawerProps {
  prospect: Prospect;
  onClose: () => void;
  onSave: (payload: { subject: string; messages: string[]; version: number }) => Promise<void>;
}

const stepLabels = ["Message initial", "Relance R1", "Relance R2", "Relance R3", "Relance R4", "Relance R5"];
const delays = ["J0", "J+3", "+7 jours", "+7 jours", "+14 jours", "+14 jours"];

export function SequenceDrawer({ prospect, onClose, onSave }: SequenceDrawerProps) {
  const [subject, setSubject] = useState(prospect.subject);
  const [messages, setMessages] = useState<string[]>(prospect.messages);
  const [baseline, setBaseline] = useState({ subject: prospect.subject, messages: prospect.messages, version: prospect.version });
  const dirty = subject !== baseline.subject || messages.some((message, index) => message !== baseline.messages[index]);
  const changedRemotely = prospect.version !== baseline.version || prospect.subject !== baseline.subject
    || prospect.messages.some((message, index) => message !== baseline.messages[index]);

  function loadLatest() {
    setSubject(prospect.subject);
    setMessages(prospect.messages);
    setBaseline({ subject: prospect.subject, messages: prospect.messages, version: prospect.version });
  }

  useEffect(() => {
    if (!dirty && changedRemotely) loadLatest();
  }, [prospect, dirty, changedRemotely]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave({ subject, messages, version: baseline.version });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Enregistrement impossible");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="drawer-mask" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="sequence-drawer win-window" role="dialog" aria-modal="true" aria-labelledby="sequence-title" onSubmit={submit}>
        <header className="win-titlebar">
          <strong id="sequence-title">Séquence — {prospect.name}</strong>
          <button type="button" className="window-close" aria-label="Fermer" onClick={onClose}>×</button>
        </header>
        <div className="drawer-toolbar">
          <StatusBadge status={prospect.messageStatus} />
          <span>Campagne : {prospect.campaignName || "Sans campagne"}</span>
          <span>Expéditeur : {prospect.senderEmail || "Non attribué"}</span>
          {prospect.variantLabel ? <span>Variante {prospect.variantLabel}</span> : null}
        </div>
        <div className="drawer-body">
          {dirty && changedRemotely ? <div className="win-alert info" role="status">Une nouvelle version est disponible. Votre saisie est conservée.
            <button className="win-button" type="button" onClick={loadLatest}>Charger la dernière version</button>
          </div> : null}
          {prospect.excluded ? (
            <div className="win-alert error">⚠ Cette adresse est exclue. Toute expédition est bloquée.</div>
          ) : null}
          {prospect.openObserved || prospect.clickObserved ? (
            <div className="interaction-summary" aria-label="Interactions observées">
              {prospect.openObserved ? <span><strong>◉ Ouverture observée</strong><small>{prospect.lastOpenAt ? `Dernière observation ${new Date(prospect.lastOpenAt).toLocaleString("fr-FR")}` : "Horodatage indisponible"} · signal technique potentiellement bruité</small></span> : null}
              {prospect.clickObserved ? <span><strong>↗ Clic observé</strong><small>{prospect.lastClickAt ? `Dernière observation ${new Date(prospect.lastClickAt).toLocaleString("fr-FR")}` : "Horodatage indisponible"}</small></span> : null}
            </div>
          ) : null}
          <label className="field full-field">
            <span>Objet</span>
            <input value={subject} onChange={(event) => setSubject(event.target.value)} />
          </label>
          <div className="sequence-grid">
            {messages.map((message, index) => (
              <label className="message-card" key={stepLabels[index]}>
                <span className="message-card-title">
                  <strong>{stepLabels[index]}</strong>
                  <small>{delays[index]}</small>
                </span>
                <textarea
                  value={message}
                  onChange={(event) => {
                    const value = event.target.value;
                    setMessages((current) => current.map((item, itemIndex) => itemIndex === index ? value : item));
                  }}
                  rows={10}
                />
              </label>
            ))}
          </div>
          {error ? <div className="win-alert error" role="alert">{error}</div> : null}
        </div>
        <footer className="drawer-actions">
          <span>Version {baseline.version} · contrôle de concurrence actif</span>
          <div>
            <button className="win-button" type="button" onClick={onClose}>Annuler</button>
            <button className="win-button primary" type="submit" disabled={saving || !subject.trim() || !messages[0]?.trim()}>
              {saving ? "Enregistrement…" : "Enregistrer"}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
