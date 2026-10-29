import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prospect } from "../types";
import { SequenceDrawer } from "./SequenceDrawer";

afterEach(cleanup);
const original = { id: "p1", name: "Test", subject: "Objet passe 1", messages: ["Passe 1", "R1", "R2", "R3", "R4", "R5"], version: 2, messageStatus: "draft" } as Prospect;
const latest = { ...original, subject: "Objet passe 2", messages: ["Passe 2", "R1", "R2", "R3", "R4", "R5"] as Prospect["messages"], version: 3 };

describe("live sequence contents", () => {
  it("refreshes the open drawer when no local edits exist", async () => {
    const save = vi.fn(); const close = vi.fn();
    const view = render(<SequenceDrawer prospect={original} onSave={save} onClose={close} />);
    view.rerender(<SequenceDrawer prospect={latest} onSave={save} onClose={close} />);
    await waitFor(() => expect(screen.getByLabelText("Objet")).toHaveValue("Objet passe 2"));
    expect(screen.getByDisplayValue("Passe 2")).toBeInTheDocument();
  });

  it("preserves unsaved typing and submits its original concurrency version", async () => {
    const save = vi.fn().mockResolvedValue(undefined); const close = vi.fn();
    const view = render(<SequenceDrawer prospect={original} onSave={save} onClose={close} />);
    fireEvent.change(screen.getByDisplayValue("Passe 1"), { target: { value: "Ma saisie" } });
    view.rerender(<SequenceDrawer prospect={latest} onSave={save} onClose={close} />);
    expect(screen.getByDisplayValue("Ma saisie")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Votre saisie est conservée");
    fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ version: 2, messages: ["Ma saisie", "R1", "R2", "R3", "R4", "R5"] })));
  });

  it("allows explicitly loading the remote version instead of local edits", () => {
    const save = vi.fn(); const close = vi.fn();
    const view = render(<SequenceDrawer prospect={original} onSave={save} onClose={close} />);
    fireEvent.change(screen.getByLabelText("Objet"), { target: { value: "Mon objet" } });
    view.rerender(<SequenceDrawer prospect={latest} onSave={save} onClose={close} />);
    fireEvent.click(screen.getByRole("button", { name: "Charger la dernière version" }));
    expect(screen.getByLabelText("Objet")).toHaveValue("Objet passe 2");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
