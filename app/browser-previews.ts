import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {resolveChatLink} from './chat-links';
import {findChatFile,readChatFile} from './chat-files';
import {previewable,previewFileResponse} from './preview-files';
import {savedPreviewResponse} from './saved-preview';
import type {Store} from './store';

type Target={url?:string;file?:string;chatFileId?:string;root?:string;location?:string};
export class BrowserPreviews{
 private servers=new Map<string,Set<http.Server>>();
 constructor(private store:Store,private data:string,private root:()=>string|null,private launch:(url:string)=>Promise<void>){}
 async open(chatId:string,target?:Target){
  if(!target){target=this.store.all<Target&{id:string}>('preview').find(row=>row.id===chatId);if(!target)throw Error('Open a preview first.');if(target.file&&target.root!==this.root())throw Error('The saved preview belongs to a different working folder.');}
  let name:string,respond:(request:Request)=>Response|Promise<Response>;
  const token=randomUUID();
  if(target.chatFileId!==undefined){
   const id=target.chatFileId,row=findChatFile(this.store,chatId,id);if(!row.artifact&&!previewable(row.name))throw Error('This file has no rendered preview.');await readChatFile(this.data,row);name=row.artifact?.entry||row.name;
   respond=request=>savedPreviewResponse(request,this.data,findChatFile(this.store,chatId,id));
  }else if(target.file!==undefined){
   const link=resolveChatLink(this.root(),target.file,[this.data]);if(link.kind!=='file'||link.directory||!previewable(link.path))throw Error('Choose an HTML, PDF, image, audio or video file to preview.');
   const file=path.join(link.root,link.path),base=path.dirname(file);name=path.basename(file);respond=request=>fs.realpathSync(base)===base?previewFileResponse(request,base,token,[this.data]):new Response('Preview folder changed.',{status:403});
  }else{
   let address=typeof target.url==='string'?target.url.trim():'';if(/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(address))address='http://'+address;
   const link=resolveChatLink(null,address);if(link.kind!=='web')throw Error('Enter an HTTP or HTTPS address.');await this.launch(link.url);return;
  }
  let origin='',cookie='';
  const server=http.createServer(async(req,res)=>{
   try{
    if(req.headers.host!==new URL(origin).host||!['GET','HEAD'].includes(req.method||'')){res.writeHead(403).end('Unavailable');return;}
    const url=new URL(req.url!,origin);
    // The launch link grants a private cookie, keeping root-relative assets working too.
    if(url.pathname.startsWith('/'+token+'/')){res.writeHead(303,{'Set-Cookie':cookie+'; HttpOnly; SameSite=Strict; Path=/','Location':origin+url.pathname.slice(token.length+1)+url.search,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}).end();return;}
    if(!req.headers.cookie?.split(/;\s*/).includes(cookie)||req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'){res.writeHead(403).end('Unavailable');return;}
    const request=new Request('tris-preview://'+token+url.pathname+url.search,{method:req.method,headers:req.headers.range?{range:req.headers.range}:{}}),response=await respond(request);
    res.writeHead(response.status,{...Object.fromEntries(response.headers),'Referrer-Policy':'no-referrer'});
    if(!response.body){res.end();return;}
    const body=Readable.fromWeb(response.body as any);body.on('error',()=>res.destroy());res.on('close',()=>body.destroy());body.pipe(res);
   }catch{if(!res.headersSent)res.writeHead(410);res.end('The preview is missing or changed.');}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});});
  const port=(server.address() as {port:number}).port;origin='http://127.0.0.1:'+port;cookie='ghidorah-preview-'+port+'='+token;
  try{await this.launch(origin+'/'+token+(target.location||'/'+name.split('/').map(encodeURIComponent).join('/')));}catch(error){server.closeAllConnections();server.close();throw error;}
  if(!this.servers.has(chatId))this.servers.set(chatId,new Set());this.servers.get(chatId)!.add(server);
 }
 close(chatId:string){for(const server of this.servers.get(chatId)||[]){server.closeAllConnections();server.close();}this.servers.delete(chatId);}
 closeAll(){for(const id of this.servers.keys())this.close(id);}
}
