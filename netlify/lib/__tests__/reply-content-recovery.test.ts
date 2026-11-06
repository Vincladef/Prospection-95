import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({query:vi.fn()}));
vi.mock('../db.mts',()=>({sqlQuery:mocks.query}));
import {recoverReplyContent} from '../reply-content-recovery.mts';
beforeEach(()=>mocks.query.mockReset());
it('recovers a historical HTML reply without refetching Gmail or touching its cursor',async()=>{
 mocks.query.mockResolvedValueOnce([{id:'source',body_html:'<p>Votre proposition nous intéresse &amp; merci.</p>'}]).mockResolvedValueOnce([{id:'source'}]);
 expect(await recoverReplyContent()).toBe(1);
 expect(mocks.query.mock.calls[1][1]).toEqual(['source','<p>Votre proposition nous intéresse &amp; merci.</p>','Votre proposition nous intéresse & merci.',true]);
});
it('records an attempted genuinely empty conversion without inventing content',async()=>{
 mocks.query.mockResolvedValueOnce([{id:'empty',body_html:'<html><body><br></body></html>'}]).mockResolvedValueOnce([{id:'empty'}]);
 expect(await recoverReplyContent()).toBe(0);
 expect(mocks.query.mock.calls[1][1].slice(2)).toEqual(['',false]);
});
it('does not report success if a concurrent repair or classification wins',async()=>{
 mocks.query.mockResolvedValueOnce([{id:'source',body_html:'<p>Bonjour</p>'}]).mockResolvedValueOnce([]);
 expect(await recoverReplyContent()).toBe(0);
});
