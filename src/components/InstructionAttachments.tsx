import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { InstructionAttachment } from "../types";

interface InstructionAttachmentsProps {
  attachments: InstructionAttachment[];
  scope: "global" | "campaign";
  campaignId?: string | null;
  fieldKey: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".0", "")} Mo`;
}

export function InstructionAttachments({ attachments, scope, campaignId = null, fieldKey }: InstructionAttachmentsProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const matching = useMemo(() => attachments.filter((attachment) =>
    attachment.scope === scope && attachment.campaignId === campaignId && attachment.fieldKey === fieldKey
  ), [attachments, scope, campaignId, fieldKey]);
  const [items, setItems] = useState(matching);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => setItems(matching), [attachments, scope, campaignId, fieldKey]);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await api.uploadInstructionAttachment({ file, scope, campaignId, fieldKey });
      setItems((current) => [...current, {
        id: result.attachment.id,
        scope,
        campaignId,
        fieldKey,
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        hasExtractedText: /^(?:text\/)|(?:json|xml|yaml|csv|markdown)/i.test(file.type),
        createdAt: new Date().toISOString(),
      }]);
      setMessage("Fichier joint");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Ajout impossible");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove(item: InstructionAttachment) {
    if (!window.confirm(`Retirer « ${item.filename} » ?`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.deleteInstructionAttachment(item.id);
      setItems((current) => current.filter((candidate) => candidate.id !== item.id));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Suppression impossible");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="instruction-attachments">
      <input ref={inputRef} type="file" aria-label="Choisir un fichier à joindre" onChange={(event) => void upload(event.target.files?.[0])} />
      <button className="attachment-add" type="button" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? "Ajout…" : "📎 Joindre un fichier"}
      </button>
      {items.map((item) => (
        <span className="attachment-chip" key={item.id}>
          <button type="button" title={`Télécharger ${item.filename}`} onClick={() => void api.downloadInstructionAttachment(item.id, item.filename)}>{item.filename}</button>
          <small>{formatSize(item.sizeBytes)}</small>
          <button className="attachment-remove" type="button" title={`Retirer ${item.filename}`} onClick={() => void remove(item)}>×</button>
        </span>
      ))}
      {message ? <small className="attachment-message" role="status">{message}</small> : null}
      {!items.length ? <small className="attachment-hint">Tout fichier · 5 Mo max.</small> : null}
    </div>
  );
}
