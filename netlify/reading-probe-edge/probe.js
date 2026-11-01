const ids = ["9c8b726b-8cb1-4ccc-a1c7-4364ec7e6200", "c3105799-a7d7-4fae-b3a7-45a482584062", "70ad6abc-f058-40ba-9305-f113a2bee306", "c242746f-29f6-40ac-bf87-177686f1f9e6"]
export default async (request, context) => {
 const id=new URL(request.url).pathname.split('/').pop();
 if(!ids.includes(id)) return new Response('Not found',{status:404});
 const started=performance.now(); let done=false, tick=0, timer;
 let resolve; const finished=new Promise(r=>resolve=r); context.waitUntil(finished);
 const persist=async(reason)=>{
  if(done)return;done=true;clearInterval(timer);
  try { await fetch(new URL('/p/result/'+id,request.url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason,elapsedMs:Math.round(performance.now()-started),ticks:tick}),signal:AbortSignal.timeout(6000)}); }finally{resolve();}
 };
 let ctrl;
 const stream=new ReadableStream({
  start(controller){
   ctrl=controller;
   controller.enqueue(Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7').slice(0,-1),c=>c.charCodeAt(0)));
   timer=setInterval(()=>{
    tick++;
    try{
     if(tick>=50){controller.enqueue(new Uint8Array([0x3b]));controller.close();void persist('cap');}
     else controller.enqueue(new Uint8Array([0x21,0xfe,0x01,0x20,0]));
    }catch{void persist('write_error');}
   },1000);
  },
  cancel(){void persist('stream_cancel');}
 });
 request.signal.addEventListener('abort',()=>{void persist('request_abort');try{ctrl.close();}catch{}},{once:true});
 return new Response(stream,{headers:{'content-type':'image/gif','cache-control':'no-store, no-transform','x-content-type-options':'nosniff'}});
};
export const config={path:'/p/stream/:id'};
