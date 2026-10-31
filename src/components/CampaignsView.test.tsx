import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Campaign, Experiment } from "../types";
import { CampaignsView } from "./CampaignsView";

const apiMocks = vi.hoisted(() => ({
  addExperimentVariant: vi.fn(),
  createCampaign: vi.fn(),
  moveCampaignToFolder: vi.fn(),
  updateExperimentVariant: vi.fn(),
  updateCampaign: vi.fn(),
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
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", label: "A", name: "Référence", allocationWeight: 1, overrides: {}, assignedCount: 12, sentCount: 10, humanReplyCount: 2, unclassifiedReplyCount: 1, positiveReplyCount: 1, confirmedMeetingCount: 1, openCount: 6, clickCount: 3 },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", label: "B", name: "Version B", allocationWeight: 1, overrides: { search: { criteria: "Recherche propre à la version B" } }, assignedCount: 11, sentCount: 10, humanReplyCount: 3, unclassifiedReplyCount: 0, positiveReplyCount: 2, confirmedMeetingCount: 1, openCount: 7, clickCount: 4 },
  ],
};

function renderCampaigns(experiments: Experiment[] = [], campaigns: Campaign[] = [campaign], selectedCampaignId: string | null = null, folders: { id: string; name: string; position: number }[] = []) {
  const onMutated = vi.fn().mockResolvedValue(undefined);
  render(
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
  return { onMutated };
}

describe("CampaignsView V53", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.createCampaign.mockResolvedValue({ campaign: { id: campaign.id, version: 1 } });
    apiMocks.moveCampaignToFolder.mockResolvedValue({ campaign: { id: campaign.id, version: 2 } });
    apiMocks.addExperimentVariant.mockResolvedValue({ variant: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", label: "C", name: "Version C" } });
    apiMocks.updateCampaign.mockResolvedValue({ campaign: { id: campaign.id, version: 2 } });
  });

  afterEach(cleanup);

  it("defaults replies to a Gmail draft and saves independent reply iterations and automatic mode", async () => {
    renderCampaigns();
    expect(screen.getByRole("radio", {name:/Brouillon Gmail/})).toBeChecked();
    const section=screen.getByRole("heading",{name:"Gestion des réponses"}).closest("section")!;
    const previous=screen.getByRole("heading",{name:"Instructions pour les réponses"});
    expect(previous.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole("radio",{name:/Réponse automatique/}));
    fireEvent.change(screen.getByRole("spinbutton",{name:"Nombre d’itérations de réponse"}),{target:{value:"3"}});
    const inputs=section.querySelectorAll("textarea");
    expect(inputs).toHaveLength(3);
    expect(Array.from(inputs,el=>el.value)).toEqual(["","",""]);
    fireEvent.change(inputs[1],{target:{value:"Affiner la réponse avec le contexte de l’échange"}});
    fireEvent.click(screen.getAllByRole("button",{name:"Enregistrer"})[0]);
    await waitFor(()=>expect(apiMocks.updateCampaign).toHaveBeenCalledWith(campaign.id,expect.objectContaining({replyMode:"automatic",replyIterations:["","Affiner la réponse avec le contexte de l’échange",""],writingIterations:campaign.writingIterations})));
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
      "Instructions pour les réponses",
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
    expect(screen.getByRole("button", { name: "↶ Reprendre A" })).toBeInTheDocument();
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
