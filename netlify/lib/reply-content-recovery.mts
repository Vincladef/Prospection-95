import { sqlQuery } from "./db.mts";
import { readableMailText } from "./mail-content.mts";

/** Repair a bounded batch of historical replies without refetching Gmail or moving its cursors. */
export async function recoverReplyContent(): Promise<number> {
  const messages = await sqlQuery<{ id: string; body_html: string }>(`
    select m.id::text,m.body_html from app.email_messages m
    where m.direction='inbound' and m.kind='reply' and btrim(m.body_text)=''
      and length(m.body_html) between 1 and 512000
      and m.raw_headers->>'htmlTextRecoveryHash' is distinct from md5(m.body_html)
      and not exists(select 1 from app.inbound_analyses a where a.message_id=m.id)
      and not exists(select 1 from app.reply_workflows w where w.source_message_id=m.id)
    order by m.received_at,m.id limit 5`);
  let recovered = 0;
  for (const message of messages) {
    const text = await readableMailText({ html: message.body_html });
    const changed = await sqlQuery<{ id: string }>(`
      update app.email_messages m set body_text=$3,
        raw_headers=coalesce(m.raw_headers,'{}'::jsonb)||jsonb_build_object(
          'htmlTextRecoveryHash',md5(m.body_html),'textRecoveredFromHtml',$4::boolean)
      where m.id=$1::uuid and m.direction='inbound' and m.kind='reply'
        and btrim(m.body_text)='' and m.body_html=$2
        and not exists(select 1 from app.inbound_analyses a where a.message_id=m.id)
        and not exists(select 1 from app.reply_workflows w where w.source_message_id=m.id)
      returning id::text`, [message.id, message.body_html, text.trim() ? text : "", !!text.trim()]);
    if (text.trim() && changed.length) recovered++;
  }
  return recovered;
}
