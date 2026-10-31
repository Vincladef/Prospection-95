import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Prospect } from "../types";
import { SequenceDrawer } from "./SequenceDrawer";

afterEach(cleanup);
const original = { id: "p1", name: "Test", subject: "Objet passe 1", messages: ["Passe 1", "R1", "R2", "R3", "R4", "R5"], version: 2, messageStatus: "draft" } as Prospect;
const latest = { ...original, subject: "Objet passe 2", messages: ["Passe 2", "R1", "R2", "R3", "R4", "R5"] as Prospect["messages"], version: 3 };

describe("live sequence contents", () => {
  it("shows successive exchanged messages and the latest reply draft separately from the prospecting sequence", () => {
    const save=vi.fn();
    render(<SequenceDrawer prospect={{...original,
      conversationMessages:[
        {id:"in1",direction:"inbound",kind:"reply",subject:"Question",body:"Première question",at:"2026-10-30T08:00:00Z"},
        {id:"out1",direction:"outbound",kind:"reply",subject:"Re: Question",body:"Réponse déjà envoyée",at:"2026-10-30T09:00:00Z"},
        {id:"in2",direction:"inbound",kind:"reply",subject:"Suite",body:"Nouvelle question",at:"2026-10-30T10:00:00Z"}],
      replyProgress:{state:"draft_created",completed:3,total:3,subject:"Re: Suite",body:"Dernière réponse IA",dueAt:null}
    }} onSave={save} onClose={vi.fn()} />);
    expect(screen.getByRole("heading",{name:"Échanges"})).toBeInTheDocument();
    expect(screen.getAllByText("Message reçu")).toHaveLength(2);
    expect(screen.getByText("Réponse déjà envoyée")).toBeInTheDocument();
    expect(screen.getByText("Dernière réponse IA")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Passe 1")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });
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
