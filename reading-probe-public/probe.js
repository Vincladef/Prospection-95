const ids=["9c8b726b-8cb1-4ccc-a1c7-4364ec7e6200", "c3105799-a7d7-4fae-b3a7-45a482584062", "70ad6abc-f058-40ba-9305-f113a2bee306", "c242746f-29f6-40ac-bf87-177686f1f9e6"];
const log=document.querySelector('#log');const print=x=>log.textContent+='\n'+x;
(async()=>{
 for(let i=0;i<3;i++){
  const id=ids[i];const ms=[7000,18000,52000][i];const ac=new AbortController();const start=performance.now();let bytes=0;
  const timer=setTimeout(()=>ac.abort(),ms);
  try{const r=await fetch('/p/stream/'+id,{signal:ac.signal,cache:'no-store'});print('En-têtes reçus en '+Math.round(performance.now()-start)+' ms');const reader=r.body.getReader();while(true){const v=await reader.read();if(v.done)break;bytes+=v.value.length;}}catch(e){print('Arrêt client '+e.name+' à '+Math.round(performance.now()-start)+' ms, '+bytes+' octets');}finally{clearTimeout(timer);}
  await new Promise(r=>setTimeout(r,3000)); print('Serveur '+JSON.stringify(await (await fetch('/p/result/'+id,{cache:'no-store'})).json()));
 }
 print('Terminé');
})();