// @vitest-environment node
import { createServer } from "node:net";
import SMTPConnection from "nodemailer/lib/smtp-connection";
import { expect,it } from "vitest";
import { sendWithCommitGate } from "../smtp-gate.mts";

it.each([false,true])("commits SMTP DATA only after the last check returns %s",async(allow)=>{
 let accepted=0;let bodySeen!:()=>void;const body=new Promise<void>(r=>{bodySeen=r;});
 const sockets=new Set<import("node:net").Socket>();
 const server=createServer(socket=>{
  sockets.add(socket);socket.on("close",()=>sockets.delete(socket));socket.write("220 fixture ESMTP\r\n");
  let buffer="",inData=false;
  socket.on("data",chunk=>{
   buffer+=chunk.toString();
   if(inData){bodySeen();if(buffer.includes("\r\n.\r\n")){accepted++;socket.write("250 accepted\r\n");buffer="";}return;}
   let index:number;while((index=buffer.indexOf("\r\n"))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+2);
    if(line.startsWith("EHLO"))socket.write("250 fixture\r\n");
    else if(line.startsWith("MAIL")||line.startsWith("RCPT"))socket.write("250 OK\r\n");
    else if(line==="DATA"){inData=true;socket.write("354 send data\r\n");}
   }
  });
 });
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 const connection=new SMTPConnection({host:"127.0.0.1",port:(server.address() as import("node:net").AddressInfo).port,secure:false,ignoreTLS:true,logger:false});
 try {
  await new Promise<void>((resolve,reject)=>{connection.once("error",reject);connection.connect(e=>e?reject(e):resolve());});
  const send=sendWithCommitGate(connection,{from:"sender@example.test",to:["recipient@example.test"]},Buffer.from("From: sender@example.test\r\nTo: recipient@example.test\r\n\r\nBody\r\n"),async()=>{
   await body; // Simulates a reply arriving while the body is already in flight.
   expect(accepted).toBe(0);return allow;
  });
  if(allow)await expect(send).resolves.toMatchObject({response:"250 accepted"});
  else await expect(send).rejects.toThrow("SMTP commit blocked");
  expect(accepted).toBe(allow?1:0);
 }finally{connection.close();for(const socket of sockets)socket.destroy();await new Promise<void>(r=>server.close(()=>r()));}
});
