import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeTrackingToken, encodeTrackingToken, prepareTrackedMessage, trackingBaseUrl, type TrackingTokenPayload } from "../tracking.mts";

const key = Buffer.alloc(32, 7);
const messageId = "9bb96dd7-e172-4d9b-93bf-fcab54fa4370";
const nowSeconds = 1_800_000_000;
afterEach(()=>vi.unstubAllEnvs());

describe("tracking domain configuration",()=>{
 it.each([false,true])("uses the dedicated domain for clicks and opens (reading duration: %s) without changing existing tokens or message text",async readingTimeEnabled=>{
  vi.stubEnv("TRACKING_BASE_URL"," https://95.denizdong.fr/ ");
  vi.stubEnv("URL","https://prospection-95.netlify.app");
  const original={messageId,text:"https://example.com/article",html:'<p><a href="https://example.com/article">Article</a></p>',opensEnabled:true,clicksEnabled:true,readingTimeEnabled,now:new Date(nowSeconds*1000),signer:async(p:TrackingTokenPayload)=>encodeTrackingToken(p,key)};
  const old=await prepareTrackedMessage({...original,baseUrl:"https://prospection-95.netlify.app"});
  const next=await prepareTrackedMessage({...original,baseUrl:trackingBaseUrl()});
  expect(next.text).toBe(original.text);
  expect(next.html).toBe(old.html?.replaceAll("https://prospection-95.netlify.app","https://95.denizdong.fr"));
  expect(next.html).toContain('href="https://95.denizdong.fr/t/c/');
  expect(next.html).toContain(`src="https://95.denizdong.fr/t/${readingTimeEnabled?"r":"o"}/`);
  expect(old.html).toContain("https://prospection-95.netlify.app/t/c/");
 });
 it("defaults to the dedicated domain independently of the interface and deploy URLs",()=>{
  vi.stubEnv("TRACKING_BASE_URL","");vi.stubEnv("URL","https://prospection-95.netlify.app/");
  vi.stubEnv("DEPLOY_PRIME_URL","https://preview.example.test");
  expect(trackingBaseUrl()).toBe("https://95.denizdong.fr");
  vi.stubEnv("URL",undefined);expect(trackingBaseUrl()).toBe("https://95.denizdong.fr");
  vi.stubEnv("DEPLOY_PRIME_URL",undefined);expect(trackingBaseUrl()).toBe("https://95.denizdong.fr");
 });
 it("allows an explicit origin override without changing the application origin",()=>{
  vi.stubEnv("APP_BASE_URL","https://prospection-95.netlify.app");
  vi.stubEnv("TRACKING_BASE_URL","https://tracking.example.test/");
  expect(trackingBaseUrl()).toBe("https://tracking.example.test");
  expect(process.env.APP_BASE_URL).toBe("https://prospection-95.netlify.app");
 });
 it.each(["http://95.denizdong.fr","https://95.denizdong.fr/path","https://95.denizdong.fr?x=1","https://95.denizdong.fr#x","https://user:password@95.denizdong.fr","not a url"])("rejects an invalid dedicated tracking origin: %s",value=>{
  vi.stubEnv("TRACKING_BASE_URL",value);expect(()=>trackingBaseUrl()).toThrow();
 });
});

describe("signed interaction tracking", () => {
  it("rejects tampering and expiration", () => {
    const payload: TrackingTokenPayload = { v: 1, k: "click", m: messageId, e: nowSeconds + 60, u: "https://example.com/article" };
    const token = encodeTrackingToken(payload, key);
    expect(decodeTrackingToken(token, key, nowSeconds)).toEqual(payload);
    expect(decodeTrackingToken(`${token.slice(0, -1)}x`, key, nowSeconds)).toBeNull();
    expect(decodeTrackingToken(token, key, nowSeconds + 61)).toBeNull();
  });

  it("keeps the text alternative and adds signed click and open URLs", async () => {
    const payloads: TrackingTokenPayload[] = [];
    const prepared = await prepareTrackedMessage({
      messageId,
      text: "Bonjour\nhttps://example.com/article.",
      html: null,
      opensEnabled: true,
      clicksEnabled: true,
      baseUrl: "https://prospection-95.netlify.app/",
      now: new Date(nowSeconds * 1_000),
      signer: async (payload) => {
        payloads.push(payload);
        return encodeTrackingToken(payload, key);
      },
    });
    expect(prepared.text).toContain("https://example.com/article.");
    expect(prepared.html).toContain('href="https://prospection-95.netlify.app/t/c/');
    expect(prepared.html).toContain('src="https://prospection-95.netlify.app/t/o/');
    expect(payloads.map((payload) => payload.k)).toEqual(["click", "open"]);
    expect(payloads[0].u).toBe("https://example.com/article");
  });
});

it("uses exactly one image and leaves the text and disabled tracking untouched",async()=>{
 const input={messageId,text:"Bonjour\nhttps://example.com/article",html:null,opensEnabled:true,clicksEnabled:true,baseUrl:"https://prospection-95.netlify.app",now:new Date(nowSeconds*1000),signer:async(p:TrackingTokenPayload)=>encodeTrackingToken(p,key)};
 const result=await prepareTrackedMessage(input);
 expect(result.text).toBe(input.text);
 expect(result.html?.match(/<img\b/g)).toHaveLength(1);
 expect(result.html).not.toMatch(/<script|iframe|setInterval|javascript:/i);
 expect(await prepareTrackedMessage({...input,opensEnabled:false,clicksEnabled:false})).toEqual({text:input.text,html:null});
});

it("reuses the single signed pixel for connection timing and never enables opens implicitly",async()=>{
 const input={messageId,text:"Bonjour",html:null,opensEnabled:true,clicksEnabled:false,readingTimeEnabled:true,baseUrl:"https://example.test",now:new Date(nowSeconds*1000),signer:async(p:TrackingTokenPayload)=>encodeTrackingToken(p,key)};
 const result=await prepareTrackedMessage(input);
 expect(result.html?.match(/<img\b/g)).toHaveLength(1);
 expect(result.html).toContain("https://example.test/t/r/");
 expect(result.html).not.toContain("/t/o/");
 expect(result.text).toBe(input.text);
 expect(await prepareTrackedMessage({...input,opensEnabled:false})).toEqual({text:input.text,html:null});
});
