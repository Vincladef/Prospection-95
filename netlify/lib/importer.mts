import { createHash } from "node:crypto";
import { isValid, parse } from "date-fns";
import { fromZonedTime } from "date-fns-tz";
import { z } from "zod";
import { HttpError } from "./http.mts";

export const importPayloadSchema = z
  .object({
    format: z.enum(["csv", "json", "v53-local-storage"]).optional(),
    filename: z.string().trim().min(1).max(255).optional(),
    content: z.string().max(15_000_000).optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    csvText: z.string().max(15_000_000).optional(),
    rows: z.array(z.record(z.string(), z.unknown())).max(20_000).optional(),
    localStorage: z.record(z.string(), z.unknown()).optional(),
    idempotencyKey: z.string().min(8).max(200).optional(),
  })
  .refine((value) => value.content || value.data || value.csvText || value.rows || value.localStorage, {
    message: "content, data, csvText, rows ou localStorage est requis",
  });

export type ImportPayload = z.infer<typeof importPayloadSchema>;

const CSV_HEADERS = {
  target: "Cible",
  name: "Prospect",
  website: "Site internet",
  contact: "Contact ou lien d'envoi",
  status: "Statut",
  lastSentAt: "Date/heure dernier envoi",
  gmailId: "ID Gmail",
  step: "Étape",
  subject: "Objet personnalisé",
  initial: "Message personnalisé",
  r1: "R1 (j+3)",
  r2: "R2 (+7 jours)",
  r3: "R3 (+7 jours)",
  r4: "R4 (+14 jours)",
  r5: "R5 (+14 jours)",
  contactKey: "Clé contact",
  sameContactCount: "Nb même contact",
  blacklisted: "Dans blacklist",
  alreadyContacted: "Déjà contacté",
  duplicateControl: "Contrôle anti-doublon",
} as const;

export interface NormalizedImportRow {
  sourceIndex: number;
  target: string;
  name: string;
  website: string | null;
  contactRaw: string;
  email: string | null;
  status: string;
  lastSentAt: string | null;
  gmailId: string | null;
  step: string | null;
  subject: string;
  messages: [string, string, string, string, string, string];
  contactKey: string | null;
  sameContactCount: number;
  blacklisted: boolean;
  alreadyContacted: boolean;
  duplicateControl: string | null;
  raw: {
    cible: string;
    prospect: string;
    site_internet: string;
    contact_ou_lien_envoi: string;
    statut: string;
    date_heure_dernier_envoi: string;
    id_gmail: string;
    etape: string;
    objet_personnalise: string;
    message_personnalise: string;
    r1_j3: string;
    r2_j7: string;
    r3_j7: string;
    r4_j14: string;
    r5_j14: string;
    cle_contact: string;
    nb_meme_contact: string;
    dans_blacklist: string;
    deja_contacte: string;
    controle_anti_doublon: string;
  };
}

export interface NormalizedImport {
  importId: string;
  rows: NormalizedImportRow[];
  summary: {
    rows: number;
    campaigns: number;
    validEmails: number;
    nonEmailContacts: number;
    exclusions: number;
    alreadyContacted: number;
    duplicates: number;
    warnings: string[];
  };
}

