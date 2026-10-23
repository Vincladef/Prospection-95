import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, GmailAccount } from "../types";
import { SettingsView } from "./SettingsView";

const apiMocks = vi.hoisted(() => ({
  saveGmailAccount: vi.fn(),
  testGmailAccount: vi.fn(),
  sendGmailTestEmail: vi.fn(),
  deleteGmailAccount: vi.fn(),
  syncBobwork: vi.fn(),
}));

vi.mock("../lib/api", () => ({ api: apiMocks }));

const settings: AppSettings = {
  timezone: "Europe/Paris",
  outboundEnabled: true,
  vaultConfigured: true,
  emergencyStop: false,
  emergencyStopReason: null,
  generalWritingInstructions: "",
  defaultSendDays: [1, 2, 3, 4, 5],
  defaultSendStart: "08:00",
  defaultSendEnd: "18:00",
  version: 1,
};

const account: GmailAccount = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "sender@example.com",
  displayName: "Sender",
  role: "sender",
  status: "active",
  hasCredential: true,
  dailyLimit: 10,
  warmupDailyLimit: null,
  sendDays: [1, 2, 3, 4, 5],
  sendStart: "08:00",
  sendEnd: "18:00",
  timezone: "Europe/Paris",
  randomizeSendTimes: true,
  progressiveRampEnabled: true,
  pausedAt: null,
  pauseSource: null,
  pauseReason: null,
  smtpVerifiedAt: "2026-10-23T10:00:00.000Z",
  imapVerifiedAt: "2026-10-23T10:00:00.000Z",
  lastSyncAt: null,
  lastErrorCode: null,
  bobworkConnected: null,
  bobworkWarmupState: "unknown",
  bobworkObservedAt: null,
  bobworkConnectionStatus: "configured",
  bobworkLastSyncAt: null,
  bobworkLastErrorCode: null,
  bobworkReadyForOutbound: null,
  bobworkHealthScore: null,
  bobworkSpamRate7d: null,
  verifierResults: [],
  verifierObservedAt: null,
  version: 3,
};

describe("SettingsView Gmail V53", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.saveGmailAccount.mockResolvedValue({ account: { id: account.id } });
  });

  it("keeps a single edit command and uses the guided V53 setup", async () => {
    const onMutated = vi.fn().mockResolvedValue(undefined);
    render(<SettingsView settings={settings} accounts={[account]} providers={[]} attachments={[]} prospects={[]} onMutated={onMutated} />);

    expect(screen.queryByRole("button", { name: "Modifier la configuration" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Modifier" }));

    expect(screen.getByRole("heading", { name: "Configurer sender@example.com" })).toBeInTheDocument();
    expect(screen.getByText("1. Connexion Gmail")).toBeInTheDocument();
    expect(screen.getByText("2. Limites d’envoi")).toBeInTheDocument();
    expect(screen.getByText("3. Vérification finale")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continuer →" }));
    const wednesday = screen.getByLabelText("Mer");
    fireEvent.click(wednesday);
    fireEvent.click(screen.getByRole("button", { name: "Continuer →" }));
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer les modifications" }));

    await waitFor(() => expect(apiMocks.saveGmailAccount).toHaveBeenCalledWith(expect.objectContaining({ sendDays: [1, 2, 4, 5], dailyLimit: 10 }), account.id));
    expect(onMutated).toHaveBeenCalledOnce();
  });
});
