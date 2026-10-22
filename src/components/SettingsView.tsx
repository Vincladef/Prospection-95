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

function GmailPanel({ accounts, vaultConfigured, onMutated }: { accounts: GmailAccount[]; vaultConfigured: boolean; onMutated: () => Promise<void> }) {
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
      await api.testGmailAccount(id);
      await onMutated();
      setMessage("Test terminé. Les indicateurs affichés proviennent du serveur.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Test impossible");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="settings-panel">
      <div className="panel-heading"><div><h2>Comptes Gmail</h2><p>Expéditeurs, Gmail principal et boîtes de test. Les mots de passe d’application restent dans le coffre chiffré.</p></div><button className="win-button primary" disabled={!vaultConfigured} onClick={() => setOpen((value) => !value)}>+ Ajouter un compte</button></div>
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
      <div className="account-list">
        {accounts.map((account) => (
          <article className="account-card" key={account.id}>
            <header><div><span className="mail-glyph">✉</span><div><strong>{account.email}</strong><small>{account.role === "primary" ? "Gmail principal" : account.role === "sender" ? "Compte expéditeur" : "Boîte de test"}</small></div></div><span className={`account-state ${account.status}`}>{account.status}</span></header>
            <dl>
              <div><dt>Coffre</dt><dd>{account.hasCredential ? "Clé enregistrée" : "À configurer"}</dd></div>
              <div><dt>SMTP</dt><dd>{account.smtpVerifiedAt ? `Vérifié ${new Date(account.smtpVerifiedAt).toLocaleDateString("fr-FR")}` : "Non vérifié"}</dd></div>
              <div><dt>IMAP</dt><dd>{account.imapVerifiedAt ? `Vérifié ${new Date(account.imapVerifiedAt).toLocaleDateString("fr-FR")}` : "Non vérifié"}</dd></div>
              <div><dt>Capacité</dt><dd>{account.dailyLimit}/jour · {account.sendStart}–{account.sendEnd}</dd></div>
              <div><dt>Dernière synchro</dt><dd>{account.lastSyncAt ? new Date(account.lastSyncAt).toLocaleString("fr-FR") : "Jamais"}</dd></div>
              <div><dt>État</dt><dd>{account.pausedAt ? `Suspendu (${account.pauseSource || "inconnu"})` : "Disponible selon garde-fous"}</dd></div>
            </dl>
            <footer><button className="win-button" disabled={busyId === account.id || !account.hasCredential} onClick={() => void test(account.id)}>{busyId === account.id ? "Test…" : "Tester SMTP / IMAP"}</button><button className="win-button danger" onClick={async () => { if (!window.confirm(`Supprimer ${account.email} ?`)) return; await api.deleteGmailAccount(account.id); await onMutated(); }}>Supprimer</button></footer>
          </article>
        ))}
        {!accounts.length ? <div className="empty-state"><strong>Aucun compte Gmail</strong><span>Ajoutez d’abord le Gmail principal et un expéditeur de test autorisé.</span></div> : null}
      </div>
    </div>
  );
}

