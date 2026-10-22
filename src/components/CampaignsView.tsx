import { FormEvent, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { Campaign, CampaignFolder, Experiment, GmailAccount, SequenceContent } from "../types";

interface CampaignsViewProps {
  campaigns: Campaign[];
  folders: CampaignFolder[];
  accounts: GmailAccount[];
  experiments: Experiment[];
  onMutated: () => Promise<void>;
}

type EditorTab = "target" | "writing" | "experiments";

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
  accounts,
  folders,
  experiments,
  onSaved,
}: {
  campaign: Campaign;
  accounts: GmailAccount[];
  folders: CampaignFolder[];
  experiments: Experiment[];
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(campaign);
  const [tab, setTab] = useState<EditorTab>("target");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setDraft(campaign);
    setTab("target");
    setMessage(null);
  }, [campaign]);

  async function save(event: FormEvent) {
    event.preventDefault();
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

  const relatedExperiments = experiments.filter((experiment) => experiment.campaignId === campaign.id);

  return (
    <form className="campaign-editor target-editor" onSubmit={save}>
      <div className="campaign-editor-head target-editor-head">
        <div>
          <input
            className="campaign-name-input"
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            aria-label="Nom de la campagne"
          />
          <span className={`campaign-state state-${draft.status}`}>{draft.status}</span>
          {draft.importedDisabled ? <span className="campaign-state imported">Importée · envois désactivés</span> : null}
        </div>
        <div className="dialog-actions">
          <select
            value={draft.status}
            onChange={(event) => setDraft((current) => ({ ...current, status: event.target.value as Campaign["status"] }))}
            aria-label="État de la campagne"
          >
            <option value="inactive">Inactive</option>
            <option value="active">Active</option>
            <option value="archived">Archivée</option>
          </select>
          <button className="win-button primary" disabled={saving || !draft.name.trim()} type="submit">
            {saving ? "Enregistrement…" : "Enregistrer"}
          </button>
        </div>
      </div>

      <div className="subtabs target-view-switch" role="tablist" aria-label="Configuration de la campagne">
        <button type="button" role="tab" aria-selected={tab === "target"} className={tab === "target" ? "active" : ""} onClick={() => setTab("target")}>Cible & envoi</button>
        <button type="button" role="tab" aria-selected={tab === "writing"} className={tab === "writing" ? "active" : ""} onClick={() => setTab("writing")}>Rédaction J0–R5</button>
        <button type="button" role="tab" aria-selected={tab === "experiments"} className={tab === "experiments" ? "active" : ""} onClick={() => setTab("experiments")}>Tests A/B</button>
      </div>

      {tab === "target" ? (
        <div className="campaign-panel target-form two-column-form">
          <label className="field wide-field">
            <span>Population ciblée</span>
            <textarea rows={8} value={draft.targetDescription} onChange={(event) => setDraft((current) => ({ ...current, targetDescription: event.target.value }))} />
            <small>Les agents reliront cette consigne dans Neon au début de chaque exécution.</small>
          </label>
          <fieldset className="win-group">
            <legend>Cadence et validation</legend>
            <label className="field">
              <span>Dossier</span>
              <select value={draft.folderId || ""} onChange={(event) => setDraft((current) => ({ ...current, folderId: event.target.value || null }))}>
                <option value="">Sans dossier</option>
                {folders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Nouveaux contacts par jour</span>
              <input type="number" min={0} max={10000} value={draft.dailyNewContactGoal} onChange={(event) => setDraft((current) => ({ ...current, dailyNewContactGoal: Number(event.target.value) }))} />
            </label>
            <label className="field">
              <span>Validation</span>
              <select value={draft.validationPolicy} onChange={(event) => setDraft((current) => ({ ...current, validationPolicy: event.target.value as Campaign["validationPolicy"] }))}>
                <option value="manual">Manuelle</option>
                <option value="automatic">Automatique sous garde-fous</option>
              </select>
            </label>
            <label className="field">
              <span>Répartition Gmail</span>
              <select value={draft.senderStrategy} onChange={(event) => setDraft((current) => ({ ...current, senderStrategy: event.target.value as Campaign["senderStrategy"] }))}>
                <option value="fixed">Compte fixe</option>
                <option value="pool">Pool de comptes</option>
              </select>
            </label>
            {draft.senderStrategy === "fixed" ? (
              <label className="field">
                <span>Compte expéditeur</span>
                <select value={draft.fixedSenderAccountId || ""} onChange={(event) => setDraft((current) => ({ ...current, fixedSenderAccountId: event.target.value || null }))}>
                  <option value="">Aucun compte attribué</option>
                  {accounts.filter((account) => account.role === "sender" && account.status !== "deleted").map((account) => <option value={account.id} key={account.id}>{account.email}</option>)}
                </select>
              </label>
            ) : (
              <fieldset className="win-group full-field">
                <legend>Comptes du pool</legend>
                {accounts.filter((account) => account.role === "sender" && account.status !== "deleted").map((account) => (
                  <label className="check-field" key={account.id}>
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
                    {account.email}
                  </label>
                ))}
                {!accounts.some((account) => account.role === "sender" && account.status !== "deleted") ? <p>Aucun compte expéditeur.</p> : null}
              </fieldset>
            )}
            <label className="check-field"><input type="checkbox" disabled checked={draft.trackingOpensEnabled} /> Suivi des ouvertures — non configuré</label>
            <label className="check-field"><input type="checkbox" disabled checked={draft.trackingClicksEnabled} /> Suivi des clics — non configuré</label>
            <p className="field-note">Les endpoints signés ne sont pas encore livrés. La métrique reste indisponible, jamais zéro.</p>
          </fieldset>
          <label className="field wide-field">
            <span>Consignes de recherche et de rédaction</span>
            <textarea rows={7} value={draft.aiInstructions} onChange={(event) => setDraft((current) => ({ ...current, aiInstructions: event.target.value }))} />
          </label>
          <label className="field wide-field">
            <span>Consignes de réponse</span>
            <textarea rows={7} value={draft.replyInstructions} onChange={(event) => setDraft((current) => ({ ...current, replyInstructions: event.target.value }))} />
          </label>
        </div>
      ) : null}

      {tab === "writing" ? (
        <div className="campaign-panel target-form">
          <label className="field full-field">
            <span>Objet / consigne d’objet</span>
            <input value={draft.sequence.subject} onChange={(event) => setDraft((current) => ({ ...current, sequence: { ...current.sequence, subject: event.target.value } }))} />
          </label>
          <div className="sequence-editor-grid">
            {draft.sequence.steps.map((step, index) => (
              <label className="message-card" key={index}>
                <span className="message-card-title"><strong>{index === 0 ? "Message initial" : `Relance R${index}`}</strong><small>{["J0", "J+3", "+7j", "+7j", "+14j", "+14j"][index]}</small></span>
                <textarea
                  rows={12}
                  value={step}
                  onChange={(event) => {
                    const steps = draft.sequence.steps.map((value, stepIndex) => stepIndex === index ? event.target.value : value) as SequenceContent["steps"];
                    setDraft((current) => ({ ...current, sequence: { ...current.sequence, steps } }));
                  }}
                />
              </label>
            ))}
          </div>
          <div className="win-alert info">Les échéances sont calculées depuis chaque expédition réellement confirmée, jamais depuis la préparation.</div>
        </div>
      ) : null}

      {tab === "experiments" ? (
        <div className="campaign-panel target-form experiments-panel">
          <fieldset className="win-group experiment-policy">
            <legend>Politique après chaque test</legend>
            <label className="radio-field"><input type="radio" name="policy" checked={draft.experimentPolicy === "continue"} onChange={() => setDraft((current) => ({ ...current, experimentPolicy: "continue" }))} /> Optimisation continue</label>
            <label className="radio-field"><input type="radio" name="policy" checked={draft.experimentPolicy === "stabilize"} onChange={() => setDraft((current) => ({ ...current, experimentPolicy: "stabilize" }))} /> Stabiliser la variante retenue</label>
            <label className="field full-field"><span>Instructions pour les prochains tests</span><textarea rows={4} value={draft.nextTestInstructions} onChange={(event) => setDraft((current) => ({ ...current, nextTestInstructions: event.target.value }))} /></label>
          </fieldset>
          {relatedExperiments.length ? relatedExperiments.map((experiment) => (
            <section className="experiment-card" key={experiment.id}>
              <header><div><strong>{experiment.name}</strong><span>{experiment.status}</span></div><small>Seuils : {experiment.thresholdContactsPerVariant}/variante ou {experiment.thresholdReplies} réponses</small></header>
              <div className="variant-grid">
                {experiment.variants.map((variant) => (
                  <article key={variant.id}>
                    <h3>Variante {variant.label}</h3>
                    <dl>
                      <div><dt>Attribués</dt><dd>{variant.assignedCount}</dd></div>
                      <div><dt>Expédiés</dt><dd>{variant.sentCount}</dd></div>
                      <div><dt>Réponses humaines</dt><dd>{variant.humanReplyCount}</dd></div>
                      <div><dt>Réponses positives</dt><dd>{variant.positiveReplyCount}</dd></div>
                      <div><dt>Rendez-vous confirmés</dt><dd>{variant.confirmedMeetingCount}</dd></div>
                    </dl>
                  </article>
                ))}
              </div>
            </section>
          )) : <div className="empty-state"><strong>Aucun test A/B</strong><span>L’agent de prospection pourra proposer une expérience via le contrat SQL documenté.</span></div>}
        </div>
      ) : null}

      <footer className="campaign-footer"><span>{message || `Version ${draft.version}`}</span><span>Les contenus exposés sont versionnés et ne sont plus réécrits.</span></footer>
    </form>
  );
}

export function CampaignsView({ campaigns, folders, accounts, experiments, onMutated }: CampaignsViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(campaigns[0]?.id || null);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const selected = campaigns.find((campaign) => campaign.id === selectedId) || campaigns[0] || null;

  useEffect(() => {
    if (selectedId && !campaigns.some((campaign) => campaign.id === selectedId)) setSelectedId(campaigns[0]?.id || null);
  }, [campaigns, selectedId]);

  const displayed = useMemo(() => campaigns.filter((campaign) => showArchived ? campaign.status === "archived" : campaign.status !== "archived"), [campaigns, showArchived]);

  async function createFolder() {
    const name = window.prompt("Nom du dossier");
    if (!name?.trim()) return;
    await api.createCampaignFolder({ name: name.trim(), position: folders.length });
    await onMutated();
  }

  async function createCampaign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api.createCampaign({
      name: String(form.get("name") || "Nouvelle campagne"),
      status: "inactive",
      validationPolicy: "manual",
      dailyNewContactGoal: 0,
      sequence: emptySequence,
    });
    setCreating(false);
    await onMutated();
  }

  return (
    <section className="view-stack" aria-labelledby="campaigns-title">
      <div className="view-heading intro"><div><h1 id="campaigns-title">Campagnes</h1><p>Ciblage, validation, tests A/B et séquences d’emails.</p></div></div>
      <div className="campaign-layout target-layout">
        <aside className="campaign-sidebar target-side">
          <header className="win-titlebar target-side-head"><strong>📁 Campagnes</strong></header>
          <div className="campaign-sidebar-tools">
            <button className="win-button primary" onClick={() => setCreating(true)}>+ Ajouter</button>
            <button className="win-button" onClick={() => void createFolder()}>+ Dossier</button>
            <button className={`win-button ${showArchived ? "pressed" : ""}`} onClick={() => setShowArchived((value) => !value)}>{showArchived ? "Actives" : "Archives"}</button>
          </div>
          {creating ? (
            <form className="new-campaign-form" onSubmit={(event) => void createCampaign(event)}>
              <input name="name" required autoFocus placeholder="Nom de la campagne" />
              <div><button className="win-button primary">Créer</button><button type="button" className="win-button" onClick={() => setCreating(false)}>Annuler</button></div>
            </form>
          ) : null}
          <div className="campaign-list target-list">
            {[...folders, { id: "", name: "Sans dossier", position: Number.MAX_SAFE_INTEGER }].map((folder) => {
              const children = displayed.filter((campaign) => (campaign.folderId || "") === folder.id);
              if (!children.length && !folder.id) return null;
              return <div key={folder.id || "unfiled"}>
                <div className="folder-heading">▾ {folder.name}{folder.id ? <button className="folder-delete" title="Supprimer le dossier" onClick={async () => { if (!window.confirm(`Supprimer le dossier ${folder.name} ? Les campagnes seront conservées.`)) return; await api.deleteCampaignFolder(folder.id); await onMutated(); }}>×</button> : null}</div>
                {children.map((campaign) => (
                  <button key={campaign.id} className={selected?.id === campaign.id ? "selected" : ""} onClick={() => setSelectedId(campaign.id)}>
                    <span className={`campaign-dot ${campaign.status}`} />
                    <span><strong>{campaign.name}</strong><small>{campaign.dailyNewContactGoal} nouveaux/jour · {campaign.validationPolicy === "manual" ? "validation manuelle" : "automatique"}</small></span>
                  </button>
                ))}
              </div>;
            })}
          </div>
          {!displayed.length ? <p className="sidebar-empty">Aucune campagne dans cette vue.</p> : null}
        </aside>
        <main className="campaign-main target-editor">
          {selected ? <CampaignEditor campaign={selected} folders={folders} accounts={accounts} experiments={experiments} onSaved={onMutated} /> : <div className="empty-state"><strong>Aucune campagne</strong><span>Créez une campagne ou importez le CRM historique.</span></div>}
        </main>
      </div>
    </section>
  );
}
