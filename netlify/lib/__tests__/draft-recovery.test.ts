import{beforeEach,expect,it,vi}from'vitest';const m=vi.hoisted(()=>({one:vi.fn(),query:vi.fn(),inspect:vi.fn()}));
vi.mock('../db.mts',()=>({sqlOne:m.one,sqlQuery:m.query}));vi.mock('../draft-evidence.mts',()=>({inspectDraftEvidence:m.inspect}));
import{recoverFalseSentDraft}from'../draft-recovery.mts';
const candidate={id:'draft',false_message_id:'false-message',email:'sender@example.test',credential_id:'private',recipient:'contact@example.test',source_id:'<source>',proposed_body:'Reply'};
beforeEach(()=>{vi.resetAllMocks();m.one.mockResolvedValue(candidate);m.query.mockResolvedValue([])});
it('only retracts false Sent evidence after live Gmail confirms an unsent own copy',async()=>{
 m.inspect.mockResolvedValue({sent:false,draftUid:42,unsentOwnCopy:true,labels:['\\Drafts']});await recoverFalseSentDraft();expect(m.query.mock.calls.some(([sql])=>sql.includes('with target as'))).toBe(true);
});
it.each([{sent:true,draftUid:null,unsentOwnCopy:false},{sent:false,draftUid:null,unsentOwnCopy:false}])('never reopens a sent or unconfirmed draft (%j)',async result=>{
 m.inspect.mockResolvedValue(result);await recoverFalseSentDraft();expect(m.query.mock.calls.some(([sql])=>sql.includes('with target as'))).toBe(false);
});
