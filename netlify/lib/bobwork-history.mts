function number(value:unknown,max=Infinity):number|null {
 if(typeof value!=="number"&&typeof value!=="string"||typeof value==="string"&&!value.trim())return null;
 const n=Number(value);return Number.isFinite(n)&&n>=0&&n<=max?n:null;
}

/** Expose only chart metrics, never mailbox identities or raw BobWork payloads. */
export function bobworkHistory(value:unknown) {
 if(!Array.isArray(value))return [];
 return value.flatMap(row=>{
  if(!row||typeof row!=="object")return [];
  if(typeof row.at!=="string"||!row.at.trim())return [];
  const date=new Date(row.at);if(!Number.isFinite(date.getTime()))return [];
  const metrics=row.metrics??{},week=metrics.last_7_days??{};
  const sources=[metrics,metrics.statistics??{},metrics.stats??{},metrics.metrics??{}];
  let spam:unknown=null;
  for(const source of sources){for(const key of ["spam_rate_7d_pct","spam_rate_7d","spamRate7d","seven_day_spam_rate","sevenDaySpamRate"]){if(source[key]!=null){spam=source[key];break;}}if(spam!=null)break;}
  return [{at:date.toISOString(),spamRate7d:number(spam,100),sent7d:number(week.sent),errors7d:number(week.errors)}];
 }).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
}
