import { expect,it } from "vitest";
import { simpleParser } from "mailparser";
import { readableMailText } from "../mail-content.mts";
it("keeps a nonempty plain part authoritative",async()=>{
 expect(await readableMailText({text:"Texte exact\n",html:"<p>Autre contenu</p>"})).toBe("Texte exact\n");
});
it("recovers a multipart reply with an empty plain part from its HTML",async()=>{
 const mime=['MIME-Version: 1.0','Content-Type: multipart/alternative; boundary="fixture"','','--fixture','Content-Type: text/plain; charset=utf-8','','','--fixture','Content-Type: text/html; charset=utf-8','','<html><head><style>secret-style</style></head><body><p>Bonjour,</p><p>Votre proposition nous intéresse &amp; nous aimons 万晓利.</p><a href="https://example.test/article">Article</a><script>secret-script</script></body></html>','--fixture--'].join('\r\n');
 const text=await readableMailText(await simpleParser(mime,{skipImageLinks:true}));
 expect(text).toContain('Votre proposition nous intéresse & nous aimons 万晓利.');expect(text).toContain('https://example.test/article');expect(text).not.toMatch(/secret-style|secret-script|<p>/);
});
it("also recovers whitespace-only text and leaves genuinely empty messages empty",async()=>{
 expect(await readableMailText({text:" \n",html:"<p>Merci pour votre message.</p>"})).toContain("Merci pour votre message.");
 expect(await readableMailText({text:"",html:null})).toBe("");
});