function DeliverabilityPanel({ providers, accounts, vaultConfigured, onMutated }: { providers: DeliverabilityProvider[]; accounts: GmailAccount[]; vaultConfigured: boolean; onMutated: () => Promise<void> }) {
  const [providerForm, setProviderForm] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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

  async function saveBobWork(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const secret = String(data.get("secret") || "");
    const baseUrl = String(data.get("baseUrl") || "").trim();
    const accountsPath = String(data.get("accountsPath") || "").trim();
    const documentationUrl = String(data.get("documentationUrl") || "").trim();
    const metadata = baseUrl && accountsPath && documentationUrl
      ? {
          baseUrl,
          accountsPath,
          documentationUrl,
          authHeader: String(data.get("authHeader") || "authorization").trim(),
          authScheme: String(data.get("authScheme") || "Bearer").trim(),
        }
      : undefined;
    try {
      await api.saveCredential({ kind: "bobwork", label: "BobWork", secret, metadata });
      form.reset();
      setMessage(metadata
        ? "Clé BobWork et contrat API chiffrés. État non vérifié tant qu’une synchronisation réelle n’a pas réussi."
        : "Clé BobWork chiffrée. La synchronisation reste inconnue tant qu’un contrat API officiel n’est pas renseigné.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Clé non enregistrée");
    }
  }

  return (
    <div className="settings-panel">
      <div className="panel-heading"><div><h2>Tests & réception</h2><p>Catalogue dynamique des vérificateurs, boîtes de test et préchauffage BobWork.</p></div><button className="win-button primary" onClick={() => setProviderForm((value) => !value)}>+ Vérificateur</button></div>
      {message ? <div className="win-alert info" role="status">{message}</div> : null}
      <div className="deliverability-grid">
        <fieldset className="win-group">
          <legend>BobWork</legend>
          <p>La clé est enregistrée dans le coffre. « Configuré » ne signifie ni connecté, ni préchauffé, ni délivrable.</p>
          {!vaultConfigured ? <div className="win-alert warning" role="alert">Le coffre privé Netlify n’est pas encore disponible. Rechargez la page pour relancer son initialisation automatique.</div> : null}
          <form className="secret-inline-form" onSubmit={(event) => void saveBobWork(event)}>
            <input name="secret" type="password" required disabled={!vaultConfigured} placeholder="Remplacer la clé API" autoComplete="new-password" />
            <button className="win-button primary" disabled={!vaultConfigured}>Enregistrer</button>
            <details className="full-field">
              <summary>Contrat API avancé (uniquement d’après la documentation BobWork)</summary>
              <div className="form-grid">
                <label className="field"><span>URL de base HTTPS</span><input name="baseUrl" type="url" placeholder="https://api.exemple.tld" /></label>
                <label className="field"><span>Chemin des comptes</span><input name="accountsPath" placeholder="/v1/accounts" /></label>
                <label className="field"><span>Documentation officielle</span><input name="documentationUrl" type="url" /></label>
                <label className="field"><span>En-tête d’authentification</span><input name="authHeader" defaultValue="authorization" /></label>
                <label className="field"><span>Schéma</span><input name="authScheme" defaultValue="Bearer" /></label>
              </div>
            </details>
          </form>
          <div className="mini-account-list">{accounts.filter((account) => account.role === "sender").map((account) => <span key={account.id}>{account.email}<em>état BobWork inconnu</em></span>)}</div>
        </fieldset>
        <fieldset className="win-group">
          <legend>Boîtes réceptrices</legend>
          {accounts.filter((account) => account.role === "test_inbox").map((account) => <div className="receiver-row" key={account.id}><strong>{account.email}</strong><span>{account.imapVerifiedAt ? "IMAP vérifié" : "Accès non vérifié"}</span></div>)}
          {!accounts.some((account) => account.role === "test_inbox") ? <p>Aucune boîte de test configurée.</p> : null}
        </fieldset>
      </div>
      {providerForm ? (
        <form className="provider-form win-group" onSubmit={(event) => void saveProvider(event)}><legend>Nouveau vérificateur</legend><label className="field"><span>Nom</span><input name="name" required /></label><label className="field"><span>URL</span><input name="url" type="url" required /></label><label className="field"><span>Capacité</span><select name="capability"><option value="content">Contenu / antispam</option><option value="placement">Placement</option><option value="authentication">SPF / DKIM / DMARC</option><option value="reputation">Réputation</option></select></label><label className="check-field"><input name="needsTestEmail" type="checkbox" /> Nécessite un email de diagnostic</label><div className="dialog-actions"><button className="win-button" type="button" onClick={() => setProviderForm(false)}>Annuler</button><button className="win-button primary">Ajouter</button></div></form>
      ) : null}
      <div className="provider-list">
        {providers.map((provider) => <article key={provider.id}><header><div><strong>{provider.name}</strong><small>{provider.capability}</small></div><span className={provider.enabled ? "enabled" : "disabled"}>{provider.enabled ? "Actif" : "Désactivé"}</span></header><p><a href={provider.url} target="_blank" rel="noreferrer">{provider.url}</a></p><dl><div><dt>Quota</dt><dd>{provider.quotaScope} · {provider.quotaConfidence}</dd></div><div><dt>Prochaine éligibilité</dt><dd>{provider.nextEligibleAt ? new Date(provider.nextEligibleAt).toLocaleString("fr-FR") : "Inconnue"}</dd></div></dl><footer><button className="win-button danger" onClick={async () => { if (!window.confirm(`Supprimer ${provider.name} ?`)) return; await api.deleteProvider(provider.id); await onMutated(); }}>Supprimer</button></footer></article>)}
        {!providers.length ? <div className="empty-state"><strong>Aucun vérificateur</strong><span>Le catalogue n’est pas figé dans le code : ajoutez les services que l’agent devra consulter.</span></div> : null}
      </div>
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

const tabs: Array<{ id: SettingsTab; label: string; icon: string }> = [
  { id: "instructions", label: "Instructions", icon: "📝" },
  { id: "accounts", label: "Comptes Gmail", icon: "✉" },
  { id: "deliverability", label: "Tests & réception", icon: "✓" },
  { id: "prospects", label: "Prospects", icon: "👥" },
];

export function SettingsView({ settings, accounts, providers, prospects, onMutated }: SettingsViewProps) {
  const [tab, setTab] = useState<SettingsTab>("instructions");
  return (
    <section className="view-stack" aria-labelledby="settings-title">
      <div className="view-heading intro"><div><h1 id="settings-title">Paramètres</h1><p>Rédaction, Gmail, délivrabilité et répertoire des prospects.</p></div></div>
      <div className="settings-window settings-layout">
        <header className="win-titlebar settings-top"><strong>⚙ Panneau de configuration</strong></header>
        <nav className="settings-tabs" aria-label="Sections des paramètres">{tabs.map((item) => <button key={item.id} className={`settings-tab ${tab === item.id ? "active" : ""}`} onClick={() => setTab(item.id)}><span>{item.icon}</span>{item.label}</button>)}</nav>
        <div className="settings-body">
          {tab === "instructions" ? <InstructionsPanel settings={settings} onMutated={onMutated} /> : null}
          {tab === "accounts" ? <GmailPanel accounts={accounts} vaultConfigured={settings.vaultConfigured} onMutated={onMutated} /> : null}
          {tab === "deliverability" ? <DeliverabilityPanel providers={providers} accounts={accounts} vaultConfigured={settings.vaultConfigured} onMutated={onMutated} /> : null}
          {tab === "prospects" ? <ProspectsPanel prospects={prospects} onMutated={onMutated} /> : null}
        </div>
      </div>
    </section>
  );
}
