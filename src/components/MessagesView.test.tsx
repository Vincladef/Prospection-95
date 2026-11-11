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
  createdAt: "2026-10-26T07:00:00Z",
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

  it("shows a discreet latest send date including a manual reply without using a newer inbound date",()=>{
    renderMessages({...baseProspect,lastSentAt:"2026-11-03T08:00:00Z",conversationMessages:[
      {id:"manual",direction:"outbound",kind:"manual",subject:"Re",body:"Réponse",at:"2026-11-04T15:42:00Z"},
      {id:"received",direction:"inbound",kind:"reply",subject:"Re",body:"Merci",at:"2026-11-05T06:00:00Z"}
    ]});
    const chronology=screen.getByText(/Dernier envoi ·/);
    expect(chronology.querySelector("time")).toHaveAttribute("datetime","2026-11-04T15:42:00Z");
    expect(chronology).toHaveTextContent("16:42");expect(chronology).toHaveClass("message-chronology");
  });
  it("does not claim a send for a prepared sequence with no confirmed timestamp",()=>{
    renderMessages(baseProspect);expect(screen.queryByText(/Dernier envoi ·/)).not.toBeInTheDocument();
    expect(screen.getByText(/Ajouté ·/).querySelector("time")).toHaveAttribute("datetime",baseProspect.createdAt);
  });
  it.each([["writing","Rédaction IA"],["message","Message mis à jour"]] as const)("shows the %s activity for an unsent sequence",(kind,label)=>{
    renderMessages({...baseProspect,lastActivityAt:"2026-11-05T07:12:00Z",lastActivityKind:kind});
    const activity=screen.getByText(new RegExp(`${label} ·`));
    expect(activity.querySelector("time")).toHaveAttribute("datetime","2026-11-05T07:12:00Z");
    expect(activity).toHaveTextContent("08:12");expect(screen.queryByText(/Dernier envoi ·/)).not.toBeInTheDocument();
  });
  it("keeps the confirmed send date distinct from a later sequence edit",()=>{
    renderMessages({...baseProspect,lastOutboundAt:"2026-11-04T09:00:00Z",lastActivityAt:"2026-11-05T07:12:00Z",lastActivityKind:"message"});
    expect(screen.getByText(/Dernier envoi ·/).querySelector("time")).toHaveAttribute("datetime","2026-11-04T09:00:00Z");
    expect(screen.getByText(/Message mis à jour ·/).querySelector("time")).toHaveAttribute("datetime","2026-11-05T07:12:00Z");
  });
  it("does not clutter a sent row with an older activity date",()=>{
    renderMessages({...baseProspect,lastOutboundAt:"2026-11-05T09:00:00Z",lastActivityAt:"2026-11-04T07:12:00Z",lastActivityKind:"writing"});
    expect(screen.getByText(/Dernier envoi ·/)).toBeInTheDocument();expect(screen.queryByText(/Rédaction IA ·/)).not.toBeInTheDocument();
  });
  it("avoids repeating a status update in the same displayed minute as the send",()=>{
    renderMessages({...baseProspect,lastOutboundAt:"2026-11-05T09:00:00Z",lastActivityAt:"2026-11-05T09:00:01Z",lastActivityKind:"prospect"});
    expect(screen.getByText(/Dernier envoi ·/)).toBeInTheDocument();expect(screen.queryByText(/Fiche modifiée ·/)).not.toBeInTheDocument();
  });
  it("handles a missing or invalid timestamp without inventing a date",()=>{
    renderMessages({...baseProspect,createdAt:null,lastActivityAt:"invalid"});expect(screen.getByText("Date indisponible")).toBeInTheDocument();
  });
  it("uses the last confirmed send even when it falls outside the paginated conversation history",()=>{
    renderMessages({...baseProspect,lastSentAt:"2026-11-01T09:00:00Z",lastOutboundAt:"2026-11-03T13:25:00Z",conversationMessages:[]});
    expect(screen.getByText(/Dernier envoi ·/).querySelector("time")).toHaveAttribute("datetime","2026-11-03T13:25:00Z");
  });

  it.each([
    ["scheduled", "Réponse programmée · 3/3", "Validés", "status-scheduled"],
    ["draft_created", "Brouillon Gmail prêt · 3/3", "Expédiés / réponses", "status-received"],
    ["failed", "Réponse · erreur", "À vérifier", "status-failed"],
  ])("keeps reply phase %s visible in the matching filter", (state,label,filter,color) => {
    renderMessages({...baseProspect,messageStatus:"received",hasOutboundMessages:true,
      writingIterationStatus:"completed",writingIterationsCompleted:3,
      replyProgress:{state,completed:3,total:3,subject:"Réponse",body:"Dernière version",dueAt:null}});
    fireEvent.click(screen.getByRole("button",{name:filter}));
    const cell=document.querySelector("[data-status-index]")!;
    expect(cell).toHaveClass(color);
    expect(cell.querySelector(".sheet-status-label")).toHaveTextContent(label);
  });

  it("shows reply writing progress and keeps it locked independently from the prospecting sequence", () => {
    renderMessages({...baseProspect,messageStatus:"received",hasOutboundMessages:true,
      writingIterationStatus:"completed",writingIterationsCompleted:3,
      replyProgress:{state:"running",completed:2,total:3,subject:"Re: proposition",body:"Version 2",dueAt:null}});
    expect(document.querySelector(".sheet-status-label")).toHaveTextContent("Réponse IA en cours · 2/3");
    expect(screen.getByRole("combobox",{name:"Statut de Prospect Test"})).toBeDisabled();
  });

  it("sorts real timestamps in both directions with stable ties and missing dates last", () => {
    const rows = [
      {id:"z",name:"Ancien",createdAt:"2026-10-29T07:00:00Z"},
      {id:"a",name:"Récent",createdAt:"2026-10-30T10:00:00Z"},
      {id:"b",name:"Milieu B",createdAt:"2026-10-30T10:30:00+02:00"},
      {id:"c",name:"Milieu C",createdAt:"2026-10-30T08:30:00Z"},
      {id:"d",name:"Sans date",createdAt:null},
      {id:"e",name:"Date invalide",createdAt:"invalid"},
    ].map(row=>({...baseProspect,...row}));
    const {container} = render(<MessagesView campaigns={[]} prospects={rows}
      totals={{prospects:6,pendingApproval:6,scheduled:0,sent:0,replied:0,excluded:0}}
      onOpenCampaign={vi.fn()} onMutated={vi.fn()} />);
    const names = () => Array.from(container.querySelectorAll(".person-name"), node=>node.textContent);
    expect(names()).toEqual(["Récent","Milieu C","Milieu B","Ancien","Date invalide","Sans date"]);
    fireEvent.change(screen.getByRole("combobox",{name:"Trier les prospects"}),{target:{value:"old"}});
    expect(names()).toEqual(["Ancien","Milieu B","Milieu C","Récent","Sans date","Date invalide"]);
    fireEvent.change(screen.getByRole("textbox",{name:"Rechercher dans le CRM"}),{target:{value:"Milieu"}});
    expect(names()).toEqual(["Milieu B","Milieu C"]);
    fireEvent.change(screen.getByRole("combobox",{name:"Trier les prospects"}),{target:{value:"recent"}});
    expect(names()).toEqual(["Milieu C","Milieu B"]);
  });

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

  it.each([3, 5])("shows the completed %i iterations in the actual status cell", (total) => {
    const { container } = render(<MessagesView campaigns={[]} prospects={[{
      ...baseProspect, messageStatus: "pending_approval", writingIterationStatus: "completed",
      writingIterationsCompleted: total, writingIterationsTotal: total, hasOutboundMessages: true,
    }]} totals={{prospects:1,pendingApproval:1,scheduled:0,sent:0,replied:0,excluded:0}}
      onOpenCampaign={vi.fn()} onMutated={vi.fn()} />);
    expect(container.querySelector(".sheet-status-label")).toHaveTextContent(`En attente… ${total}/${total}`);
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
    expect(screen.getByRole("option", { name: "À finaliser · 3/3" })).toBeInTheDocument();
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

  it("shows a received reply and prevents bulk status changes from reviving follow-ups", () => {
    renderMessages({ ...baseProspect, messageStatus: "received", lastSentStep: "J0", statusStep: null,
      hasOutboundMessages: true, writingIterationStatus: "completed", writingIterationsCompleted: 3 });
    expect(document.querySelector(".sheet-status-label")).toHaveTextContent("Répondu");
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

it("keeps validated rows in their current position until the user reapplies the view",async()=>{
 const ready:Prospect={...baseProspect,messageStatus:"pending_approval",writingIterationStatus:"completed",writingIterationsCompleted:3,writingIterationsTotal:3,hasOutboundMessages:true};
 const totals={prospects:1,pendingApproval:1,scheduled:0,sent:0,replied:0,excluded:0};
 let rows=[ready];
 let redraw:()=>void;
 const refresh=vi.fn(async()=>{rows=[{...ready,messageStatus:"approved",version:2}];redraw();});
 const view=()=> <MessagesView campaigns={[]} prospects={rows} totals={totals} onOpenCampaign={vi.fn()} onMutated={refresh}/>;
 const rendered=render(view());redraw=()=>rendered.rerender(view());
 apiMocks.bulkStatus.mockResolvedValue({updated:1,prospects:[{id:ready.id,version:2}]});
 fireEvent.click(screen.getByRole("button",{name:/En attente/}));
 fireEvent.change(screen.getByRole("combobox",{name:"Statut de Prospect Test"}),{target:{value:"approved"}});
 await waitFor(()=>expect(screen.getByRole("combobox",{name:"Statut de Prospect Test"})).toHaveValue("approved"));
 expect(refresh).toHaveBeenCalledOnce();
 fireEvent.click(screen.getByRole("button",{name:"Actualiser la liste"}));
 await waitFor(()=>expect(screen.queryByRole("combobox",{name:"Statut de Prospect Test"})).not.toBeInTheDocument());
 cleanup();
});

describe("writing progress recovery",()=>{
 beforeEach(()=>{cleanup();vi.clearAllMocks();});
 afterEach(cleanup);
it("does not invent a zero when the matching writing history is unavailable",()=>{
 renderMessages({...baseProspect,writingProgressKnown:false,writingIterationStatus:"unknown",writingIterationsCompleted:0,writingIterationsTotal:5});
 expect(screen.getAllByText("Avancement indisponible").length).toBeGreaterThan(0);
 expect(screen.queryByText("En attente… 0/5")).not.toBeInTheDocument();
 expect(screen.getByRole("combobox",{name:"Statut de Prospect Test"})).toHaveAttribute("aria-disabled","true");
 fireEvent.click(screen.getByRole("button",{name:"À vérifier"}));
 expect(screen.getByText("Prospect Test")).toBeInTheDocument();
});
it("shows a failed writing pass as needing recovery with its actual counter",()=>{
 renderMessages({...baseProspect,writingIterationsCompleted:0,writingIterationError:"invalid_prospect_iteration_sequence"});
 expect(screen.getAllByText("À reprendre · 0/3").length).toBeGreaterThan(0);
 expect(screen.getByTitle("invalid_prospect_iteration_sequence")).toBeInTheDocument();
});
it("distinguishes completed writing from a sequence still awaiting finalization",()=>{
 renderMessages({...baseProspect,writingIterationStatus:"completed",writingIterationsCompleted:3,hasOutboundMessages:false});
 expect(screen.getAllByText("À finaliser · 3/3").length).toBeGreaterThan(0);
 expect(screen.getByRole("combobox",{name:"Statut de Prospect Test"})).toHaveAttribute("aria-disabled","true");
});

});
