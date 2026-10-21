import { sqlOne, sqlQuery } from "./db.mts";
import {
  importRowSha256,
  importSourceMetadata,
  normalizeImport,
  type ImportPayload,
  type NormalizedImport,
} from "./importer.mts";
import { HttpError } from "./http.mts";

function contactKind(contactRaw: string, email: string | null): "email" | "url" | "other" {
  if (email) return "email";
  try {
    const url = new URL(contactRaw);
    if (["http:", "https:"].includes(url.protocol)) return "url";
  } catch {
    // It remains a non-addressable, non-URL contact.
  }
  return "other";
}

function storageRows(value: NormalizedImport): Record<string, unknown>[] {
  return value.rows.map((row) => ({
    row_number: row.sourceIndex + 1,
    row_sha256: importRowSha256(row),
    ...row.raw,
    parsed_last_sent_at: row.lastSentAt,
    parsed_duplicate_count: row.sameContactCount,
    parsed_blacklisted: row.blacklisted,
    parsed_already_contacted: row.alreadyContacted,
    normalized_contact: row.email ?? row.contactRaw.trim().toLowerCase(),
    contact_kind: contactKind(row.contactRaw, row.email),
    validation_errors: row.contactRaw ? [] : [{ code: "missing_contact" }],
  }));
}

export async function stageImport(payload: ImportPayload, actor: string): Promise<NormalizedImport> {
  const normalized = normalizeImport(payload);
  const source = importSourceMetadata(payload);
  const rows = storageRows(normalized);
  const batch = await sqlOne<{ id: string; status: string }>(
    `insert into app.import_batches
       (source_filename, source_sha256, source_kind, status, row_count,
        valid_row_count, invalid_row_count, summary, created_by)
     values ($1, $2, $3, 'previewed', $4, $5, $6, $7::jsonb, $8)
     on conflict (source_sha256) do update
       set source_filename = excluded.source_filename,
           summary = excluded.summary,
           status = case when app.import_batches.status = 'completed'
                         then app.import_batches.status else 'previewed' end
     returning id::text, status`,
    [
      source.filename,
      normalized.importId,
      source.kind,
      rows.length,
      rows.filter((row) => (row.validation_errors as unknown[]).length === 0).length,
      rows.filter((row) => (row.validation_errors as unknown[]).length > 0).length,
      JSON.stringify(normalized.summary),
      actor,
    ],
  );
  if (!batch) throw new HttpError(500, "import_stage_failed", "L’import n’a pas pu être préparé.");
  if (batch.status !== "completed") {
    await sqlQuery(
      `insert into app.import_rows
        (batch_id, row_number, row_sha256, cible, prospect, site_internet,
         contact_ou_lien_envoi, statut, date_heure_dernier_envoi, id_gmail,
         etape, objet_personnalise, message_personnalise, r1_j3, r2_j7, r3_j7,
         r4_j14, r5_j14, cle_contact, nb_meme_contact, dans_blacklist,
         deja_contacte, controle_anti_doublon, parsed_last_sent_at,
         parsed_duplicate_count, parsed_blacklisted, parsed_already_contacted,
         normalized_contact, contact_kind, validation_errors)
       select $1::uuid, source.row_number, source.row_sha256, source.cible,
              source.prospect, source.site_internet, source.contact_ou_lien_envoi,
              source.statut, source.date_heure_dernier_envoi, source.id_gmail,
              source.etape, source.objet_personnalise, source.message_personnalise,
              source.r1_j3, source.r2_j7, source.r3_j7, source.r4_j14, source.r5_j14,
              source.cle_contact, source.nb_meme_contact, source.dans_blacklist,
              source.deja_contacte, source.controle_anti_doublon,
              source.parsed_last_sent_at::timestamptz, source.parsed_duplicate_count,
              source.parsed_blacklisted, source.parsed_already_contacted,
              source.normalized_contact, source.contact_kind, source.validation_errors
       from jsonb_to_recordset($2::jsonb) as source(
         row_number integer, row_sha256 text, cible text, prospect text,
         site_internet text, contact_ou_lien_envoi text, statut text,
         date_heure_dernier_envoi text, id_gmail text, etape text,
         objet_personnalise text, message_personnalise text, r1_j3 text,
         r2_j7 text, r3_j7 text, r4_j14 text, r5_j14 text, cle_contact text,
         nb_meme_contact text, dans_blacklist text, deja_contacte text,
         controle_anti_doublon text, parsed_last_sent_at text,
         parsed_duplicate_count integer, parsed_blacklisted boolean,
         parsed_already_contacted boolean, normalized_contact text,
         contact_kind text, validation_errors jsonb
       )
       on conflict (batch_id, row_number) do update set
         row_sha256 = excluded.row_sha256,
         cible = excluded.cible,
         prospect = excluded.prospect,
         site_internet = excluded.site_internet,
         contact_ou_lien_envoi = excluded.contact_ou_lien_envoi,
         statut = excluded.statut,
         date_heure_dernier_envoi = excluded.date_heure_dernier_envoi,
         id_gmail = excluded.id_gmail,
         etape = excluded.etape,
         objet_personnalise = excluded.objet_personnalise,
         message_personnalise = excluded.message_personnalise,
         r1_j3 = excluded.r1_j3, r2_j7 = excluded.r2_j7,
         r3_j7 = excluded.r3_j7, r4_j14 = excluded.r4_j14,
         r5_j14 = excluded.r5_j14, cle_contact = excluded.cle_contact,
         nb_meme_contact = excluded.nb_meme_contact,
         dans_blacklist = excluded.dans_blacklist,
         deja_contacte = excluded.deja_contacte,
         controle_anti_doublon = excluded.controle_anti_doublon,
         parsed_last_sent_at = excluded.parsed_last_sent_at,
         parsed_duplicate_count = excluded.parsed_duplicate_count,
         parsed_blacklisted = excluded.parsed_blacklisted,
         parsed_already_contacted = excluded.parsed_already_contacted,
         normalized_contact = excluded.normalized_contact,
         contact_kind = excluded.contact_kind,
         validation_errors = excluded.validation_errors`,
      [batch.id, JSON.stringify(rows)],
    );
  }
  return normalized;
}

export async function commitStagedImport(
  payload: ImportPayload,
  actor: string,
): Promise<{ imported: number; report: Record<string, number | boolean> }> {
  const normalized = await stageImport(payload, actor);
  const row = await sqlOne<{ result: Record<string, unknown> }>(
    `select app.commit_import_batch(id, $2) as result
       from app.import_batches where source_sha256 = $1`,
    [normalized.importId, actor],
  );
  if (!row) throw new HttpError(404, "import_not_found", "Lot d’import introuvable.");
  const report = row.result ?? {};
  return {
    imported: Number(report.imported_rows ?? 0),
    report: {
      imported: Number(report.imported_rows ?? 0),
      rejected: Number(report.rejected_rows ?? 0),
      campaignsForcedInactive: Boolean(report.campaigns_forced_inactive),
      outboxJobsCreated: Number(report.outbox_jobs_created ?? 0),
    },
  };
}
