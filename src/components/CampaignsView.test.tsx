import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Campaign, Experiment } from "../types";
import { CampaignsView } from "./CampaignsView";

const apiMocks = vi.hoisted(() => ({
  addExperimentVariant: vi.fn(),
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
    expect(screen.getByRole("button", { name: "↶ Reprendre la configuration générale" })).toBeInTheDocument();
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
    fireEvent.change(screen.getByRole("spinbutton", { name: "Nombre d’itérations" }), { target: { value: "3" } });
    expect(screen.getByLabelText(/Itération 1/)).toHaveValue("Prépare une première version.");
    expect(screen.getByLabelText(/Itération 2/)).toHaveValue("");
    expect(screen.getByLabelText(/Itération 3/)).toHaveValue("");
  });

  it("changes and persists the number of successive AI writing iterations", async () => {
    const { onMutated } = renderCampaigns();
    const iterationCount = screen.getByRole("spinbutton", { name: "Nombre d’itérations" });

    fireEvent.change(iterationCount, { target: { value: "3" } });

    expect(iterationCount).toHaveValue(3);
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
    const iterationCount = screen.getByRole("spinbutton", { name: "Nombre d’itérations" });

    fireEvent.change(iterationCount, { target: { value: "12" } });

    expect(iterationCount).toHaveValue(12);
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

describe("campaign configuration and A/B editing regression", () => {
  const configured: Campaign = {
    ...campaign,
    sequence: { subject: "Objet général", subjectInstructions: "Consignes objet générales", steps: ["Modèle général", "R1", "R2", "R3", "R4", "R5"], stepInstructions: ["Consignes J0 générales", "I1", "I2", "I3", "I4", "I5"] },
  };
  const test: Experiment = { ...experiment, variants: experiment.variants.map(v => ({ ...v, version: 3, overrides: { initial: { body: `Modèle ${v.label}`, metadata: "à conserver" }, followup0: { instructions: `Consignes R1 ${v.label}` } } })) };
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

  it("edits the general first-email instructions even when A has a custom initial block", async () => {
    renderCampaigns([test], [configured]);
    expect(screen.getByRole("button", { name: "Configuration générale" })).toHaveClass("on");
    expect(initial()).toHaveValue("Consignes J0 générales");
    expect(screen.getByLabelText("Modèle du premier email")).toHaveValue("Modèle général");
    fireEvent.change(initial(), { target: { value: "Nouvelles consignes générales" } });
    expect(initial()).toHaveValue("Nouvelles consignes générales");
    choose("A");
    expect(initial()).toHaveValue("Nouvelles consignes générales");
    expect(initial()).toBeEnabled(); // Only the body was overridden in A.
    expect(screen.getByLabelText("Modèle du premier email")).toHaveValue("Modèle A");
    save();
    await waitFor(() => expect(apiMocks.updateCampaign).toHaveBeenCalledOnce());
    expect(apiMocks.updateCampaign.mock.calls[0][1].sequence.stepInstructions[0]).toBe("Nouvelles consignes générales");
    expect(apiMocks.updateExperimentVariant).not.toHaveBeenCalled();
  });

  it.each(["A", "B"])("saves partial first-email, subject and follow-up overrides for %s and reloads them", async label => {
    const view = renderCampaigns([test], [configured]);
    choose(label);
    expect(initial()).toHaveValue("Consignes J0 générales");
    expect(screen.getByLabelText("Consignes pour personnaliser l’objet")).toBeDisabled();
    fireEvent.click(group("subject").getByRole("button", { name: "✎ Personnaliser" }));
    fireEvent.change(screen.getByLabelText("Consignes pour personnaliser l’objet"), { target: { value: `Objet ${label} modifié` } });
    fireEvent.change(initial(), { target: { value: `J0 ${label} modifié` } });
    fireEvent.change(screen.getByLabelText("Consignes pour la relance R1"), { target: { value: `R1 ${label} modifié` } });
    fireEvent.click(screen.getByRole("button", { name: "Configuration générale" }));
    expect(initial()).toHaveValue("Consignes J0 générales");
    choose(label);
    expect(initial()).toHaveValue(`J0 ${label} modifié`);
    save();
    await waitFor(() => expect(view.onMutated).toHaveBeenCalledOnce());
    expect(apiMocks.updateCampaign).not.toHaveBeenCalled();
    const variant = test.variants.find(v => v.label === label)!;
    const [id, payload] = apiMocks.updateExperimentVariant.mock.calls[0];
    expect(id).toBe(variant.id);
    expect(payload).toMatchObject({ version: 3, overrides: { initial: { body: `Modèle ${label}`, bodyInstructions: `J0 ${label} modifié`, metadata: "à conserver" }, subject: { subjectInstructions: `Objet ${label} modifié` }, followup0: { body: "R1", instructions: `R1 ${label} modifié` } } });
    view.unmount();
    renderCampaigns([{ ...test, variants: test.variants.map(v => v.id === id ? { ...v, version: 4, overrides: payload.overrides } : v) }], [configured]);
    choose(label);
    expect(initial()).toHaveValue(`J0 ${label} modifié`);
    expect(screen.getByLabelText("Consignes pour personnaliser l’objet")).toHaveValue(`Objet ${label} modifié`);
    expect(screen.getByLabelText("Consignes pour la relance R1")).toHaveValue(`R1 ${label} modifié`);
    expect(screen.getAllByRole("button", { name: "Enregistrer" })[0]).toBeDisabled();
  });

  it("preserves an intentional empty instruction and lets a block inherit the general configuration again", async () => {
    const custom = { ...test, variants: test.variants.map(v => ({ ...v, overrides: { ...v.overrides, initial: { bodyInstructions: "" } } })) };
    renderCampaigns([custom], [configured]);
    choose("A");
    expect(initial()).toHaveValue("");
    expect(screen.getByLabelText("Modèle du premier email")).toHaveValue("Modèle général");
    fireEvent.click(group("initial").getByRole("button", { name: "↶ Reprendre la configuration générale" }));
    expect(initial()).toHaveValue("Consignes J0 générales");
    expect(initial()).toBeDisabled();
    save();
    await waitFor(() => expect(apiMocks.updateExperimentVariant).toHaveBeenCalledOnce());
    expect(apiMocks.updateExperimentVariant.mock.calls[0][1].overrides).toEqual({ followup0: { instructions: "Consignes R1 A" } });
  });

  it("keeps B inherited from the general configuration rather than a customized A", () => {
    renderCampaigns([{ ...test, variants: [ { ...test.variants[0], overrides: { initial: { bodyInstructions: "Consignes exclusives A" } } }, { ...test.variants[1], overrides: {} } ] }], [configured]);
    choose("A"); expect(initial()).toHaveValue("Consignes exclusives A");
    choose("B"); expect(initial()).toHaveValue("Consignes J0 générales"); expect(initial()).toBeDisabled();
    fireEvent.click(group("initial").getByRole("button", { name: "✎ Personnaliser" }));
    fireEvent.change(initial(), { target: { value: "" } });
    expect(initial()).toHaveValue("");
  });

  it.each(["assigned", "running"])("clearly protects a variant that is %s while leaving the general configuration editable", mode => {
    renderCampaigns([{ ...test, status: mode === "running" ? "recruiting" : "draft", variants: test.variants.map(v => ({ ...v, assignedCount: mode === "assigned" ? 1 : 0 })) }], [configured]);
    choose("A");
    expect(initial()).toBeDisabled();
    expect(group("initial").getByRole("button", { name: "↶ Reprendre la configuration générale" })).toBeDisabled();
    expect(screen.getByText(/consultation uniquement/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Configuration générale" }));
    expect(initial()).toBeEnabled();
    expect(apiMocks.updateExperimentVariant).not.toHaveBeenCalled();
  });

  it("retries only unsaved data after the campaign and A save successfully but B conflicts", async () => {
    apiMocks.updateExperimentVariant.mockResolvedValueOnce({ variant: { id: test.variants[0].id, version: 4 } }).mockRejectedValueOnce(new Error("Conflit de version B"));
    renderCampaigns([test], [configured]);
    fireEvent.change(initial(), { target: { value: "Général modifié" } });
    choose("A"); fireEvent.change(initial(), { target: { value: "A modifié" } });
    choose("B"); fireEvent.change(initial(), { target: { value: "B conservé" } });
    save();
    await screen.findByText(/Enregistrement partiel.*Conflit de version B/);
    expect(initial()).toHaveValue("B conservé");
    save();
    await waitFor(() => expect(apiMocks.updateExperimentVariant).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Enregistrer" })[0]).toBeDisabled());
    expect(apiMocks.updateCampaign).toHaveBeenCalledOnce();
    expect(apiMocks.updateExperimentVariant.mock.calls.map(call => call[0])).toEqual([test.variants[0].id, test.variants[1].id, test.variants[1].id]);
    expect(apiMocks.updateExperimentVariant.mock.calls[2][1]).toMatchObject({ version: 3, overrides: { initial: { bodyInstructions: "B conservé" } } });
  });

  it("retains the saved variant when a delayed dashboard refresh still carries its old version", async () => {
    const props = { campaigns: [configured], folders: [], accounts: [], experiments: [test], attachments: [], prospects: [], totals: { pendingApproval: 0 }, onOpenSettings: vi.fn(), onMutated: vi.fn().mockResolvedValue(undefined) };
    const view = render(<CampaignsView {...props} />);
    choose("A"); fireEvent.change(initial(), { target: { value: "A sauvegardé" } }); save();
    await waitFor(() => expect(props.onMutated).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Enregistrer" })[0]).toBeDisabled());
    view.rerender(<CampaignsView {...props} experiments={[{ ...test, variants: test.variants.map(v => ({ ...v })) }]} />);
    expect(initial()).toHaveValue("A sauvegardé");
    fireEvent.change(initial(), { target: { value: "A deuxième sauvegarde" } }); save();
    await waitFor(() => expect(apiMocks.updateExperimentVariant).toHaveBeenCalledTimes(2));
    expect(apiMocks.updateExperimentVariant.mock.calls[1][1].version).toBe(4);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Enregistrer" })[0]).toBeDisabled());
    fireEvent.change(initial(), { target: { value: "Saisie abandonnée" } });
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    expect(initial()).toHaveValue("A deuxième sauvegarde");
  });

  it("shows every minimum follow-up delay relative to the preceding send", () => {
    renderCampaigns();
    ["+3 j après J0", "+7 j après R1", "+7 j après R2", "+14 j après R3", "+14 j après R4"].forEach(label => expect(screen.getByText(label)).toBeInTheDocument());
    expect(screen.getByText(/Délais minimaux après l’envoi précédent/)).toBeInTheDocument();
  });

  it("keeps confirmed saves when refreshing the dashboard fails and uses the new versions on the next edit", async () => {
    const { onMutated } = renderCampaigns([test], [configured]);
    onMutated.mockRejectedValueOnce(new Error("Réseau indisponible"));
    fireEvent.change(initial(), { target: { value: "Général enregistré" } });
    choose("A"); fireEvent.change(initial(), { target: { value: "A enregistré" } }); save();
    await screen.findByText(/Modifications enregistrées dans Neon ; actualisation impossible/);
    expect(screen.getAllByRole("button", { name: "Enregistrer" })[0]).toBeDisabled();
    expect(onMutated).toHaveBeenCalledOnce();
    fireEvent.change(initial(), { target: { value: "A deuxième édition" } }); save();
    await waitFor(() => expect(apiMocks.updateExperimentVariant).toHaveBeenCalledTimes(2));
    expect(apiMocks.updateCampaign).toHaveBeenCalledOnce();
    expect(apiMocks.updateExperimentVariant.mock.calls[1][1].version).toBe(4);
  });
});
