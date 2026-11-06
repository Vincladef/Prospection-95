import { simpleParser } from "mailparser";

/** Some multipart mails declare an empty plain part alongside the actual HTML reply. */
export async function readableMailText(message: { text?: string; html?: string | false | null }): Promise<string> {
  if (message.text?.trim()) return message.text;
  if (typeof message.html !== "string" || !message.html.trim()) return message.text ?? "";
  // Reuse the MIME parser's HTML conversion: entities, Unicode and links are preserved,
  // scripts/styles are excluded, and no external URL or image is fetched.
  const converted = await simpleParser(Buffer.from(`MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${message.html}`, "utf8"), { skipImageLinks: true });
  return converted.text ?? message.text ?? "";
}
