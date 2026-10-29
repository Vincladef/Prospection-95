import { useEffect, useRef, useState, type RefObject } from "react";
import { api } from "../lib/api";
import type { MessageStatus, Prospect } from "../types";

export const cellStatuses: Array<[MessageStatus, string]> = [["draft", "Brouillon"], ["prepared", "Préparé"], ["pending_approval", "En attente…"], ["approved", "Validé"], ["scheduled", "Programmé"], ["cancelled", "Annulé"]];
export function canEditStatus(p: Prospect) {
  return !p.excluded && p.writingIterationStatus === "completed" && p.writingIterationsCompleted >= p.writingIterationsTotal
    && p.hasOutboundMessages && cellStatuses.some(([s]) => s === p.messageStatus);
}
type Change = { id: string; before: MessageStatus; after: MessageStatus; version: number };
function advanceVersions(stack: Change[][], saved: Change[]) {
  const versions = new Map(saved.map(c => [c.id, c.version]));
  return stack.map(entry => entry.map(c => ({ ...c, version: versions.get(c.id) ?? c.version })));
}
type Drag = { anchor: number; end: number; fill: boolean; source: MessageStatus | null; y: number; x: number };

export function useStatusSheet(rows: Prospect[], scroll: RefObject<HTMLDivElement | null>, refresh: () => Promise<void>) {
  const [range, setRange] = useState<[number, number] | null>(null);
  const [preview, setPreview] = useState<[number, number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [undoStack, setUndo] = useState<Change[][]>([]);
  const [redoStack, setRedo] = useState<Change[][]>([]);
  const operation = useRef(false);
  const drag = useRef<Drag | null>(null);
  const clipboard = useRef<MessageStatus[]>([]);
  const current = useRef({ rows, range }); current.current = { rows, range };
  const signature = rows.map(p => p.id).join(",");
  useEffect(() => { drag.current = null; setRange(null); setPreview(null); }, [signature]);
  useEffect(() => {
    function deselectOutside(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const workspace = scroll.current?.closest(".sheet-window");
      const control = target.closest("[data-status-index], .status-sheet-toolbar, .scroll-rail");
      if (control && workspace?.contains(control)) return;
      // Keep the range while using the table's native scrollbars.
      const table = scroll.current;
      if (target === table && table) {
        const rect = table.getBoundingClientRect();
        if (event.clientX >= rect.left + table.clientWidth || event.clientY >= rect.top + table.clientHeight) return;
      }
      drag.current = null;
      setPreview(null);
      setRange(null);
    }
    document.addEventListener("pointerdown", deselectOutside, true);
    return () => document.removeEventListener("pointerdown", deselectOutside, true);
  }, [scroll]);
  const indices = (r: [number, number]) => [Math.min(...r), Math.max(...r)];
  function selected() { if (!range) return []; const [a,b] = indices(range); return rows.slice(a,b+1); }

  async function commit(changes: Change[], history = true): Promise<Change[] | null> {
    if (operation.current || !changes.length) return null;
    if (changes.length > 500) { setNotice("Sélection limitée à 500 statuts par opération."); return null; }
    operation.current = true; setBusy(true); setNotice(null);
    const done: Change[] = [];
    try {
      for (const status of [...new Set(changes.map(c => c.after))]) {
        const group = changes.filter(c => c.after === status);
        const result = await api.bulkStatus(group.map(c => c.id), status, group.map(c => ({ id: c.id, version: c.version })));
        const accepted = new Set(result.prospects.map(p => p.id));
        done.push(...group.filter(c => accepted.has(c.id)).map(c => ({ ...c, version: result.prospects.find(p => p.id === c.id)!.version })));
      }
      setNotice(`${done.length} statut(s) modifié(s).${done.length < changes.length ? " Certaines lignes ont changé ou sont verrouillées." : ""}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Modification refusée."); }
    finally {
      if (history && done.length) { setUndo(stack => advanceVersions([...stack.slice(-19), done], done)); setRedo([]); }
      try { await refresh(); } finally { operation.current = false; setBusy(false); }
    }
    return done;
  }
  function changesFor(targets: Prospect[], statuses: MessageStatus[]) {
    return targets.flatMap((p,i) => canEditStatus(p) && p.messageStatus !== statuses[i % statuses.length]
      ? [{ id: p.id, before: p.messageStatus!, after: statuses[i % statuses.length], version: p.version }] : []);
  }
  function apply(status: MessageStatus, index?: number) {
    scroll.current?.focus({ preventScroll: true });
    const targets = index !== undefined && (!range || index < Math.min(...range) || index > Math.max(...range)) ? [rows[index]] : selected();
    if (targets.some(p => !canEditStatus(p))) setNotice("Les lignes verrouillées sont ignorées.");
    void commit(changesFor(targets, [status]));
  }
  async function undo(redo = false) {
    const stack = redo ? redoStack : undoStack; const last = stack.at(-1);
    if (!last || operation.current) return;
    const result = await commit(last.map(c => ({ id: c.id, before: c.after, after: c.before, version: c.version })), false);
    if (!result) return;
    if (redo) {
      setRedo(stack => advanceVersions(stack.slice(0,-1), result));
      if (result.length) setUndo(stack => advanceVersions([...stack, result], result));
    } else {
      setUndo(stack => advanceVersions(stack.slice(0,-1), result));
      if (result.length) setRedo(stack => advanceVersions([...stack, result], result));
    }
  }
  function start(index: number, event: { button: number; shiftKey: boolean; clientX: number; clientY: number; preventDefault: () => void }, fill = false) {
    if (event.button !== 0 || operation.current) return;
    event.preventDefault(); scroll.current?.focus({ preventScroll: true });
    const anchor = fill && range ? Math.min(...range) : event.shiftKey && range ? range[0] : index;
    if (fill && !canEditStatus(rows[anchor])) return;
    drag.current = { anchor, end: index, fill, source: rows[anchor]?.messageStatus ?? null, x: event.clientX, y: event.clientY };
    if (!fill) setRange([anchor,index]);
    else setPreview([anchor,index]);
  }
  const latestCommit = useRef(commit); latestCommit.current = commit;
  useEffect(() => {
    let frame = 0;
    function locate(x: number, y: number, fallback?: EventTarget | null) {
      const element = document.elementFromPoint?.(x,y) ?? (fallback instanceof Element ? fallback : null);
      const cell = element?.closest<HTMLElement>("[data-status-index]");
      const d = drag.current;
      if (!cell || !d) return;
      const index = Number(cell.dataset.statusIndex);
      if (d.end === index) return;
      d.end = index;
      if (d.fill) setPreview([d.anchor,index]); else setRange([d.anchor,index]);
    }
    function tick() {
      const d = drag.current; const container = scroll.current;
      if (d && container) {
        const rect = container.getBoundingClientRect();
        const delta = d.y > rect.bottom-35 ? 18 : d.y < rect.top+65 ? -18 : 0;
        if (delta) { container.scrollTop += delta; locate(d.x, Math.max(rect.top+66, Math.min(rect.bottom-2,d.y))); }
      }
      frame = drag.current ? requestAnimationFrame(tick) : 0;
    }
    function move(e: PointerEvent) { const d = drag.current; if (d) { d.x=e.clientX; d.y=e.clientY; locate(e.clientX,e.clientY,e.target); if (!frame) frame=requestAnimationFrame(tick); } }
    function up() {
      const d = drag.current; drag.current=null; setPreview(null);
      if (!d?.fill || !d.source || !cellStatuses.some(([s]) => s === d.source)) return;
      const [a,b]=[Math.min(d.anchor,d.end),Math.max(d.anchor,d.end)];
      const targets=current.current.rows.slice(a,b+1);
      setRange([a,b]); void latestCommit.current(changesFor(targets,[d.source]));
    }
    function cancel() { drag.current=null; setPreview(null); }
    window.addEventListener("pointermove",move); window.addEventListener("pointerup",up); window.addEventListener("pointercancel",cancel);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("pointermove",move); window.removeEventListener("pointerup",up); window.removeEventListener("pointercancel",cancel); };
  }, [scroll]);

  function copy(e: React.ClipboardEvent) {
    if (!range) return;
    const source=selected().map(p=>p.messageStatus);
    if (!source.length || source.some(s=>!s || !cellStatuses.some(([v])=>v===s))) return;
    const values=source as MessageStatus[];
    clipboard.current=values; e.clipboardData.setData("text/plain",values.map(status=>cellStatuses.find(([s])=>s===status)![1]).join("\n")); e.preventDefault();
  }
  function paste(e: React.ClipboardEvent) {
    if (!range) return;
    const text=e.clipboardData.getData("text/plain").trim();
    const values=text ? text.split(/\r?\n/).map(s=>cellStatuses.find(([value,label])=>value===s || label.toLocaleLowerCase("fr")===s.trim().toLocaleLowerCase("fr"))?.[0]) : clipboard.current;
    e.preventDefault();
    if (!values.length || values.some(s=>!s)) { setNotice("Le presse-papiers doit contenir des statuts reconnus, un par ligne."); return; }
    const [a,b]=indices(range); const targets=rows.slice(a,Math.max(b+1,a+values.length));
    void commit(changesFor(targets,values as MessageStatus[]));
  }
  function keyDown(e: React.KeyboardEvent) {
    if ((e.target as HTMLElement).matches("input,textarea,select")) return;
    const mod=e.ctrlKey || e.metaKey;
    if (e.key==="Escape") { drag.current=null; setPreview(null); setRange(null); }
    else if (mod && e.key.toLowerCase()==="a") { e.preventDefault(); if(rows.length)setRange([0,rows.length-1]); }
    else if (mod && (e.key.toLowerCase()==="z" || e.key.toLowerCase()==="y")) { e.preventDefault(); void undo(e.shiftKey || e.key.toLowerCase()==="y"); }
    else if (mod && e.key.toLowerCase()==="d" && range) { e.preventDefault(); const items=selected(); const source=items[0]; if(source && canEditStatus(source)) void commit(changesFor(items,[source.messageStatus!])); }
    else if (range && ["ArrowDown","ArrowUp","Home","End"].includes(e.key)) { e.preventDefault(); const end=e.key==="Home"?0:e.key==="End"?rows.length-1:Math.max(0,Math.min(rows.length-1,range[1]+(e.key==="ArrowDown"?1:-1))); setRange([e.shiftKey?range[0]:end,end]); scroll.current?.querySelector(`[data-status-index="${end}"]`)?.scrollIntoView?.({block:"nearest"}); }
  }
  return { range, preview, previewStatus:drag.current?.source ?? null, busy, notice, selectedCount:selected().length, apply, start, undo, canUndo:undoStack.length>0, canRedo:redoStack.length>0, copy, paste, keyDown };
}
