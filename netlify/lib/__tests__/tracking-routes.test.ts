import {describe,expect,it,vi,beforeEach} from "vitest";
vi.mock("../tracking.mts",async importOriginal=>{
 const actual=await importOriginal<typeof import("../tracking.mts")>();
 return {...actual,verifyTrackingToken:vi.fn(async(token:string)=>actual.decodeTrackingToken(token,Buffer.alloc(32,7))),recordInteraction:vi.fn(async()=>true)};
});
import {encodeTrackingToken,recordInteraction} from "../tracking.mts";
import click from "../../functions/track-click.mts";
import open from "../../functions/track-open.mts";

beforeEach(()=>vi.clearAllMocks());
describe.each(["https://prospection-95.netlify.app","https://95.denizdong.fr"])("signed tracking endpoints on %s",origin=>{
 it.each([
  ["https://example.com/article","https://example.com/article"],
  ["https://vincentdenizdong.substack.com/p/comment-choisit-on-ses-amis","https://vincentdenizot.substack.com/p/comment-choisit-on-ses-amis"]
 ])("accepts an existing signed click token for %s regardless of host",async(destination,expected)=>{
  const token=encodeTrackingToken({v:1,k:"click",m:"9bb96dd7-e172-4d9b-93bf-fcab54fa4370",e:Math.floor(Date.now()/1000)+60,u:destination},Buffer.alloc(32,7));
  const response=await click(new Request(`${origin}/t/c/${token}`),{params:{token}} as never);
  expect(response.status).toBe(302);expect(response.headers.get("location")).toBe(expected);
  expect(recordInteraction).toHaveBeenCalledOnce();expect(response.headers.get("cache-control")).toContain("no-store");
 });
 it("serves the same GIF and records a valid signed opening",async()=>{
  const token=encodeTrackingToken({v:1,k:"open",m:"9bb96dd7-e172-4d9b-93bf-fcab54fa4370",e:Math.floor(Date.now()/1000)+60},Buffer.alloc(32,7));
  const response=await open(new Request(`${origin}/t/o/${token}`),{params:{token}} as never);
  expect(response.status).toBe(200);expect(response.headers.get("content-type")).toBe("image/gif");
  expect(new TextDecoder().decode((await response.arrayBuffer()).slice(0,6))).toBe("GIF89a");
  expect(recordInteraction).toHaveBeenCalledOnce();
 });
});
