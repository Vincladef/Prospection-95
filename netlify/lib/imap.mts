import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { readCredential } from "./credentials.mts";

export interface MailboxCursor {
  mailbox: string;
  uidValidity?: string | null;
  lastUid: number;
}

export interface SyncedMessage {
  uid: number;
  uidValidity: string;
  mailbox: string;
  internetMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: string[];
  to: string[];
  subject: string;
  text: string;
  html: string | null;
  date: string | null;
  autoSubmitted: string | null;
  precedence: string | null;
  isBounce: boolean;
}

export interface MailboxDelta {
  uidValidity: string;
  lastUid: number;
  messages: SyncedMessage[];
  resetRequired: boolean;
}

async function mailboxPath(client: ImapFlow, requested: string): Promise<string> {
  if (requested !== "__SENT__") return requested;
  const mailboxes = await client.list();
  const sent = mailboxes.find((mailbox) => mailbox.specialUse === "\\Sent");
  if (!sent) throw new Error("gmail_sent_mailbox_not_found");
  return sent.path;
}

export async function fetchMailboxDelta(input: {
  email: string;
  credentialId: string;
  cursor: MailboxCursor;
  maxMessages?: number;
}): Promise<MailboxDelta> {
  const credential = await readCredential(input.credentialId);
  if (!["gmail_sender", "gmail_primary", "test_inbox"].includes(credential.kind)) {
    throw new Error("Credential is not a Gmail application password");
  }
  const password = credential.secret.replace(/\s+/g, "");
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: input.email, pass: password },
    logger: false,
    socketTimeout: 25_000,
  });
  await client.connect();
  try {
    const selectedMailbox = await mailboxPath(client, input.cursor.mailbox);
    const lock = await client.getMailboxLock(selectedMailbox);
    try {
      if (!client.mailbox) throw new Error("IMAP mailbox was not selected");
      const uidValidity = String(client.mailbox.uidValidity);
      const resetRequired = !!input.cursor.uidValidity && input.cursor.uidValidity !== uidValidity;
      const startUid = resetRequired ? 1 : Math.max(1, input.cursor.lastUid + 1);
      const messages: SyncedMessage[] = [];
      let lastUid = resetRequired ? 0 : input.cursor.lastUid;
      for await (const item of client.fetch(
        `${startUid}:*`,
        { uid: true, source: true },
        { uid: true },
      )) {
        if (!item.source || item.uid < startUid) continue;
        const parsed = await simpleParser(item.source, { skipImageLinks: true });
        const headers = parsed.headers;
        const references = Array.isArray(parsed.references)
          ? parsed.references
          : parsed.references
            ? [parsed.references]
            : [];
        messages.push({
          uid: item.uid,
          uidValidity,
          mailbox: input.cursor.mailbox,
          internetMessageId: parsed.messageId ?? null,
          inReplyTo: parsed.inReplyTo ?? null,
          references,
          from: parsed.from?.value.map((entry) => entry.address).filter((value): value is string => !!value) ?? [],
          to: parsed.to && "value" in parsed.to
            ? parsed.to.value.map((entry) => entry.address).filter((value): value is string => !!value)
            : [],
          subject: parsed.subject ?? "",
          text: parsed.text ?? "",
          html: typeof parsed.html === "string" ? parsed.html : null,
          date: parsed.date?.toISOString() ?? null,
          autoSubmitted: headers.get("auto-submitted")?.toString() ?? null,
          precedence: headers.get("precedence")?.toString() ?? null,
          isBounce:
            /mailer-daemon|postmaster/i.test(parsed.from?.text ?? "") ||
            /delivery status notification|undeliverable|mail delivery subsystem/i.test(parsed.subject ?? ""),
        });
        lastUid = Math.max(lastUid, item.uid);
        if (messages.length >= (input.maxMessages ?? 25)) break;
      }
      return { uidValidity, lastUid, messages, resetRequired };
    } finally {
      lock.release();
    }
  } finally {
    if (client.usable) await client.logout().catch(() => undefined);
  }
}

export function classifyOperationalMessage(message: SyncedMessage):
  | "bounce"
  | "automatic_reply"
  | "human_or_unknown" {
  if (message.isBounce) return "bounce";
  if (
    (message.autoSubmitted && !/^no$/i.test(message.autoSubmitted)) ||
    /^(?:bulk|list|junk)$/i.test(message.precedence ?? "")
  ) return "automatic_reply";
  return "human_or_unknown";
}
