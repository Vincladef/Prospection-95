import { afterEach, beforeEach, expect, it, vi } from "vitest";
import handler from "../../edge-functions/track-reading";
const fetchMock=vi.fn();
beforeEach(()=>{
 vi.stubGlobal("Netlify",{env:{get:()=>"private-test-key"}});vi.stubGlobal("fetch",fetchMock);fetchMock.mockReset();
});
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
const request=(signal?:AbortSignal)=>new Request("https://example.test/t/r/signed",{signal,headers:{"user-agent":"Thunderbird/128.0"}});
it("uses one short start and one short finish, and keeps the session and secret out of the image",async()=>{
 vi.useFakeTimers();
 fetchMock.mockResolvedValueOnce(Response.json({stream:true,id:"private-session"})).mockResolvedValueOnce(Response.json({recorded:true}));
 const ac=new AbortController(),waitUntil=vi.fn();
 const response=await handler(request(ac.signal),{params:{token:"signed"},waitUntil});
 const reader=response.body!.getReader();expect((await reader.read()).value!.length).toBeLessThan(50);
 await vi.advanceTimersByTimeAsync(7400);ac.abort();await Promise.all(waitUntil.mock.calls.map(c=>c[0]));
 expect(fetchMock).toHaveBeenCalledTimes(2);
 expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({action:"finish",id:"private-session",end:"disconnected",elapsedMs:7400});
 expect([...response.headers.values()].join(" ")).not.toMatch(/private-session|private-test-key/);
 expect(response.headers.get("cache-control")).toContain("no-store");
});
it.each(["excluded","unavailable"])("falls back to a small image when %s without a long stream",async(mode)=>{
 if(mode==="excluded")fetchMock.mockResolvedValue(Response.json({stream:false,reason:"proxy"}));
 else fetchMock.mockRejectedValue(new Error("backend unavailable"));
 const waitUntil=vi.fn(),response=await handler(request(),{params:{token:"signed"},waitUntil});
 expect((await response.arrayBuffer()).byteLength).toBeLessThan(50);expect(waitUntil).not.toHaveBeenCalled();
 expect(fetchMock).toHaveBeenCalledOnce();
});
