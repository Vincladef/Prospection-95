import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { readCredential } from "./credentials.mts";
import { isProductionOutboundEnabled } from "./auth.mts";
import { HttpError } from "./http.mts";

export interface GmailConnection {
  email: string;
  credentialId: string;
}

export interface GmailVerificationResult {
  smtp: boolean;
  imap: boolean;
  checkedAt: string;
  errorCode?: string;
}

export interface GmailDiagnosticResult {
  state: "accepted" | "failed" | "uncertain";
  checkedAt: string;
  messageId?: string;
  response?: string;
  errorCode?: string;
}

async function appPassword(connection: GmailConnection): Promise<string> {
  const credential = await readCredential(connection.credentialId);
  if (!["gmail_sender", "gmail_primary", "test_inbox"].includes(credential.kind)) {
    throw new HttpError(409, "wrong_credential_kind", "L’identifiant n’est pas un compte Gmail.");
  }
  return credential.secret.replace(/\s+/g, "");
}

function smtpTransport(email: string, password: string) {
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: email, pass: password },
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 15_000,
  });
}

export async function verifyGmail(connection: GmailConnection): Promise<GmailVerificationResult> {
  const password = await appPassword(connection);
  let smtp = false;
  let imap = false;
  let smtpError: string | undefined;
  if (isProductionOutboundEnabled()) {
    try {
      const transport = smtpTransport(connection.email, password);
      await transport.verify();
      smtp = true;
      transport.close();
    } catch (error) {
      smtpError = gmailErrorCode(error);
    }
  } else {
    smtpError = "outbound_disabled";
  }
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: connection.email, pass: password },
    logger: false,
    socketTimeout: 25_000,
  });
  try {
    await client.connect();
    imap = true;
  } catch (error) {
    return { smtp, imap: false, checkedAt: new Date().toISOString(), errorCode: gmailErrorCode(error) };
  } finally {
    if (client.usable) await client.logout().catch(() => undefined);
  }
  return { smtp, imap, checkedAt: new Date().toISOString(), errorCode: smtpError };
}

export interface OutboundEmail {
  fromEmail: string;
  credentialEmail?: string;
  fromName?: string | null;
  credentialId: string;
  recipient: string;
  subject: string;
  text: string;
  html?: string | null;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
}

export type SmtpResult =
  | { state: "accepted"; response: string; messageId: string; accepted: string[]; rejected: string[] }
  | { state: "failed"; code: string; retryable: boolean }
  | { state: "uncertain"; code: string };

export async function sendGmailMessage(message: OutboundEmail): Promise<SmtpResult> {
  if (!isProductionOutboundEnabled()) {
    throw new HttpError(423, "outbound_disabled", "Les envois sont désactivés côté serveur.");
  }
  const password = await appPassword({ email: message.fromEmail, credentialId: message.credentialId });
  const transport = smtpTransport(message.fromEmail, password);
  try {
    const result = await transport.sendMail({
      from: message.fromName
        ? { name: message.fromName, address: message.fromEmail }
        : message.fromEmail,
      to: message.recipient,
      subject: message.subject,
      text: message.text,
      html: message.html ?? undefined,
      messageId: message.messageId,
      inReplyTo: message.inReplyTo ?? undefined,
      references: message.references?.length ? message.references : undefined,
      date: new Date(),
      headers: {
        "X-Prospection95-Message-ID": message.messageId,
      },
    });
    const accepted = result.accepted.map(String);
    const rejected = result.rejected.map(String);
    if (accepted.length) {
      return {
        state: "accepted",
        response: result.response,
        messageId: result.messageId,
        accepted,
        rejected,
      };
    }
    return { state: "failed", code: "smtp_rejected", retryable: false };
  } catch (error) {
    const code = gmailErrorCode(error);
    if (isAmbiguousSmtpFailure(error)) return { state: "uncertain", code };
    return { state: "failed", code, retryable: isRetryableSmtpFailure(error) };
  } finally {
    transport.close();
  }
}

