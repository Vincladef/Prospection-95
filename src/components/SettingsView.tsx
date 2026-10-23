import { FormEvent, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { AppSettings, DeliverabilityProvider, GmailAccount, ImportPreview, Prospect } from "../types";

type SettingsTab = "instructions" | "accounts" | "deliverability" | "prospects";

interface SettingsViewProps {
  settings: AppSettings;
  accounts: GmailAccount[];
  providers: DeliverabilityProvider[];
  prospects: Prospect[];
  onMutated: () => Promise<void>;
}

const storageKeys = [
  "crm-maquette-v5-targets",
  "prospection95-v9-general-guidance",
  "prospection95-v9-sender-accounts",
  "prospection95-v10-target-folders",
  "prospection95-v11-delivery-tests",
  "prospection95-v16-shared-diagnostics",
  "prospection95-v34-test-assignments",
  "prospection95-v49-tracking-defaults",
  "crm-maquette-v7-blacklist",
  "prospection95-v51-explicit-exclusions",
  "prospection95-v51-prior-contact-history",
  "prospection95-v23-prospect-drafts",
];

function InstructionsPanel({ settings, onMutated }: { settings: AppSettings; onMutated: () => Promise<void> }) {
  const [text, setText] = useState(settings.generalWritingInstructions);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await api.updateSettings({ generalWritingInstructions: text, version: settings.version });
      await onMutated();
      setMessage("Instructions enregistrées dans Neon.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Enregistrement impossible");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="settings-panel" onSubmit={submit}>
      <div className="panel-heading"><div><h2>Instructions générales de rédaction</h2><p>Règles communes, appliquées avant les consignes propres aux campagnes et variantes.</p></div><span className="panel-stamp">COMMUN À TOUTES LES CAMPAGNES</span></div>
      <div className="win-alert info">Les agents ChatGPT lisent ces instructions dans Neon. Le backend n’appelle aucune API OpenAI.</div>
      <label className="field full-field"><span>Consignes globales</span><textarea rows={18} value={text} onChange={(event) => setText(event.target.value)} placeholder="Ton, longueur, signature, informations à ne jamais inventer…" /></label>
      <div className="settings-actions"><span>{message || `Version ${settings.version}`}</span><div><button type="button" className="win-button" onClick={() => setText(settings.generalWritingInstructions)}>Annuler</button><button className="win-button primary" disabled={saving || text === settings.generalWritingInstructions}>{saving ? "Enregistrement…" : "Enregistrer"}</button></div></div>
    </form>
  );
}

