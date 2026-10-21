import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "../lib/api";
import type { Campaign, MessageStatus, Prospect } from "../types";
import { SequenceDrawer } from "./SequenceDrawer";
import { statusLabel } from "./StatusBadge";

interface MessagesViewProps {
  campaigns: Campaign[];
  prospects: Prospect[];
  totals: {
    prospects: number;
    pendingApproval: number;
    scheduled: number;
    sent: number;
    replied: number;
    excluded: number;
  };
  onMutated: () => Promise<void>;
}

const editableStatuses: Array<[MessageStatus, string]> = [
  ["prepared", "Préparé"],
  ["pending_approval", "À valider"],
  ["approved", "Validé"],
  ["scheduled", "Programmé"],
  ["cancelled", "Annulé"],
];

const statusFilters = [
  ["all", "Tous"],
  ["pending", "À valider"],
  ["ready", "Validés / programmés"],
  ["sent", "Expédiés / réponses"],
  ["issues", "À vérifier"],
] as const;

function filterStatus(prospect: Prospect, filter: string) {
  if (filter === "all") return true;
  if (filter === "pending") return prospect.messageStatus === "pending_approval" || prospect.messageStatus === "prepared";
  if (filter === "ready") return prospect.messageStatus === "approved" || prospect.messageStatus === "scheduled";
  if (filter === "sent") return ["smtp_accepted", "received", "sent_manually"].includes(prospect.messageStatus || "");
  return prospect.excluded || ["failed", "uncertain"].includes(prospect.messageStatus || "");
}

const MessageRow = memo(function MessageRow({
  prospect,
  selected,
  onSelect,
  onOpen,
  onStatus,
}: {
  prospect: Prospect;
  selected: boolean;
  onSelect: (shift: boolean) => void;
  onOpen: () => void;
  onStatus: (status: MessageStatus) => void;
}) {
  return (
    <tr className={`${selected ? "selected-row" : ""} ${prospect.excluded ? "excluded-row" : ""}`}>
      <td className="sticky-col sticky-index">
        <label className="row-selector">
          <input
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelect(event.nativeEvent instanceof MouseEvent && event.nativeEvent.shiftKey)}
            aria-label={`Sélectionner ${prospect.name}`}
          />
          <span>{prospect.id.slice(0, 5)}</span>
        </label>
      </td>
      <td className="sticky-col sticky-contact">
        <button className="contact-button" type="button" onDoubleClick={onOpen} onClick={onOpen}>
          <strong>{prospect.name}</strong>
          <small>{prospect.email || prospect.contactRaw || "Contact non adressable"}</small>
          <em>{prospect.campaignName || "Sans campagne"}</em>
        </button>
      </td>
      <td className="sticky-col sticky-status">
        <select
          className={`status-select status-${prospect.messageStatus || "empty"}`}
          value={prospect.messageStatus || "prepared"}
          onChange={(event) => onStatus(event.target.value as MessageStatus)}
          aria-label={`Statut de ${prospect.name}`}
          disabled={prospect.excluded}
        >
          {prospect.messageStatus && !editableStatuses.some(([status]) => status === prospect.messageStatus) ? (
            <option value={prospect.messageStatus}>{statusLabel(prospect.messageStatus)}</option>
          ) : null}
          {editableStatuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {prospect.excluded ? <span className="cell-warning">⚠ Exclu</span> : null}
      </td>
      <td className="subject-cell" onDoubleClick={onOpen}>{prospect.subject || <span className="muted">Sans objet</span>}</td>
      {prospect.messages.map((message, index) => (
        <td className="message-cell" key={`${prospect.id}-${index}`} onDoubleClick={onOpen}>
          {message ? <span>{message}</span> : <span className="muted">Non rédigé</span>}
        </td>
      ))}
    </tr>
  );
});

