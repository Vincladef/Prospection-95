import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prospect } from "../types";
import { MessagesView } from "./MessagesView";

const apiMocks = vi.hoisted(() => ({
  updateProspect: vi.fn(),
}));

vi.mock("../lib/api", () => ({ api: apiMocks }));

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

vi.stubGlobal("ResizeObserver", ResizeObserverStub);

const baseProspect: Prospect = {
  id: "11111111-1111-4111-8111-111111111111",
  campaignId: "22222222-2222-4222-8222-222222222222",
  campaignName: "Campagne test",
  organizationName: "Organisation",
  name: "Prospect Test",
  email: "prospect@example.test",
  contactRaw: "prospect@example.test",
  website: null,
  contactState: "never_contacted",
  messageStatus: null,
  step: null,
  lastSentAt: null,
  senderEmail: null,
  openObserved: false,
  clickObserved: false,
  firstOpenAt: null,
  lastOpenAt: null,
  firstClickAt: null,
  lastClickAt: null,
  openObservationCount: 0,
  clickObservationCount: 0,
  alreadyContacted: false,
  excluded: false,
  exclusionReason: null,
  variantLabel: "B",
  writingIterationStatus: "pending",
  writingIterationsCompleted: 1,
  writingIterationsTotal: 3,
  hasOutboundMessages: false,
  subject: "",
  messages: ["", "", "", "", "", ""],
  version: 1,
};

function renderMessages(prospect: Prospect) {
  const onMutated = vi.fn().mockResolvedValue(undefined);
  const onOpenCampaign = vi.fn();
  render(
    <MessagesView
      campaigns={[]}
      prospects={[prospect]}
      totals={{ prospects: 1, pendingApproval: 1, scheduled: 0, sent: 0, replied: 0, excluded: 0 }}
      onOpenCampaign={onOpenCampaign}
      onMutated={onMutated}
    />,
  );
  return { onMutated, onOpenCampaign };
}

describe("MessagesView statuses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.updateProspect.mockResolvedValue({ updated: 1 });
  });

  afterEach(cleanup);

  it("keeps revised drafts in the pending list without restarting completed AI passes", () => {
    renderMessages({
      ...baseProspect,
      messageStatus: "draft",
      writingIterationStatus: "completed",
      writingIterationsCompleted: 3,
      hasOutboundMessages: true,
    });
    fireEvent.click(screen.getByRole("button", { name: /En attente/ }));
    expect(screen.getByRole("combobox", { name: "Statut de Prospect Test" })).toHaveValue("draft");
    expect(screen.getByRole("option", { name: "Brouillon" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "En attente… 0/3" })).not.toBeInTheDocument();
    expect(apiMocks.updateProspect).not.toHaveBeenCalled();
  });

  it("shows the persisted per-prospect iteration progress without row selection controls", () => {
    renderMessages(baseProspect);

    const status = screen.getByRole("combobox", { name: "Statut de Prospect Test" });
    expect(status).toHaveValue("__preparing__");
    expect(screen.getByRole("option", { name: "En attente… 1/3" })).toBeInTheDocument();
    expect(screen.queryByText(/ligne\(s\) sélectionnée\(s\)/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Maj \+ clic/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "1" })).not.toBeInTheDocument();

    fireEvent.change(status, { target: { value: "approved" } });
    expect(apiMocks.updateProspect).not.toHaveBeenCalled();
  });

  it("restores the individual menu after all passes and messages exist", async () => {
    const ready = {
      ...baseProspect,
      messageStatus: "pending_approval" as const,
      writingIterationStatus: "completed" as const,
      writingIterationsCompleted: 3,
      hasOutboundMessages: true,
      subject: "Objet final",
      messages: ["J0", "R1", "R2", "R3", "R4", "R5"] as Prospect["messages"],
    };
    const { onMutated, onOpenCampaign } = renderMessages(ready);
    const status = screen.getByRole("combobox", { name: "Statut de Prospect Test" });

    expect(status).toHaveValue("pending_approval");
    expect(screen.getByRole("option", { name: "En attente… 3/3" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Campagne test" }));
    expect(onOpenCampaign).toHaveBeenCalledWith(ready.campaignId);
    fireEvent.change(status, { target: { value: "approved" } });

    await waitFor(() => expect(apiMocks.updateProspect).toHaveBeenCalledWith(ready.id, { status: "approved", version: 1 }));
    expect(onMutated).toHaveBeenCalledOnce();
  });

  it("does not invent a prepared status when the final messages do not exist", () => {
    renderMessages({
      ...baseProspect,
      messageStatus: "prepared",
      writingIterationStatus: "completed",
      writingIterationsCompleted: 3,
      hasOutboundMessages: false,
    });

    const status = screen.getByRole("combobox", { name: "Statut de Prospect Test" });
    expect(status).toHaveValue("__preparing__");
    expect(screen.getByRole("option", { name: "En attente… 3/3" })).toBeInTheDocument();
    expect(apiMocks.updateProspect).not.toHaveBeenCalled();
  });

  it("keeps a confirmed sent status locked", () => {
    renderMessages({
      ...baseProspect,
      messageStatus: "smtp_accepted",
      writingIterationStatus: "completed",
      writingIterationsCompleted: 3,
      hasOutboundMessages: true,
    });

    expect(screen.getByRole("combobox", { name: "Statut de Prospect Test" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "SMTP accepté" })).toBeInTheDocument();
  });
});
