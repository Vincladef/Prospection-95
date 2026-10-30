import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prospect } from "../types";
import { MessagesView } from "./MessagesView";

const apiMocks = vi.hoisted(() => ({
  updateProspect: vi.fn(),
  bulkStatus: vi.fn(),
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
    vi.stubGlobal("PointerEvent", MouseEvent);
    apiMocks.bulkStatus.mockImplementation(async (ids: string[], _status: string, versions: Array<{ id: string; version: number }>) => ({ updated: ids.length, prospects: ids.map(id => ({ id, version:(versions.find(v => v.id===id)?.version ?? 1)+1 })) }));
  });

  afterEach(cleanup);

  function renderSheet() {
    const rows = ["1", "2", "3"].map((id,i) => ({ ...baseProspect, id, name: `Ligne ${id}`, messageStatus: (i===0 ? "approved" : "draft") as Prospect["messageStatus"], writingIterationStatus: "completed" as const, writingIterationsCompleted: 3, hasOutboundMessages: true }));
    const props = { campaigns: [], prospects: rows, totals:{prospects:3,pendingApproval:2,scheduled:0,sent:0,replied:0,excluded:0}, onOpenCampaign:vi.fn(), onMutated:vi.fn().mockResolvedValue(undefined) };
    const view=render(<MessagesView {...props} />);
    const cells=()=>Array.from(view.container.querySelectorAll<HTMLElement>("[data-status-index]"));
    return {rows,props,view,cells};
  }

  it("selects consecutive cells by dragging and applies one bulk operation", async () => {
    const {cells}=renderSheet();
    fireEvent.pointerDown(cells()[0], {button:0});
    fireEvent.pointerMove(cells()[2], {buttons:1});
    fireEvent.pointerUp(window);
    expect(cells().every(c=>c.classList.contains("sheet-selected"))).toBe(true);
    expect(apiMocks.bulkStatus).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Statut de la sélection"),{target:{value:"prepared"}});
    await waitFor(()=>expect(apiMocks.bulkStatus).toHaveBeenCalledWith(["3","2","1"],"prepared",[{id:"3",version:1},{id:"2",version:1},{id:"1",version:1}]));
  });

  it("deselects on outside clicks while preserving status controls and the fill handle", () => {
    const {cells}=renderSheet();
    const selectCell=()=>{ fireEvent.pointerDown(cells()[0],{button:0}); fireEvent.pointerUp(window); };
    selectCell();
    fireEvent.pointerDown(screen.getByLabelText("Statut de la sélection"),{button:0});
    expect(cells()[0]).toHaveClass("sheet-selected");
    fireEvent.pointerDown(screen.getByRole("button",{name:"Recopier le statut de Ligne 3"}),{button:0});
    fireEvent.pointerUp(window);
    expect(cells()[0]).toHaveClass("sheet-selected");
    fireEvent.pointerDown(screen.getByRole("heading",{name:"Messages"}),{button:0});
    expect(cells()[0]).not.toHaveClass("sheet-selected");
    selectCell();
    fireEvent.pointerDown(screen.getByLabelText("Rechercher dans le CRM"),{button:0});
    expect(cells().some(c=>c.classList.contains("sheet-selected"))).toBe(false);
    expect(apiMocks.bulkStatus).not.toHaveBeenCalled();
  });

  it("previews handle fill without saving until release, then supports undo and redo", async () => {
    const {cells}=renderSheet();
    // The default descending sort places the approved source last.
    fireEvent.pointerDown(cells()[2],{button:0}); fireEvent.pointerUp(window);
    fireEvent.pointerDown(screen.getByRole("button",{name:"Recopier le statut de Ligne 1"}),{button:0});
    fireEvent.pointerMove(cells()[0],{buttons:1});
    expect(cells()[0]).toHaveClass("sheet-preview");
    expect(apiMocks.bulkStatus).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    await waitFor(()=>expect(apiMocks.bulkStatus).toHaveBeenCalledTimes(1));
    expect(apiMocks.bulkStatus.mock.calls[0][0]).toEqual(["3","2"]);
    await waitFor(()=>expect(screen.getByRole("button",{name:"Annuler"})).toBeEnabled());
    fireEvent.click(screen.getByRole("button",{name:"Annuler"}));
    await waitFor(()=>expect(apiMocks.bulkStatus).toHaveBeenCalledWith(["3","2"],"draft",[{id:"3",version:2},{id:"2",version:2}]));
    await waitFor(()=>expect(screen.getByRole("button",{name:"Rétablir"})).toBeEnabled());
    fireEvent.click(screen.getByRole("button",{name:"Rétablir"}));
    await waitFor(()=>expect(apiMocks.bulkStatus).toHaveBeenCalledWith(["3","2"],"approved",[{id:"3",version:3},{id:"2",version:3}]));
  });

  it("copies and pastes statuses, clears selection on sorting, and cancels previews", async () => {
    const {cells,view}=renderSheet();
    fireEvent.pointerDown(cells()[2],{button:0}); fireEvent.pointerUp(window);
    const table=view.container.querySelector(".table-scroll")!;
    const clipboardData={setData:vi.fn(), getData:()=>"Validé"};
    fireEvent.copy(table,{clipboardData}); expect(clipboardData.setData).toHaveBeenCalledWith("text/plain","Validé");
    fireEvent.pointerDown(cells()[0],{button:0}); fireEvent.pointerUp(window);
    fireEvent.paste(table,{clipboardData});
    await waitFor(()=>expect(apiMocks.bulkStatus).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText("Trier les prospects"),{target:{value:"alpha"}});
    expect(cells().some(c=>c.classList.contains("sheet-selected"))).toBe(false);
    fireEvent.pointerDown(cells()[0],{button:0}); fireEvent.pointerUp(window);
    fireEvent.pointerDown(screen.getByRole("button",{name:"Recopier le statut de Ligne 1"}),{button:0});
    fireEvent.pointerMove(cells()[2]); fireEvent.keyDown(table,{key:"Escape"}); fireEvent.pointerUp(window);
    expect(apiMocks.bulkStatus).toHaveBeenCalledTimes(1);
  });

  it("supports keyboard selection and fill-down while skipping locked rows", async () => {
    const {cells,view,rows,props}=renderSheet();
    view.rerender(<MessagesView {...props} prospects={rows.map(p=>p.id==="2"?{...p,excluded:true}:p)} />);
    fireEvent.pointerDown(cells()[0],{button:0}); fireEvent.pointerUp(window);
    const table=view.container.querySelector(".table-scroll")!;
    fireEvent.keyDown(table,{key:"ArrowDown",shiftKey:true});
    fireEvent.keyDown(table,{key:"ArrowDown",shiftKey:true});
    fireEvent.change(screen.getByLabelText("Statut de la sélection"),{target:{value:"prepared"}});
    await waitFor(()=>expect(apiMocks.bulkStatus).toHaveBeenCalledWith(["3","1"],"prepared",[{id:"3",version:1},{id:"1",version:1}]));
  });

  it("can undo successive edits of the same cell using the updated versions", async () => {
    const {cells,view,rows,props}=renderSheet();
    fireEvent.pointerDown(cells()[0],{button:0}); fireEvent.pointerUp(window);
    fireEvent.change(screen.getByLabelText("Statut de la sélection"),{target:{value:"prepared"}});
    await waitFor(()=>expect(screen.getByRole("button",{name:"Annuler"})).toBeEnabled());
    view.rerender(<MessagesView {...props} prospects={rows.map(p=>p.id==="3"?{...p,messageStatus:"prepared",version:2}:p)} />);
    fireEvent.change(screen.getByLabelText("Statut de la sélection"),{target:{value:"approved"}});
    await waitFor(()=>expect(apiMocks.bulkStatus).toHaveBeenCalledTimes(2));
    await waitFor(()=>expect(screen.getByRole("button",{name:"Annuler"})).toBeEnabled());
    fireEvent.click(screen.getByRole("button",{name:"Annuler"}));
    await waitFor(()=>expect(apiMocks.bulkStatus).toHaveBeenCalledTimes(3));
    await waitFor(()=>expect(screen.getByRole("button",{name:"Annuler"})).toBeEnabled());
    fireEvent.click(screen.getByRole("button",{name:"Annuler"}));
    await waitFor(()=>expect(apiMocks.bulkStatus).toHaveBeenLastCalledWith(["3"],"draft",[{id:"3",version:4}]));
  });

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
    expect(screen.getAllByRole("option", { name: "Brouillon" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("option", { name: "En attente… 0/3" })).not.toBeInTheDocument();
    expect(apiMocks.updateProspect).not.toHaveBeenCalled();
  });

  it("shows persisted progress and keeps unfinished rows locked", () => {
    renderMessages(baseProspect);

    const status = screen.getByRole("combobox", { name: "Statut de Prospect Test" });
    expect(status).toHaveValue("__preparing__");
    expect(screen.getByRole("option", { name: "En attente… 1/3" })).toBeInTheDocument();

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

    await waitFor(() => expect(apiMocks.bulkStatus).toHaveBeenCalledWith([ready.id], "approved", [{id:ready.id,version:1}]));
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

  it("shows the initial send alongside the actionable follow-up and includes it in sent results", () => {
    renderMessages({ ...baseProspect, messageStatus: "approved", statusStep: "R1", lastSentStep: "J0",
      lastSentAt: "2026-10-30T07:00:00Z", hasOutboundMessages: true,
      writingIterationStatus: "completed", writingIterationsCompleted: 3 });
    expect(screen.getByText("J0 envoyé")).toBeInTheDocument();
    expect(screen.getByText("R1 · Validé")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Statut de Prospect Test" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Expédiés / réponses" }));
    expect(screen.getByText("J0 envoyé")).toBeInTheDocument();
    expect(apiMocks.bulkStatus).not.toHaveBeenCalled();
  });

  it("retains the confirmed progress when a follow-up is changed to draft or fails", () => {
    renderMessages({ ...baseProspect, messageStatus: "failed", statusStep: "R2", lastSentStep: "R1",
      lastSentAt: "2026-10-30T07:00:00Z", hasOutboundMessages: true,
      writingIterationStatus: "completed", writingIterationsCompleted: 3 });
    expect(screen.getByText("R1 envoyé")).toBeInTheDocument();
    expect(screen.getByText("R2 · Erreur")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Statut de Prospect Test" })).toBeDisabled();
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
