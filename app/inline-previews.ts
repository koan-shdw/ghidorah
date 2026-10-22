import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Store} from './store';
import type {Turn} from './types';
import {resolveChatLink} from './chat-links';
import {findChatFile,readChatFile,type ChatFile} from './chat-files';
import {readArtifactFile} from './artifacts';
import {previewFileResponse,previewMime} from './preview-files';

const image=/\.(png|jpe?g|gif|webp|avif|svg)$/i,html=/\.html?$/i;
const theme='<style>:root{color-scheme:dark;--background:#141413;--foreground:#e8e6dc;--muted-foreground:#99988f;--accent:#c99271;--border:#373733}body{margin:0;font:14px system-ui;background:var(--background);color:var(--foreground)}</style>';
type Entry={turnId:string;base?:string;row?:ChatFile;name:string};
export class InlinePreviews{
 private entries=new Map<string,Entry>();
 constructor(private store:Store,private data:string){}
 async open(turn:Turn,root:string,href:unknown){
  let base:string|undefined,row:ChatFile|undefined,name:string;
  if(typeof href==='string'&&/^tris-output:[a-f0-9-]{36}$/.test(href)){
   row=findChatFile(this.store,turn.chatId,'output:'+href.slice(12));name=row.artifact?.entry||row.name;
   if(row.artifact)await readArtifactFile(this.data,row,name);else await readChatFile(this.data,row);
  }else{
   const link=resolveChatLink(root,href,[this.data]);if(link.kind!=='file'||link.directory)throw Error('Choose a local image or HTML mockup.');
   const file=path.join(link.root,link.path);base=path.dirname(file);name=path.basename(file);
   if((await fs.stat(file)).size>25*1024*1024)throw Error('Inline previews support files up to 25 MB.');
  }
  if(!image.test(name)&&!html.test(name))throw Error('This file has no inline image or HTML preview.');
  const token=randomUUID();this.entries.set(token,{turnId:turn.id,base,row,name});
  // Bound abandoned grants if a renderer closes before sending its cleanup.
  if(this.entries.size>256)this.entries.delete(this.entries.keys().next().value!);
  return {url:'tris-inline://'+token+'/'+name.split('/').map(encodeURIComponent).join('/'),href:base?path.join(base,name):String(href),name,kind:image.test(name)?'image':'html'};
 }
 close(turnId:string,href:string){const url=new URL(href);if(url.protocol==='tris-inline:'&&this.entries.get(url.hostname)?.turnId===turnId)this.entries.delete(url.hostname);}
 async response(request:Request):Promise<Response>{
  try{
   const url=new URL(request.url),entry=this.entries.get(url.hostname);
   if(url.protocol!=='tris-inline:'||!entry||!['GET','HEAD'].includes(request.method))return new Response('Unavailable',{status:403});
   let response:Response;
   if(entry.row){
    const member=decodeURIComponent(url.pathname.slice(1));
    const bytes=entry.row.artifact?await readArtifactFile(this.data,entry.row,member):member===entry.row.name?await readChatFile(this.data,entry.row):null;
    if(!bytes||!previewMime(member))return new Response('Unavailable',{status:403});
    response=new Response(request.method==='HEAD'?null:new Uint8Array(bytes),{headers:{'Content-Type':previewMime(member),'Content-Length':String(bytes.length)}});
   }else{
    if(await fs.realpath(entry.base!)!==entry.base)throw Error('Preview folder changed.');
    const mapped=new URL(request.url);mapped.protocol='tris-preview:';
    response=previewFileResponse(new Request(mapped,{method:request.method,headers:request.headers}),entry.base!,url.hostname,[this.data]);
   }
   if(Number(response.headers.get('Content-Length'))>25*1024*1024){await response.body?.cancel();return new Response('Preview too large',{status:413});}
   const origin='tris-inline://'+url.hostname,headers=new Headers(response.headers);
   headers.set('Content-Security-Policy',`sandbox allow-scripts; default-src 'none'; script-src ${origin} 'unsafe-inline'; style-src ${origin} 'unsafe-inline'; img-src ${origin} data: blob:; font-src ${origin} data:; media-src ${origin} data: blob:; connect-src ${origin}; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`);
   headers.set('Access-Control-Allow-Origin','*');headers.set('Cache-Control','no-store');headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');
   if(request.method==='GET'&&response.ok&&headers.get('Content-Type')?.startsWith('text/html')){
    const text=await response.text(),head=/<head(?:\s[^>]*)?>/i;
    headers.delete('Content-Length');
    return new Response(head.test(text)?text.replace(head,match=>match+theme):theme+text,{headers});
   }
   return new Response(response.body,{status:response.status,headers});
  }catch{return new Response('This preview is missing, changed or outside the allowed folder.',{status:403});}
 }
}
