import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prospect } from "../../../src/types";
import { loadDashboard } from "../dashboard.mts";

const mocks = vi.hoisted(() => ({ sqlQuery: vi.fn() }));
vi.mock("../db.mts", () => mocks);
vi.mock("../credentials.mts", () => ({ credentialVaultConfigured: async () => true }));

const sequence = (pass: string) => ({ subject: `Objet ${pass}`, steps: [0, 1, 2, 3, 4, 5].map((i) => `${pass} étape ${i}`) });
let rows: Record<string, unknown>[];
let messages: Record<string, unknown>[];
async function displayed() { return (await loadDashboard()).prospects as Prospect[]; }

it("includes sourcing progress in campaign statistics", async () => {
 mocks.sqlQuery.mockImplementation(async (sql:string) => {
   if (sql.includes("select c.*")) return [{id:"c1", name:"Test", daily_new_contact_goal:5}];
   if (sql.includes("coalesce(sourcing.new_contacts_today")) return [{campaign_id:"c1", new_contacts_today:"2", writing_in_progress:"1"}];
   return [];
 });
 const data = await loadDashboard() as {campaigns:Array<{stats:{newContactsToday:number;writingInProgress:number;sent:number}}>} ;
 expect(data.campaigns[0].stats).toMatchObject({newContactsToday:2,writingInProgress:1,sent:0});
});

it("exposes a historical scored assessment separately from the current decision and sanitizes BobWork history",async()=>{
 mocks.sqlQuery.mockImplementation(async(sql:string)=>sql.includes("select ga.*")?[{
  id:"account",email:"sender@example.test",daily_limit:20,effective_daily_limit:5,ai_score:null,
  last_deliverability_score:"75",last_scored_at:"2026-11-03T06:00:00Z",
  bobwork_history:[{at:"2026-11-05T06:00:00Z",metrics:{email:"hidden@example.test",signature:"private content",spam_rate_7d_pct:0,last_7_days:{sent:10,errors:0}}}]
 }]:[]);
 const accounts=(await loadDashboard()).gmailAccounts as Array<Record<string,unknown>>;
 expect(accounts[0].deliverabilityScore).toBeNull();expect(accounts[0].lastScoredDeliverability).toEqual({score:75,at:"2026-11-03T06:00:00.000Z"});
 expect(accounts[0].effectiveDailyLimit).toBe(5);
 expect(accounts[0].bobworkHistory).toEqual([{at:"2026-11-05T06:00:00.000Z",spamRate7d:0,sent7d:10,errors7d:0}]);
 expect(JSON.stringify(accounts)).not.toMatch(/hidden@example|private content/);
});

beforeEach(() => {
  rows = [{ id: "p1", campaign_id: "c1", output_sequence: sequence("passe 1"), iteration_completed_at: "2026-10-29T09:00:00Z", writing_iterations_completed: 1, writing_iterations_total: 5 }];
  messages = [];
  mocks.sqlQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("select p.id::text")) return rows;
    if (sql.includes("select distinct on (conv.campaign_id")) return messages;
    if (sql.includes("select distinct on (campaign_id, step)")) return [{ campaign_id: "c1", step: "J0", subject: "Modèle générique", body: "Texte générique" }];
    return [];
  });
});

