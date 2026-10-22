import { type FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { Campaign, CampaignFolder, Experiment, GmailAccount, Prospect, SequenceContent } from "../types";

interface CampaignsViewProps {
  campaigns: Campaign[];
  folders: CampaignFolder[];
  accounts: GmailAccount[];
  experiments: Experiment[];
  prospects: Prospect[];
  totals: { pendingApproval: number };
  onOpenSettings: () => void;
  onMutated: () => Promise<void>;
}

const emptySequence: SequenceContent = { subject: "", steps: ["", "", "", "", "", ""] };

function campaignPayload(campaign: Campaign) {
  return {
    name: campaign.name,
    status: campaign.status,
    folderId: campaign.folderId,
    targetDescription: campaign.targetDescription,
    dailyNewContactGoal: campaign.dailyNewContactGoal,
    validationPolicy: campaign.validationPolicy,
    senderStrategy: campaign.senderStrategy,
    fixedSenderAccountId: campaign.fixedSenderAccountId,
    senderAccountIds: campaign.senderAccountIds,
    aiInstructions: campaign.aiInstructions,
    replyInstructions: campaign.replyInstructions,
    trackingOpensEnabled: campaign.trackingOpensEnabled,
    trackingClicksEnabled: campaign.trackingClicksEnabled,
    experimentPolicy: campaign.experimentPolicy,
    nextTestInstructions: campaign.nextTestInstructions,
    sequence: campaign.sequence,
    version: campaign.version,
  };
}

function CampaignEditor({
  campaign,
  campaignNumber,
  prospectCount,
  accounts,
  folders,
  experiments,
  onOpenSettings,
  onSaved,
}: {
  campaign: Campaign;
  campaignNumber: number;
  prospectCount: number;
  accounts: GmailAccount[];
  folders: CampaignFolder[];
  experiments: Experiment[];
  onOpenSettings: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(campaign);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setDraft(campaign);
    setMessage(null);
  }, [campaign]);

  const senderAccounts = useMemo(
    () => accounts.filter((account) => account.role === "sender" && account.status !== "deleted"),
    [accounts],
  );
  const relatedExperiments = useMemo(
    () => experiments.filter((experiment) => experiment.campaignId === campaign.id),
    [campaign.id, experiments],
  );
  const dirty = JSON.stringify(campaignPayload(draft)) !== JSON.stringify(campaignPayload(campaign));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!dirty || !draft.name.trim()) return;
    setSaving(true);
    setMessage(null);
    try {
      await api.updateCampaign(draft.id, campaignPayload(draft));
      await onSaved();
      setMessage("Campagne enregistrée dans Neon.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Enregistrement impossible");
    } finally {
      setSaving(false);
    }
  }

  async function archiveOrRestore() {
    const restoring = campaign.status === "archived";
    const question = restoring
      ? `Restaurer « ${campaign.name} » dans les campagnes actives ?`
      : `Archiver « ${campaign.name} » ? Son historique sera conservé.`;
    if (!window.confirm(question)) return;
    setSaving(true);
    try {
      if (restoring) await api.updateCampaign(campaign.id, { ...campaignPayload(campaign), status: "inactive" });
      else await api.deleteCampaign(campaign.id);
      await onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Action impossible");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="campaign-editor target-editor" onSubmit={(event) => void save(event)}>
      <header className="campaign-editor-head target-editor-head">
        <div>
          <h2>{draft.name || "Nouvelle campagne"}</h2>
          <p>{prospectCount} prospect(s) dans l’extrait · Campagne n°{campaignNumber}{campaign.status === "archived" ? " · Archivée" : ""}</p>
        </div>
        <div className="target-actions">
          <span className={`target-notice ${dirty ? "dirty" : ""}`}>{saving ? "Enregistrement…" : message || (dirty ? "Modifications non enregistrées" : "Aucune modification")}</span>
          <button className="secondary" type="button" disabled={!dirty || saving} onClick={() => setDraft(campaign)}>Annuler</button>
          <button className="target-save" type="submit" disabled={!dirty || saving || !draft.name.trim()}>Enregistrer</button>
          <details className="v16-more v16-target-more">
            <summary aria-label="Autres actions" title="Autres actions">⋯</summary>
            <div><button className="plain-btn" type="button" disabled={saving} onClick={() => void archiveOrRestore()}>{campaign.status === "archived" ? "↶ Restaurer" : "▤ Archiver"}</button></div>
          </details>
        </div>
      </header>

      <div className="target-form">
        <div className="target-help-note">
          <strong>{campaign.status === "archived" ? "Campagne archivée." : "Configuration de la campagne."}</strong>{" "}
          {campaign.status === "archived" ? "Elle est retirée des campagnes actives ; son historique reste disponible." : "Ces modèles servent à préparer les emails et les réponses de cette campagne."}{" "}
          <button className="inline-hyperlink" type="button" onClick={onOpenSettings}>Voir les instructions générales de rédaction ↗</button>
          <br />Les instructions générales sont communes à toutes les campagnes ; celles-ci les complètent.
        </div>

        <section className="target-section">
          <div className="target-section-title"><h3>Définition de la campagne</h3><small>Organisation et rythme</small></div>
          <div className="target-form-grid">
            <label className="target-field">
              <span>Nom de la campagne</span>
              <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
              <small className="target-hint">Identifiant lisible de la campagne</small>
            </label>
            <label className="target-field">
              <span>Dossier</span>
              <select value={draft.folderId || ""} onChange={(event) => setDraft((current) => ({ ...current, folderId: event.target.value || null }))}>
                <option value="">Sans dossier</option>
                {folders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
              </select>
              <small className="target-hint">Classement interne, sans incidence sur les prospects</small>
            </label>
            <label className="target-field">
              <span>Statut</span>
              <select value={draft.status} onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as Campaign["status"] }))}>
                <option value="active">Actif</option>
                <option value="inactive">Pas actif</option>
                <option value="archived">Archivée</option>
              </select>
            </label>
            <label className="target-field">
              <span>Nouveaux contacts / jour</span>
              <input type="number" min={0} max={10_000} value={draft.dailyNewContactGoal} onChange={(event) => setDraft((current) => ({ ...current, dailyNewContactGoal: Number(event.target.value) }))} />
              <small className="target-hint">Objectif de premiers emails, hors relances, sous réserve des limites de chaque compte Gmail.</small>
            </label>

            <div className="target-field v22-sender-field">
              <span>Compte Gmail expéditeur</span>
              <div className="v22-sender-choice">
                <label><input type="radio" name="sender-mode" checked={draft.senderStrategy === "fixed"} onChange={() => setDraft((current) => ({ ...current, senderStrategy: "fixed" }))} /> Compte fixe</label>
                <label><input type="radio" name="sender-mode" checked={draft.senderStrategy === "pool"} onChange={() => setDraft((current) => ({ ...current, senderStrategy: "pool" }))} /> Répartir entre les comptes</label>
              </div>
              {draft.senderStrategy === "fixed" ? (
                <div>
                  <select value={draft.fixedSenderAccountId || ""} onChange={(event) => setDraft((current) => ({ ...current, fixedSenderAccountId: event.target.value || null }))}>
                    <option value="">— Aucun compte attribué —</option>
                    {senderAccounts.map((account) => <option value={account.id} key={account.id}>{account.email}</option>)}
                  </select>
                  <small className="target-hint">Les relances et réponses restent sur le compte attribué au prospect.</small>
                </div>
              ) : (
                <div className="v22-pool-preview">
                  <strong>{senderAccounts.length ? `${senderAccounts.length} compte(s) Gmail disponibles` : "⚠ Aucun compte disponible"}</strong>
                  {senderAccounts.map((account) => (
                    <label className="v22-sender-chip" key={account.id}>
                      <input
                        type="checkbox"
                        checked={draft.senderAccountIds.includes(account.id)}
                        onChange={(event) => setDraft((current) => ({
                          ...current,
                          senderAccountIds: event.target.checked
                            ? [...new Set([...current.senderAccountIds, account.id])]
                            : current.senderAccountIds.filter((id) => id !== account.id),
                        }))}
                      />
                      {account.email} <b>plafond {account.dailyLimit}/j</b>
                    </label>
                  ))}
                  <small>Un prospect conserve le même compte pour ses relances.</small>
                </div>
              )}
            </div>
          </div>

          <details className="v48-campaign-tracking">
            <summary>Suivi des interactions <span>{draft.trackingOpensEnabled || draft.trackingClicksEnabled ? "Configuré" : "Désactivé"}</span></summary>
            <div className="v48-tracking-body">
              <label><input type="checkbox" disabled checked={draft.trackingOpensEnabled} /> Détecter les ouvertures</label>
              <label><input type="checkbox" disabled checked={draft.trackingClicksEnabled} /> Mesurer les clics sur les liens</label>
              <small>Le suivi signé n’est pas encore configuré : aucune métrique n’est présentée comme un zéro.</small>
            </div>
          </details>
        </section>

        <section className="target-section">
          <div className="target-section-title"><h3>Validation des emails</h3><small>Mode appliqué aux futurs messages générés</small></div>
          <div className="v21-approval-options">
            <label className="v21-choice"><input type="radio" name="approval-mode" checked={draft.validationPolicy === "manual"} onChange={() => setDraft((current) => ({ ...current, validationPolicy: "manual" }))} /><span><strong>Validation manuelle</strong><small>Les nouveaux emails commencent « En attente… » et vous les validez dans Messages.</small></span></label>
            <label className="v21-choice"><input type="radio" name="approval-mode" checked={draft.validationPolicy === "automatic"} onChange={() => setDraft((current) => ({ ...current, validationPolicy: "automatic" }))} /><span><strong>Validation automatique</strong><small>Les futurs emails peuvent passer « Validé » après les contrôles obligatoires.</small></span></label>
          </div>
          <div className="v21-config-example">{draft.validationPolicy === "automatic" ? "Prochain email conforme : Validé automatiquement" : "Prochain email : En attente de validation humaine"}</div>
        </section>

        <section className="target-section">
          <div className="target-section-title"><h3>Rédaction de la campagne</h3><small>Cible, recherche et séquence complète</small></div>
          <label className="target-field target-wide-field">
            <span>Population ciblée</span>
            <textarea rows={5} value={draft.targetDescription} onChange={(event) => setDraft((current) => ({ ...current, targetDescription: event.target.value }))} />
            <small className="target-hint">Les agents relisent cette consigne depuis Neon au début de chaque exécution.</small>
          </label>
          <div className="target-writing-grid">
            <label className="target-field"><span>Consignes de recherche et de rédaction</span><textarea rows={6} value={draft.aiInstructions} onChange={(event) => setDraft((current) => ({ ...current, aiInstructions: event.target.value }))} /></label>
            <label className="target-field"><span>Consignes de réponse</span><textarea rows={6} value={draft.replyInstructions} onChange={(event) => setDraft((current) => ({ ...current, replyInstructions: event.target.value }))} /></label>
          </div>
          <label className="target-field target-subject-field"><span>Objet / consigne d’objet</span><input value={draft.sequence.subject} onChange={(event) => setDraft((current) => ({ ...current, sequence: { ...current.sequence, subject: event.target.value } }))} /></label>
          <div className="target-sequences">
            {draft.sequence.steps.map((step, index) => (
              <label className="target-sequence-card" key={index}>
                <span className="target-sequence-header"><strong>{index === 0 ? "Message initial" : `Relance R${index}`}</strong><small>{["J0", "J+3", "J+7", "J+7", "J+14", "J+14"][index]}</small></span>
                <textarea value={step} onChange={(event) => {
                  const steps = draft.sequence.steps.map((value, stepIndex) => stepIndex === index ? event.target.value : value) as SequenceContent["steps"];
                  setDraft((current) => ({ ...current, sequence: { ...current.sequence, steps } }));
                }} />
              </label>
            ))}
          </div>
        </section>

        <section className="target-section">
          <div className="target-section-title"><h3>Tests A/B</h3><small>Expériences rattachées à cette campagne</small></div>
          <div className="v21-approval-options">
            <label className="v21-choice"><input type="radio" name="experiment-policy" checked={draft.experimentPolicy === "continue"} onChange={() => setDraft((current) => ({ ...current, experimentPolicy: "continue" }))} /><span><strong>Optimisation continue</strong><small>Préparer un nouveau test après chaque lecture des résultats.</small></span></label>
            <label className="v21-choice"><input type="radio" name="experiment-policy" checked={draft.experimentPolicy === "stabilize"} onChange={() => setDraft((current) => ({ ...current, experimentPolicy: "stabilize" }))} /><span><strong>Stabiliser la variante retenue</strong><small>Conserver la version choisie sans relancer automatiquement un test.</small></span></label>
          </div>
          <label className="target-field"><span>Instructions pour les prochains tests</span><textarea rows={4} value={draft.nextTestInstructions} onChange={(event) => setDraft((current) => ({ ...current, nextTestInstructions: event.target.value }))} /></label>
          <div className="v53-experiment-list">
            {relatedExperiments.map((experiment) => <article className="experiment-card" key={experiment.id}><header><div><strong>{experiment.name}</strong><span>{experiment.status}</span></div><small>{experiment.variants.length} variante(s) · seuil {experiment.thresholdContactsPerVariant}/variante</small></header></article>)}
            {!relatedExperiments.length ? <div className="v53-empty-experiment">Aucun test A/B pour cette campagne.</div> : null}
          </div>
        </section>
      </div>

      <footer className="target-footer campaign-footer">
        <span>Neon PostgreSQL · version {draft.version}{draft.importedDisabled ? " · campagne importée, envois désactivés" : ""}</span>
        <button className="target-save" type="submit" disabled={!dirty || saving || !draft.name.trim()}>Enregistrer</button>
      </footer>
    </form>
  );
}

