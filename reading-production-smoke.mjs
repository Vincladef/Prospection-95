const base='https://prospection-95.netlify.app';
const checks=[{path:'/',status:200,type:'text/html'},{path:'/t/o/invalid-signature',status:200,type:'image/gif'},{path:'/t/r/invalid-signature',status:200,type:'image/gif'},
{path:'/internal/reading-session',method:'POST',body:'{}',status:404},{path:'/api/bootstrap',status:401}];
for(const c of checks){const r=await fetch(base+c.path,{method:c.method??'GET',body:c.body,signal:AbortSignal.timeout(20000)});
 const bytes=(await r.arrayBuffer()).byteLength;
 if(r.status!==c.status || c.type&&!r.headers.get('content-type')?.includes(c.type))throw new Error('production smoke failed '+c.path+' '+r.status);
 if(c.type==='image/gif'&&bytes>50)throw new Error('invalid pixel fallback size');
 console.log('PRODUCTION_SMOKE',c.path,r.status,bytes);
}
console.log('PRODUCTION_SMOKE_OK');