export function MessagesView({ campaigns, prospects, totals, onMutated }: MessagesViewProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [campaignId, setCampaignId] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState("recent");
  const [compact, setCompact] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<Prospect | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const lastSelection = useRef<number | null>(null);
  const tableScroll = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const railInner = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    const normalized = deferredQuery.trim().toLocaleLowerCase("fr");
    const rows = prospects.filter((prospect) => {
      if (campaignId !== "all" && prospect.campaignId !== campaignId) return false;
      if (!filterStatus(prospect, statusFilter)) return false;
      if (!normalized) return true;
      return [prospect.name, prospect.email, prospect.contactRaw, prospect.organizationName, prospect.subject]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase("fr")
        .includes(normalized);
    });
    return rows.slice().sort((left, right) => {
      if (sort === "alpha") return left.name.localeCompare(right.name, "fr");
      if (sort === "old") return left.id.localeCompare(right.id);
      return right.id.localeCompare(left.id);
    });
  }, [campaignId, deferredQuery, prospects, sort, statusFilter]);

  useEffect(() => {
    const source = tableScroll.current;
    const target = rail.current;
    const inner = railInner.current;
    if (!source || !target || !inner) return;
    inner.style.width = `${source.scrollWidth}px`;
    let syncing = false;
    const fromTable = () => {
      if (syncing) return;
      syncing = true;
      target.scrollLeft = source.scrollLeft;
      syncing = false;
    };
    const fromRail = () => {
      if (syncing) return;
      syncing = true;
      source.scrollLeft = target.scrollLeft;
      syncing = false;
    };
    source.addEventListener("scroll", fromTable, { passive: true });
    target.addEventListener("scroll", fromRail, { passive: true });
    const observer = new ResizeObserver(() => { inner.style.width = `${source.scrollWidth}px`; });
    observer.observe(source);
    return () => {
      source.removeEventListener("scroll", fromTable);
      target.removeEventListener("scroll", fromRail);
      observer.disconnect();
    };
  }, [visible.length]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag || "")) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelected(new Set(visible.map((row) => row.id)));
      }
      if (event.key === "Escape") setSelected(new Set());
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  }, [visible]);

  function selectAt(index: number, id: string, shift: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (shift && lastSelection.current !== null) {
        const start = Math.min(index, lastSelection.current);
        const end = Math.max(index, lastSelection.current);
        visible.slice(start, end + 1).forEach((row) => next.add(row.id));
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastSelection.current = index;
  }

  async function updateStatus(prospect: Prospect, status: MessageStatus) {
    setBusy(true);
    setNotice(null);
    try {
      await api.updateProspect(prospect.id, { status, version: prospect.version });
      await onMutated();
      setNotice("Statut enregistré dans Neon.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Modification refusée");
    } finally {
      setBusy(false);
    }
  }

  async function bulk(status: MessageStatus) {
    if (!selected.size) return;
    setBusy(true);
    try {
      await api.bulkStatus([...selected], status);
      setSelected(new Set());
      await onMutated();
      setNotice(`${selected.size} ligne(s) mises à jour.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Modification groupée impossible");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="view-stack" aria-labelledby="messages-title">
      <div className="view-heading">
        <div>
          <h1 id="messages-title">Messages</h1>
          <p>Préparation, validation et suivi du message initial et des cinq relances.</p>
        </div>
        <div className="metric-strip" aria-label="Résumé">
          <span><strong>{totals.pendingApproval}</strong> à valider</span>
          <span><strong>{totals.scheduled}</strong> programmés</span>
          <span><strong>{totals.sent}</strong> expédiés</span>
          <span><strong>{totals.replied}</strong> réponses</span>
        </div>
      </div>

      <div className="win-window sheet-window">
        <header className="win-titlebar"><strong>Tableau de prospection — {visible.length} sur {totals.prospects}</strong></header>
        <div className="toolbar">
          <label className="search-box">
            <span aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher un prospect…" />
          </label>
          <select value={campaignId} onChange={(event) => setCampaignId(event.target.value)} aria-label="Filtrer par campagne">
            <option value="all">Toutes les campagnes</option>
            {campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
          </select>
          <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Trier les prospects">
            <option value="recent">Plus récents</option>
            <option value="old">Plus anciens</option>
            <option value="alpha">Nom A → Z</option>
          </select>
          <button className={`win-button ${compact ? "pressed" : ""}`} onClick={() => setCompact((value) => !value)}>
            {compact ? "Vue normale" : "Vue compacte"}
          </button>
        </div>
        <div className="filter-bar">
          {statusFilters.map(([value, label]) => (
            <button key={value} className={statusFilter === value ? "active" : ""} onClick={() => setStatusFilter(value)}>{label}</button>
          ))}
        </div>
        {selected.size ? (
          <div className="selection-bar">
            <strong>{selected.size} ligne(s) sélectionnée(s)</strong>
            <span>Appliquer :</span>
            <button className="win-button" disabled={busy} onClick={() => void bulk("approved")}>✓ Valider</button>
            <button className="win-button" disabled={busy} onClick={() => void bulk("pending_approval")}>⌛ À revoir</button>
            <button className="win-button" disabled={busy} onClick={() => void bulk("cancelled")}>× Annuler</button>
          </div>
        ) : (
          <div className="sheet-help">Cochez des lignes pour une action groupée · Maj + clic sélectionne une plage · Ctrl+A sélectionne la vue.</div>
        )}
        <div className="table-scroll" ref={tableScroll} tabIndex={0}>
          <table className={`message-table ${compact ? "compact" : ""}`}>
            <thead>
              <tr>
                <th className="sticky-col sticky-index">#</th>
                <th className="sticky-col sticky-contact">Prospect / contact</th>
                <th className="sticky-col sticky-status">Statut</th>
                <th>Objet</th>
                <th>Message initial</th>
                <th>R1 <small>J+3</small></th>
                <th>R2 <small>+7j</small></th>
                <th>R3 <small>+7j</small></th>
                <th>R4 <small>+14j</small></th>
                <th>R5 <small>+14j</small></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((prospect, index) => (
                <MessageRow
                  key={prospect.id}
                  prospect={prospect}
                  selected={selected.has(prospect.id)}
                  onSelect={(shift) => selectAt(index, prospect.id, shift)}
                  onOpen={() => setEditing(prospect)}
                  onStatus={(status) => void updateStatus(prospect, status)}
                />
              ))}
            </tbody>
          </table>
          {!visible.length ? <div className="empty-state"><strong>Aucun prospect</strong><span>Modifiez les filtres ou importez le CRM historique.</span></div> : null}
        </div>
        <div className="scroll-rail" ref={rail} aria-label="Défilement horizontal du tableau" tabIndex={0}>
          <div ref={railInner} />
        </div>
        <footer className="statusbar">
          <span>{notice || "Double-cliquez sur un message pour ouvrir la séquence complète."}</span>
          <span>{busy ? "Enregistrement…" : "Source : Neon PostgreSQL"}</span>
        </footer>
      </div>

      {editing ? (
        <SequenceDrawer
          prospect={editing}
          onClose={() => setEditing(null)}
          onSave={async (payload) => {
            await api.updateProspect(editing.id, payload);
            await onMutated();
          }}
        />
      ) : null}
    </section>
  );
}
