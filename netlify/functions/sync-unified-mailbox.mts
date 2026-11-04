import type {Config,Context} from "@netlify/functions";
import {randomUUID} from "node:crypto";
import {processMailboxJob,refreshMailboxThread} from "../lib/unified-mailbox-sync.mts";
import {workerFailure,workerResult} from "../lib/worker-response.mts";
export default async function syncUnifiedMailbox(_request:Request,_context:Context):Promise<Response>{
 const worker=`netlify-unified-mail-${randomUUID()}`;
 try{
  let operations=0;for(let i=0;i<3;i++){if(!await processMailboxJob())break;operations++;}
  const refreshed=await refreshMailboxThread();
  return workerResult(worker,{ok:true,operations,refreshed});
 }catch(error){return workerFailure(worker,error);}
}
export const config:Config={schedule:"* * * * *",background:true};
