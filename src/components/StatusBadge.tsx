import type { MessageStatus, Prospect } from "../types";

const labels: Record<string, string> = {
  draft: "Brouillon",
  prepared: "Préparé",
  pending_approval: "En attente…",
  approved: "Validé",
  scheduled: "Programmé",
  reserved: "Réservé",
  sending: "En cours",
  smtp_accepted: "SMTP accepté",
  uncertain: "Résultat incertain",
  failed: "Erreur",
  cancelled: "Annulé",
  received: "Répondu",
  sent_manually: "Envoyé manuellement",
};

export function statusLabel(status: MessageStatus | null | string) {
  return status ? labels[status] || status : "Non préparé";
}

export function StatusBadge({ status }: { status: MessageStatus | null | string }) {
  return <span className={`status-badge status-${status || "empty"}`}>{statusLabel(status)}</span>;
}

export function replyStatusLabel(progress: Prospect["replyProgress"]) {
  if (!progress) return null;
  const count = `${progress.completed}/${progress.total}`;
  const labels: Record<string,string> = {
    received: "Répondu · à analyser", writing_failed: `Réponse IA · erreur · ${count}`, pending: `Réponse IA · ${count}`, running: `Réponse IA en cours · ${count}`,
    draft_requested: `Brouillon Gmail en préparation · ${count}`, draft_created: `Brouillon Gmail prêt · ${count}`,
    scheduled: `Réponse programmée · ${count}`, reserved: "Réponse réservée", sending: "Réponse en cours d’envoi",
    sent: "Réponse envoyée", sent_manually: "Réponse envoyée manuellement", failed: "Réponse · erreur",
    uncertain: "Réponse · résultat incertain", cancelled: "Réponse annulée", not_required: "Répondu · sans réponse à envoyer",
  };
  return labels[progress.state] || "Répondu";
}
