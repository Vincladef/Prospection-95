import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Campaign, Experiment } from "../types";
import { CampaignsView } from "./CampaignsView";
import { campaignVariantDefaults, materializeVariant, resolveVariantGroups } from "../lib/variant-configuration";

const apiMocks = vi.hoisted(() => ({
  addExperimentVariant: vi.fn(),
  createExperiment: vi.fn(),
  createCampaign: vi.fn(),
  moveCampaignToFolder: vi.fn(),
  updateExperimentVariant: vi.fn(),
  updateCampaign: vi.fn(),
  uploadInstructionAttachment: vi.fn(),
}));

vi.mock("../lib/api", () => ({ api: apiMocks }));

const campaign: Campaign = {
  id: "11111111-1111-4111-8111-111111111111",
  folderId: null,
  name: "Nouvelle campagne",
  status: "inactive",
  targetDescription: "",
  dailyNewContactGoal: 0,
  validationPolicy: "manual",
  senderStrategy: "fixed",
  fixedSenderAccountId: null,
  senderAccountIds: [],
  aiInstructions: "",
  writingIterations: ["Prépare une première version."],
  replyInstructions: "",
  replyMode: "draft",
  replyAutoScope: "first",
  replyIterations: [""],
  trackingOpensEnabled: false,
  trackingClicksEnabled: false,
  experimentPolicy: "continue",
  nextTestInstructions: "",
  importedDisabled: true,
  version: 1,
  sequence: {
    subject: "",
    subjectInstructions: "",
    steps: ["", "", "", "", "", ""],
    stepInstructions: ["", "", "", "", "", ""],
  },
  updatedAt: "2026-10-22T00:00:00.000Z",
  stats: { sent: 0, contacted: 0, opened: 0, clicked: 0, replied: 0, unclassifiedReplies: 2, openRate: 0, clickRate: 0, firstSentAt: null, lastSentAt: null },
};

const experiment: Experiment = {
  id: "22222222-2222-4222-8222-222222222222",
  campaignId: campaign.id,
  name: "Test 1",
  status: "draft",
  scope: "sequence",
  comparablePopulation: true,
  allocationMethod: "balanced_random",
  thresholdContactsPerVariant: 40,
  thresholdReplies: 20,
  winnerVariantId: null,
  winnerVariantLabel: null,
  decision: null,
  matureAt: null,
  variants: [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", label: "A", name: "Référence", allocationWeight: 1, overrides: {}, assignedCount: 0, sentCount: 10, contactedCount: 8, openRate:60,clickRate:30,replyRate:25, humanReplyCount: 2, unclassifiedReplyCount: 1, positiveReplyCount: 1, confirmedMeetingCount: 1, openCount: 6, clickCount: 3 },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", label: "B", name: "Version B", allocationWeight: 1, overrides: { search: { criteria: "Recherche propre à la version B" } }, assignedCount: 0, sentCount: 10, contactedCount: 9, openRate:70,clickRate:40,replyRate:33, humanReplyCount: 3, unclassifiedReplyCount: 0, positiveReplyCount: 2, confirmedMeetingCount: 1, openCount: 7, clickCount: 4 },
  ],
};

function renderCampaigns(experiments: Experiment[] = [], campaigns: Campaign[] = [campaign], selectedCampaignId: string | null = null, folders: { id: string; name: string; position: number }[] = []) {
  const onMutated = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <CampaignsView
      campaigns={campaigns}
      folders={folders}
      accounts={[]}
      experiments={experiments}
      attachments={[]}
      prospects={[]}
      totals={{ pendingApproval: 0 }}
      selectedCampaignId={selectedCampaignId}
      onOpenSettings={vi.fn()}
      onMutated={onMutated}
    />,
  );
  return { onMutated, ...view };
}

