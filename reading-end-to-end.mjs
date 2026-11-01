// Synthetic messages exist only on the isolated Neon branch. No SMTP.
const base='https://reading-duration-validation--prospection-95.netlify.app';
const tokens=["eyJ2IjoxLCJrIjoib3BlbiIsIm0iOiJlZmU4ZTc2MS05ZTNiLTQyNjAtYTkxYy00OWE1ZDc1NTMwYWYiLCJlIjoxNzkzNTQ4OTYxfQ.TXqRZsDDY2SefIlNt1epAbb-qgtl6jUarCE6-w_0Tgs", "eyJ2IjoxLCJrIjoib3BlbiIsIm0iOiJlOTBmNTg5ZS1jOGI0LTQzMWUtOGU2ZC03OGQwZjkzYjI4OWMiLCJlIjoxNzkzNTQ4OTYxfQ.rEQvJK71TRr97Ov_Ce3ugejuRfbySE0VMGymj_QUDgE", "eyJ2IjoxLCJrIjoib3BlbiIsIm0iOiIxZjhmZmEwNC1iMjg5LTQ5NDEtYjAyNC1kMTVhMjhkNjViY2QiLCJlIjoxNzkzNTQ4OTYxfQ.86NkQMBy9pQYL9ESl_aZRfeScD9YgvmPwRTpVYnD44Q", "eyJ2IjoxLCJrIjoib3BlbiIsIm0iOiJiZDI0YjU0MC04NmM4LTQyZmUtOWM0Mi02MmU4ZWE3NTU2MjUiLCJlIjoxNzkzNTQ4OTYxfQ.Iea-C0OBOAL-Qgpi0ipq54_twoV3bj7dstMUeX5Vc5A", "eyJ2IjoxLCJrIjoib3BlbiIsIm0iOiI0ZDI4OGRiZS0zYjEwLTRiYjYtYTFlMy1jMGJiY2Y5M2ZiZWIiLCJlIjoxNzkzNTQ4OTYxfQ.C41ilSJIf1lEFNM53NMp9hUfdAPVEuOgpqx3H6NpyKU"];
const cases=[{i:3,ua:'GoogleImageProxy',ms:3000},{i:4,ua:'Mozilla/5.0 AppleWebKit/605.1.15',ms:3000},{i:0,ua:'Mozilla/5.0 Thunderbird/128.0',ms:7400},{i:1,ua:'Mozilla/5.0 Thunderbird/128.0',ms:18000},{i:2,ua:'Mozilla/5.0 Thunderbird/128.0',ms:55000}];
for(const test of cases){
 const ac=new AbortController();const first=performance.now();let timer=setTimeout(()=>ac.abort(),65000),bytes=0,exposed=null;
 try{const response=await fetch(base+'/t/r/'+tokens[test.i],{headers:{'user-agent':test.ua},signal:ac.signal});
  console.log('READING_RESPONSE',test.i,response.status,response.headers.get('content-type'),Math.round(performance.now()-first));
  if(response.status!==200 || response.headers.get('content-type')!=='image/gif')throw new Error('invalid image response');
  clearTimeout(timer);exposed=performance.now();timer=setTimeout(()=>ac.abort(),test.ms);
  const reader=response.body.getReader();while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;}
 }catch(e){if(e.name!=='AbortError')throw e;}finally{clearTimeout(timer);}
 console.log('READING_FINISHED',test.i,bytes,exposed===null?null:Math.round(performance.now()-exposed));
 if(bytes>400)throw new Error('image too large');
 if(test.i>=3 && (bytes>50 || performance.now()-first>5000))throw new Error('incompatible client streamed');
 await new Promise(r=>setTimeout(r,2000));
}
// Forged tokens still return the same tiny fallback without touching Neon.
const invalid=await fetch(base+'/t/r/invalid-signature');if(invalid.status!==200||(await invalid.arrayBuffer()).byteLength>50)throw new Error('invalid-token fallback');
console.log('READING_END_TO_END_COMPLETE');
