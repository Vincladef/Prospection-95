import { Readable } from "node:stream";
import SMTPConnection from "nodemailer/lib/smtp-connection";

/** The SMTP DATA terminator is emitted only after the last safety check.
 * Throwing before EOF closes the socket without committing the message.
 */
export async function sendWithCommitGate(connection: SMTPConnection, envelope: {from:string;to:string[]}, raw:Buffer,
  guard:()=>Promise<boolean>): Promise<{accepted:string[];rejected:string[];response:string}> {
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(error:Error|null,info?:{accepted:string[];rejected:string[];response:string})=>{
      if(settled)return;settled=true;connection.removeListener("error",onError);connection.close();
      if(error)reject(error);else resolve(info!);
    };
    const onError=(error:Error)=>finish(error);
    connection.on("error",onError);
    const stream=Readable.from((async function*(){
      yield raw;
      // DATA bytes can be transmitted, but cannot be delivered until the final dot.
      if(!await guard())throw Object.assign(new Error("SMTP commit blocked"),{code:"PRECOMMIT_BLOCKED"});
    })());
    stream.once("error",onError);
    connection.send(envelope,stream,(error,info)=>finish(error,info));
  });
}
