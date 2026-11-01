const ids=["9c8b726b-8cb1-4ccc-a1c7-4364ec7e6200", "c3105799-a7d7-4fae-b3a7-45a482584062", "70ad6abc-f058-40ba-9305-f113a2bee306", "c242746f-29f6-40ac-bf87-177686f1f9e6"]; const base='https://reading-transport-validation--prospection-95.netlify.app';
const results=[];for(let i=0;i<3;i++){
 const id=ids[i]+'-ci';const ms=[7000,18000,53000][i];const ac=new AbortController();let bytes=0;const start=performance.now();const timer=setTimeout(()=>ac.abort(),ms);
 try{const r=await fetch(base+'/p/stream/'+id,{signal:ac.signal});console.log('PROBE_HEADERS',i,r.status,Math.round(performance.now()-start));const reader=r.body.getReader();while(true){const v=await reader.read();if(v.done)break;bytes+=v.value.length;}}catch(e){console.log('PROBE_ABORT',i,e.name,Math.round(performance.now()-start),bytes);}finally{clearTimeout(timer);}
 await new Promise(r=>setTimeout(r,3000));const server=await (await fetch(base+'/p/result/'+id,{signal:AbortSignal.timeout(10000)})).json();results.push({targetMs:ms,server});console.log('PROBE_SERVER',i,server);
}

await fetch(base+'/p/result/'+ids[3],{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({source:'synthetic-http',results}),signal:AbortSignal.timeout(10000)});
