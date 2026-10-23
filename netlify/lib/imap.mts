import { lookup } from "node:dns/promises";
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
  const imapAddress = await lookup("imap.gmail.com", { family: 4 });
  const client = new ImapFlow({
    host: imapAddress.address,
    port: 993,
    secure: true,
    servername: "imap.gmail.com",
    auth: { user: input.email, pass: password },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 7_000,
  });
  // Netlify's scheduler gives synchronous invocations a short response window.
  // Closing the client rejects whichever IMAP operation is pending, leaving time
  // for the worker to persist a useful failure instead of being cut off at 15 s.
  const operationDeadline = setTimeout(() => client.close(), 10_000);
  try {
    await client.connect();
    const selectedMailbox = await mailboxPath(client, input.cursor.mailbox);
    const status = await client.status(selectedMailbox, { uidNext: true, uidValidity: true });
    if (!status || status.uidValidity === undefined) throw new Error("IMAP mailbox status is unavailable");
    const uidValidity = String(status.uidValidity);
    const resetRequired = !!input.cursor.uidValidity && input.cursor.uidValidity !== uidValidity;
    const startUid = resetRequired ? 1 : Math.max(1, input.cursor.lastUid + 1);
    const maxMessages = input.maxMessages ?? 25;
    const mailboxLastUid = Math.max(0, Number(status.uidNext ?? 1) - 1);
    let lastUid = resetRequired ? 0 : input.cursor.lastUid;
    if (mailboxLastUid < startUid) {
      return { uidValidity, lastUid, messages: [], resetRequired };
    }

    const lock = await client.getMailboxLock(selectedMailbox, { readOnly: true });
    try {
      if (!client.mailbox) throw new Error("IMAP mailbox was not selected");
      // Gmail interprets an open range whose start is already past the last UID
      // as a reversed range. Besides re-reading the last message, that query can
      // take longer than Netlify's scheduled-function request window. UIDNEXT is
      // part of the mailbox STATUS, so an empty delta can be returned
      // immediately and non-empty searches can be bounded to a real UID.
      const found = await client.search({ uid: `${startUid}:${mailboxLastUid}` }, { uid: true });
      const candidateUids = (Array.isArray(found) ? found : [])
        .filter((uid) => uid >= startUid && uid <= mailboxLastUid)
        .sort((left, right) => left - right)
        .slice(0, maxMessages);
      const messages: SyncedMessage[] = [];
      if (!candidateUids.length) return { uidValidity, lastUid, messages, resetRequired };
      for await (const item of client.fetch(
        candidateUids.join(","),
        { uid: true, source: { start: 0, maxLength: 512_000 } },
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
      }
      return { uidValidity, lastUid, messages, resetRequired };
    } finally {
      lock.release();
    }
  } finally {
    clearTimeout(operationDeadline);
    client.close();
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
