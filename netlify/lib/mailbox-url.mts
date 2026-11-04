/** Gmail IMAP returns X-GM-THRID as a decimal uint64; Gmail URLs use hex. */
export function gmailConversationUrl(accountEmail:string,threadId:string|null,messageId:string|null):string|null {
 if(!accountEmail)return null;
 const url=new URL("https://mail.google.com/mail/u/");
 url.searchParams.set("authuser",accountEmail);
 if(threadId&&/^\d{1,20}$/.test(threadId)){
  const id=BigInt(threadId);
  if(id>0n&&id<=0xffffffffffffffffn){
   url.hash=`all/${id.toString(16)}`;
   return url.href;
  }
 }
 const rfcId=messageId?.trim().replace(/^<([^<>]+)>$/,"$1");
 if(rfcId&&/^[^\s<>]+@[^\s<>]+$/.test(rfcId)){
  url.hash=`search/${encodeURIComponent(`in:anywhere rfc822msgid:${rfcId}`)}`;
  return url.href;
 }
 return null;
}
