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
    expect(screen.queryByText("Campagnes en pause.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "⚙ Configurer Gmail" }));
    expect(onPageChange).toHaveBeenCalledWith("settings");
  });

  it("shows the neutral campaign pause state when an active sender exists", () => {
    renderShell(true);

    expect(screen.getByText("Ⅱ CAMPAGNES EN PAUSE")).toBeInTheDocument();
    expect(screen.getByText("Campagnes en pause.")).toBeInTheDocument();
  });
});