describe("CampaignsView V53", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.createCampaign.mockResolvedValue({ campaign: { id: campaign.id, version: 1 } });
    apiMocks.moveCampaignToFolder.mockResolvedValue({ campaign: { id: campaign.id, version: 2 } });
    apiMocks.addExperimentVariant.mockResolvedValue({ variant: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", label: "C", name: "Version C" } });
    apiMocks.updateCampaign.mockResolvedValue({ campaign: { id: campaign.id, version: 2 } });
    apiMocks.updateExperimentVariant.mockResolvedValue({variant:{id:experiment.variants[1].id,label:"B",version:2}});
    apiMocks.uploadInstructionAttachment.mockResolvedValue({attachment:{id:"file-036"}});
  });

  afterEach(cleanup);

  it("displays daily sourcing separately from emails sent", () => {
    const sample: Campaign = { ...campaign, status: "active", dailyNewContactGoal: 5,
      stats: { ...campaign.stats, newContactsToday: 2, writingInProgress: 1, sent: 0 } };
    renderCampaigns([], [sample]);
    const region = screen.getByRole("region", { name: "Avancement quotidien des nouveaux contacts" });
    expect(within(region).getByText("3")).toBeInTheDocument();
    expect(within(region).getByText("1")).toBeInTheDocument();
    expect(screen.getByText(/Aujourd'hui : 2\/5 contacts ajoutés/)).toBeInTheDocument();
  });

  it("saves first-exchange automation without broadening it to later replies", async () => {
    renderCampaigns();
    fireEvent.click(screen.getByRole("radio",{name:/Réponse automatique/}));
    expect(screen.getByRole("combobox",{name:/Automatique pour/})).toHaveValue("first");
    fireEvent.click(screen.getAllByRole("button",{name:"Enregistrer"})[0]);
    await waitFor(()=>expect(apiMocks.updateCampaign).toHaveBeenCalledWith(campaign.id,
      expect.objectContaining({replyMode:"automatic",replyAutoScope:"first"})));
  });

  it("defaults replies to a Gmail draft and saves independent reply iterations and automatic mode", async () => {
    renderCampaigns();
    expect(screen.getByRole("radio", {name:/Brouillon Gmail/})).toBeChecked();
    expect(screen.queryByRole("combobox",{name:/Automatique pour/})).not.toBeInTheDocument();
    const section=screen.getByRole("heading",{name:"Instructions de réponse"}).closest("section")!;
    expect(screen.queryByRole("heading",{name:"Instructions pour les réponses"})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio",{name:/Réponse automatique/}));
    expect(screen.getByRole("combobox",{name:/Automatique pour/})).toHaveValue("first");
    fireEvent.change(screen.getByRole("combobox",{name:/Automatique pour/}),{target:{value:"all"}});
    fireEvent.click(screen.getByRole("button",{name:"+ Ajouter une étape"}));
    fireEvent.click(screen.getByRole("button",{name:"+ Ajouter une étape"}));
    const file=new File(["Contexte de réponse"],"reponses.txt",{type:"text/plain"});
    fireEvent.change(section.querySelector('input[type="file"]')!,{target:{files:[file]}});
    await waitFor(()=>expect(apiMocks.uploadInstructionAttachment).toHaveBeenCalledWith({file,scope:"campaign",campaignId:campaign.id,fieldKey:"reply"}));
    const inputs=section.querySelectorAll("textarea");
    expect(inputs).toHaveLength(3);
    expect(Array.from(inputs,el=>el.value)).toEqual(["","",""]);
    fireEvent.change(inputs[1],{target:{value:"Affiner la réponse avec le contexte de l’échange"}});
    fireEvent.click(screen.getAllByRole("button",{name:"Enregistrer"})[0]);
    await waitFor(()=>expect(apiMocks.updateCampaign).toHaveBeenCalledWith(campaign.id,expect.objectContaining({replyMode:"automatic",replyAutoScope:"all",replyIterations:["","Affiner la réponse avec le contexte de l’échange",""],writingIterations:campaign.writingIterations})));
  });

  it("saves the existing-only campaign mode without changing writing instructions or the daily goal", async () => {
    renderCampaigns();
    fireEvent.change(screen.getByRole("combobox", {name:"Statut"}), {target:{value:"existing_only"}});
    expect(screen.getByRole("option", {name:"Sans nouveaux prospects"})).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", {name:"Enregistrer"})[0]);
    await waitFor(() => expect(apiMocks.updateCampaign).toHaveBeenCalledWith(campaign.id,
      expect.objectContaining({status:"existing_only",writingIterations:campaign.writingIterations,dailyNewContactGoal:campaign.dailyNewContactGoal})));
  });

  it("uses the continuous V53 editor instead of the old tabbed layout", () => {
    renderCampaigns();

    expect(screen.getAllByText("Nouvelle campagne").length).toBeGreaterThan(0);
    const orderedSections = [
      "Définition de la campagne",
      "Validation des emails",
      "Tests A/B",
      "Critères et instructions de recherche des prospects",
      "Itérations de rédaction IA",
      "Premier email",
      "Relances",
      "Instructions de réponse",
    ].map((label) => screen.getByText(label));
    orderedSections.slice(0, -1).forEach((section, index) => {
      expect(section.compareDocumentPosition(orderedSections[index + 1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
    expect(screen.queryByRole("tab", { name: "Cible & envoi" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Enregistrer" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
  });

  it("opens the campaign explicitly requested from the Messages view", () => {
    const requested = { ...campaign, id: "33333333-3333-4333-8333-333333333333", name: "Campagne ciblée" };
    renderCampaigns([], [campaign, requested], requested.id);

    expect(screen.getByLabelText("Choisir une campagne")).toHaveValue(requested.id);
    expect(screen.getAllByDisplayValue("Campagne ciblée")).toHaveLength(2);
  });

  it("switches to B and exposes its persisted custom blocks", () => {
    renderCampaigns([experiment]);

    const variantB = screen.getByRole("button", { name: /^B1/ });
    fireEvent.click(variantB);

    expect(variantB).toHaveClass("on");
    expect(screen.getByText("Recherche · version B")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Recherche propre à la version B")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "↶ Reprendre A1" })).toBeInTheDocument();
  });

  it("adds the next version through the API", async () => {
    const { onMutated } = renderCampaigns([experiment]);

    fireEvent.click(screen.getByRole("button", { name: "+ Version" }));

    await waitFor(() => expect(apiMocks.addExperimentVariant).toHaveBeenCalledWith(experiment.id));
    expect(onMutated).toHaveBeenCalledOnce();
  });

  it("chooses an unused name including archived campaigns and case variants", async () => {
    renderCampaigns([], [campaign,
      { ...campaign, id: "archived", status: "archived", name: "NOUVELLE CAMPAGNE (2)" },
      { ...campaign, id: "other", name: "Nouvelle campagne (3)" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "+ Ajouter" }));
    await waitFor(() => expect(apiMocks.createCampaign).toHaveBeenCalledWith(expect.objectContaining({ name: "Nouvelle campagne (4)", status: "inactive" })));
  });

  it("shows creation errors and allows retrying instead of failing silently", async () => {
    apiMocks.createCampaign.mockRejectedValueOnce(new Error("Cette opération existe déjà."));
    renderCampaigns();
    fireEvent.click(screen.getByRole("button", { name: "+ Ajouter" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cette opération existe déjà.");
    fireEvent.click(screen.getByRole("button", { name: "+ Ajouter" }));
    await waitFor(() => expect(apiMocks.createCampaign).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("opens the created campaign after refresh even when another campaign was requested", async () => {
    const created = { ...campaign, id: "33333333-3333-4333-8333-333333333333", name: "Nouvelle campagne (2)" };
    apiMocks.createCampaign.mockResolvedValue({ campaign: { id: created.id, version: 1 } });
    const props = { campaigns: [campaign], folders: [], accounts: [], experiments: [], attachments: [], prospects: [], totals: { pendingApproval: 0 }, selectedCampaignId: campaign.id, onOpenSettings: vi.fn(), onMutated: vi.fn().mockResolvedValue(undefined) };
    const view = render(<CampaignsView {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Ajouter" }));
    await waitFor(() => expect(props.onMutated).toHaveBeenCalledOnce());
    view.rerender(<CampaignsView {...props} campaigns={[created, campaign]} />);
    expect(screen.getByLabelText("Choisir une campagne")).toHaveValue(created.id);
  });

  it("preserves campaign edits across automatic refreshes and saves the original version", async () => {
    const props = { campaigns: [campaign], folders: [], accounts: [], experiments: [experiment], attachments: [], prospects: [], totals: { pendingApproval: 0 }, onOpenSettings: vi.fn(), onMutated: vi.fn().mockResolvedValue(undefined) };
    const view = render(<CampaignsView {...props} />);
    fireEvent.change(screen.getByRole("textbox", { name: /Nom de la campagne/ }), { target: { value: "Mon nouveau nom" } });
    view.rerender(<CampaignsView {...props} campaigns={[{ ...campaign }]} experiments={[{ ...experiment, variants: experiment.variants.map((v) => ({ ...v })) }]} />);
    expect(screen.getByRole("textbox", { name: /Nom de la campagne/ })).toHaveValue("Mon nouveau nom");
    fireEvent.click(screen.getAllByRole("button", { name: "Enregistrer" })[0]);
    await waitFor(() => expect(apiMocks.updateCampaign).toHaveBeenCalledWith(campaign.id, expect.objectContaining({ name: "Mon nouveau nom", version: 1 })));
    await waitFor(() => expect(props.onMutated).toHaveBeenCalled());
    expect(screen.getByRole("textbox", { name: /Nom de la campagne/ })).toHaveValue("Mon nouveau nom");
  });

  it("preserves variant edits across refreshes and resets them only on cancel", () => {
    const props = { campaigns: [campaign], folders: [], accounts: [], experiments: [experiment], attachments: [], prospects: [], totals: { pendingApproval: 0 }, onOpenSettings: vi.fn(), onMutated: vi.fn() };
    const view = render(<CampaignsView {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /^B1/ }));
    fireEvent.change(screen.getByDisplayValue("Recherche propre à la version B"), { target: { value: "Ma recherche B" } });
    view.rerender(<CampaignsView {...props} campaigns={[{ ...campaign }]} experiments={[{ ...experiment }]} />);
    expect(screen.getByDisplayValue("Ma recherche B")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    expect(screen.getByDisplayValue("Recherche propre à la version B")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Enregistrer" }).every((b) => b.hasAttribute("disabled"))).toBe(true);
  });

  it("updates a pristine editor from the server but retains a dirty editor on conflict", async () => {
    const props = { campaigns: [campaign], folders: [], accounts: [], experiments: [], attachments: [], prospects: [], totals: { pendingApproval: 0 }, onOpenSettings: vi.fn(), onMutated: vi.fn() };
    const view = render(<CampaignsView {...props} />);
    const refreshed = { ...campaign, name: "Nom distant", version: 2 };
    view.rerender(<CampaignsView {...props} campaigns={[refreshed]} />);
    expect(screen.getByRole("textbox", { name: /Nom de la campagne/ })).toHaveValue("Nom distant");
    fireEvent.change(screen.getByRole("textbox", { name: /Nom de la campagne/ }), { target: { value: "Ma saisie" } });
    view.rerender(<CampaignsView {...props} campaigns={[{ ...refreshed, name: "Encore distant", version: 3 }]} />);
    apiMocks.updateCampaign.mockRejectedValueOnce(new Error("Conflit de version"));
    fireEvent.click(screen.getAllByRole("button", { name: "Enregistrer" })[0]);
    await screen.findByText("Conflit de version");
    expect(screen.getByRole("textbox", { name: /Nom de la campagne/ })).toHaveValue("Ma saisie");
    expect(apiMocks.updateCampaign).toHaveBeenCalledWith(campaign.id, expect.objectContaining({ version: 2 }));
  });

  it("starts new campaigns with empty instructions and message models", async () => {
    renderCampaigns();
    fireEvent.click(screen.getByRole("button", { name: "+ Ajouter" }));

    await waitFor(() => expect(apiMocks.createCampaign).toHaveBeenCalledOnce());
    const payload = apiMocks.createCampaign.mock.calls[0][0];
    expect(payload).toMatchObject({
      trackingOpensEnabled: true, trackingClicksEnabled: true,
      writingIterations: [""], aiInstructions: "", targetDescription: "", replyInstructions: "", nextTestInstructions: "",
      sequence: { subject: "", subjectInstructions: "", steps: ["", "", "", "", "", ""], stepInstructions: ["", "", "", "", "", ""] },
    });
  });

  it("keeps every instruction field empty in a new campaign editor", () => {
    renderCampaigns([], [{ ...campaign, writingIterations: [""], aiInstructions: "", targetDescription: "", replyInstructions: "", nextTestInstructions: "" }]);
    expect(document.querySelectorAll("textarea").length).toBeGreaterThan(10);
    document.querySelectorAll("textarea").forEach((field) => expect(field).toHaveValue(""));
  });

  it("adds empty iteration fields without altering existing instructions", () => {
    renderCampaigns();
    for (let i = 0; i < 2; i++) fireEvent.click(screen.getByRole("button", { name: "+ Ajouter une itération" }));
    expect(screen.getByLabelText(/Itération 1/)).toHaveValue("Prépare une première version.");
    expect(screen.getByLabelText(/Itération 2/)).toHaveValue("");
    expect(screen.getByLabelText(/Itération 3/)).toHaveValue("");
  });

  it("changes and persists the number of successive AI writing iterations", async () => {
    const { onMutated } = renderCampaigns();

    for (let i = 0; i < 2; i++) fireEvent.click(screen.getByRole("button", { name: "+ Ajouter une itération" }));

    expect(screen.getByText("3 itérations successives")).toBeInTheDocument();
    expect(screen.getByText("Itération 3")).toBeInTheDocument();
    const iterationTextareas = screen.getAllByRole("textbox").filter((field) => field.closest(".v23-pass-step"));
    fireEvent.change(iterationTextareas[2], { target: { value: "Resserre le message et améliore l’appel à l’action." } });
    fireEvent.click(screen.getAllByRole("button", { name: "Enregistrer" }).find((button) => !button.hasAttribute("disabled"))!);

    await waitFor(() => expect(apiMocks.updateCampaign).toHaveBeenCalledOnce());
    expect(apiMocks.updateCampaign.mock.calls[0][1].writingIterations).toHaveLength(3);
    expect(apiMocks.updateCampaign.mock.calls[0][1].writingIterations[2]).toContain("Resserre le message");
    expect(onMutated).toHaveBeenCalledOnce();
  });

  it("accepts more than ten successive AI writing iterations", () => {
    renderCampaigns();

    for (let i = 0; i < 11; i++) fireEvent.click(screen.getByRole("button", { name: "+ Ajouter une itération" }));

    expect(screen.getByText("12 itérations successives")).toBeInTheDocument();
    expect(screen.getByText("Itération 12")).toBeInTheDocument();
  });

  it("shows discreet per-variant metrics in campaign statistics", () => {
    renderCampaigns([experiment]);

    fireEvent.click(screen.getByRole("button", { name: "▥ Voir les statistiques" }));

    expect(screen.getByRole("dialog", { name: "Statistiques · Nouvelle campagne" })).toBeInTheDocument();
    expect(screen.getByText("Résultats des tests A/B")).toBeInTheDocument();
    expect(screen.getByText("60 %")).toBeInTheDocument();
    expect(screen.getByText("70 %")).toBeInTheDocument();
    expect(screen.getByText("Version B")).toBeInTheDocument();
    expect(screen.getByText("réponses à classer")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "À classer" })).toBeInTheDocument();
  });

  it("warns about interpretation without blocking variants with different targets", () => {
    const segmented = {
      ...experiment,
      scope: "population",
      variants: experiment.variants.map((variant, index) => ({
        ...variant,
        overrides: { search: { criteria: index === 0 ? "Salles folk" : "Festivals internationaux" } },
      })),
    };
    renderCampaigns([segmented]);

    expect(screen.getByText(/Publics différents : les résultats restent utiles/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^B1/ })).toBeEnabled();
  });

  it.each(["writing", "reply"])("removes a chosen %s step, renumbers and persists the remaining text", async kind => {
    const field = kind === "writing" ? "writingIterations" : "replyIterations";
    const source = { ...campaign, [field]: ["Première", "Milieu", "Dernière"] };
    const view = renderCampaigns([], [source]);
    const remove = (number: number) => screen.getByRole("button", { name: kind === "writing" ? `Supprimer l’itération ${number}` : `Supprimer l’étape de réponse ${number}` });
    const area = () => document.querySelector(`[data-v35-group="${kind === "writing" ? "iterations" : "reply"}"]`)!;
    fireEvent.click(remove(2));
    expect(Array.from(area().querySelectorAll("textarea"), el => el.value)).toEqual(["Première", "Dernière"]);
    expect(remove(2)).toBeEnabled();
    fireEvent.click(remove(1));
    expect(Array.from(area().querySelectorAll("textarea"), el => el.value)).toEqual(["Dernière"]);
    expect(remove(1)).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: kind === "writing" ? "+ Ajouter une itération" : "+ Ajouter une étape" }));
    expect(area().querySelectorAll("textarea")[1]).toHaveFocus();
    fireEvent.click(remove(2));
    fireEvent.click(screen.getAllByRole("button", { name: "Enregistrer" })[0]);
    await waitFor(() => expect(view.onMutated).toHaveBeenCalledOnce());
    const saved = apiMocks.updateCampaign.mock.calls[0][1];
    expect(saved[field]).toEqual(["Dernière"]);
    view.unmount(); renderCampaigns([], [{ ...source, ...saved, version: 2 }]);
    expect(Array.from(area().querySelectorAll("textarea"), el => el.value)).toEqual(["Dernière"]);
  });

  it("moves a campaign to a folder by drag and drop", async () => {
    const folder = { id: "44444444-4444-4444-8444-444444444444", name: "Concerts", position: 0 };
    const { onMutated } = renderCampaigns([], [campaign], null, [folder]);
    const campaignButton = screen.getByRole("button", { name: /Nouvelle campagne/ });
    const folderDropZone = screen.getAllByText("Concerts").find((node) => node.classList.contains("folder-title"))!.closest("details")!;

    fireEvent.dragStart(campaignButton, { dataTransfer: { effectAllowed: "move", setData: vi.fn() } });
    fireEvent.drop(folderDropZone, { dataTransfer: { getData: () => campaign.id } });

    await waitFor(() => expect(apiMocks.moveCampaignToFolder).toHaveBeenCalledWith(campaign.id, folder.id, campaign.version));
    expect(onMutated).toHaveBeenCalledOnce();
  });
});

it("shows unavailable measurements instead of zero rates",()=>{
 renderCampaigns([{...experiment,variants:experiment.variants.map(v=>({...v,openRate:null,clickRate:null,replyRate:null}))}],
  [{...campaign,stats:{...campaign.stats,openRate:null,clickRate:null}}]);
 fireEvent.click(screen.getByRole("button",{name:/Voir les statistiques/}));
 expect(screen.getAllByText("Non mesuré")).toHaveLength(2);
 expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(6);
});

it("offers exactly three tracking choices with automatic secondary analyses",async()=>{
 cleanup();
 renderCampaigns([], [{...campaign,trackingOpensEnabled:true,trackingClicksEnabled:true}]);
 fireEvent.click(screen.getByText(/Suivi des interactions/));
 const panel=screen.getByText(/Suivi des interactions/).closest("details")!;
 expect(panel.querySelectorAll('input[type="checkbox"]')).toHaveLength(3);
 expect(screen.queryByRole("checkbox",{name:/réouvertures/})).not.toBeInTheDocument();
 expect(screen.queryByRole("checkbox",{name:/délai entre/})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole("checkbox",{name:"Mesurer les clics sur les liens"}));
 fireEvent.click(screen.getAllByRole("button",{name:"Enregistrer"})[0]);
 await waitFor(()=>expect(apiMocks.updateCampaign).toHaveBeenCalledWith(campaign.id,expect.objectContaining({trackingOpensEnabled:true,trackingClicksEnabled:false})));
 expect(apiMocks.updateCampaign.mock.calls[0][1]).not.toHaveProperty("readDelayEnabled");
 cleanup();
});

it("saves real connection timing independently from clicks and removes the compliance notice",async()=>{
 cleanup();
 renderCampaigns([], [{...campaign,trackingOpensEnabled:true,trackingClicksEnabled:false}]);
 fireEvent.click(screen.getByText(/Suivi des interactions/));
 const reading=screen.getByRole("checkbox",{name:"Mesurer la durée de lecture"});
 expect(reading).toBeEnabled();expect(reading).not.toBeChecked();fireEvent.click(reading);
 expect(screen.queryByText(/Recommandations CNIL/)).not.toBeInTheDocument();
 expect(screen.queryByText(/expérimental/)).not.toBeInTheDocument();
 fireEvent.click(screen.getAllByRole("button",{name:"Enregistrer"})[0]);
 await waitFor(()=>expect(apiMocks.updateCampaign).toHaveBeenCalledWith(campaign.id,expect.objectContaining({readingTimeEnabled:true,trackingClicksEnabled:false})));
 cleanup();
});

describe("A1 is the reference of its test", () => {
  const configured: Campaign = {
    ...campaign,
    sequence: { subject: "Objet initial", subjectInstructions: "Consignes objet", steps: ["Modèle initial", "R1", "R2", "R3", "R4", "R5"], stepInstructions: ["Consignes initiales", "I1", "I2", "I3", "I4", "I5"] },
  };
  const referenceOverrides = { initial: { body: "Modèle A1", bodyInstructions: "Consignes A1", metadata: "à conserver" }, subject: { subjectInstructions: "Objet A1" } };
  const inherited = materializeVariant(resolveVariantGroups(campaignVariantDefaults(configured), referenceOverrides), {});
  const test: Experiment = { ...experiment, variants: experiment.variants.map(v => ({ ...v, version: 3, overrides: v.label === "A" ? referenceOverrides : inherited })) };
  const initial = () => screen.getByLabelText("Consignes pour le premier email");
  const save = () => fireEvent.click(screen.getAllByRole("button", { name: "Enregistrer" })[0]);
  const choose = (label: string) => fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}1`) }));
  const group = (key: string) => within(document.querySelector(`[data-v35-group="${key}"]`)! as HTMLElement);

  beforeEach(() => {
    Object.values(apiMocks).forEach(mock => mock.mockReset());
    apiMocks.updateCampaign.mockResolvedValue({ campaign: { id: campaign.id, version: 2 } });
    apiMocks.updateExperimentVariant.mockImplementation(async (id, body) => ({ variant: { id, version: body.version + 1 } }));
  });
  afterEach(cleanup);

  it("selects editable A1 immediately and exposes no additional configuration level", () => {
    renderCampaigns([test], [configured]);
    expect(screen.getByRole("button", { name: /^A1/ })).toHaveClass("on");
    expect(screen.queryByText("Configuration générale")).not.toBeInTheDocument();
    expect(initial()).toHaveValue("Consignes A1"); expect(initial()).toBeEnabled();
    expect(screen.getByLabelText("Modèle du premier email")).toHaveValue("Modèle A1");
    expect(group("initial").queryByRole("button", { name: /Personnaliser/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Enregistrer" })[0]).toBeDisabled();
  });

  it("keeps minimum follow-up delays relative to the preceding confirmed send", () => {
    renderCampaigns();
    ["+3 j après J0", "+7 j après R1", "+7 j après R2", "+14 j après R3", "+14 j après R4"].forEach(label => expect(screen.getByText(label)).toBeInTheDocument());
    expect(screen.getByText(/Délais minimaux après l’envoi précédent/)).toBeInTheDocument();
  });

  it("saves A1 and its inherited B1 blocks without changing campaign defaults or another test, then reloads them", async () => {
    const other = { ...test, id: "other-test", variants: test.variants.map(v => ({ ...v, id: `other-${v.id}` })) };
    const view = renderCampaigns([test, other], [configured]);
    fireEvent.change(initial(), { target: { value: "Nouvelles consignes A1" } });
    fireEvent.change(screen.getByLabelText("Consignes pour personnaliser l’objet"), { target: { value: "Nouvel objet A1" } });
    fireEvent.change(screen.getByLabelText("Consignes pour la relance R1"), { target: { value: "Nouvelle relance A1" } });
    choose("B");
    expect(initial()).toHaveValue("Nouvelles consignes A1"); expect(initial()).toBeDisabled();
    expect(group("initial").getByText("Identique à A1 · hérité")).toBeInTheDocument();
    save(); await waitFor(() => expect(view.onMutated).toHaveBeenCalledOnce());
    expect(apiMocks.updateCampaign).not.toHaveBeenCalled();
    expect(apiMocks.updateExperimentVariant.mock.calls.map(call => call[0])).toEqual(test.variants.map(v => v.id));
    const saved = new Map(apiMocks.updateExperimentVariant.mock.calls.map(([id, payload]) => [id, payload.overrides]));
    expect(saved.get(test.variants[0].id)).toMatchObject({ initial: { body: "Modèle A1", bodyInstructions: "Nouvelles consignes A1", metadata: "à conserver" } });
    expect(saved.get(test.variants[1].id)).toMatchObject({ initial: { body: "Modèle A1", bodyInstructions: "Nouvelles consignes A1" }, subject: { subjectInstructions: "Nouvel objet A1" }, followup0: { instructions: "Nouvelle relance A1" } });
    view.unmount();
    renderCampaigns([{ ...test, variants: test.variants.map(v => ({ ...v, version: 4, overrides: saved.get(v.id) })) }, other], [configured]);
    expect(initial()).toHaveValue("Nouvelles consignes A1"); choose("B");
    expect(initial()).toHaveValue("Nouvelles consignes A1"); expect(initial()).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Enregistrer" })[0]).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Expérience"), { target: { value: other.id } });
    expect(initial()).toHaveValue("Consignes A1");
  });

  it("customizes B1 independently and keeps its edits when switching back to A1", async () => {
    const view = renderCampaigns([test], [configured]); choose("B");
    fireEvent.click(group("initial").getByRole("button", { name: "✎ Personnaliser" }));
    fireEvent.change(initial(), { target: { value: "Consignes B1 distinctes" } });
    choose("A"); expect(initial()).toHaveValue("Consignes A1");
    choose("B"); expect(initial()).toHaveValue("Consignes B1 distinctes");
    save(); await waitFor(() => expect(view.onMutated).toHaveBeenCalledOnce());
    expect(apiMocks.updateExperimentVariant).toHaveBeenCalledOnce();
    expect(apiMocks.updateExperimentVariant.mock.calls[0]).toEqual([test.variants[1].id, expect.objectContaining({ version: 3, overrides: expect.objectContaining({ initial: expect.objectContaining({ bodyInstructions: "Consignes B1 distinctes" }) }) })]);
    const persisted = apiMocks.updateExperimentVariant.mock.calls[0][1].overrides;
    view.unmount(); renderCampaigns([{ ...test, variants: [test.variants[0], { ...test.variants[1], version: 4, overrides: persisted }] }], [configured]); choose("B");
    expect(initial()).toHaveValue("Consignes B1 distinctes"); expect(initial()).toBeEnabled();
  });

  it("preserves historical B1 values, including partial overrides, until the user explicitly takes A1 again", async () => {
    const legacy = { ...test, variants: [test.variants[0], { ...test.variants[1], overrides: { initial: { bodyInstructions: "Anciennes consignes B1" }, followup0: { instructions: "Relance B conservée" }, extension: { note: "à conserver" } } }] };
    renderCampaigns([legacy], [configured]);
    expect(screen.getAllByRole("button", { name: "Enregistrer" })[0]).toBeDisabled();
    expect(screen.getByRole("button", { name: /^B1/ })).toHaveTextContent("3 perso.");
    choose("B"); expect(initial()).toHaveValue("Anciennes consignes B1");
    expect(screen.getByLabelText("Modèle du premier email")).toHaveValue("Modèle initial");
    fireEvent.click(group("initial").getByRole("button", { name: "↶ Reprendre A1" }));
    expect(initial()).toHaveValue("Consignes A1"); expect(initial()).toBeDisabled();
    save(); await waitFor(() => expect(apiMocks.updateExperimentVariant).toHaveBeenCalledOnce());
    expect(apiMocks.updateExperimentVariant.mock.calls[0][1].overrides).toMatchObject({ initial: { body: "Modèle A1", bodyInstructions: "Consignes A1" }, followup0: { instructions: "Relance B conservée" }, extension: { note: "à conserver" } });
  });

  it("preserves explicitly empty A1 instructions and propagates them to an inherited B1", async () => {
    renderCampaigns([test], [configured]); fireEvent.change(initial(), { target: { value: "" } });
    expect(initial()).toHaveValue(""); choose("B"); expect(initial()).toHaveValue(""); save();
    await waitFor(() => expect(apiMocks.updateExperimentVariant).toHaveBeenCalledTimes(2));
    expect(apiMocks.updateExperimentVariant.mock.calls[1][1].overrides.initial.bodyInstructions).toBe("");
  });

  it.each(["assigned", "running"])("protects a test reference that is %s", mode => {
    renderCampaigns([{ ...test, status: mode === "running" ? "recruiting" : "draft", variants: test.variants.map(v => ({ ...v, assignedCount: mode === "assigned" && v.label === "B" ? 1 : 0 })) }], [configured]);
    expect(initial()).toBeDisabled(); expect(screen.getByText(/consultation uniquement/)).toBeInTheDocument();
    choose("B"); expect(initial()).toBeDisabled(); expect(group("initial").getByRole("button", { name: "✎ Personnaliser" })).toBeDisabled();
  });

  it("retries an inherited B1 save after A1 succeeds without losing the remaining change or resaving A1", async () => {
    apiMocks.updateExperimentVariant.mockResolvedValueOnce({ variant: { id: test.variants[0].id, version: 4 } }).mockRejectedValueOnce(new Error("Conflit B1"));
    renderCampaigns([test], [configured]); fireEvent.change(initial(), { target: { value: "Référence modifiée" } }); save();
    await screen.findByText(/Enregistrement partiel.*Conflit B1/);
    choose("B"); expect(initial()).toHaveValue("Référence modifiée");
    expect(screen.getAllByRole("button", { name: "Enregistrer" })[0]).toBeEnabled(); save();
    await waitFor(() => expect(apiMocks.updateExperimentVariant).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Enregistrer" })[0]).toBeDisabled());
    expect(apiMocks.updateExperimentVariant.mock.calls.map(call => call[0])).toEqual([test.variants[0].id, test.variants[1].id, test.variants[1].id]);
    expect(apiMocks.updateExperimentVariant.mock.calls[2][1]).toMatchObject({ version: 3, overrides: { initial: { bodyInstructions: "Référence modifiée" } } });
  });

  it.each(["iterations", "reply"])("keeps inherited %s controls disabled and saves a chosen deletion only in customized B1", async key => {
    const field = key === "iterations" ? "draftPasses" : "replyIterations";
    const ref = { ...referenceOverrides, [key]: { [field]: ["Un", "Deux", "Trois"] } };
    const b = materializeVariant(resolveVariantGroups(campaignVariantDefaults(configured), ref), {});
    const fixture = { ...test, variants: test.variants.map(v => ({ ...v, overrides: v.label === "A" ? ref : b })) };
    const view = renderCampaigns([fixture], [configured]); choose("B");
    const name = key === "iterations" ? "Supprimer l’itération 2" : "Supprimer l’étape de réponse 2";
    expect(screen.getByRole("button", { name })).toBeDisabled();
    fireEvent.click(group(key).getByRole("button", { name: "✎ Personnaliser" }));
    fireEvent.click(screen.getByRole("button", { name }));
    expect(Array.from(document.querySelectorAll(`[data-v35-group="${key}"] textarea`), el => (el as HTMLTextAreaElement).value)).toEqual(["Un", "Trois"]);
    save(); await waitFor(() => expect(view.onMutated).toHaveBeenCalledOnce());
    expect(apiMocks.updateExperimentVariant).toHaveBeenCalledOnce();
    expect(apiMocks.updateExperimentVariant.mock.calls[0][0]).toBe(test.variants[1].id);
    expect(apiMocks.updateExperimentVariant.mock.calls[0][1].overrides[key][field]).toEqual(["Un", "Trois"]);
    choose("A");
    expect(Array.from(document.querySelectorAll(`[data-v35-group="${key}"] textarea`), el => (el as HTMLTextAreaElement).value)).toEqual(["Un", "Deux", "Trois"]);
  });

  it("retains B1 typing if the planner assigns it during editing and the backend then refuses the save", async () => {
    const props = { campaigns: [configured], folders: [], accounts: [], experiments: [test], attachments: [], prospects: [], totals: { pendingApproval: 0 }, onOpenSettings: vi.fn(), onMutated: vi.fn() };
    const view = render(<CampaignsView {...props} />); choose("B");
    fireEvent.click(group("initial").getByRole("button", { name: "✎ Personnaliser" }));
    fireEvent.change(initial(), { target: { value: "Saisie B1 à conserver" } });
    view.rerender(<CampaignsView {...props} experiments={[{ ...test, variants: test.variants.map(v => ({ ...v, assignedCount: v.label === "B" ? 1 : 0 })) }]} />);
    expect(initial()).toHaveValue("Saisie B1 à conserver"); expect(initial()).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Enregistrer" })[0]).toBeEnabled();
    apiMocks.updateExperimentVariant.mockRejectedValueOnce(new Error("Cette version a déjà été utilisée")); save();
    await screen.findByText("Cette version a déjà été utilisée");
    expect(initial()).toHaveValue("Saisie B1 à conserver");
    expect(apiMocks.updateCampaign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    expect(initial()).toHaveValue("Consignes A1");
  });

  it("keeps confirmed A1 and B1 saves when refreshing fails and ignores an old dashboard response", async () => {
    const props = { campaigns: [configured], folders: [], accounts: [], experiments: [test], attachments: [], prospects: [], totals: { pendingApproval: 0 }, onOpenSettings: vi.fn(), onMutated: vi.fn().mockRejectedValueOnce(new Error("Réseau indisponible")).mockResolvedValue(undefined) };
    const view = render(<CampaignsView {...props} />);
    fireEvent.change(initial(), { target: { value: "A1 enregistré" } }); save();
    await screen.findByText(/Modifications enregistrées dans Neon ; actualisation impossible/);
    expect(screen.getAllByRole("button", { name: "Enregistrer" })[0]).toBeDisabled();
    view.rerender(<CampaignsView {...props} experiments={[{ ...test, variants: test.variants.map(v => ({ ...v })) }]} />);
    expect(initial()).toHaveValue("A1 enregistré");
    fireEvent.change(initial(), { target: { value: "A1 deuxième saisie" } });
    fireEvent.click(screen.getByRole("button", { name: "Annuler" })); expect(initial()).toHaveValue("A1 enregistré");
    fireEvent.change(initial(), { target: { value: "A1 deuxième sauvegarde" } }); save();
    await waitFor(() => expect(apiMocks.updateExperimentVariant).toHaveBeenCalledTimes(4));
    expect(apiMocks.updateExperimentVariant.mock.calls[2][1].version).toBe(4);
    expect(apiMocks.updateExperimentVariant.mock.calls[3][1].version).toBe(4);
  });

  it("snapshots A1 as the reference of a new test and prevents adding a version from unsaved changes", async () => {
    apiMocks.createExperiment.mockResolvedValue({ experiment: { id: "new-test" } });
    renderCampaigns([test], [configured]); fireEvent.click(screen.getByRole("button", { name: "+ Nouveau test" }));
    await waitFor(() => expect(apiMocks.createExperiment).toHaveBeenCalledOnce());
    expect(apiMocks.createExperiment.mock.calls[0][0].variants[0].overrides).toMatchObject({ initial: { body: "Modèle A1", bodyInstructions: "Consignes A1" }, subject: { subjectInstructions: "Objet A1" } });
    fireEvent.change(initial(), { target: { value: "Non enregistré" } });
    expect(screen.getByRole("button", { name: "+ Version" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "+ Nouveau test" })).toBeDisabled();
  });
});
