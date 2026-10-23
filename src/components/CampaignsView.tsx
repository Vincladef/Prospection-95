import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { Campaign, CampaignFolder, Experiment, GmailAccount, InstructionAttachment, Prospect, SequenceContent } from "../types";
import { InstructionAttachments } from "./InstructionAttachments";

interface CampaignsViewProps {
  campaigns: Campaign[];
  folders: CampaignFolder[];
  accounts: GmailAccount[];
  experiments: Experiment[];
  attachments: InstructionAttachment[];
  prospects: Prospect[];
  totals: { pendingApproval: number };
  onOpenSettings: () => void;
  onMutated: () => Promise<void>;
}

const emptySequence: SequenceContent = {
  subject: "",
  subjectInstructions: "",
  steps: ["", "", "", "", "", ""],
  stepInstructions: ["", "", "", "", "", ""],
};

type VariantGroupKey = "search" | "iterations" | "subject" | "initial" | "followup0" | "followup1" | "followup2" | "followup3" | "followup4" | "reply";
type VariantOverrides = Partial<Record<VariantGroupKey, Record<string, unknown>>>;

function cloneOverrides(value: Record<string, unknown>): VariantOverrides {
  return JSON.parse(JSON.stringify(value || {})) as VariantOverrides;
}

function variantGroup<T extends Record<string, unknown>>(overrides: VariantOverrides, key: VariantGroupKey, fallback: T): T {
  const value = overrides[key];
  return value && typeof value === "object" ? value as T : fallback;
}

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
  attachments,
  onOpenSettings,
  onSaved,
}: {
  campaign: Campaign;
  campaignNumber: number;
  prospectCount: number;
  accounts: GmailAccount[];
  folders: CampaignFolder[];
  experiments: Experiment[];
  attachments: InstructionAttachment[];
  onOpenSettings: () => void;
  onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(campaign);
  const [saving, setSaving] = useState(false);
  const [experimentBusy, setExperimentBusy] = useState(false);
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const [variantDrafts, setVariantDrafts] = useState<Record<string, VariantOverrides>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [showStats, setShowStats] = useState(false);

  useEffect(() => {
    setDraft(campaign);
    setMessage(null);
  }, [campaign]);

  useEffect(() => {
    const next: Record<string, VariantOverrides> = {};
    experiments
      .filter((experiment) => experiment.campaignId === campaign.id)
      .flatMap((experiment) => experiment.variants)
      .forEach((variant) => { next[variant.id] = cloneOverrides(variant.overrides); });
    setVariantDrafts(next);
  }, [campaign.id, experiments]);

  const senderAccounts = useMemo(
    () => accounts.filter((account) => account.role === "sender" && account.status !== "deleted"),
    [accounts],
  );
  const relatedExperiments = useMemo(
    () => experiments.filter((experiment) => experiment.campaignId === campaign.id),
    [campaign.id, experiments],
  );
  const selectedExperiment = relatedExperiments.find((experiment) => experiment.id === selectedExperimentId)
    ?? relatedExperiments[0]
    ?? null;
  const selectedVariant = selectedExperiment?.variants.find((variant) => variant.id === selectedVariantId)
    ?? selectedExperiment?.variants[0]
    ?? null;
  const selectedOverrides = selectedVariant ? (variantDrafts[selectedVariant.id] ?? {}) : {};
  const isReferenceVariant = !selectedVariant || selectedVariant.label === "A";
  const attachmentField = (base: string) => isReferenceVariant ? base : `variant:${selectedVariant?.id}:${base}`;
  const campaignDirty = JSON.stringify(campaignPayload(draft)) !== JSON.stringify(campaignPayload(campaign));
  const dirtyVariants = relatedExperiments.flatMap((experiment) => experiment.variants).filter((variant) =>
    variant.label !== "A" && JSON.stringify(variantDrafts[variant.id] ?? {}) !== JSON.stringify(cloneOverrides(variant.overrides)),
  );
  const dirty = campaignDirty || dirtyVariants.length > 0;

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!dirty || !draft.name.trim()) return;
    setSaving(true);
    setMessage(null);
    try {
      if (campaignDirty) await api.updateCampaign(draft.id, campaignPayload(draft));
      for (const variant of dirtyVariants) {
        await api.updateExperimentVariant(variant.id, { overrides: variantDrafts[variant.id] ?? {} });
      }
      await onSaved();
      setMessage(dirtyVariants.length ? "Campagne et versions A/B enregistrées dans Neon." : "Campagne enregistrée dans Neon.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Enregistrement impossible");
    } finally {
      setSaving(false);
    }
  }

  async function archiveOrRestore() {
    const restoring = campaign.status === "archived";
    const question = restoring
      ? `Restaurer « ${campaign.name} » dans les campagnes courantes ?`
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

  async function createExperiment() {
    setExperimentBusy(true);
    setMessage(null);
    try {
      const result = await api.createExperiment({
        campaignId: campaign.id,
        name: `Test ${relatedExperiments.length + 1}`,
        scope: "sequence",
        thresholdContactsPerVariant: 40,
        thresholdReplies: 20,
        idempotencyKey: `ui-${campaign.id}-${Date.now()}`,
        variants: [
          { label: "A", name: "Référence", allocationWeight: 1, overrides: {} },
        ],
      });
      setSelectedExperimentId(result.experiment.id);
      setSelectedVariantId(null);
      await onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Création du test impossible");
    } finally {
      setExperimentBusy(false);
    }
  }

  async function addVariant() {
    if (!selectedExperiment) return;
    setExperimentBusy(true);
    setMessage(null);
    try {
      const result = await api.addExperimentVariant(selectedExperiment.id);
      setSelectedVariantId(result.variant.id);
      await onSaved();
      setMessage(`Version ${result.variant.label} ajoutée. Elle reprend A tant qu’aucun bloc n’est personnalisé.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Ajout de la version impossible");
    } finally {
      setExperimentBusy(false);
    }
  }

  function baseVariantGroup(key: VariantGroupKey): Record<string, unknown> {
    if (key === "search") return { criteria: draft.targetDescription };
    if (key === "iterations") return { draftPasses: [draft.aiInstructions] };
    if (key === "subject") return { subject: draft.sequence.subject, subjectInstructions: draft.sequence.subjectInstructions };
    if (key === "initial") return { body: draft.sequence.steps[0], bodyInstructions: draft.sequence.stepInstructions[0] };
    if (key === "reply") return { replyInstructions: draft.replyInstructions };
    const index = Number(key.replace("followup", "")) + 1;
    return { body: draft.sequence.steps[index], instructions: draft.sequence.stepInstructions[index] };
  }

  function updateVariantGroup(key: VariantGroupKey, value: Record<string, unknown>) {
    if (!selectedVariant || isReferenceVariant) return;
    setVariantDrafts((current) => ({
      ...current,
      [selectedVariant.id]: { ...(current[selectedVariant.id] ?? {}), [key]: value },
    }));
  }

  function customizeVariantGroup(key: VariantGroupKey) {
    updateVariantGroup(key, JSON.parse(JSON.stringify(baseVariantGroup(key))) as Record<string, unknown>);
  }

  function inheritVariantGroup(key: VariantGroupKey) {
    if (!selectedVariant || isReferenceVariant) return;
    setVariantDrafts((current) => {
      const overrides = { ...(current[selectedVariant.id] ?? {}) };
      delete overrides[key];
      return { ...current, [selectedVariant.id]: overrides };
    });
  }

  function variantBlock(key: VariantGroupKey, label: string, children: ReactNode) {
    if (isReferenceVariant) return <div className="v35-base-group" data-v35-group={key}>{children}</div>;
    const customized = Object.hasOwn(selectedOverrides, key);
    return (
      <div className={`v35-group ${customized ? "v35-custom" : "v35-inherited"}`} data-v35-group={key}>
        <div className="v35-group-head">
          <span>{label}</span>
          <div className="v35-group-tools">
            <span className="v35-flag">{customized ? "Personnalisé" : "Identique à A · hérité"}</span>
            <button className="v35-group-action" type="button" onClick={() => customized ? inheritVariantGroup(key) : customizeVariantGroup(key)}>{customized ? "↶ Reprendre A" : "✎ Personnaliser"}</button>
          </div>
        </div>
        <fieldset className="v35-inputs" disabled={!customized}>{children}</fieldset>
      </div>
    );
  }

  const searchGroup = variantGroup(selectedOverrides, "search", { criteria: draft.targetDescription });
  const iterationsGroup = variantGroup(selectedOverrides, "iterations", { draftPasses: [draft.aiInstructions] as string[] });
  const subjectGroup = variantGroup(selectedOverrides, "subject", { subject: draft.sequence.subject, subjectInstructions: draft.sequence.subjectInstructions });
  const initialGroup = variantGroup(selectedOverrides, "initial", { body: draft.sequence.steps[0], bodyInstructions: draft.sequence.stepInstructions[0] });
  const replyGroup = variantGroup(selectedOverrides, "reply", { replyInstructions: draft.replyInstructions });

  return (
    <form className="campaign-editor target-editor" onSubmit={(event) => void save(event)}>
      <header className="campaign-editor-head target-editor-head">
        <div>
          <h2>{draft.name || "Nouvelle campagne"}</h2>
          <p>{prospectCount} prospect(s) dans l’extrait · Campagne n°{campaignNumber}{campaign.status === "archived" ? " · Archivée" : ""}</p>
        </div>
        <div className="target-actions">
          <span className={`target-notice ${dirty ? "dirty" : ""}`}>{saving ? "Enregistrement…" : message || (dirty ? "Modifications non enregistrées" : "Aucune modification")}</span>
          <button className="secondary campaign-stats-button" type="button" onClick={() => setShowStats(true)}>▥ Voir les statistiques</button>
          <button className="secondary" type="button" disabled={!dirty || saving} onClick={() => setDraft(campaign)}>Annuler</button>
          <button className="target-save" type="submit" disabled={!dirty || saving || !draft.name.trim()}>Enregistrer</button>
          <details className="v16-more v16-target-more">
            <summary aria-label="Autres actions" title="Autres actions">⋯</summary>
            <div><button className="plain-btn" type="button" disabled={saving} onClick={() => void archiveOrRestore()}>{campaign.status === "archived" ? "↶ Restaurer" : "▤ Archiver"}</button></div>
          </details>
        </div>
      </header>

      {showStats ? <div className="campaign-stats-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setShowStats(false); }}><section className="campaign-stats-dialog" role="dialog" aria-modal="true" aria-labelledby="campaign-stats-title"><header><div><h3 id="campaign-stats-title">Statistiques · {campaign.name}</h3><small>Données réelles enregistrées dans Neon</small></div><button type="button" aria-label="Fermer" onClick={() => setShowStats(false)}>×</button></header><div className="campaign-stats-grid"><div><strong>{campaign.stats.sent}</strong><span>emails envoyés</span></div><div><strong>{campaign.stats.contacted}</strong><span>prospects contactés</span></div><div><strong>{campaign.stats.opened}</strong><span>emails ouverts</span><small>{campaign.stats.openRate}% d’ouverture</small></div><div><strong>{campaign.stats.clicked}</strong><span>emails cliqués</span><small>{campaign.stats.clickRate}% de clic</small></div><div><strong>{campaign.stats.replied}</strong><span>prospects ayant répondu</span></div></div>
        <section className="campaign-ab-stats" aria-labelledby="campaign-ab-stats-title">
          <div className="campaign-ab-stats-heading"><strong id="campaign-ab-stats-title">Résultats des tests A/B</strong><span>{relatedExperiments.length ? `${relatedExperiments.length} test${relatedExperiments.length > 1 ? "s" : ""}` : "Aucun test configuré"}</span></div>
          {relatedExperiments.map((experiment, experimentIndex) => <details key={experiment.id} open={experimentIndex === 0} className="campaign-ab-test"><summary><span>{experiment.name}</span><small>{experiment.status === "recruiting" ? "En cours" : experiment.status === "draft" ? "Préparé" : "Terminé"} · {experiment.variants.length} version{experiment.variants.length > 1 ? "s" : ""}</small></summary><div className="campaign-ab-table-wrap"><table className="campaign-ab-table"><thead><tr><th>Version</th><th>Attribués</th><th>Envoyés</th><th>Ouvertures</th><th>Clics</th><th>Réponses</th><th>Positives</th><th>RDV</th></tr></thead><tbody>{experiment.variants.map((variant) => {
            const rate = (value: number) => variant.sentCount ? Math.round((value / variant.sentCount) * 100) : 0;
            return <tr key={variant.id}><th><span className="campaign-ab-letter">{variant.label}</span><small>{variant.name || (variant.label === "A" ? "Référence" : `Version ${variant.label}`)}</small></th><td>{variant.assignedCount}</td><td>{variant.sentCount}</td><td>{variant.openCount}<small>{rate(variant.openCount)} %</small></td><td>{variant.clickCount}<small>{rate(variant.clickCount)} %</small></td><td>{variant.humanReplyCount}<small>{rate(variant.humanReplyCount)} %</small></td><td>{variant.positiveReplyCount}</td><td>{variant.confirmedMeetingCount}</td></tr>;
          })}</tbody></table></div></details>)}
          {!relatedExperiments.length ? <p>Les résultats par version apparaîtront ici dès qu’un test sera créé.</p> : null}
        </section>
        <p>Les ouvertures et clics sont comptés par email au moins une fois. Les ouvertures peuvent inclure les proxys d’images des messageries.</p><footer><span>{campaign.stats.lastSentAt ? `Dernier envoi : ${new Date(campaign.stats.lastSentAt).toLocaleString("fr-FR")}` : "Aucun envoi confirmé"}</span><button className="win-button primary" type="button" onClick={() => setShowStats(false)}>Fermer</button></footer></section></div> : null}

      <div className="target-form">
        <div className="target-help-note">
          <strong>{campaign.status === "archived" ? "Campagne archivée." : "Configuration de la campagne."}</strong>{" "}
          {campaign.status === "archived" ? "Elle est retirée des campagnes courantes ; son historique reste disponible." : "Ces modèles servent à préparer les emails et les réponses de cette campagne."}{" "}
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
              <label><input type="checkbox" checked={draft.trackingOpensEnabled} onChange={(event) => setDraft((current) => ({ ...current, trackingOpensEnabled: event.target.checked }))} /> Détecter les ouvertures</label>
              <label><input type="checkbox" checked={draft.trackingClicksEnabled} onChange={(event) => setDraft((current) => ({ ...current, trackingClicksEnabled: event.target.checked }))} /> Mesurer les clics sur les liens</label>
              <small>Suivi signé appliqué aux prochains envois. Une ouverture est une observation technique : les proxys d’images comme Gmail peuvent la déclencher sans lecture humaine.</small>
            </div>
          </details>
        </section>

        <section className="target-section">
          <div className="target-section-title"><h3>Validation des emails</h3><small>Mode appliqué aux futurs messages générés</small></div>
          <div className="v21-approval-options">
            <label className="v21-choice"><input type="radio" name="approval-mode" checked={draft.validationPolicy === "manual"} onChange={() => setDraft((current) => ({ ...current, validationPolicy: "manual" }))} /><span><strong>Validation manuelle</strong><small>Les nouveaux emails commencent « En attente… » et tu les valides toi-même dans Prospects.</small></span></label>
            <label className="v21-choice"><input type="radio" name="approval-mode" checked={draft.validationPolicy === "automatic"} onChange={() => setDraft((current) => ({ ...current, validationPolicy: "automatic" }))} /><span><strong>Validation automatique</strong><small>Les futurs emails peuvent passer « Validé » après les contrôles obligatoires, sans clic humain.</small></span></label>
          </div>
          <div className="v21-config-example">{draft.validationPolicy === "automatic" ? "Prochain email conforme : Validé automatiquement" : "Prochain email : En attente de validation humaine"}</div>
        </section>

        <section className="v37-testnav" aria-labelledby="campaign-tests-title">
          <div className="v37-testnav-top">
            <div className="v37-testnav-heading"><span className="v37-flask" aria-hidden="true">⚗</span><strong id="campaign-tests-title">Tests A/B</strong><span className="v37-test-count">{relatedExperiments.length} test{relatedExperiments.length > 1 ? "s" : ""}</span></div>
            <div className="v37-testnav-select">
              <label className="v37-test-count" htmlFor="campaign-experiment">Expérience</label>
              <select id="campaign-experiment" value={selectedExperiment?.id || ""} onChange={(event) => { setSelectedExperimentId(event.target.value); setSelectedVariantId(null); }} disabled={!relatedExperiments.length}>
                {!relatedExperiments.length ? <option value="">Aucun test</option> : null}
                {relatedExperiments.map((experiment, index) => <option value={experiment.id} key={experiment.id}>Test {index + 1} · {experiment.variants.length > 1 ? experiment.variants.map((variant) => variant.label).join(" / ") : "À configurer"} · {experiment.status === "recruiting" ? "En cours" : experiment.status === "draft" ? "Préparé" : "Terminé"}</option>)}
              </select>
              <button type="button" disabled={experimentBusy} onClick={() => void createExperiment()}>+ Nouveau test</button>
            </div>
          </div>
          {selectedExperiment ? (
            <>
              <div className="v37-state-line">
                <div className="v37-state-copy"><span className={`v37-state ${selectedExperiment.status === "recruiting" ? "active" : selectedExperiment.status === "draft" ? "" : "completed"}`}>{selectedExperiment.status === "recruiting" ? "En cours" : selectedExperiment.status === "draft" ? "Préparé" : "Terminé"}</span><span className="v37-test-count">{selectedExperiment.name} · {selectedExperiment.variants.map((variant) => variant.label).join(" / ") || "Référence A seule"}</span></div>
              </div>
              <details className="v40-rules">
                <summary>⚙ Règles du test <span className="v40-rules-overview">{selectedExperiment.thresholdContactsPerVariant} prospects / variante · 4 indicateurs</span></summary>
                <div className="v40-rules-body"><div className="v40-rules-grid"><label className="v40-rule"><span>Prospects par variante</span><input value={selectedExperiment.thresholdContactsPerVariant} readOnly /></label><label className="v40-rule"><span>Réponses minimales</span><input value={selectedExperiment.thresholdReplies} readOnly /></label><div className="v40-rule"><span>Indicateurs</span><small>Réponse humaine, réponse positive, rendez-vous confirmé et suivi disponible.</small></div></div></div>
              </details>
            </>
          ) : <p className="v37-testnav-note">Crée le premier test pour comparer une référence A à une autre version.</p>}
          <div className="v48-ab-preferences">
            <div className="v48-ab-policy"><label htmlFor="experiment-policy">À l’issue du test</label><select id="experiment-policy" value={draft.experimentPolicy} onChange={(event) => setDraft((current) => ({ ...current, experimentPolicy: event.target.value as Campaign["experimentPolicy"] }))}><option value="continue">Optimisation continue</option><option value="stabilize">Stabiliser sur la meilleure approche</option></select></div>
            {draft.experimentPolicy === "continue" ? <details className="v48-roadmap"><summary>Instructions pour les prochains tests <span>{draft.nextTestInstructions.trim() ? "Renseignées" : "Facultatif"}</span></summary><div className="v48-roadmap-body"><textarea rows={4} value={draft.nextTestInstructions} onChange={(event) => setDraft((current) => ({ ...current, nextTestInstructions: event.target.value }))} /><small>Consignes pour cette campagne, adaptées aux résultats par ChatGPT.</small><InstructionAttachments attachments={attachments} scope="campaign" campaignId={campaign.id} fieldKey="next-tests" /></div></details> : null}
          </div>
        </section>

        {selectedExperiment ? (
          <section className="v35-variant-panel">
            <div className="v35-topline">
              <div><strong>Versions du test · {selectedExperiment.name}</strong><small>{selectedExperiment.variants.length > 1 ? selectedExperiment.variants.map((variant) => variant.label).join(" / ") : "Référence A"}</small></div>
              <div className="v35-tabs v43-tabs" role="group" aria-label="Choisir une version">
                {selectedExperiment.variants.map((variant, index) => {
                  const customCount = Object.keys(variantDrafts[variant.id] ?? {}).length;
                  return <button type="button" className={selectedVariant?.id === variant.id ? "on" : ""} onClick={() => setSelectedVariantId(variant.id)} key={variant.id}>{variant.label}{relatedExperiments.indexOf(selectedExperiment) + 1}{index === 0 ? " · Référence" : ` · ${customCount} perso.`}</button>;
                })}
                <button type="button" id="v35-add-version" disabled={experimentBusy || selectedExperiment.status !== "draft" || selectedExperiment.variants.length >= 12} onClick={() => void addVariant()}>+ Version</button>
              </div>
            </div>
            <div className="v35-options"><small>{selectedExperiment.variants.length === 1 ? "A est la référence. Ajoute une version pour préparer la comparaison." : isReferenceVariant ? "Chaque autre version reprend A, sauf les blocs personnalisés." : `${selectedVariant?.label}${relatedExperiments.indexOf(selectedExperiment) + 1} · ${Object.keys(selectedOverrides).length} bloc(s) personnalisé(s).`}</small></div>
            {!isReferenceVariant ? <p className="v35-explain">Les éléments gris reprennent A. Clique sur « Personnaliser » pour modifier uniquement ce bloc.</p> : null}
          </section>
        ) : null}

        <section className="target-section">
          <div className="target-section-title"><h3>Critères et instructions de recherche des prospects</h3><small>{isReferenceVariant ? "Recherche de référence" : `Recherche · version ${selectedVariant?.label}`}</small></div>
          {variantBlock("search", "Recherche de prospects", <div className="target-field"><textarea rows={6} aria-label="Critères et instructions de recherche des prospects" value={searchGroup.criteria} onChange={(event) => {
            if (isReferenceVariant) setDraft((current) => ({ ...current, targetDescription: event.target.value }));
            else updateVariantGroup("search", { ...searchGroup, criteria: event.target.value });
          }} /><InstructionAttachments attachments={attachments} scope="campaign" campaignId={campaign.id} fieldKey={attachmentField("search")} /></div>)}
        </section>

        <section className="target-section">
          <div className="target-section-title"><h3>Itérations de rédaction IA</h3><small>{isReferenceVariant ? "Configuration de référence" : `Version ${selectedVariant?.label}`}</small></div>
          {variantBlock("iterations", "Itérations", <div className="v23-pass-config"><div className="v23-pass-head"><label>Nombre d’itérations <input type="number" value={1} min={1} max={1} readOnly /></label><span className="target-pill">1 itération successive</span></div><div className="v23-pass-list"><label className="v23-pass-step"><strong>Itération 1</strong><small>Prépare une première version de la séquence : objet, premier email et relances.</small><textarea value={iterationsGroup.draftPasses[0] || ""} onChange={(event) => {
            if (isReferenceVariant) setDraft((current) => ({ ...current, aiInstructions: event.target.value }));
            else updateVariantGroup("iterations", { ...iterationsGroup, draftPasses: [event.target.value] });
          }} /></label><InstructionAttachments attachments={attachments} scope="campaign" campaignId={campaign.id} fieldKey={attachmentField("iterations")} /></div><p className="v23-pass-help">Les itérations concernent l’objet et les six emails de cette version. Le statut des prospects sera actualisé par ChatGPT via Neon.</p></div>)}
        </section>

        <section className="target-section">
          <div className="target-section-title"><h3>Premier email</h3><small>Objet et modèle personnalisables séparément</small></div>
          {variantBlock("subject", "Objet", <div className="target-field"><label className="target-field target-subject-field"><span>Objet type à personnaliser</span><input value={subjectGroup.subject} onChange={(event) => {
            if (isReferenceVariant) setDraft((current) => ({ ...current, sequence: { ...current.sequence, subject: event.target.value } }));
            else updateVariantGroup("subject", { ...subjectGroup, subject: event.target.value });
          }} /></label><details className="v25-instructions v25-subject-guidance"><summary>Instructions{subjectGroup.subjectInstructions.trim() ? " · renseignées" : ""}</summary><div className="v25-instructions-body"><label>Consignes pour personnaliser l’objet<textarea value={subjectGroup.subjectInstructions} onChange={(event) => {
            if (isReferenceVariant) setDraft((current) => ({ ...current, sequence: { ...current.sequence, subjectInstructions: event.target.value } }));
            else updateVariantGroup("subject", { ...subjectGroup, subjectInstructions: event.target.value });
          }} /></label><InstructionAttachments attachments={attachments} scope="campaign" campaignId={campaign.id} fieldKey={attachmentField("subject-instructions")} /></div></details></div>)}
          {variantBlock("initial", "Premier message", <div className="target-field"><label className="target-field target-initial-field"><span>Modèle du premier email</span><textarea rows={8} value={initialGroup.body} onChange={(event) => {
            if (isReferenceVariant) {
              const steps = draft.sequence.steps.map((value, index) => index === 0 ? event.target.value : value) as SequenceContent["steps"];
              setDraft((current) => ({ ...current, sequence: { ...current.sequence, steps } }));
            } else updateVariantGroup("initial", { ...initialGroup, body: event.target.value });
          }} /></label><InstructionAttachments attachments={attachments} scope="campaign" campaignId={campaign.id} fieldKey={attachmentField("initial-model")} /><details className="v25-instructions"><summary>Instructions{initialGroup.bodyInstructions.trim() ? " · renseignées" : ""}</summary><div className="v25-instructions-body"><label>Consignes pour le premier email<textarea value={initialGroup.bodyInstructions} onChange={(event) => {
            if (isReferenceVariant) {
              const stepInstructions = draft.sequence.stepInstructions.map((value, index) => index === 0 ? event.target.value : value) as SequenceContent["stepInstructions"];
              setDraft((current) => ({ ...current, sequence: { ...current.sequence, stepInstructions } }));
            } else updateVariantGroup("initial", { ...initialGroup, bodyInstructions: event.target.value });
          }} /></label><InstructionAttachments attachments={attachments} scope="campaign" campaignId={campaign.id} fieldKey={attachmentField("initial-instructions")} /></div></details></div>)}
        </section>

        <section className="target-section">
          <div className="target-section-title"><h3>Relances</h3><small>R1 à R5 · délais conservés</small></div>
          <div className="target-sequences v35-followups">
            {draft.sequence.steps.slice(1).map((_step, followupIndex) => {
              const index = followupIndex + 1;
              const key = `followup${followupIndex}` as VariantGroupKey;
              const followupGroup = variantGroup(selectedOverrides, key, { body: draft.sequence.steps[index], instructions: draft.sequence.stepInstructions[index] });
              return <div key={index}>{variantBlock(key, `R${index} · ${["J+3", "J+7", "J+7", "J+14", "J+14"][followupIndex]}`, <article className="target-sequence-card"><span className="target-sequence-header"><strong>R{index}</strong><small>{["J+3", "J+7", "J+7", "J+14", "J+14"][followupIndex]}</small></span><textarea value={followupGroup.body} onChange={(event) => {
                if (isReferenceVariant) {
                  const steps = draft.sequence.steps.map((value, stepIndex) => stepIndex === index ? event.target.value : value) as SequenceContent["steps"];
                  setDraft((current) => ({ ...current, sequence: { ...current.sequence, steps } }));
                } else updateVariantGroup(key, { ...followupGroup, body: event.target.value });
              }} /><InstructionAttachments attachments={attachments} scope="campaign" campaignId={campaign.id} fieldKey={attachmentField(`r${index}-model`)} /><details className="v25-instructions"><summary>Instructions{followupGroup.instructions.trim() ? " · renseignées" : ""}</summary><div className="v25-instructions-body"><label>Consignes pour la relance R{index}<textarea value={followupGroup.instructions} onChange={(event) => {
                if (isReferenceVariant) {
                  const stepInstructions = draft.sequence.stepInstructions.map((value, stepIndex) => stepIndex === index ? event.target.value : value) as SequenceContent["stepInstructions"];
                  setDraft((current) => ({ ...current, sequence: { ...current.sequence, stepInstructions } }));
                } else updateVariantGroup(key, { ...followupGroup, instructions: event.target.value });
              }} /></label><InstructionAttachments attachments={attachments} scope="campaign" campaignId={campaign.id} fieldKey={attachmentField(`r${index}-instructions`)} /></div></details></article>)}</div>;
            })}
          </div>
        </section>

        <section className="target-section">
          <div className="target-section-title"><h3>Instructions pour les réponses</h3></div>
          {variantBlock("reply", "Instructions de réponse", <div className="target-field target-reply"><span>Comment répondre aux prospects selon leur réaction ?</span><textarea rows={7} value={replyGroup.replyInstructions} onChange={(event) => {
            if (isReferenceVariant) setDraft((current) => ({ ...current, replyInstructions: event.target.value }));
            else updateVariantGroup("reply", { ...replyGroup, replyInstructions: event.target.value });
          }} /><InstructionAttachments attachments={attachments} scope="campaign" campaignId={campaign.id} fieldKey={attachmentField("reply")} /></div>)}
        </section>
      </div>

      <footer className="target-footer campaign-footer">
        <span>Neon PostgreSQL · version {draft.version}{draft.importedDisabled ? " · campagne importée, envois désactivés" : ""}</span>
        <button className="target-save" type="submit" disabled={!dirty || saving || !draft.name.trim()}>Enregistrer</button>
      </footer>
    </form>
  );
}

export function CampaignsView({ campaigns, folders, accounts, experiments, attachments, prospects, totals, onOpenSettings, onMutated }: CampaignsViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(campaigns[0]?.id || null);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);

  const displayed = useMemo(
    () => campaigns.filter((campaign) => showArchived ? campaign.status === "archived" : campaign.status !== "archived"),
    [campaigns, showArchived],
  );
  const selected = displayed.find((campaign) => campaign.id === selectedId) || displayed[0] || null;
  const currentCount = campaigns.filter((campaign) => campaign.status !== "archived").length;
  const archivedCount = campaigns.length - currentCount;
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
      const result = await api.createCampaign({ name: "Nouvelle campagne", status: "inactive", folderId, validationPolicy: "manual", dailyNewContactGoal: 0, trackingOpensEnabled: true, trackingClicksEnabled: true, sequence: emptySequence });
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
            <div><strong>📁 Campagnes</strong><small>{currentCount} courantes · {archivedCount} archivées</small></div>
            <button className="target-add" disabled={creating} onClick={() => void createCampaign()}>+ Ajouter</button>
          </header>
          <div className="target-view-switch" role="group" aria-label="Afficher les campagnes courantes ou archivées">
            <button className={`target-view-btn ${!showArchived ? "on" : ""}`} aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>📁 Courantes <span>{currentCount}</span></button>
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
          {!displayed.length ? <p className="sidebar-empty">{showArchived ? "Aucune campagne archivée." : "Aucune campagne courante. Créez une campagne."}</p> : null}
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
              attachments={attachments}
              onOpenSettings={onOpenSettings}
              onSaved={onMutated}
            />
          ) : <div className="empty-state"><strong>{showArchived ? "Aucune archive" : "Aucune campagne courante"}</strong><span>{showArchived ? "Les campagnes archivées apparaîtront ici." : "Créez une campagne ou consultez les archives."}</span></div>}
        </div>
      </div>
    </section>
  );
}
