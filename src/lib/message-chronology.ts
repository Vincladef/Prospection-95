import type {Prospect} from "../types";

/** History contains confirmed outbound messages, including manual replies
 * that do not advance the J0–R5 sequence. */
export function lastOutboundAt(prospect:Prospect):string|null {
 const dates=[prospect.lastOutboundAt,prospect.lastSentAt,...(prospect.conversationMessages??[])
  .filter(message=>message.direction==="outbound").map(message=>message.at)]
  .filter((at):at is string=>!!at&&Number.isFinite(Date.parse(at)));
 return dates.sort((a,b)=>Date.parse(b)-Date.parse(a))[0]??null;
}
