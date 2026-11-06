import { lookup } from "node:dns/promises";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { readableMailText } from "./mail-content.mts";
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
  isPermanentBounce: boolean;
  gmailThreadId?: string | null;
  draftRequestId?: string | null;
  prospectionMessageId?: string | null;
  sent?: boolean;
  gmailMessageId?: string | null;
  unread?: boolean;
  archived?: boolean;
  warmup?: boolean;
  listId?: string | null;
}

export interface MailboxDelta {
  uidValidity: string;
  lastUid: number;
  messages: SyncedMessage[];
  resetRequired: boolean;
  hasMore: boolean;
}

export function isPermanentBounceDiagnostic(isBounce: boolean, subject: string, text: string): boolean {
  if (!isBounce) return false;
  const diagnostic = `${subject}\n${text}`;
  return (
    /(?:^|\n)\s*status\s*:\s*5\.\d{1,3}\.\d{1,3}\b/im.test(diagnostic) ||
    /\b5\d\d[ -]+5\.\d{1,3}\.\d{1,3}\b/i.test(diagnostic)
  );
}

async function mailboxPath(client: ImapFlow, requested: string): Promise<string> {
  if (requested === "__LIVE_ALL__" || requested === "__UNIFIED_ALL__") {
    const mailboxes = await client.list();
    const all = mailboxes.find((mailbox) => mailbox.specialUse === "\\All");
    if (!all) throw new Error("gmail_all_mailbox_not_found");
    return all.path;
  }
  if (requested !== "__SENT__" && requested !== "__LIVE_SENT__") return requested;
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
  bootstrapSince?: Date;
  correspondent?: string;
  identifiers?: string[];
  threadId?: string;
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
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  // This worker runs in the background because Gmail can spend more than ten
  // seconds establishing TLS. Keep our own ceiling well below Netlify's
  // background-function limit so a stalled IMAP command still releases its claim.
  const operationDeadline = setTimeout(() => client.close(), 45_000);
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
      return { uidValidity, lastUid, messages: [], resetRequired, hasMore: false };
    }

    const lock = await client.getMailboxLock(selectedMailbox, { readOnly: true });
    try {
      if (!client.mailbox) throw new Error("IMAP mailbox was not selected");
      // Gmail interprets an open range whose start is already past the last UID
      // as a reversed range. Besides re-reading the last message, that query can
      // take longer than Netlify's scheduled-function request window. UIDNEXT is
      // part of the mailbox STATUS, so an empty delta can be returned
      // immediately and non-empty searches can be bounded to a real UID.
      const found = await client.search({ draft: false, deleted: false,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.correspondent ? { or: [{ from: input.correspondent }, { to: input.correspondent },
          ...(input.identifiers ?? []).flatMap(id => ["In-Reply-To","References"].map(key => ({ header: { [key]: id } })))] } : {}),
        uid: `${startUid}:${mailboxLastUid}`,
        ...(input.bootstrapSince && (resetRequired || !input.cursor.lastUid) ? { since: input.bootstrapSince } : {}),
      }, { uid: true });
      if (!Array.isArray(found)) throw new Error("imap_search_unconfirmed");
      const eligibleUids = found
        .filter((uid) => uid >= startUid && uid <= mailboxLastUid)
        .sort((left, right) => left - right);
      const candidateUids = eligibleUids.slice(0, maxMessages);
      const messages: SyncedMessage[] = [];
      const fetchedUids = new Set<number>();
      if (!candidateUids.length) return { uidValidity, lastUid: mailboxLastUid, messages, resetRequired, hasMore: false };
      for await (const item of client.fetch(
        candidateUids.join(","),
        { uid: true, flags: true, labels: true, emailId: true, threadId: true, internalDate: true, source: { start: 0, maxLength: 512_000 } },
        { uid: true },
      )) {
        if (item.uid < startUid) continue;
        // A missing source must not silently advance a cursor past an unread mail.
        if (!item.source) throw new Error("imap_message_source_missing");
        fetchedUids.add(item.uid);
        if (item.flags?.has("\\Draft") || item.flags?.has("\\Deleted")) {
          lastUid = Math.max(lastUid,item.uid);
          continue;
        }
        const parsed = await simpleParser(item.source, { skipImageLinks: true });
        const text = await readableMailText(parsed);
        const headers = parsed.headers;
        const references = Array.isArray(parsed.references)
          ? parsed.references
          : parsed.references
            ? [parsed.references]
            : [];
        const isBounce =
          /mailer-daemon|postmaster/i.test(parsed.from?.text ?? "") ||
          /delivery status notification|undeliverable|mail delivery subsystem/i.test(parsed.subject ?? "");
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
          text,
          html: typeof parsed.html === "string" ? parsed.html : null,
          date: parsed.date?.toISOString() ?? (item.internalDate ? new Date(item.internalDate).toISOString() : null),
          gmailThreadId: item.threadId ?? null,
          gmailMessageId: item.emailId ?? null,
          unread: !(item.flags?.has("\\Seen") ?? true),
          archived: item.labels ? !item.labels.has("\\Inbox") : input.cursor.mailbox !== "INBOX",
          warmup: [...headers.keys()].some(key => /^(?:x-.*(?:warmup|warm-up|bobwork)|x-warmup)/i.test(key)),
          listId: headers.get("list-id")?.toString() ?? null,
          draftRequestId: headers.get("x-prospection95-draft")?.toString().match(/draft-([0-9a-f-]{36})@/i)?.[1] ?? null,
          prospectionMessageId: headers.get("x-prospection95-message-id")?.toString() ?? null,
          sent: item.labels?.has("\\Sent") ?? false,
          autoSubmitted: headers.get("auto-submitted")?.toString() ?? null,
          precedence: headers.get("precedence")?.toString() ?? null,
          isBounce,
          // RFC 3463: la classe 5.x.x est un échec permanent. Les classes 4.x.x
          // restent temporaires et ne doivent pas interrompre les relances.
          isPermanentBounce: isPermanentBounceDiagnostic(
            isBounce,
            parsed.subject ?? "",
            text,
          ),
        });
        lastUid = Math.max(lastUid, item.uid);
      }
      // Every selected UID must have been read before committing the batch cursor.
      if (candidateUids.some(uid => !fetchedUids.has(uid))) {
        throw new Error("imap_batch_incomplete");
      }
      messages.sort((a,b) => a.uid-b.uid);
      const hasMore = eligibleUids.length > candidateUids.length;
      return { uidValidity, lastUid: hasMore ? lastUid : mailboxLastUid, messages, resetRequired, hasMore };
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
    /^(?:bulk|list|junk)$/i.test(message.precedence ?? "") || message.warmup || message.listId
  ) return "automatic_reply";
  return "human_or_unknown";
}
