import {beforeEach,describe,it,expect,vi} from "vitest";
const mocks=vi.hoisted(()=>({one:vi.fn(),query:vi.fn(),audit:vi.fn()}));
vi.mock("../db.mts",()=>({sqlOne:mocks.one,sqlQuery:mocks.query}));
vi.mock("../audit.mts",()=>({auditEvent:mocks.audit}));
import {listMailbox,mailboxDetail,mailboxMutation} from "../mailbox.mts";
const id="11111111-1111-4111-8111-111111111111";
const campaign="22222222-2222-4222-8222-222222222222";
const identity={subject:"fixture",email:"admin@example.test"};
const post=(body:unknown)=>new Request("https://example.test/api/mailbox",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
beforeEach(()=>{vi.resetAllMocks();mocks.query.mockResolvedValue([]);mocks.one.mockResolvedValue(null);});
describe("unified mailbox API",()=>{
 it("combines Gmail, campaign, folder and search in parameterised queries",async()=>{
  mocks.one.mockResolvedValue({total:0});
  await listMailbox(new Request(`https://example.test/api/mailbox?account=${id}&campaign=${campaign}&folder=waiting&q=O%27Reilly&page=2`));
  const [sql,params]=mocks.query.mock.calls[0];
  expect(params).toEqual([id,campaign,"O'Reilly","waiting","all",50]);
  expect(sql).not.toContain("O'Reilly");expect(sql).toContain("t.account_id=$1::uuid");expect(sql).toContain("c.campaign_id::text=$2");
  expect(sql).toContain("t.category='normal'");expect(sql).toContain("latest.direction='outbound'");
 });
 it("rejects malformed filters before querying the database",async()=>{
  await expect(listMailbox(new Request("https://example.test/api/mailbox?account=not-a-uuid"))).rejects.toMatchObject({status:400});
  expect(mocks.one).not.toHaveBeenCalled();expect(mocks.query).not.toHaveBeenCalled();
 });
 it("paginates full history with a message identity, including equal timestamps",async()=>{
  mocks.one.mockResolvedValueOnce({id});mocks.query.mockResolvedValue(Array.from({length:51},(_,n)=>({id:String(n)})));
  const result=await(await mailboxDetail(id,new Request(`https://example.test/api/mailbox/${id}?before=${campaign}`))).json();
  expect(result.hasOlder).toBe(true);expect(result.messages).toHaveLength(50);expect(result.messages[0].id).toBe("49");
  expect(mocks.query.mock.calls[0][1]).toEqual([id,campaign]);
  expect(mocks.query.mock.calls[0][0]).toContain("(at,id)<");
 });
 it("returns a Gmail link with the selected thread account and a full precision thread identifier",async()=>{
  mocks.one.mockResolvedValueOnce({id,accountEmail:"sender@example.test",gmailThreadId:"1234567890123456789",gmailInternetMessageId:"<reply@example.test>"});
  const result=await(await mailboxDetail(id,new Request(`https://example.test/api/mailbox/${id}`))).json();
  expect(result.thread.gmailUrl).toBe("https://mail.google.com/mail/u/?authuser=sender%40example.test#all/112210f47de98115");
  expect(mocks.one.mock.calls[0][0]).toContain("e.mailbox_account_id=t.account_id");
  expect(result.thread.gmailThreadId).toBeUndefined();
 });
 it("saves a draft and queues Gmail synchronization atomically",async()=>{
  mocks.one.mockResolvedValue({version:8});
  expect(await(await mailboxMutation(id,"draft",post({version:7,body:"Bonjour"}),identity,id)).json()).toEqual({version:8});
  expect(mocks.one).toHaveBeenCalledOnce();const [sql,params]=mocks.one.mock.calls[0];
  expect(params).toEqual([id,7,"Bonjour"]);expect(sql).toContain("where id=$1::uuid and draft_version=$2");expect(sql).toContain("from changed");
 });
 it("does not enqueue a Gmail action after a concurrent edit conflicts",async()=>{
  await expect(mailboxMutation(id,"state",post({version:7,archived:true}),identity,id)).rejects.toMatchObject({status:409});
  expect(mocks.one).toHaveBeenCalledOnce();expect(mocks.one.mock.calls[0][0]).toContain("from changed cross join");
  expect(mocks.audit).not.toHaveBeenCalled();
 });
 it("sends through the existing outbox with a stable key and never accepts a sender override",async()=>{
  mocks.one.mockResolvedValue({id,status:"pending"});
  const result=await mailboxMutation(id,"send",post({version:8,lastMessageId:campaign,key:id,from:"attacker@example.test"}),identity,id);
  expect(result.status).toBe(202);expect(mocks.one.mock.calls[0][1]).toEqual([id,8,campaign,id]);
  expect(mocks.one.mock.calls[0][0]).toContain("app.mailbox_queue_reply");
 });
});