/**
 * Sends one explicit diagnostic message requested by the authenticated owner.
 * This deliberately does not consult OUTBOUND_ENABLED: that flag continues to
 * guard campaign jobs, while this isolated path is only exposed by the private
 * test-send API route and never creates an outbox job.
 */
export async function sendGmailDiagnostic(input: {
  email: string;
  credentialId: string;
  recipient: string;
}): Promise<GmailDiagnosticResult> {
  const checkedAt = new Date().toISOString();
  const password = await appPassword({ email: input.email, credentialId: input.credentialId });
  const transport = smtpTransport(input.email, password);
  try {
    const result = await transport.sendMail({
      from: { name: "Prospection 95", address: input.email },
      to: input.recipient,
      subject: "Test d’envoi Prospection 95",
      text: [
        "Ceci est un email de diagnostic envoyé manuellement depuis Prospection 95.",
        "",
        `Compte expéditeur : ${input.email}`,
        `Date du test : ${checkedAt}`,
        "",
        "Aucune campagne ni aucune relance n’a été déclenchée.",
      ].join("\n"),
      headers: { "X-Prospection95-Diagnostic": "manual-test" },
    });
    const accepted = result.accepted.map(String);
    if (accepted.length) {
      return {
        state: "accepted",
        checkedAt,
        messageId: result.messageId,
        response: result.response,
      };
    }
    return { state: "failed", checkedAt, errorCode: "smtp_rejected" };
  } catch (error) {
    const errorCode = gmailErrorCode(error);
    return {
      state: isAmbiguousSmtpFailure(error) ? "uncertain" : "failed",
      checkedAt,
      errorCode,
    };
  } finally {
    transport.close();
  }
}

export async function createGmailDraft(input: OutboundEmail & { mailbox?: string }): Promise<{
  uid?: number;
  mailbox: string;
  threadingVerified: false;
}> {
  const credentialEmail = input.credentialEmail ?? input.fromEmail;
  const password = await appPassword({ email: credentialEmail, credentialId: input.credentialId });
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  const compiled = await transport.sendMail({
    from: input.fromName ? { name: input.fromName, address: input.fromEmail } : input.fromEmail,
    to: input.recipient,
    subject: input.subject,
    text: input.text,
    html: input.html ?? undefined,
    messageId: input.messageId,
    inReplyTo: input.inReplyTo ?? undefined,
    references: input.references?.length ? input.references : undefined,
    date: new Date(),
    headers: { "X-Prospection95-Draft": input.messageId },
  });
  const raw = compiled.message as Buffer;
  const mailbox = input.mailbox ?? "[Gmail]/Drafts";
  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: credentialEmail, pass: password },
    logger: false,
    socketTimeout: 25_000,
  });
  try {
    await client.connect();
    const result = await client.append(mailbox, raw, ["\\Draft"]);
    return { uid: result ? Number(result.uid) : undefined, mailbox, threadingVerified: false };
  } finally {
    if (client.usable) await client.logout().catch(() => undefined);
  }
}

function gmailErrorCode(error: unknown): string {
  const candidate = error as { code?: unknown; responseCode?: unknown };
  if (candidate.responseCode === 535) return "gmail_auth_failed";
  if (candidate.responseCode === 534) return "gmail_app_password_required";
  if (typeof candidate.code === "string") return candidate.code.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  return "gmail_connection_failed";
}

function isAmbiguousSmtpFailure(error: unknown): boolean {
  const code = String((error as { code?: unknown }).code ?? "").toUpperCase();
  const command = String((error as { command?: unknown }).command ?? "").toUpperCase();
  return ["ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(code) && ["DATA", "DOT", ""].includes(command);
}

function isRetryableSmtpFailure(error: unknown): boolean {
  const responseCode = Number((error as { responseCode?: unknown }).responseCode ?? 0);
  const code = String((error as { code?: unknown }).code ?? "").toUpperCase();
  return (responseCode >= 400 && responseCode < 500) || ["ECONNREFUSED", "ENETUNREACH"].includes(code);
}
