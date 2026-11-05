import {beforeEach,expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({one:vi.fn(),query:vi.fn(),audit:vi.fn()}));
vi.mock("../db.mts",()=>({sqlOne:mocks.one,sqlQuery:mocks.query,pingDatabase:vi.fn()}));
vi.mock("../auth.mts",()=>({requireAdmin:async()=>({email:"test@example.invalid",subject:"test"})}));
vi.mock("../audit.mts",()=>({auditEvent:mocks.audit}));
import handler from "../../functions/api.mts";
const id="11111111-1111-4111-8111-111111111111";
const patch=(path:string,body:unknown)=>new Request(`https://example.test/api/${path}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();mocks.one.mockReset();mocks.query.mockResolvedValue([]);});
it("saves the first-email body instructions separately from the subject and preserves follow-up instructions",async()=>{
 mocks.one.mockResolvedValueOnce({id,version:1}).mockResolvedValueOnce({id,version:2});
 const response=await handler(patch(`campaigns/${id}`,{name:"Fixture",status:"inactive",version:1,sequence:{subject:"Objet",subjectInstructions:"Consignes objet",steps:["J0","R1","R2","R3","R4","R5"],stepInstructions:["Consigne J0 d’aujourd’hui","I1","I2","I3","I4","I5"]}}),{} as never);
 expect(response.status).toBe(200);
 const messages=JSON.parse(mocks.one.mock.calls[1][1][17]);
 expect(JSON.parse(messages[0].instructions)).toEqual({subject:"Consignes objet",body:"Consigne J0 d’aujourd’hui"});
 expect(messages.slice(1).map((m:{instructions:string})=>m.instructions)).toEqual(["I1","I2","I3","I4","I5"]);
});
it("includes the expected version in the variant update and returns its new version",async()=>{
 mocks.one.mockResolvedValueOnce({id,label:"A",version:4});
 const overrides={initial:{bodyInstructions:"Consignes A"}};
 const response=await handler(patch(`experiment-variants/${id}`,{version:3,overrides}),{} as never);
 expect(response.status).toBe(200);expect(await response.json()).toMatchObject({variant:{version:4}});
 expect(mocks.one.mock.calls[0][1]).toEqual([id,null,null,JSON.stringify(overrides),3]);
});
it("keeps a conflicting or already exposed variant unchanged",async()=>{
 mocks.one.mockResolvedValueOnce(null);
 const response=await handler(patch(`experiment-variants/${id}`,{version:2,overrides:{initial:{bodyInstructions:"Nouvelle saisie"}}}),{} as never);
 expect(response.status).toBe(409);expect(mocks.audit).not.toHaveBeenCalled();
});

it("creates B from the effective A reference, merging only the explicitly requested differences",async()=>{
 mocks.one.mockResolvedValueOnce({campaign_version:7,target_description:"Public",writing_iteration_instructions:["Passe"],reply_iteration_instructions:["Répondre"],sequence_payload:{subject:"Objet initial",subjectInstructions:"Objet instructions",steps:["J0","R1","R2","R3","R4","R5"],stepInstructions:["I0","I1","I2","I3","I4","I5"]},reference_id:id,reference_version:4,reference_overrides:{initial:{bodyInstructions:"Instructions A1"},search:{criteria:"Public A1"}}}).mockResolvedValueOnce({id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",label:"B",name:"Version B"});
 const request=new Request(`https://example.test/api/experiments/${id}/variants`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({overrides:{subject:{subject:"Objet B1"}}})});
 const response=await handler(request,{} as never);
 expect(response.status).toBe(201);
 const params=mocks.one.mock.calls[1][1];
 expect(JSON.parse(params[3])).toMatchObject({initial:{body:"J0",bodyInstructions:"Instructions A1"},subject:{subject:"Objet B1",subjectInstructions:"Objet instructions"},search:{criteria:"Public A1"},iterations:{draftPasses:["Passe"]},reply:{replyIterations:["Répondre"]}});
 expect(params.slice(4)).toEqual([7,id,4]);
});

it("rejects variant creation if the reference changes before its snapshot is stored",async()=>{
 mocks.one.mockResolvedValueOnce({campaign_version:7,target_description:"Public",writing_iteration_instructions:["Passe"],reply_iteration_instructions:["Répondre"],sequence_payload:{subject:"Objet",subjectInstructions:"",steps:["J0","R1","R2","R3","R4","R5"],stepInstructions:["","","","","",""]},reference_id:id,reference_version:4,reference_overrides:{}}).mockResolvedValueOnce(null);
 const response=await handler(new Request(`https://example.test/api/experiments/${id}/variants`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"}),{} as never);
 expect(response.status).toBe(409);expect(mocks.audit).not.toHaveBeenCalled();
});
