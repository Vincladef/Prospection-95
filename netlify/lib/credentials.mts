import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { getStore } from "@netlify/blobs";
import { env } from "./env.mts";
import { sqlOne, sqlQuery } from "./db.mts";
import { HttpError } from "./http.mts";

const ALGORITHM = "aes-256-gcm";
const AAD = Buffer.from("prospection95:credential:v1", "utf8");
const VAULT_KEY_STORE = "prospection95-vault-keys";
const VAULT_KEY_REGION = "eu-central-1";

export type CredentialKind =
  | "gmail_sender"
  | "gmail_primary"
  | "test_inbox"
  | "bobwork";

interface EncryptedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

function currentKeyVersion(): number {
  const value = Number(env("CREDENTIALS_KEY_VERSION", "1"));
  if (!Number.isSafeInteger(value) || value < 1 || value > 32_767) {
    throw new Error("CREDENTIALS_KEY_VERSION must be a positive small integer");
  }
  return value;
}

function decodeKey(encoded: string, version: number): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength !== 32) {
    throw new Error(`Encryption key version ${version} must decode to exactly 32 bytes`);
  }
  return key;
}

function environmentKey(version: number): Buffer | null {
  const versioned = env(`CREDENTIALS_ENCRYPTION_KEY_V${version}`);
  const encoded = versioned ?? (version === currentKeyVersion() ? env("CREDENTIALS_ENCRYPTION_KEY") : undefined);
  return encoded ? decodeKey(encoded, version) : null;
}

function vaultKeyStore() {
  return getStore({
    name: VAULT_KEY_STORE,
    consistency: "strong",
    region: VAULT_KEY_REGION,
  });
}

function blobKey(version: number): string {
  return `credentials-master-v${version}`;
}

async function keyForVersion(version: number): Promise<Buffer> {
  const configured = environmentKey(version);
  if (configured) return configured;

  const encoded = await vaultKeyStore().get(blobKey(version), {
    consistency: "strong",
    type: "text",
  });
  if (!encoded) throw new Error(`Missing encryption key version ${version}`);
  return decodeKey(encoded, version);
}

export async function credentialVaultConfigured(): Promise<boolean> {
  const version = currentKeyVersion();
  if (environmentKey(version)) return true;
  try {
    return Boolean(await vaultKeyStore().getMetadata(blobKey(version), { consistency: "strong" }));
  } catch {
    return false;
  }
}

export async function initializeCredentialVault(): Promise<{
  configured: true;
  created: boolean;
  source: "environment" | "netlify_blobs";
}> {
  const version = currentKeyVersion();
  if (environmentKey(version)) {
    return { configured: true, created: false, source: "environment" };
  }

  const store = vaultKeyStore();
  const key = blobKey(version);
  if (await store.getMetadata(key, { consistency: "strong" })) {
    return { configured: true, created: false, source: "netlify_blobs" };
  }

  const generated = randomBytes(32).toString("base64");
  const result = await store.set(key, generated, {
    onlyIfNew: true,
    metadata: {
      algorithm: ALGORITHM,
      createdAt: new Date().toISOString(),
      keyVersion: version,
      purpose: "prospection95-credential-encryption",
    },
  });
  if (!result.modified && !(await store.getMetadata(key, { consistency: "strong" }))) {
    throw new Error("Credential vault initialization did not persist a master key");
  }
  return { configured: true, created: result.modified, source: "netlify_blobs" };
}

export async function encryptSecret(plaintext: string): Promise<EncryptedSecret> {
  if (!plaintext) throw new HttpError(422, "empty_secret", "Le secret ne peut pas être vide.");
  const keyVersion = currentKeyVersion();
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, await keyForVersion(keyVersion), nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag(), keyVersion };
}

export async function decryptSecret(input: {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authTag: Uint8Array;
  keyVersion: number;
}): Promise<string> {
  const decipher = createDecipheriv(
    ALGORITHM,
    await keyForVersion(input.keyVersion),
    Buffer.from(input.nonce),
  );
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(input.authTag));
  return Buffer.concat([
    decipher.update(Buffer.from(input.ciphertext)),
    decipher.final(),
  ]).toString("utf8");
}

export async function storeCredential(input: {
  id?: string;
  kind: CredentialKind;
  label: string;
  secret: string;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string; configured: true; verificationStatus: string }> {
  if (!(await credentialVaultConfigured())) await initializeCredentialVault();
  const encrypted = await encryptSecret(input.secret);
  const row = input.id
    ? await sqlOne<{ id: string; verification_status: string }>(
        `update vault.credentials
            set kind = $2::vault.credential_kind,
                label = $3,
                ciphertext = $4,
                nonce = $5,
                auth_tag = $6,
                key_version = $7,
                metadata = $8::jsonb,
                verification_status = 'unverified',
                verification_error_code = null,
                last_verified_at = null,
                retired_at = null,
                updated_at = clock_timestamp()
          where id = $1::uuid
          returning id::text, verification_status`,
        [
          input.id,
          input.kind,
          input.label,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          encrypted.keyVersion,
          JSON.stringify(input.metadata ?? {}),
        ],
      )
    : await sqlOne<{ id: string; verification_status: string }>(
        `insert into vault.credentials
          (kind, label, ciphertext, nonce, auth_tag, key_version, metadata)
         values ($1::vault.credential_kind, $2, $3, $4, $5, $6, $7::jsonb)
         returning id::text, verification_status`,
        [
          input.kind,
          input.label,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          encrypted.keyVersion,
          JSON.stringify(input.metadata ?? {}),
        ],
      );
  if (!row) throw new HttpError(404, "credential_not_found", "Identifiant introuvable.");
  return { id: row.id, configured: true, verificationStatus: row.verification_status };
}

export async function readCredential(id: string): Promise<{
  secret: string;
  kind: CredentialKind;
  label: string;
  metadata: Record<string, unknown>;
}> {
  const row = await sqlOne<{
    kind: CredentialKind;
    label: string;
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    auth_tag: Uint8Array;
    key_version: number;
    metadata: Record<string, unknown>;
  }>(
    `select kind::text as kind, label, ciphertext, nonce, auth_tag, key_version, metadata
       from vault.credentials
      where id = $1::uuid and retired_at is null`,
    [id],
  );
  if (!row) throw new HttpError(404, "credential_not_found", "Identifiant introuvable.");
  return {
    kind: row.kind,
    label: row.label,
    metadata: row.metadata ?? {},
    secret: await decryptSecret({
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      authTag: row.auth_tag,
      keyVersion: Number(row.key_version),
    }),
  };
}

export async function setCredentialVerification(
  id: string,
  status: "verified" | "failed" | "unverified",
  errorCode?: string,
): Promise<void> {
  await sqlQuery(
    `update vault.credentials
        set verification_status = $2,
            verification_error_code = $3,
            last_verified_at = case when $2 = 'verified' then clock_timestamp() else last_verified_at end,
            updated_at = clock_timestamp()
      where id = $1::uuid`,
    [id, status, errorCode ?? null],
  );
}

export async function retireCredential(id: string): Promise<void> {
  await sqlQuery(
    `update vault.credentials
        set retired_at = clock_timestamp(), updated_at = clock_timestamp()
      where id = $1::uuid and retired_at is null`,
    [id],
  );
}
