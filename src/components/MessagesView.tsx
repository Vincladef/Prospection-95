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
  ["pending", "En attente"],
  ["ready", "Validés"],
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
  rowNumber,
  prospect,
  selected,
  onSelect,
  onOpen,
  onStatus,
}: {
  rowNumber: number;
  prospect: Prospect;
  selected: boolean;
  onSelect: (shift: boolean) => void;
  onOpen: () => void;
  onStatus: (status: MessageStatus) => void;
}) {
  return (
    <tr className={`${selected ? "selected-row" : ""} ${prospect.excluded ? "excluded-row" : ""}`}>
      <td className="sticky-col sticky-index pin-no">
        <button
          type="button"
          className="row-index"
          aria-pressed={selected}
          onClick={(event) => onSelect(event.shiftKey)}
          title="Cliquer pour sélectionner le statut de cette ligne"
        >{rowNumber}</button>
      </td>
      <td className="sticky-col sticky-contact pin-contact">
        <button className="contact-button" type="button" onDoubleClick={onOpen} onClick={onOpen}>
          <strong className="person-name">{prospect.name}</strong>
          <small className="person-contact">{prospect.email || prospect.contactRaw || "Contact non adressable"}</small>
          <em className="v28-prospect-campaign">{prospect.campaignName || "Sans campagne"}</em>
          {prospect.openObserved || prospect.clickObserved ? <span className="interaction-observations">
            {prospect.openObserved ? <i title="Au moins une observation technique d’ouverture reçue">◉ Ouverture observée</i> : null}
            {prospect.clickObserved ? <i title="Au moins un lien suivi a été appelé">↗ Clic observé</i> : null}
          </span> : null}
          <span className="tiny-link">Voir toute la séquence</span>
        </button>
      </td>
      <td
        className={`sticky-col sticky-status pin-status status-cell ${selected ? "is-selected" : ""}`}
        onPointerDown={(event) => onSelect(event.shiftKey)}
      >
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
      <td className="subject-cell message-cell col-subject" onDoubleClick={onOpen}>{prospect.subject || <span className="muted">Sans objet</span>}</td>
      {prospect.messages.map((message, index) => (
        <td className={`message-cell ${index === 0 ? "col-initial" : "col-message"}`} key={`${prospect.id}-${index}`} onDoubleClick={onOpen}>
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
      if (sort === "alphaDesc") return right.name.localeCompare(left.name, "fr");
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
      <div className="view-heading intro">
        <div>
          <h1 id="messages-title">Messages</h1>
          <p>Valide les emails et consulte les séquences de relances.</p>
        </div>
        <div className="metric-strip overview" aria-label="Résumé">
          <span><strong>{totals.pendingApproval}</strong> en attente</span>
          <span><strong>{prospects.filter((prospect) => prospect.messageStatus === "approved").length}</strong> validés</span>
        </div>
      </div>

      <div className="sheet-window workspace">
        <div className="toolbar commands">
          <div className="command-left">
            <label className="search-box search">
              <span aria-hidden="true">⌕</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Rechercher…" aria-label="Rechercher dans le CRM" />
            </label>
            <select className="select" value={campaignId} onChange={(event) => setCampaignId(event.target.value)} aria-label="Filtrer par campagne">
              <option value="all">Toutes les campagnes</option>
              {campaigns.map((campaign) => <option key={campaign.id} value={campaign.id}>{campaign.name}</option>)}
            </select>
          </div>
          <div className="command-right">
            <select className="select sort-control" value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Trier les prospects">
              <option value="recent">Plus récents d’abord</option>
              <option value="old">Plus anciens d’abord</option>
              <option value="alpha">Nom A → Z</option>
              <option value="alphaDesc">Nom Z → A</option>
            </select>
            <span className="command-count">{visible.length} lignes dans cet extrait</span>
            <button className={`win-button plain-btn ${compact ? "pressed on" : ""}`} onClick={() => setCompact((value) => !value)}>
              {compact ? "Vue normale" : "Vue compacte"}
            </button>
          </div>
        </div>
        <div className="filter-bar chipbar">
          {statusFilters.map(([value, label]) => (
            <button key={value} className={`chip ${statusFilter === value ? "active on" : ""}`} onClick={() => setStatusFilter(value)}>{label}</button>
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
          <div className="sheet-help sheet-hint"><strong>Cliquez sur un statut pour sélectionner une cellule</strong><span>· Maj + clic sélectionne une plage · <span className="kbd">Ctrl+A</span> sélectionne la vue.</span></div>
        )}
        <div className="table-scroll" ref={tableScroll} tabIndex={0}>
          <table className={`message-table data-grid ${compact ? "compact density-compact" : ""}`}>
            <colgroup><col className="col-no" /><col className="col-contact" /><col className="col-state" /><col className="col-subject" /><col className="col-initial" />{[1, 2, 3, 4, 5].map((item) => <col className="col-message" key={item} />)}</colgroup>
            <thead>
              <tr>
                <th className="sticky-col sticky-index pin-no">#</th>
                <th className="sticky-col sticky-contact pin-contact">Prospect / contact</th>
                <th className="sticky-col sticky-status pin-status">Statut</th>
                <th className="col-subject">Objet</th>
                <th className="col-initial">Message initial</th>
                <th>R1 <small>J+3</small></th>
                <th>R2 <small>J+7</small></th>
                <th>R3 <small>J+7</small></th>
                <th>R4 <small>J+14</small></th>
                <th>R5 <small>J+14</small></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((prospect, index) => (
                <MessageRow
                  key={prospect.id}
                  rowNumber={index + 1}
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
        <div className="scroll-rail v52-message-rail" ref={rail} aria-label="Défilement horizontal du tableau" tabIndex={0}>
          <div ref={railInner} />
        </div>
        <footer className="statusbar footerline">
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
