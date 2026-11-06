import { simpleParser } from "mailparser";
import type { SearchObject } from "imapflow";
import { draftHash, withMailboxClient } from "./mailbox-gmail.mts";
import { readableMailText } from "./mail-content.mts";

export interface DraftEvidence {
  sent: boolean; draftUid: number | null; draftMailbox: string;
  unsentOwnCopy: boolean; labels: string[];
}

/** Inspect folder membership; From=self and a message Date are never delivery evidence. */
export async function inspectDraftEvidence(input: {
  email: string; credentialId: string; messageId: string; sourceId: string;
  recipient: string; body: string;
}): Promise<DraftEvidence> {
  return withMailboxClient(input.email, input.credentialId, async client => {
    const boxes = await client.list();
    const sent = boxes.find(box => box.specialUse === "\\Sent");
    const drafts = boxes.find(box => box.specialUse === "\\Drafts");
    const all = boxes.find(box => box.specialUse === "\\All");
    if (!sent || !drafts || !all) throw new Error("draft_evidence_mailboxes_missing");
    const result: DraftEvidence = { sent: false, draftUid: null, draftMailbox: drafts.path, unsentOwnCopy: false, labels: [] };
    const identity: SearchObject = { or: [{ header: { "Message-ID": input.messageId } }, { header: { "X-Prospection95-Draft": input.messageId } }] };
    for (const box of [sent, drafts, all]) {
      const lock = await client.getMailboxLock(box.path, { readOnly: true });
      try {
        // Gmail can rewrite a draft's Message-ID while preserving its reply parent.
        const query: SearchObject = { or: [...identity.or!, { header: { "In-Reply-To": input.sourceId }, to: input.recipient }], deleted: false };
        const ids = await client.search(query, { uid: true });
        if (!Array.isArray(ids)) throw new Error("draft_evidence_search_unconfirmed");
        if (ids.length > 20) throw new Error("draft_evidence_search_too_large");
        for (const id of ids.slice(0, 20)) {
          const message = await client.fetchOne(String(id), { flags: true, labels: true, source: true }, { uid: true });
          if (!message || !message.labels || !message.flags || !message.source) throw new Error("draft_evidence_fetch_incomplete");
          const isDraft = [...message.flags, ...message.labels].some(label => /^\\drafts?$/i.test(label));
          if (message.labels.has("\\Sent") && !isDraft) { result.sent = true; return result; }
          if (box === sent) continue;
          if (box === drafts) result.draftUid = id;
          const parsed = await simpleParser(message.source, { skipImageLinks: true });
          if (parsed.messageId === input.messageId && draftHash(await readableMailText(parsed)) === draftHash(input.body)) {
            result.unsentOwnCopy = true;
            result.labels = [...message.labels];
          }
        }
      } finally { lock.release(); }
    }
    return result;
  });
}
