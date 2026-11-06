import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({box:'',list:vi.fn(),search:vi.fn(),fetch:vi.fn(),lock:vi.fn()}));
vi.mock('../mailbox-gmail.mts',async original=>{const actual=await original<typeof import('../mailbox-gmail.mts')>();return {...actual,withMailboxClient:async(_a:unknown,_b:unknown,run:(c:unknown)=>unknown)=>run({list:m.list,search:m.search,fetchOne:m.fetch,getMailboxLock:m.lock})}});
import {inspectDraftEvidence} from '../draft-evidence.mts';
const input={email:'sender@example.test',credentialId:'credential',messageId:'<draft@test>',sourceId:'<source@test>',recipient:'contact@example.test',body:'Prepared reply'};
beforeEach(()=>{vi.resetAllMocks();m.list.mockResolvedValue([{path:'Sent',specialUse:'\\Sent'},{path:'Drafts',specialUse:'\\Drafts'},{path:'All',specialUse:'\\All'}]);m.lock.mockImplementation(async(box:string)=>{m.box=box;return{release(){}}});m.search.mockImplementation(async()=>m.box==='Sent'?[]:[42]);m.fetch.mockImplementation(async()=>({flags:new Set(),labels:new Set(['\\Drafts']),source:Buffer.from('Message-ID: <draft@test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPrepared reply')}));});
it('confirms an actual draft without turning its own All Mail copy into Sent',async()=>{
 expect(await inspectDraftEvidence(input)).toMatchObject({sent:false,draftUid:42,unsentOwnCopy:true});
});
it('preserves actual Sent evidence and stops before trying to recover a draft',async()=>{
 m.search.mockResolvedValue([99]);m.fetch.mockResolvedValue({flags:new Set(['\\Seen']),labels:new Set(['\\Sent']),source:Buffer.from('Sent')});
 expect(await inspectDraftEvidence(input)).toMatchObject({sent:true,draftUid:null});expect(m.lock).toHaveBeenCalledOnce();
});
it('does not infer success from missing Gmail metadata',async()=>{
 m.fetch.mockResolvedValue(false);await expect(inspectDraftEvidence(input)).rejects.toThrow('draft_evidence_fetch_incomplete');
});
it('also searches the reply parent in Drafts when Gmail rewrote the generated Message-ID',async()=>{
 await inspectDraftEvidence(input);
 expect(m.search.mock.calls[1][0].or).toContainEqual({header:{'In-Reply-To':'<source@test>'},to:'contact@example.test'});
});
