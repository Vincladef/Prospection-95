import { beforeEach, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({sqlOne:vi.fn(),verify:vi.fn(),record:vi.fn()}));
vi.mock("../db.mts",()=>({sqlOne:mocks.sqlOne}));
vi.mock("../env.mts",()=>({env:()=>"private-test-edge-key"}));
vi.mock("../tracking.mts",()=>({verifyTrackingToken:mocks.verify,recordInteraction:mocks.record}));
import handler from "../../functions/reading-session.mts";
const run=(body:object,key="private-test-edge-key")=>handler(new Request("https://example.test/internal/reading-session",{
 method:"POST",headers:{"x-reading-key":key,"content-type":"application/json"},body:JSON.stringify(body),
}));
beforeEach(()=>vi.resetAllMocks());
it("rejects unauthenticated and malformed secrets before any database or signing-key access",async()=>{
 for(const key of ["","wrong","é".repeat(21)])expect((await run({action:"start",token:"x"},key)).status).toBe(404);
 expect(mocks.sqlOne).not.toHaveBeenCalled();expect(mocks.verify).not.toHaveBeenCalled();
});
it("validates the original signed open token before reserving a measurement",async()=>{
 mocks.verify.mockResolvedValue(null);
 expect(await (await run({action:"start",token:"invalid"})).json()).toEqual({stream:false});
 expect(mocks.sqlOne).not.toHaveBeenCalled();expect(mocks.record).not.toHaveBeenCalled();
});
it("records the ordinary open and reserves a server-gated session without trusting client duration",async()=>{
 const payload={v:1,k:"open",m:"9bb96dd7-e172-4d9b-93bf-fcab54fa4370",e:2_000_000_000};
 mocks.verify.mockResolvedValue(payload);mocks.sqlOne.mockResolvedValue({result:{stream:true,id:"session"}});
 expect(await (await run({action:"start",token:"signed",userAgent:"Mozilla Thunderbird/128.0",elapsedMs:40000})).json()).toEqual({stream:true,id:"session"});
 expect(mocks.record).toHaveBeenCalledExactlyOnceWith({token:"signed",payload,userAgent:"Mozilla Thunderbird/128.0"});
 expect(mocks.sqlOne.mock.calls[0][1]).toEqual([payload.m,"thunderbird"]);
});
it("accepts only bounded results from our edge, with SQL providing idempotency",async()=>{
 const id="9bb96dd7-e172-4d9b-93bf-fcab54fa4370";
 for(const elapsedMs of [-1,50001,NaN,7.4])expect((await run({action:"finish",id,end:"disconnected",elapsedMs})).status).toBe(400);
 mocks.sqlOne.mockResolvedValue({recorded:true});
 expect(await (await run({action:"finish",id,end:"disconnected",elapsedMs:7400})).json()).toEqual({recorded:true});
 expect(mocks.sqlOne).toHaveBeenCalledExactlyOnceWith("select app.finish_reading_session($1::uuid,$2,$3::integer) as recorded",[id,"disconnected",7400]);
});
