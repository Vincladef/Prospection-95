import {expect,it} from "vitest";
import {bobworkHistory} from "../bobwork-history.mts";
it("keeps real zero values, sorts observations and exposes no raw account data",()=>{
 expect(bobworkHistory([
  {at:"2026-11-05T06:00:00Z",metrics:{email:"private@example.test",signature:"private",spam_rate_7d_pct:"0",last_7_days:{sent:12,errors:0}}},
  {at:"2026-11-04T06:00:00Z",metrics:{spam_rate_7d_pct:20.5,last_7_days:{sent:"15",errors:"2"}}}
 ])).toEqual([
  {at:"2026-11-04T06:00:00.000Z",spamRate7d:20.5,sent7d:15,errors7d:2},
  {at:"2026-11-05T06:00:00.000Z",spamRate7d:0,sent7d:12,errors7d:0}
 ]);
});
it("preserves missing or invalid metrics as unknown rather than zero",()=>{
 expect(bobworkHistory([{at:"2026-11-05",metrics:{spam_rate_7d_pct:101,last_7_days:{sent:false,errors:-1}}}])[0]).toMatchObject({spamRate7d:null,sent7d:null,errors7d:null});
 expect(bobworkHistory([{at:null},{at:"invalid"}])).toEqual([]);expect(bobworkHistory(null)).toEqual([]);
});
