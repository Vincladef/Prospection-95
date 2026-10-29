import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, BlacklistPage, GmailAccount } from "../types";
import { SettingsView } from "./SettingsView";

const apiMocks = vi.hoisted(() => ({
  saveGmailAccount: vi.fn(),
  testGmailAccount: vi.fn(),
  sendGmailTestEmail: vi.fn(),
  deleteGmailAccount: vi.fn(),
  syncBobwork: vi.fn(),
  blacklist: vi.fn(),
}));

vi.mock("../lib/api", () => ({ api: apiMocks }));

afterEach(cleanup);

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

describe("SettingsView blacklist", () => {
  const entry = {
    id: "excluded-contact", matchType: "email" as const, matchValue: "blocked@example.com",
    reason: "Demande de retrait", createdAt: "2026-10-29T09:00:00Z",
  };

  function openProspects() {
    render(<SettingsView settings={settings} accounts={[]} providers={[]} attachments={[]} prospects={[]} onMutated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Prospects" }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.blacklist.mockResolvedValue({ entries: [entry], total: 1 });
  });

  it("loads the blacklist only when selected and shows contacts absent from prospects", async () => {
    openProspects();
    expect(apiMocks.blacklist).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Filtrer les prospects"), { target: { value: "blacklist" } });
    expect(await screen.findByText(entry.matchValue)).toBeInTheDocument();
    expect(screen.getAllByText(entry.matchValue)).toHaveLength(1);
    expect(screen.getByText(entry.reason)).toBeInTheDocument();
    expect(screen.getByText("Adresse email")).toBeInTheDocument();
    expect(apiMocks.blacklist).toHaveBeenCalledWith("", 1, expect.any(AbortSignal));
    fireEvent.change(screen.getByLabelText("Filtrer les prospects"), { target: { value: "excluded" } });
    expect(screen.queryByText(entry.matchValue)).not.toBeInTheDocument();
    expect(screen.getByText("Aucun prospect pour ces filtres.")).toBeInTheDocument();
  });

  it("paginates on the server and resets the page when searching", async () => {
    apiMocks.blacklist.mockResolvedValue({ entries: [entry], total: 51 });
    openProspects();
    fireEvent.change(screen.getByLabelText("Filtrer les prospects"), { target: { value: "blacklist" } });
    await screen.findByText(entry.matchValue);
    expect(screen.getByRole("button", { name: "Précédent" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Suivant" }));
    await waitFor(() => expect(apiMocks.blacklist).toHaveBeenLastCalledWith("", 2, expect.any(AbortSignal)));
    await screen.findByText("Page 2");
    expect(screen.getByRole("button", { name: "Suivant" })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("Email, domaine, motif…"), { target: { value: "example.com" } });
    await waitFor(() => expect(apiMocks.blacklist).toHaveBeenLastCalledWith("example.com", 1, expect.any(AbortSignal)));
    await screen.findByText("Page 1");
  });

  it("distinguishes domain exclusions and allows retrying a failed request", async () => {
    apiMocks.blacklist.mockRejectedValueOnce(new Error("Service indisponible"));
    apiMocks.blacklist.mockResolvedValue({ entries: [{ ...entry, matchType: "domain", matchValue: "example.org" }], total: 1 });
    openProspects();
    fireEvent.change(screen.getByLabelText("Filtrer les prospects"), { target: { value: "blacklist" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Service indisponible");
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByText("example.org")).toBeInTheDocument();
    expect(screen.getByText("Domaine entier")).toBeInTheDocument();
  });

  it("ignores stale search results and cancels requests when leaving the filter", async () => {
    let resolveOld!: (value: BlacklistPage) => void;
    apiMocks.blacklist.mockImplementationOnce(() => new Promise<BlacklistPage>((resolve) => { resolveOld = resolve; }));
    openProspects();
    fireEvent.change(screen.getByLabelText("Filtrer les prospects"), { target: { value: "blacklist" } });
    await waitFor(() => expect(apiMocks.blacklist).toHaveBeenCalledOnce());
    const oldSignal = apiMocks.blacklist.mock.calls[0][2] as AbortSignal;
    apiMocks.blacklist.mockResolvedValue({ entries: [], total: 0 });
    fireEvent.change(screen.getByPlaceholderText("Email, domaine, motif…"), { target: { value: "absent" } });
    expect(oldSignal.aborted).toBe(true);
    expect(await screen.findByText("Aucune entrée dans la blacklist pour ces filtres.")).toBeInTheDocument();
    resolveOld({ entries: [entry], total: 1 });
    await waitFor(() => expect(screen.queryByText(entry.matchValue)).not.toBeInTheDocument());
    const currentSignal = apiMocks.blacklist.mock.calls[1][2] as AbortSignal;
    fireEvent.change(screen.getByLabelText("Filtrer les prospects"), { target: { value: "all" } });
    expect(currentSignal.aborted).toBe(true);
  });
});