function GmailPanel({ accounts, vaultConfigured, onMutated, onOpenDeliverability }: { accounts: GmailAccount[]; vaultConfigured: boolean; onMutated: () => Promise<void>; onOpenDeliverability: () => void }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setMessage(null);
    try {
      await api.saveGmailAccount({
        email: String(data.get("email") || ""),
        displayName: String(data.get("displayName") || ""),
        role: String(data.get("role") || "sender"),
        appPassword: String(data.get("appPassword") || ""),
        dailyLimit: Number(data.get("dailyLimit") || 20),
        sendStart: String(data.get("sendStart") || "08:00"),
        sendEnd: String(data.get("sendEnd") || "18:00"),
        timezone: "Europe/Paris",
      });
      form.reset();
      setOpen(false);
      await onMutated();
      setMessage("Compte enregistré. Le mot de passe n’est plus accessible au navigateur.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Compte non enregistré");
    }
  }

  async function test(id: string) {
    setBusyId(id);
    setMessage(null);
    try {
      const result = await api.testGmailAccount(id);
      await onMutated();
      if (result.imap) {
        setMessage("Connexion Gmail vérifiée. Aucun email n’a été envoyé : les envois restent désactivés côté serveur.");
      } else if (["gmail_auth_failed", "gmail_app_password_required", "authenticationfailed"].includes(result.errorCode || "")) {
        setMessage("Google a refusé la connexion. Vérifie que l’adresse saisie est celle qui a créé ce mot de passe d’application Gmail.");
      } else {
        setMessage(`Connexion Gmail non vérifiée${result.errorCode ? ` (${result.errorCode})` : ""}.`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Test impossible");
    } finally {
      setBusyId(null);
    }
  }

  async function sendTestEmail(event: FormEvent<HTMLFormElement>, account: GmailAccount) {
    event.preventDefault();
    const form = event.currentTarget;
    const recipient = String(new FormData(form).get("recipient") || "").trim();
    if (!recipient) return;
    setBusyId(account.id);
    setMessage(null);
    try {
      const result = await api.sendGmailTestEmail(account.id, recipient);
      await onMutated();
      if (result.state === "accepted") {
        setMessage(`Email test accepté par Gmail et envoyé à ${recipient}. Aucun prospect ni aucune campagne n’a été déclenché.`);
        form.reset();
      } else if (result.state === "uncertain") {
        setMessage("Gmail n’a pas confirmé clairement l’envoi. Vérifie la boîte destinataire avant de recommencer pour éviter un doublon.");
      } else if (["gmail_auth_failed", "gmail_app_password_required", "eauth"].includes(result.errorCode || "")) {
        setMessage("Google a refusé l’envoi SMTP. Vérifie que le mot de passe d’application appartient exactement à cette adresse Gmail.");
      } else {
        setMessage(`Email test non envoyé${result.errorCode ? ` (${result.errorCode})` : ""}.`);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Envoi du test impossible");
    } finally {
      setBusyId(null);
    }
  }

  async function syncBobwork() {
    setBusyId("bobwork");
    setMessage(null);
    try {
      const result = await api.syncBobwork();
      await onMutated();
      setMessage(`BobWork connecté : ${result.records} boîte(s) lue(s) depuis l’API officielle.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Synchronisation BobWork impossible");
    } finally {
      setBusyId(null);
    }
  }

  function accountState(account: GmailAccount): { label: string; className: string } {
    if (account.pausedAt || account.status === "suspended") return { label: "En pause", className: "pause" };
    if (account.status === "active" && account.smtpVerifiedAt && account.imapVerifiedAt) return { label: "Prêt", className: "ready" };
    if (account.status === "error") return { label: "À vérifier", className: "pause" };
    return { label: "Configuration", className: "setup" };
  }

  function roleLabel(account: GmailAccount): string {
    if (account.role === "primary") return "Gmail principal";
    if (account.role === "test_inbox") return "Boîte réceptrice de test";
    return account.displayName || "Expéditeur";
  }

  function warmupLabel(account: GmailAccount): string {
    if (!account.bobworkObservedAt) {
      if (account.bobworkConnectionStatus === "error") return `Erreur de synchronisation${account.bobworkLastErrorCode ? ` (${account.bobworkLastErrorCode})` : ""}`;
      return "Aucune mesure reçue";
    }
    const labels: Record<string, string> = { active: "Actif", paused: "En pause", interrupted: "Interrompu", inactive: "Inactif", unknown: "État non communiqué" };
    const ready = account.bobworkReadyForOutbound === true ? " · prêt pour l’envoi" : account.bobworkReadyForOutbound === false ? " · pas encore prêt" : "";
    return `${labels[account.bobworkWarmupState] || account.bobworkWarmupState}${ready}`;
  }

  return (
    <div className="settings-panel">
      <div className="panel-heading"><div><h2>Comptes Gmail</h2><p>Connecte tes adresses une fois, puis consulte leur délivrabilité.</p></div><button className="win-button primary" disabled={!vaultConfigured} onClick={() => setOpen((value) => !value)}>+ Ajouter un compte</button></div>
      {!vaultConfigured ? <div className="win-alert warning" role="alert">Le coffre privé Netlify n’est pas encore disponible. Rechargez la page pour relancer son initialisation automatique.</div> : null}
      {message ? <div className="win-alert info" role="status">{message}</div> : null}
      {open ? (
        <form className="account-form win-group" onSubmit={(event) => void save(event)}>
          <legend>Nouveau compte</legend>
          <div className="form-grid">
            <label className="field"><span>Adresse Gmail</span><input name="email" type="email" required autoComplete="off" /></label>
            <label className="field"><span>Nom d’expéditeur</span><input name="displayName" autoComplete="off" /></label>
            <label className="field"><span>Rôle</span><select name="role"><option value="sender">Expéditeur</option><option value="primary">Gmail principal</option><option value="test_inbox">Boîte réceptrice de test</option></select></label>
            <label className="field"><span>Mot de passe d’application</span><input name="appPassword" type="password" required minLength={8} autoComplete="new-password" /></label>
            <label className="field"><span>Limite quotidienne</span><input name="dailyLimit" type="number" min={0} max={2000} defaultValue={20} /></label>
            <label className="field"><span>Plage autorisée</span><span className="inline-fields"><input name="sendStart" type="time" defaultValue="08:00" /><span>à</span><input name="sendEnd" type="time" defaultValue="18:00" /></span></label>
          </div>
          <div className="settings-actions"><span>Transmission HTTPS → chiffrement AES-256-GCM côté serveur.</span><div><button type="button" className="win-button" onClick={() => setOpen(false)}>Annuler</button><button className="win-button primary">Chiffrer et enregistrer</button></div></div>
        </form>
      ) : null}
      <div className="account-list v16-account-list">
        {accounts.map((account) => {
          const state = accountState(account);
          const score = account.bobworkHealthScore;
          return (
            <article className="v19-account-entry" key={account.id}>
              <div className="v16-account-row">
                <div className="sender-avatar">✉</div>
                <div className="sender-identity">
                  <strong>{account.email}</strong>
                  <div className="v14-account-summary"><span className={`v14-tag ${state.className}`}>{state.label}</span><small>{roleLabel(account)}</small></div>
                  <div className="v42-account-quota"><strong>{account.dailyLimit} emails/jour max.</strong><small>Lun–ven · {account.sendStart}–{account.sendEnd}</small></div>
                </div>
                <div className="v19-overview">
                  <div className="v19-score-label">Indice de délivrabilité</div>
                  <strong className={`v19-score ${score === null ? "unknown" : "has-score"}`}>{score === null ? "Non évalué" : `${score}/100`}</strong>
                  <small>{score === null ? "En attente de mesures réelles" : "Source : BobWork"}</small>
                </div>
                <div className="v16-account-actions">
                  <button className="win-button primary" type="button" disabled={busyId === account.id || !account.hasCredential} onClick={() => void test(account.id)}>{busyId === account.id ? "Test…" : "Tester SMTP / IMAP"}</button>
                  <details className="v16-more"><summary title="Autres actions" aria-label="Autres actions">⋯</summary><div><button className="win-button danger" type="button" onClick={async () => { if (!window.confirm(`Supprimer ${account.email} ?`)) return; await api.deleteGmailAccount(account.id); await onMutated(); }}>Supprimer</button></div></details>
                </div>
              </div>
              <details className="v19-account-details">
                <summary>Détails de délivrabilité <span>({account.bobworkObservedAt ? "mesures BobWork disponibles" : "aucune mesure enregistrée"})</span></summary>
                <div className="v19-details-body v20-details-body">
                  <div><b>Coffre privé</b><span>{account.hasCredential ? "Clé enregistrée" : "À configurer"}</span></div>
                  <div><b>SMTP</b><span>{account.smtpVerifiedAt ? `Vérifié ${new Date(account.smtpVerifiedAt).toLocaleDateString("fr-FR")}` : "Non vérifié"}</span></div>
                  <div><b>IMAP</b><span>{account.imapVerifiedAt ? `Vérifié ${new Date(account.imapVerifiedAt).toLocaleDateString("fr-FR")}` : "Non vérifié"}</span></div>
                  <div><b>Warm-up BobWork</b><span>{warmupLabel(account)}</span></div>
                  <div><b>Taux spam sur 7 jours</b><span>{account.bobworkSpamRate7d === null ? "Non mesuré" : `${account.bobworkSpamRate7d}%`}</span></div>
                  <div><b>Dernier contrôle</b><span>{account.bobworkObservedAt ? new Date(account.bobworkObservedAt).toLocaleString("fr-FR") : account.lastSyncAt ? new Date(account.lastSyncAt).toLocaleString("fr-FR") : "Aucune date enregistrée"}</span></div>
                  <form className="gmail-test-send" onSubmit={(event) => void sendTestEmail(event, account)}>
                    <label><span>Envoyer un email test à</span><input name="recipient" type="email" required placeholder="adresse@exemple.com" autoComplete="email" /></label>
                    <button className="win-button primary" disabled={busyId === account.id || !account.hasCredential}>{busyId === account.id ? "Envoi…" : "Envoyer le test"}</button>
                    <small>Envoi diagnostic unique : l’arrêt des campagnes reste actif.</small>
                  </form>
                  <button className="win-button" type="button" disabled={busyId === "bobwork"} onClick={() => void syncBobwork()}>{busyId === "bobwork" ? "Synchronisation…" : "Actualiser les mesures BobWork"}</button>
                </div>
              </details>
            </article>
          );
        })}
        {!accounts.length ? <div className="v53-sender-empty">Aucune adresse. Ajoute un compte pour commencer.</div> : null}
      </div>
      <div className="v53-settings-crosslink"><span>Les boîtes réceptrices et les vérificateurs sont gérés pour toute l’application.</span><button className="win-button" onClick={onOpenDeliverability}>Ouvrir Tests &amp; réception ↗</button></div>
    </div>
  );
}

function DeliverabilityPanel({ providers, accounts, onMutated }: { providers: DeliverabilityProvider[]; accounts: GmailAccount[]; onMutated: () => Promise<void> }) {
  const [providerForm, setProviderForm] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [providerBusyId, setProviderBusyId] = useState<string | null>(null);

  function providerUsageLabel(lastUsedAt: string | null): string {
    if (!lastUsedAt) return "Pas encore utilisé par l’agent";
    const date = new Date(lastUsedAt);
    if (!Number.isFinite(date.getTime())) return "Date inconnue";
    return `Dernière utilisation : ${date.toLocaleString("fr-FR")}`;
  }

  async function toggleProvider(provider: DeliverabilityProvider, enabled: boolean) {
    setProviderBusyId(provider.id);
    setMessage(null);
    try {
      await api.saveProvider({ enabled }, provider.id);
      await onMutated();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "État du vérificateur non enregistré");
    } finally {
      setProviderBusyId(null);
    }
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    try {
      await api.saveProvider({ name: data.get("name"), url: data.get("url"), capability: data.get("capability"), needsTestEmail: data.get("needsTestEmail") === "on", enabled: true, quotaScope: "unknown", quotaConfidence: "unknown" });
      form.reset();
      setProviderForm(false);
      await onMutated();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Prestataire non enregistré");
    }
  }

  return (
    <div className="settings-panel">
      <div className="panel-heading"><div><h2>Tests de délivrabilité &amp; boîtes réceptrices</h2><p>Infrastructure commune à tous les comptes Gmail expéditeurs. Les résultats restent individuels pour chaque adresse d’envoi.</p></div><span className="panel-stamp">PARAMÈTRES GLOBAUX</span></div>
      {message ? <div className="win-alert info" role="status">{message}</div> : null}
      <div className="deliverability-grid receivers-only">
        <fieldset className="win-group">
          <legend>Boîtes réceptrices</legend>
          {accounts.filter((account) => account.role === "test_inbox").map((account) => <div className="receiver-row" key={account.id}><strong>{account.email}</strong><span>{account.imapVerifiedAt ? "IMAP vérifié" : "Accès non vérifié"}</span></div>)}
          {!accounts.some((account) => account.role === "test_inbox") ? <p>Aucune boîte de test configurée.</p> : null}
        </fieldset>
      </div>
      <section className="verifier-section">
        <div className="verifier-section-heading"><div><h3>Vérificateurs de délivrabilité</h3><p>L’IA utilisera les prestataires sélectionnés. Tous ceux de la maquette V53 sont activés par défaut ; la dernière utilisation vient uniquement de résultats réels.</p></div></div>
        <div className="provider-list v19-provider-list">
          {providers.map((provider) => (
            <article className="v19-provider-item" key={provider.id}>
              <label className="v19-provider-select">
                <input type="checkbox" checked={provider.enabled} disabled={providerBusyId === provider.id} onChange={(event) => void toggleProvider(provider, event.target.checked)} />
                <span><strong>{provider.name}</strong><small>{providerUsageLabel(provider.lastUsedAt)}</small></span>
              </label>
              <span className="v19-provider-description">{provider.capability}</span>
              <a className="v19-provider-link" href={provider.url} target="_blank" rel="noopener noreferrer" aria-label={`Site de ${provider.name}`}>↗</a>
              {!provider.builtIn ? <button className="v19-remove-provider" type="button" title={`Retirer ${provider.name}`} onClick={async () => { if (!window.confirm(`Supprimer ${provider.name} ?`)) return; await api.deleteProvider(provider.id); await onMutated(); }}>×</button> : null}
            </article>
          ))}
          {!providers.length ? <div className="empty-state"><strong>Aucun vérificateur</strong><span>Le catalogue V53 doit être initialisé dans Neon.</span></div> : null}
        </div>
        <details className="v19-add-provider" open={providerForm} onToggle={(event) => setProviderForm(event.currentTarget.open)}>
          <summary>+ Ajouter un autre vérificateur</summary>
          {providerForm ? (
        <form className="provider-form win-group" onSubmit={(event) => void saveProvider(event)}><legend>Nouveau vérificateur</legend><label className="field"><span>Nom</span><input name="name" required /></label><label className="field"><span>URL</span><input name="url" type="url" required /></label><label className="field"><span>Capacité</span><select name="capability"><option value="content">Contenu / antispam</option><option value="placement">Placement</option><option value="authentication">SPF / DKIM / DMARC</option><option value="reputation">Réputation</option></select></label><label className="check-field"><input name="needsTestEmail" type="checkbox" /> Nécessite un email de diagnostic</label><div className="dialog-actions"><button className="win-button" type="button" onClick={() => setProviderForm(false)}>Annuler</button><button className="win-button primary">Ajouter</button></div></form>
          ) : null}
        </details>
      </section>
    </div>
  );
}

function ProspectsPanel({ prospects, onMutated }: { prospects: Prospect[]; onMutated: () => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importPayload, setImportPayload] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("fr");
    return prospects.filter((prospect) => {
      if (filter === "excluded" && !prospect.excluded) return false;
      if (filter === "contacted" && !prospect.alreadyContacted) return false;
      if (filter === "new" && (prospect.alreadyContacted || prospect.excluded)) return false;
      return !normalized || [prospect.name, prospect.email, prospect.contactRaw, prospect.campaignName].filter(Boolean).join(" ").toLocaleLowerCase("fr").includes(normalized);
    });
  }, [filter, prospects, query]);

  async function previewFile(file: File) {
    const text = await file.text();
    const payload = { format: file.name.toLowerCase().endsWith(".csv") ? "csv" : "json", filename: file.name, content: text };
    setImportPayload(payload);
    setPreview(await api.previewImport(payload));
  }

  async function previewBrowserStorage() {
    const values: Record<string, unknown> = {};
    for (const key of storageKeys) {
      const value = localStorage.getItem(key);
      if (value === null) continue;
      try { values[key] = JSON.parse(value); } catch { values[key] = value; }
    }
    const payload = { format: "v53-local-storage", data: values };
    setImportPayload(payload);
    setPreview(await api.previewImport(payload));
  }

  async function commitImport() {
    if (!importPayload || !preview || !window.confirm("Importer ces données ? Toutes les campagnes importées resteront inactives et aucun envoi ne sera créé.")) return;
    const result = await api.commitImport(importPayload);
    setMessage(`${result.imported} ligne(s) importée(s). Aucune expédition activée.`);
    setPreview(null);
    setImportPayload(null);
    if (fileRef.current) fileRef.current.value = "";
    await onMutated();
  }

  async function exportBackup() {
    const data = await api.exportData();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `prospection95-backup-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="settings-panel">
      <div className="panel-heading"><div><h2>Répertoire des prospects</h2><p>Historique transversal, anti-recontact et exclusions explicites.</p></div><span className="panel-stamp">{prospects.length} CONTACTS</span></div>
      <div className="toolbar"><label className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nom, email, campagne…" /></label><select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">Tous</option><option value="new">Jamais contactés</option><option value="contacted">Déjà contactés</option><option value="excluded">Ne pas contacter</option></select></div>
      <div className="directory-table-wrap"><table className="directory-table"><thead><tr><th>Prospect</th><th>Campagne</th><th>Situation</th><th>Étape</th><th>Dernier envoi</th></tr></thead><tbody>{visible.map((prospect) => <tr key={prospect.id}><td><strong>{prospect.name}</strong><small>{prospect.email || prospect.contactRaw || "—"}</small></td><td>{prospect.campaignName || "—"}</td><td>{prospect.excluded ? <span className="directory-tag danger">Ne pas contacter</span> : prospect.alreadyContacted ? <span className="directory-tag contacted">Déjà contacté</span> : <span className="directory-tag">Nouveau</span>}</td><td>{prospect.step || "—"}</td><td>{prospect.lastSentAt ? new Date(prospect.lastSentAt).toLocaleString("fr-FR") : "—"}</td></tr>)}</tbody></table>{!visible.length ? <div className="empty-state"><span>Aucun prospect pour ces filtres.</span></div> : null}</div>
      <section className="migration-panel win-group">
        <legend>Sauvegarde et migration V53</legend>
        <p>Le CSV ou l’export local est envoyé à l’API pour prévisualisation. Les données ne sont jamais ajoutées au bundle public.</p>
        <div className="migration-actions"><label className="win-button file-button">Choisir un CSV / JSON<input ref={fileRef} type="file" accept=".csv,.json,text/csv,application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void previewFile(file).catch((error) => setMessage(error instanceof Error ? error.message : "Prévisualisation impossible")); }} /></label><button className="win-button" onClick={() => void previewBrowserStorage().catch((error) => setMessage(error instanceof Error ? error.message : "Lecture impossible"))}>Analyser ce navigateur</button><button className="win-button" onClick={() => void exportBackup().catch((error) => setMessage(error instanceof Error ? error.message : "Export impossible"))}>Exporter Neon</button></div>
        {preview ? <div className="import-preview"><h3>Prévisualisation</h3><dl><div><dt>Lignes</dt><dd>{preview.rows}</dd></div><div><dt>Campagnes</dt><dd>{preview.campaigns}</dd></div><div><dt>Emails valides</dt><dd>{preview.validEmails}</dd></div><div><dt>Contacts non adressables</dt><dd>{preview.nonEmailContacts}</dd></div><div><dt>Exclusions</dt><dd>{preview.exclusions}</dd></div><div><dt>Déjà contactés</dt><dd>{preview.alreadyContacted}</dd></div><div><dt>Doublons</dt><dd>{preview.duplicates}</dd></div></dl>{preview.warnings.length ? <ul>{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}<div className="win-alert info">Toutes les campagnes importées seront inactives. Les statuts historiques ne constituent pas des confirmations SMTP.</div><button className="win-button primary" onClick={() => void commitImport()}>Confirmer l’import contrôlé</button></div> : null}
        {message ? <div className="win-alert info" role="status">{message}</div> : null}
      </section>
    </div>
  );
}

const tabs: Array<{ id: SettingsTab; label: string }> = [
  { id: "instructions", label: "Instructions générales" },
  { id: "accounts", label: "Comptes Gmail" },
  { id: "deliverability", label: "Tests & réception" },
  { id: "prospects", label: "Prospects" },
];

export function SettingsView({ settings, accounts, providers, prospects, onMutated }: SettingsViewProps) {
  const [tab, setTab] = useState<SettingsTab>("accounts");
  return (
    <section className="view-stack" aria-labelledby="settings-title">
      <div className="settings-window settings-layout">
        <header className="win-titlebar settings-top"><strong id="settings-title">⚙ Panneau de configuration</strong></header>
        <nav className="settings-tabs" aria-label="Sections des paramètres">{tabs.map((item) => <button key={item.id} className={`settings-tab ${tab === item.id ? "active" : ""}`} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>
        <div className="settings-body">
          {tab === "instructions" ? <InstructionsPanel settings={settings} onMutated={onMutated} /> : null}
          {tab === "accounts" ? <GmailPanel accounts={accounts} vaultConfigured={settings.vaultConfigured} onMutated={onMutated} onOpenDeliverability={() => setTab("deliverability")} /> : null}
          {tab === "deliverability" ? <DeliverabilityPanel providers={providers} accounts={accounts} onMutated={onMutated} /> : null}
          {tab === "prospects" ? <ProspectsPanel prospects={prospects} onMutated={onMutated} /> : null}
        </div>
      </div>
    </section>
  );
}
