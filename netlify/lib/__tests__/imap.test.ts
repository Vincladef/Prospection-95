import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyOperationalMessage, isPermanentBounceDiagnostic, type SyncedMessage } from "../imap.mts";

function message(overrides: Partial<SyncedMessage> = {}): SyncedMessage {
  return {
    uid: 1,
    uidValidity: "1",
    mailbox: "INBOX",
    internetMessageId: "<test@example.test>",
    inReplyTo: null,
    references: [],
    from: ["person@example.test"],
    to: ["sender@example.test"],
    subject: "Re: test",
    text: "Bonjour",
    html: null,
    date: "2026-10-21T12:00:00Z",
    autoSubmitted: null,
    precedence: null,
    isBounce: false,
    isPermanentBounce: false,
    ...overrides,
  };
}

describe("operational IMAP classification", () => {
  it("keeps an ordinary response for human analysis", () => {
    expect(classifyOperationalMessage(message())).toBe("human_or_unknown");
  });

  it("recognizes automatic and bounce signals without inventing a human reply", () => {
    expect(classifyOperationalMessage(message({ autoSubmitted: "auto-replied" }))).toBe("automatic_reply");
    expect(classifyOperationalMessage(message({ isBounce: true }))).toBe("bounce");
  });

  it("distinguishes permanent DSN failures from temporary bounces", () => {
    expect(isPermanentBounceDiagnostic(true, "Delivery Status Notification", "Status: 5.1.1\n550 5.1.1 user unknown")).toBe(true);
    expect(isPermanentBounceDiagnostic(true, "Delivery delayed", "Status: 4.2.0\nMailbox temporarily unavailable")).toBe(false);
    expect(isPermanentBounceDiagnostic(false, "Regular reply", "550 5.1.1 quoted text")).toBe(false);
  });

  it("bounds mailbox synchronization to a small UID set and capped source", () => {
    const implementation = readFileSync(join(process.cwd(), "netlify", "lib", "imap.mts"), "utf8");
    const worker = readFileSync(join(process.cwd(), "netlify", "functions", "sync-mailboxes.mts"), "utf8");
    expect(implementation).toContain("candidateUids.join");
    expect(implementation).toContain("maxLength: 512_000");
    expect(implementation).toContain("connectionTimeout: 20_000");
    expect(implementation).toContain("client.status(selectedMailbox");
    expect(implementation).toContain("operationDeadline");
    expect(implementation).toContain("`${startUid}:${mailboxLastUid}`");
    expect(implementation).toContain("client.close()");
    expect(worker).toContain('background: true');
  });
});
