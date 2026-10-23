// A local stand-in for the share site (FEATURE-SPECS 3): the real Worker code Tris staged in its data folder, run in
// Node with its static files from that folder, notes in an in-memory SQLite (the same SQL D1 runs), and a minimal
// HTMLRewriter for the one thing the Worker uses it for (adding the notes layer to the body).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.txt':'text/plain; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
(globalThis as any).HTMLRewriter??=class{
 private handler:any;
 on(_selector:string,handler:any){this.handler=handler;return this;}
 transform(response:Response){const handler=this.handler;return new Response(new ReadableStream({async start(controller){const html=await response.text();let added='';handler.element({append:(text:string)=>{added+=text;}});controller.enqueue(new TextEncoder().encode(html.replace(/<\/body>/i,added+'</body>')));controller.close();}}),{status:response.status,headers:response.headers});}
};

export async function shareSite(site:string){
 let worker:any=null,db:DatabaseSync|null=null;
 const env={
  ASSETS:{fetch:async(request:Request)=>{
   const pathname=decodeURIComponent(new URL(request.url).pathname),file=path.join(site,'public',pathname.endsWith('/')?pathname+'index.html':pathname);
   if(!file.startsWith(path.join(site,'public')))return new Response('',{status:404});
   try{return new Response(await fs.readFile(file),{headers:{'content-type':types[path.extname(file)]||'application/octet-stream'}});}catch{return new Response('Not found',{status:404});}
  }},
  NOTES:{prepare:(sql:string)=>({bind:(...values:any[])=>({all:async()=>({results:db!.prepare(sql).all(...values)}),run:async()=>db!.prepare(sql).run(...values)})})},
 };
 // The Worker and its database start with the first request, after Tris staged the site.
 const ready=async()=>{if(!worker){worker=(await import(pathToFileURL(path.join(site,'src','worker.js')).href)).default;db=new DatabaseSync(':memory:');db.exec(await fs.readFile(path.join(site,'schema.sql'),'utf8'));}};
 const server=http.createServer(async(req,res)=>{
  try{
   await ready();const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk as Buffer);
   const headers=Object.fromEntries(Object.entries(req.headers).filter(([name])=>!['host','connection','content-length','transfer-encoding'].includes(name))) as Record<string,string>;
   const request=new Request('http://'+req.headers.host+req.url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method!)?undefined:Buffer.concat(chunks)});
   const response:Response=await worker.fetch(request,env);
   res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch(error){res.writeHead(500);res.end(String(error));}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {url:'http://127.0.0.1:'+(server.address() as any).port,close:()=>new Promise<void>(resolve=>server.close(()=>resolve())),db:()=>db};
}