describe("prospect content displayed by dashboard", () => {
  it("exposes the creation timestamp used for chronological sorting", async () => {
    rows[0].created_at = "2026-10-30T10:30:00+02:00";
    const [p] = await displayed();
    expect(p.createdAt).toBe("2026-10-30T08:30:00.000Z");
  });
  it("prioritizes a received reply over the next approved follow-up without hiding the sent initial", async () => {
    rows[0].has_reply = true;
    messages = [
      { campaign_id: "c1", prospect_id: "p1", step: "J0", content_version: 6, status: "smtp_accepted", technical_confirmation: true, smtp_accepted_at: "2026-10-30T07:00:00Z" },
      { campaign_id: "c1", prospect_id: "p1", step: "R1", content_version: 6, status: "approved" },
    ];
    const [p] = await displayed();
    expect(p.messageStatus).toBe("received");
    expect(p.statusStep).toBeNull();
    expect(p.lastSentStep).toBe("J0");
  });
  it("shows every intermediate pass before final messages exist", async () => {
    for (const pass of [1, 2, 3, 4, 5]) {
      rows[0].output_sequence = sequence(`passe ${pass}`);
      rows[0].writing_iterations_completed = pass;
      const [p] = await displayed();
      expect(p.subject).toBe(`Objet passe ${pass}`);
      expect(p.messages).toEqual(sequence(`passe ${pass}`).steps);
      expect(p.writingIterationsCompleted).toBe(pass);
    }
  });

  it("never replaces missing personalized content with campaign templates", async () => {
    rows[0].output_sequence = null;
    const [p] = await displayed();
    expect(p.subject).toBe("");
    expect(p.messages).toEqual(["", "", "", "", "", ""]);
  });

  it("keeps later manual or plugin revisions and the existing draft status", async () => {
    rows[0].message_status = "draft";
    messages = sequence("révision").steps.map((body, i) => ({ campaign_id: "c1", prospect_id: "p1", step: ["J0", "R1", "R2", "R3", "R4", "R5"][i], subject: "Objet modifié", body_text: body, created_at: "2026-10-29T10:00:00Z", content_version: 6, status: "draft" }));
    const [p] = await displayed();
    expect(p.subject).toBe("Objet modifié");
    expect(p.messages).toEqual(sequence("révision").steps);
    expect(p.messageStatus).toBe("draft");
  });

  it("uses a newer iteration instead of older generated content and isolates campaigns", async () => {
    messages = [
      { campaign_id: "c1", prospect_id: "p1", step: "J0", subject: "Ancien", body_text: "Ancien", created_at: "2026-10-28T10:00:00Z" },
      { campaign_id: "other", prospect_id: "p1", step: "R1", subject: "Autre", body_text: "Autre campagne", created_at: "2026-10-30T10:00:00Z" },
    ];
    const [p] = await displayed();
    expect(p.subject).toBe("Objet passe 1");
    expect(p.messages).toEqual(sequence("passe 1").steps);
  });

  it("derives the displayed status from current step versions and retains the sent date", async () => {
    rows[0].message_status = "draft";
    messages = [
      { campaign_id: "c1", prospect_id: "p1", step: "J0", content_version: 6, status: "smtp_accepted", technical_confirmation: true, smtp_accepted_at: "2026-10-29T15:25:12.158Z" },
      { campaign_id: "c1", prospect_id: "p1", step: "R1", content_version: 6, status: "scheduled" },
    ];
    const [p] = await displayed();
    expect(p.messageStatus).toBe("scheduled");
    expect(p.statusStep).toBe("R1");
    expect(p.lastSentStep).toBe("J0");
    expect(p.lastSentAt).toBe("2026-10-29T15:25:12.158Z");
  });

  it("keeps sent and in-flight content authoritative even with a newer output", async () => {
    for (const status of ["smtp_accepted", "sending", "reserved", "uncertain", "sent_manually"]) {
      messages = [{ campaign_id: "c1", prospect_id: "p1", step: "J0", subject: "Objet envoyé", body_text: "Texte envoyé", created_at: "2026-10-28T10:00:00Z", status }];
      expect((await displayed())[0].messages[0]).toBe("Texte envoyé");
    }
  });
});