function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field.replace(/\r$/, ""));
      records.push(record);
      record = [];
      field = "";
    } else field += char;
  }
  if (quoted) throw new HttpError(422, "invalid_csv", "Le CSV contient un champ non fermé.");
  if (field || record.length) {
    record.push(field.replace(/\r$/, ""));
    records.push(record);
  }
  const [headers, ...data] = records.filter((row) => row.some((value) => value.trim()));
  if (!headers) return [];
  const normalizedHeaders = headers.map((value) => value.replace(/^\uFEFF/, "").trim());
  return data.map((values) =>
    Object.fromEntries(normalizedHeaders.map((header, index) => [header, values[index] ?? ""])),
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function rawStringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function boolValue(value: unknown): boolean {
  const normalized = stringValue(value).toLocaleLowerCase("fr-FR");
  return ["1", "true", "oui", "yes", "x", "vrai", "blacklisté", "blackliste"].includes(normalized);
}

function emailFromContact(value: string): string | null {
  const candidate = value.replace(/^mailto:/i, "").trim().toLowerCase();
  return /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(candidate) ? candidate : null;
}

function isoDateOrNull(value: string): string | null {
  if (!value || /^(?:n\/?d|—|-|aucun)$/i.test(value)) return null;
  if (/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/.test(value)) {
    const parsed = parse(value, "dd/MM/yyyy HH:mm:ss", new Date(0));
    if (isValid(parsed)) return fromZonedTime(parsed, "Europe/Paris").toISOString();
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function rowsFromLocalStorage(storage: Record<string, unknown>): Record<string, unknown>[] {
  const candidates: unknown[] = [storage.records, storage.people, storage.prospects, ...Object.values(storage)];
  for (const candidate of candidates) {
    let value = candidate;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        continue;
      }
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const object = value as Record<string, unknown>;
      value = object.records ?? object.people ?? object.prospects ?? object.rows;
    }
    if (Array.isArray(value)) {
      const rows = value.filter(
        (row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row),
      );
      if (rows.some((row) =>
        [CSV_HEADERS.contact, CSV_HEADERS.name, "contact", "email", "fullName", "name"]
          .some((key) => key in row),
      )) return rows;
    }
  }
  return [];
}

function sourceRows(payload: ImportPayload): Record<string, unknown>[] {
  if (payload.format === "csv" && payload.content != null) return parseCsv(payload.content);
  if (payload.format === "json" && payload.content != null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload.content) as unknown;
    } catch {
      throw new HttpError(422, "invalid_json_import", "Le fichier JSON d’import est invalide.");
    }
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row),
      );
    }
    if (parsed && typeof parsed === "object") return rowsFromLocalStorage(parsed as Record<string, unknown>);
    return [];
  }
  if (payload.format === "v53-local-storage") return rowsFromLocalStorage(payload.data ?? {});
  if (payload.csvText) return parseCsv(payload.csvText);
  if (payload.rows) return payload.rows;
  return rowsFromLocalStorage(payload.localStorage ?? {});
}

function pick(row: Record<string, unknown>, csvHeader: string, ...aliases: string[]): unknown {
  if (csvHeader in row) return row[csvHeader];
  for (const alias of aliases) if (alias in row) return row[alias];
  return "";
}

