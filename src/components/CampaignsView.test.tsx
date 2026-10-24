import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Campaign, Experiment } from "../types";
import { CampaignsView } from "./CampaignsView";

const apiMocks = vi.hoisted(() => ({
  addExperimentVariant: vi.fn(),
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
  replyInstructions: "",
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
  stats: { sent: 0, contacted: 0, opened: 0, clicked: 0, replied: 0, openRate: 0, clickRate: 0, firstSentAt: null, lastSentAt: null },
};

const experiment: Experiment = {
  id: "22222222-2222-4222-8222-222222222222",
  campaignId: campaign.id,
  name: "Test 1",
  status: "draft",
  thresholdContactsPerVariant: 40,
  thresholdReplies: 20,
  variants: [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", label: "A", name: "Référence", allocationWeight: 1, overrides: {}, assignedCount: 12, sentCount: 10, humanReplyCount: 2, positiveReplyCount: 1, confirmedMeetingCount: 1, openCount: 6, clickCount: 3 },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", label: "B", name: "Version B", allocationWeight: 1, overrides: { search: { criteria: "Recherche propre à la version B" } }, assignedCount: 11, sentCount: 10, humanReplyCount: 3, positiveReplyCount: 2, confirmedMeetingCount: 1, openCount: 7, clickCount: 4 },
  ],
};

function renderCampaigns(experiments: Experiment[] = []) {
  const onMutated = vi.fn().mockResolvedValue(undefined);
  render(
    <CampaignsView
      campaigns={[campaign]}
      folders={[]}
      accounts={[]}
      experiments={experiments}
      attachments={[]}
      prospects={[]}
      totals={{ pendingApproval: 0 }}
      onOpenSettings={vi.fn()}
      onMutated={onMutated}
    />,
  );
  return { onMutated };
}

describe("CampaignsView V53", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.addExperimentVariant.mockResolvedValue({ variant: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", label: "C", name: "Version C" } });
    apiMocks.updateCampaign.mockResolvedValue({ campaign: { id: campaign.id, version: 2 } });
  });

  afterEach(cleanup);

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
    expect(apiMocks.updateCampaign.mock.calls[0][1].aiInstructions).toContain("### Itération 3\nResserre le message");
    expect(onMutated).toHaveBeenCalledOnce();
  });

  it("shows discreet per-variant metrics in campaign statistics", () => {
    renderCampaigns([experiment]);

    fireEvent.click(screen.getByRole("button", { name: "▥ Voir les statistiques" }));

    expect(screen.getByRole("dialog", { name: "Statistiques · Nouvelle campagne" })).toBeInTheDocument();
    expect(screen.getByText("Résultats des tests A/B")).toBeInTheDocument();
    expect(screen.getByText("60 %")).toBeInTheDocument();
    expect(screen.getByText("70 %")).toBeInTheDocument();
    expect(screen.getByText("Version B")).toBeInTheDocument();
  });
});
