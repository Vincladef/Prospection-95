import { randomUUID } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { sqlOne } from "./db.mts";
import { HttpError } from "./http.mts";

const STORE_NAME = "prospection95-instruction-attachments";
const STORE_REGION = "eu-central-1";
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 300_000;

export type AttachmentScope = "global" | "campaign";

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong", region: STORE_REGION });
}

function cleanFilename(value: string): string {
  const name = value.replace(/[\u0000-\u001f\u007f/\\]+/g, " ").trim().slice(0, 255);
  return name || "fichier";
}

function validateFieldKey(value: string): string {
  if (!/^[a-z0-9:_/-]{1,180}$/.test(value)) {
    throw new HttpError(422, "attachment_field_invalid", "Le champ associé à cette pièce jointe est invalide.");
  }
  return value;
}

function readableAsText(contentType: string, filename: string): boolean {
  return contentType.startsWith("text/")
    || /(?:json|xml|yaml|javascript|csv|markdown)/i.test(contentType)
    || /\.(?:txt|md|csv|json|xml|ya?ml|html?|css|js|ts|tsx|jsx|sql)$/i.test(filename);
}

function extractText(bytes: ArrayBuffer, contentType: string, filename: string): string | null {
  if (!readableAsText(contentType, filename)) return null;
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).slice(0, MAX_EXTRACTED_CHARACTERS);
}

export async function saveInstructionAttachment(input: {
  file: File;
  scope: AttachmentScope;
  campaignId?: string | null;
  fieldKey: string;
  actor: string;
}): Promise<{ id: string }> {
  if (input.file.size > MAX_BYTES) throw new HttpError(413, "attachment_too_large", "Le fichier dépasse la limite de 5 Mo.");
  if (input.scope === "campaign" && !input.campaignId) throw new HttpError(422, "campaign_required", "La campagne est obligatoire.");
  if (input.scope === "global" && input.campaignId) throw new HttpError(422, "campaign_not_allowed", "Une pièce jointe globale ne dépend pas d’une campagne.");

  const filename = cleanFilename(input.file.name);
  const contentType = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:;[\w!#$&^_.+;= -]+)?$/.test(input.file.type)
    ? input.file.type.slice(0, 180)
    : "application/octet-stream";
  const fieldKey = validateFieldKey(input.fieldKey);
  const bytes = await input.file.arrayBuffer();
  const blobKey = `${input.scope}/${input.campaignId ?? "global"}/${randomUUID()}`;
  await store().set(blobKey, bytes, {
    onlyIfNew: true,
    metadata: { filename, contentType, size: input.file.size },
  });
  try {
    const row = await sqlOne<{ id: string }>(`
      insert into app.instruction_attachments
        (scope_type, campaign_id, field_key, filename, content_type, size_bytes, blob_key, extracted_text, created_by)
      values ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9)
      returning id::text
    `, [input.scope, input.campaignId ?? null, fieldKey, filename, contentType, input.file.size, blobKey,
      extractText(bytes, contentType, filename), input.actor]);
    if (!row) throw new Error("attachment insert failed");
    return row;
  } catch (error) {
    await store().delete(blobKey).catch(() => undefined);
    throw error;
  }
}

export async function readInstructionAttachment(id: string): Promise<{
  bytes: ArrayBuffer;
  filename: string;
  contentType: string;
}> {
  const row = await sqlOne<{ blob_key: string; filename: string; content_type: string }>(`
    select blob_key, filename, content_type
    from app.instruction_attachments
    where id = $1::uuid and deleted_at is null
  `, [id]);
  if (!row) throw new HttpError(404, "attachment_not_found", "Pièce jointe introuvable.");
  const bytes = await store().get(row.blob_key, { consistency: "strong", type: "arrayBuffer" });
  if (!bytes) throw new HttpError(404, "attachment_blob_missing", "Le fichier privé est introuvable.");
  return { bytes, filename: row.filename, contentType: row.content_type };
}

export async function removeInstructionAttachment(id: string): Promise<{ filename: string }> {
  const row = await sqlOne<{ blob_key: string; filename: string }>(`
    update app.instruction_attachments
    set deleted_at = clock_timestamp()
    where id = $1::uuid and deleted_at is null
    returning blob_key, filename
  `, [id]);
  if (!row) throw new HttpError(404, "attachment_not_found", "Pièce jointe introuvable.");
  await store().delete(row.blob_key).catch(() => undefined);
  return { filename: row.filename };
}
