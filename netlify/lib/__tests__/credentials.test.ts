import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../credentials.mts";

describe("credential encryption", () => {
  afterEach(() => {
    delete process.env.CREDENTIALS_ENCRYPTION_KEY;
    delete process.env.CREDENTIALS_KEY_VERSION;
  });

  it("round-trips with AES-256-GCM and a unique nonce", async () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
    const first = await encryptSecret("secret-value");
    const second = await encryptSecret("secret-value");
    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(
      await decryptSecret({
        ciphertext: first.ciphertext,
        nonce: first.nonce,
        authTag: first.authTag,
        keyVersion: first.keyVersion,
      }),
    ).toBe("secret-value");
  });

  it("rejects a key with the wrong size", async () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(16).toString("base64");
    await expect(encryptSecret("x")).rejects.toThrow(/32 bytes/);
  });

  it("rejects a ciphertext whose authentication tag was altered", async () => {
    process.env.CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString("base64");
    const encrypted = await encryptSecret("protected-value");
    const alteredTag = Buffer.from(encrypted.authTag);
    alteredTag[0] ^= 0xff;
    await expect(decryptSecret({
      ciphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      authTag: alteredTag,
      keyVersion: encrypted.keyVersion,
    })).rejects.toThrow();
  });
});
