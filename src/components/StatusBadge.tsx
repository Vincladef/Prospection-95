import type { MessageStatus } from "../types";

const labels: Record<string, string> = {
  draft: "Brouillon",
  prepared: "Préparé",
  pending_approval: "À valider",
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