it("carries reading measurements to campaign and variant statistics with equal prospect weights",async()=>{
 mocks.sqlQuery.mockImplementation(async(sql:string)=>{
  if(sql.includes("select c.*"))return [{id:"c1",reading_time_enabled:true}];
  if(sql.includes("from app.experiments experiment"))return [{id:"e1",campaign_id:"c1"}];
  if(sql.includes("from app.experiment_variants v"))return [{id:"a",experiment_id:"e1",code:"A"},{id:"b",experiment_id:"e1",code:"B"}];
  if(sql.includes("select * from agent_api.reading_metrics"))return [
   {campaign_id:"c1",variant_id:"a",samples:"2",measured_prospects:"1",reading_time_seconds:"7",capped_samples:"1"},
   {campaign_id:"c1",variant_id:"b",samples:"3",measured_prospects:"3",reading_time_seconds:"19",incompatible_messages:"2"},
  ];return [];
 });
 const data=await loadDashboard() as {campaigns:Array<{readingTimeEnabled:boolean;stats:{engagement:{reading:{meanSeconds:number;samples:number;cappedSamples:number}}}}>;experiments:Array<{variants:Array<{engagement:{reading:{meanSeconds:number}}}>}>};
 expect(data.campaigns[0].readingTimeEnabled).toBe(true);
 expect(data.campaigns[0].stats.engagement.reading).toMatchObject({meanSeconds:16,samples:5,cappedSamples:1});
 expect(data.experiments[0].variants.map(v=>v.engagement.reading.meanSeconds)).toEqual([7,19]);
});

it.each([
 [JSON.stringify({subject:"Objet personnalisé",body:"Consignes premier email"}),"Objet personnalisé","Consignes premier email"],
 ["Consignes historiques en texte brut","","Consignes historiques en texte brut"],
 ['"Consignes écrites entre guillemets"',"",'"Consignes écrites entre guillemets"'],
 ["null","","null"],
 [JSON.stringify({body:""}),"",""],
])("reloads first-email instructions without losing legacy or explicitly empty content (%s)",async(instructions,subject,body)=>{
 mocks.sqlQuery.mockImplementation(async(sql:string)=>{
  if(sql.includes("select c.*"))return [{id:"c1"}];
  if(sql.includes("select distinct on (campaign_id, step)"))return [{campaign_id:"c1",step:"J0",subject:"Modèle objet",body:"Modèle message",instructions},{campaign_id:"c1",step:"R1",body:"Relance",instructions:"Consignes R1"}];
  return [];
 });
 const data=await loadDashboard() as {campaigns:Array<{sequence:{subjectInstructions:string;stepInstructions:string[]}}>};
 expect(data.campaigns[0].sequence.subjectInstructions).toBe(subject);
 expect(data.campaigns[0].sequence.stepInstructions).toEqual([body,"Consignes R1","","","",""]);
});

it("returns the persisted version and partial overrides of each A/B variant for safe editing",async()=>{
 mocks.sqlQuery.mockImplementation(async(sql:string)=>{
  if(sql.includes("from app.experiments experiment"))return [{id:"e1",campaign_id:"c1"}];
  if(sql.includes("from app.experiment_variants v"))return [{id:"a",experiment_id:"e1",code:"A",version:"7",overrides:{initial:{bodyInstructions:"Instructions A"}}}];
  return [];
 });
 const data=await loadDashboard() as {experiments:Array<{variants:Array<{version:number;overrides:unknown}>}>};
 expect(data.experiments[0].variants[0]).toMatchObject({version:7,overrides:{initial:{bodyInstructions:"Instructions A"}}});
});

it("distinguishes an unavailable A/B history from a genuine zero and exposes retry errors",async()=>{
 rows[0].writing_progress_known=false;rows[0].writing_iteration_status="unknown";
 rows[0].writing_iterations_completed=0;rows[0].output_sequence=null;
 const [unknown]=await displayed();expect(unknown.writingProgressKnown).toBe(false);
 expect(unknown.writingIterationStatus).toBe("unknown");expect(unknown.subject).toBe("");
 rows[0].writing_progress_known=true;rows[0].writing_iteration_status="pending";
 rows[0].writing_iteration_error="invalid_prospect_iteration_sequence";
 const [failed]=await displayed();expect(failed.writingProgressKnown).toBe(true);
 expect(failed.writingIterationError).toBe("invalid_prospect_iteration_sequence");
});
