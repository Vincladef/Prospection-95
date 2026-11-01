import { getStore } from '@netlify/blobs';
const ids = ["9c8b726b-8cb1-4ccc-a1c7-4364ec7e6200", "c3105799-a7d7-4fae-b3a7-45a482584062", "70ad6abc-f058-40ba-9305-f113a2bee306", "c242746f-29f6-40ac-bf87-177686f1f9e6"];
export default async (request) => {
 const url = new URL(request.url); const id=url.pathname.split('/').pop();
 if(!ids.includes(id)) return new Response('Not found',{status:404});
 const store=getStore('reading-transport-probe');
 if(request.method==='POST') {
  const body=await request.json(); await store.setJSON(id,body);return new Response('ok');
 }
 return Response.json(await store.get(id,{type:'json',consistency:'strong'}) ?? {state:'pending'}, {headers:{'cache-control':'no-store'}});
};
export const config={path:'/p/result/:id'};
