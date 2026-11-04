import {describe,expect,it} from "vitest";
import {gmailConversationUrl} from "../mailbox-url.mts";

describe("Gmail conversation links",()=>{
 it("selects the associated account and converts the full IMAP thread ID without rounding",()=>{
  const link=new URL(gmailConversationUrl("sender+prospection@example.test","1234567890123456789",null)!);
  expect(link.origin).toBe("https://mail.google.com");
  expect(link.searchParams.get("authuser")).toBe("sender+prospection@example.test");
  expect(link.hash).toBe("#all/112210f47de98115");
 });
 it("preserves the largest Gmail uint64 identifier",()=>{
  expect(gmailConversationUrl("sender@example.test","18446744073709551615",null)).toContain("#all/ffffffffffffffff");
 });
 it("finds the specific RFC message across Gmail folders when no thread ID is available",()=>{
  const link=new URL(gmailConversationUrl("other@example.test",null,"<reply+123@example.test>")!);
  expect(link.searchParams.get("authuser")).toBe("other@example.test");
  expect(decodeURIComponent(link.hash)).toBe("#search/in:anywhere rfc822msgid:reply+123@example.test");
 });
 it.each(["0","18446744073709551616","not-a-thread","123/https://example.test"])("uses message search for an invalid thread ID %s",thread=>{
  expect(gmailConversationUrl("sender@example.test",thread,"<reply@example.test>")).toContain("#search/");
 });
 it.each([null,"", "<bad id@example.test>","<id@example.test> from:other@example.test"])("does not invent a destination without a usable message or thread identity",message=>{
  expect(gmailConversationUrl("sender@example.test",null,message)).toBeNull();
 });
});