export function CampaignsView({ campaigns, folders, accounts, experiments, prospects, totals, onOpenSettings, onMutated }: CampaignsViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(campaigns[0]?.id || null);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);

  const displayed = useMemo(
    () => campaigns.filter((campaign) => showArchived ? campaign.status === "archived" : campaign.status !== "archived"),
    [campaigns, showArchived],
  );
  const selected = displayed.find((campaign) => campaign.id === selectedId) || displayed[0] || null;
  const activeCount = campaigns.filter((campaign) => campaign.status !== "archived").length;
  const archivedCount = campaigns.length - activeCount;
  const approvedCount = prospects.filter((prospect) => prospect.messageStatus === "approved").length;
  const prospectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    prospects.forEach((prospect) => {
      if (prospect.campaignId) counts.set(prospect.campaignId, (counts.get(prospect.campaignId) || 0) + 1);
    });
    return counts;
  }, [prospects]);

  useEffect(() => {
    if (selected) setSelectedId(selected.id);
  }, [selected]);

  async function createFolder() {
    const name = window.prompt("Nom du dossier");
    if (!name?.trim()) return;
    await api.createCampaignFolder({ name: name.trim(), position: folders.length });
    await onMutated();
  }

  async function renameFolder(folder: CampaignFolder) {
    const name = window.prompt("Nouveau nom du dossier", folder.name);
    if (!name?.trim() || name.trim() === folder.name) return;
    await api.updateCampaignFolder(folder.id, { name: name.trim() });
    await onMutated();
  }

  async function removeFolder(folder: CampaignFolder) {
    if (!window.confirm(`Supprimer le dossier « ${folder.name} » ? Les campagnes seront conservées sans dossier.`)) return;
    await api.deleteCampaignFolder(folder.id);
    await onMutated();
  }

  async function createCampaign(folderId: string | null = null) {
    if (creating) return;
    setCreating(true);
    try {
      const result = await api.createCampaign({ name: "Nouvelle campagne", status: "inactive", folderId, validationPolicy: "manual", dailyNewContactGoal: 0, sequence: emptySequence });
      setShowArchived(false);
      setSelectedId(result.campaign.id);
      await onMutated();
    } finally {
      setCreating(false);
    }
  }

  const folderGroups = [...folders.map((folder) => ({ ...folder, folderId: folder.id as string | null })), { id: "unfiled", name: "Sans dossier", position: Number.MAX_SAFE_INTEGER, folderId: null }];

  return (
    <section className="view-stack" aria-labelledby="campaigns-title">
      <div className="view-heading intro">
        <div><h1 id="campaigns-title">Campagnes</h1><p>Ciblage, validation, tests A/B et séquences d’emails.</p></div>
        <div className="metric-strip overview"><span><strong>{totals.pendingApproval}</strong> en attente</span><span><strong>{approvedCount}</strong> validés</span></div>
      </div>
      <div className="campaign-layout target-layout">
        <aside className="campaign-sidebar target-side">
          <header className="target-side-head">
            <div><strong>📁 Campagnes</strong><small>{activeCount} actives · {archivedCount} archivées</small></div>
            <button className="target-add" disabled={creating} onClick={() => void createCampaign()}>+ Ajouter</button>
          </header>
          <div className="target-view-switch" role="group" aria-label="Afficher les campagnes actives ou archivées">
            <button className={`target-view-btn ${!showArchived ? "on" : ""}`} aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>📁 Actives <span>{activeCount}</span></button>
            <button className={`target-view-btn ${showArchived ? "on" : ""}`} aria-pressed={showArchived} onClick={() => setShowArchived(true)}>▤ Archives <span>{archivedCount}</span></button>
          </div>
          <div className="target-folders-head"><strong>Dossiers</strong><button className="target-add" onClick={() => void createFolder()}>+ Dossier</button></div>
          <div className="v16-mobile-target">
            <label htmlFor="mobile-campaign-picker">Choisir une campagne</label>
            <select id="mobile-campaign-picker" value={selected?.id || ""} onChange={(event) => setSelectedId(event.target.value)}>
              {displayed.map((campaign) => <option value={campaign.id} key={campaign.id}>{campaign.name}</option>)}
            </select>
          </div>
          <div className="campaign-list target-list">
            {folderGroups.map((folder) => {
              const children = displayed.filter((campaign) => campaign.folderId === folder.folderId);
              if (!children.length && folder.folderId === null) return null;
              return (
                <details className="target-folder" key={folder.id}>
                  <summary className="target-folder-bar">
                    <span className="folder-chevron">▾</span><span className="folder-glyph">📁</span><span className="folder-title">{folder.name}</span><span className="folder-count">{children.length}</span>
                    <span className="folder-actions" onClick={(event) => event.preventDefault()}>
                      <button type="button" title="Ajouter une campagne dans ce dossier" onClick={() => void createCampaign(folder.folderId)}>+</button>
                      {folder.folderId ? <button type="button" title="Renommer le dossier" onClick={() => void renameFolder(folder)}>✎</button> : null}
                      {folder.folderId ? <button type="button" title="Supprimer le dossier" onClick={() => void removeFolder(folder)}>×</button> : null}
                    </span>
                  </summary>
                  <div className="target-folder-items">
                    {children.map((campaign) => (
                      <button className={`target-item ${selected?.id === campaign.id ? "active selected" : ""}`} type="button" key={campaign.id} onClick={() => setSelectedId(campaign.id)}>
                        <span className="target-item-title"><strong>{campaign.name}</strong><i className={`target-status-dot ${campaign.status === "active" ? "on" : ""}`} /></span>
                        <span className="target-meta">{campaign.dailyNewContactGoal} nouveaux/jour · {campaign.validationPolicy === "manual" ? "validation manuelle" : "validation automatique"}</span>
                      </button>
                    ))}
                    {!children.length ? <span className="target-folder-empty">Aucune campagne</span> : null}
                  </div>
                </details>
              );
            })}
          </div>
          {!displayed.length ? <p className="sidebar-empty">{showArchived ? "Aucune campagne archivée." : "Aucune campagne active. Créez une campagne."}</p> : null}
          <footer className="target-side-foot">Les dossiers classent les campagnes sans modifier leurs prospects.</footer>
        </aside>
        <div className="campaign-main target-editor">
          {selected ? (
            <CampaignEditor
              campaign={selected}
              campaignNumber={campaigns.findIndex((campaign) => campaign.id === selected.id) + 1}
              prospectCount={prospectCounts.get(selected.id) || 0}
              folders={folders}
              accounts={accounts}
              experiments={experiments}
              onOpenSettings={onOpenSettings}
              onSaved={onMutated}
            />
          ) : <div className="empty-state"><strong>{showArchived ? "Aucune archive" : "Aucune campagne active"}</strong><span>{showArchived ? "Les campagnes archivées apparaîtront ici." : "Créez une campagne ou consultez les archives."}</span></div>}
        </div>
      </div>
    </section>
  );
}
