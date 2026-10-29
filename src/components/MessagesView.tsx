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
  onOpenCampaign: (campaignId: string) => void;
  onMutated: () => Promise<void>;
}

const editableStatuses: Array<[MessageStatus, string]> = [
  ["prepared", "Préparé"],
  ["pending_approval", "En attente…"],
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
  if (filter === "pending") return !prospect.excluded && (
    !isPreparationComplete(prospect)
    || !prospect.hasOutboundMessages
    || prospect.messageStatus === "draft"
    || prospect.messageStatus === "pending_approval"
    || prospect.messageStatus === "prepared"
  );
  if (filter === "ready") return prospect.messageStatus === "approved" || prospect.messageStatus === "scheduled";
  if (filter === "sent") return ["smtp_accepted", "received", "sent_manually"].includes(prospect.messageStatus || "");
  return prospect.excluded || ["failed", "uncertain"].includes(prospect.messageStatus || "");
}

const preservedStatuses = new Set<MessageStatus>([
  "reserved", "sending", "smtp_accepted", "uncertain", "failed", "received", "sent_manually",
]);

function isPreparationComplete(prospect: Prospect) {
  return prospect.writingIterationStatus === "completed"
    && prospect.writingIterationsCompleted >= prospect.writingIterationsTotal;
}

function preparationLabel(prospect: Prospect) {
  const completed = Math.min(prospect.writingIterationsCompleted, prospect.writingIterationsTotal);
  return `En attente… ${completed}/${prospect.writingIterationsTotal}`;
}

const MessageRow = memo(function MessageRow({
  rowNumber,
  prospect,
  onOpen,
  onOpenCampaign,
  onStatus,
}: {
  rowNumber: number;
  prospect: Prospect;
  onOpen: () => void;
  onOpenCampaign: () => void;
  onStatus: (status: MessageStatus) => void;
}) {
  const preserved = prospect.messageStatus ? preservedStatuses.has(prospect.messageStatus) : false;
  const preparing = !prospect.excluded && !preserved
    && (!isPreparationComplete(prospect) || !prospect.hasOutboundMessages);
  const selectValue = prospect.excluded
    ? "__excluded__"
    : preparing
      ? "__preparing__"
      : prospect.messageStatus || "__preparing__";
  const statusLocked = prospect.excluded || preserved || preparing;
  return (
    <tr className={prospect.excluded ? "excluded-row" : ""}>
      <td className="sticky-col sticky-index pin-no">
        <span className="row-index">{rowNumber}</span>
      </td>
      <td className="sticky-col sticky-contact pin-contact">
        <div className="contact-cell-content">
          <button className="contact-button" type="button" onDoubleClick={onOpen} onClick={onOpen}>
            <strong className="person-name">{prospect.name}</strong>
            <small className="person-contact">{prospect.email || prospect.contactRaw || "Contact non adressable"}</small>
          </button>
          {prospect.campaignId ? (
            <button className="v28-prospect-campaign campaign-link" type="button" onClick={onOpenCampaign} title={`Ouvrir la campagne ${prospect.campaignName || "correspondante"}`}>
              {prospect.campaignName || "Campagne"}
            </button>
          ) : <span className="v28-prospect-campaign campaign-link unavailable">Sans campagne</span>}
          {prospect.openObserved || prospect.clickObserved ? <span className="interaction-observations">
            {prospect.openObserved ? <i title="Au moins une observation technique d’ouverture reçue">◉ Ouverture observée</i> : null}
            {prospect.clickObserved ? <i title="Au moins un lien suivi a été appelé">↗ Clic observé</i> : null}
          </span> : null}
          <button className="tiny-link sequence-link" type="button" onClick={onOpen}>Voir toute la séquence</button>
        </div>
      </td>
      <td className="sticky-col sticky-status pin-status status-cell">
        <select
          className={`status-select status-${prospect.messageStatus || "empty"}`}
          value={selectValue}
          onChange={(event) => {
            if (!statusLocked) onStatus(event.target.value as MessageStatus);
          }}
          aria-label={`Statut de ${prospect.name}`}
          aria-disabled={statusLocked}
          disabled={prospect.excluded || preserved}
        >
          {prospect.excluded ? <option value="__excluded__">Exclu</option> : null}
          {preparing ? <option value="__preparing__">{preparationLabel(prospect)}</option> : null}
          {prospect.messageStatus && !editableStatuses.some(([status]) => status === prospect.messageStatus) ? (
            <option value={prospect.messageStatus}>{statusLabel(prospect.messageStatus)}</option>
          ) : null}
          {editableStatuses.map(([value, label]) => (
            <option key={value} value={value} disabled={preparing}>
              {value === "pending_approval" && !preparing && isPreparationComplete(prospect) ? preparationLabel(prospect) : label}
            </option>
          ))}
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

export function MessagesView({ campaigns, prospects, totals, onOpenCampaign, onMutated }: MessagesViewProps) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [campaignId, setCampaignId] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState("recent");
  const [compact, setCompact] = useState(false);
  const [editing, setEditing] = useState<Prospect | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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
                  onOpen={() => setEditing(prospect)}
                  onOpenCampaign={() => { if (prospect.campaignId) onOpenCampaign(prospect.campaignId); }}
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
