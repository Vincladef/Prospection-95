import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Shell } from "./Shell";

vi.mock("../lib/auth", () => ({
  authClient: { signOut: vi.fn() },
}));

function renderShell(hasActiveSender: boolean) {
  const onPageChange = vi.fn();
  render(
    <Shell
      page="messages"
      onPageChange={onPageChange}
      userEmail="admin@example.com"
      hasActiveSender={hasActiveSender}
      emergencyStop
      emergencyReason="Initialisation sécurisée"
      onEmergencyToggle={vi.fn()}
    >
      <div>Contenu</div>
    </Shell>,
  );
  return { onPageChange };
}

describe("Shell outbound status", () => {
  it("shows a neutral setup state when no active sender exists", () => {
    const { onPageChange } = renderShell(false);

    expect(screen.getByText("○ AUCUN EXPÉDITEUR ACTIF")).toBeInTheDocument();
    expect(screen.queryByText("Arrêt serveur actif.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "⚙ Configurer Gmail" }));
    expect(onPageChange).toHaveBeenCalledWith("settings");
  });

  it("keeps the stop warning when an active sender could send mail", () => {
    renderShell(true);

    expect(screen.getByText("■ ENVOIS ARRÊTÉS")).toBeInTheDocument();
    expect(screen.getByText("Arrêt serveur actif.")).toBeInTheDocument();
  });
});
