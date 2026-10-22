import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Campaign } from "../types";
import { CampaignsView } from "./CampaignsView";

vi.mock("../lib/api", () => ({ api: {} }));

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
  sequence: { subject: "", steps: ["", "", "", "", "", ""] },
  updatedAt: "2026-10-22T00:00:00.000Z",
};

describe("CampaignsView V53", () => {
  it("uses the continuous V53 editor instead of the old tabbed layout", () => {
    render(
      <CampaignsView
        campaigns={[campaign]}
        folders={[]}
        accounts={[]}
        experiments={[]}
        prospects={[]}
        totals={{ pendingApproval: 0 }}
        onOpenSettings={vi.fn()}
        onMutated={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getAllByText("Nouvelle campagne").length).toBeGreaterThan(0);
    expect(screen.getByText("Définition de la campagne")).toBeInTheDocument();
    expect(screen.getByText("Validation des emails")).toBeInTheDocument();
    expect(screen.getByText("Rédaction de la campagne")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Cible & envoi" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Enregistrer" }).every((button) => button.hasAttribute("disabled"))).toBe(true);
  });
});