export function normalizeImport(payload: ImportPayload): NormalizedImport {
  const rawRows = sourceRows(payload);
  if (!rawRows.length) throw new HttpError(422, "empty_import", "Aucune ligne importable n’a été trouvée.");
  const rows = rawRows.map((row, sourceIndex): NormalizedImportRow => {
    const raw = {
      cible: rawStringValue(pick(row, CSV_HEADERS.target, "target", "campaign", "campaignName")),
      prospect: rawStringValue(pick(row, CSV_HEADERS.name, "name", "fullName")),
      site_internet: rawStringValue(pick(row, CSV_HEADERS.website, "site", "website", "websiteUrl")),
      contact_ou_lien_envoi: rawStringValue(pick(row, CSV_HEADERS.contact, "contact", "email")),
      statut: rawStringValue(pick(row, CSV_HEADERS.status, "status")),
      date_heure_dernier_envoi: rawStringValue(pick(row, CSV_HEADERS.lastSentAt, "lastSent", "lastSentAt")),
      id_gmail: rawStringValue(pick(row, CSV_HEADERS.gmailId, "gmailId")),
      etape: rawStringValue(pick(row, CSV_HEADERS.step, "step")),
      objet_personnalise: rawStringValue(pick(row, CSV_HEADERS.subject, "subject")),
      message_personnalise: rawStringValue(pick(row, CSV_HEADERS.initial, "body", "message", "initial")),
      r1_j3: rawStringValue(pick(row, CSV_HEADERS.r1, "r1")),
      r2_j7: rawStringValue(pick(row, CSV_HEADERS.r2, "r2")),
      r3_j7: rawStringValue(pick(row, CSV_HEADERS.r3, "r3")),
      r4_j14: rawStringValue(pick(row, CSV_HEADERS.r4, "r4")),
      r5_j14: rawStringValue(pick(row, CSV_HEADERS.r5, "r5")),
      cle_contact: rawStringValue(pick(row, CSV_HEADERS.contactKey, "contactKey")),
      nb_meme_contact: rawStringValue(pick(row, CSV_HEADERS.sameContactCount, "sameContactCount")),
      dans_blacklist: rawStringValue(pick(row, CSV_HEADERS.blacklisted, "blacklisted", "excluded")),
      deja_contacte: rawStringValue(pick(row, CSV_HEADERS.alreadyContacted, "contacted", "alreadyContacted")),
      controle_anti_doublon: rawStringValue(pick(row, CSV_HEADERS.duplicateControl, "duplicateControl")),
    };
    const contactRaw = stringValue(raw.contact_ou_lien_envoi);
    const legacyMessages = Array.isArray(row.messages) ? row.messages.map(stringValue) : [];
    const messages: [string, string, string, string, string, string] = [
      stringValue(raw.message_personnalise) || legacyMessages[0] || "",
      stringValue(raw.r1_j3) || legacyMessages[1] || "",
      stringValue(raw.r2_j7) || legacyMessages[2] || "",
      stringValue(raw.r3_j7) || legacyMessages[3] || "",
      stringValue(raw.r4_j14) || legacyMessages[4] || "",
      stringValue(raw.r5_j14) || legacyMessages[5] || "",
    ];
    return {
      sourceIndex,
      target: stringValue(raw.cible) || "Import sans campagne",
      name: stringValue(raw.prospect),
      website: stringValue(raw.site_internet) || null,
      contactRaw,
      email: emailFromContact(contactRaw),
      status: stringValue(raw.statut) || "En attente...",
      lastSentAt: isoDateOrNull(stringValue(raw.date_heure_dernier_envoi)),
      gmailId: stringValue(raw.id_gmail) || null,
      step: stringValue(raw.etape) || null,
      subject: stringValue(raw.objet_personnalise),
      messages,
      contactKey: stringValue(raw.cle_contact) || null,
      sameContactCount: Math.max(0, Number.parseInt(stringValue(raw.nb_meme_contact), 10) || 0),
      blacklisted: boolValue(raw.dans_blacklist),
      alreadyContacted: boolValue(raw.deja_contacte),
      duplicateControl: stringValue(raw.controle_anti_doublon) || null,
      raw,
    };
  });
  const campaigns = new Set(rows.map((row) => row.target));
  const emailCounts = new Map<string, number>();
  for (const row of rows) if (row.email) emailCounts.set(row.email, (emailCounts.get(row.email) ?? 0) + 1);
  const duplicates = [...emailCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const warnings: string[] = [];
  const nonEmailContacts = rows.filter((row) => !row.email).length;
  if (nonEmailContacts) warnings.push(`${nonEmailContacts} contact(s) sans adresse email seront conservés dans le rapport mais jamais placés dans la file d’envoi.`);
  if (duplicates) warnings.push(`${duplicates} doublon(s) d’adresse seront fusionnés par la contrainte globale anti-recontact.`);
  if (rows.some((row) => row.lastSentAt || /envoy|répondu|repondu/i.test(row.status))) {
    warnings.push("Les historiques d’envoi importés restent déclaratifs et ne constituent pas une confirmation SMTP.");
  }
  warnings.push("Toutes les campagnes importées seront créées inactives et avec l’envoi désactivé.");
  const canonical = JSON.stringify(rows);
  const importId = createHash("sha256").update(canonical).digest("hex");
  return {
    importId,
    rows,
    summary: {
      rows: rows.length,
      campaigns: campaigns.size,
      validEmails: rows.length - nonEmailContacts,
      nonEmailContacts,
      exclusions: rows.filter((row) => row.blacklisted).length,
      alreadyContacted: rows.filter((row) => row.alreadyContacted).length,
      duplicates,
      warnings,
    },
  };
}

export function importSourceMetadata(payload: ImportPayload): {
  filename: string;
  kind: "v53_csv" | "v53_localstorage_json";
} {
  const isCsv = payload.format === "csv" || (!!payload.csvText && !payload.format);
  return {
    filename: payload.filename ?? (isCsv ? "prospection-v53.csv" : "prospection-v53-local-storage.json"),
    kind: isCsv ? "v53_csv" : "v53_localstorage_json",
  };
}

export function importRowSha256(row: NormalizedImportRow): string {
  return createHash("sha256").update(JSON.stringify(row)).digest("hex");
}
