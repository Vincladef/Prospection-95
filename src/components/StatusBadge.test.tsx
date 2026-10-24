import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge, statusLabel } from "./StatusBadge";

describe("StatusBadge", () => {
  it("distingue une acceptation SMTP d'un envoi générique", () => {
    render(<StatusBadge status="smtp_accepted" />);
    expect(screen.getByText("SMTP accepté")).toBeInTheDocument();
  });

  it("conserve les états inconnus au lieu de les inventer", () => {
    expect(statusLabel("legacy_imported")).toBe("legacy_imported");
  });

  it("uses the simplified pending label without renaming the technical status", () => {
    expect(statusLabel("pending_approval")).toBe("En attente…");
  });
});
