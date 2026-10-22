import fs from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {resolveChatLink} from './chat-links';

const mime:Record<string,string>={'.html':'text/html','.htm':'text/html','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.avif':'image/avif','.ico':'image/x-icon','.pdf':'application/pdf','.mp4':'video/mp4','.webm':'video/webm','.ogg':'audio/ogg','.mp3':'audio/mpeg','.wav':'audio/wav','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf','.wasm':'application/wasm'};
export const previewMime=(file:string)=>mime[path.extname(file).toLowerCase()];
export const previewable=(file:string)=>/\.(html?|pdf|svg|png|jpe?g|gif|webp|avif|mp4|webm|ogg|mp3|wav)$/i.test(file);
export function previewFileResponse(request:Request,base:string,host:string,protectedRoots:string[]=[]):Response{
  try{
    const url=new URL(request.url);
    if(url.protocol!=='tris-preview:'||url.hostname!==host||!['GET','HEAD'].includes(request.method))return new Response('Unavailable',{status:403});
    const link=resolveChatLink(base,url.pathname.slice(1),protectedRoots);if(link.kind!=='file'||link.directory)throw Error('Unavailable');
    const file=path.join(link.root,link.path),type=mime[path.extname(file).toLowerCase()];if(!type)throw Error('Unsupported preview type');
    const size=fs.statSync(file).size,headers=new Headers({'Content-Type':type,'Accept-Ranges':'bytes','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});
    let start=0,end=size-1,status=200;const range=request.headers.get('range');
    if(range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(range);
      if(!match||(!match[1]&&!match[2]))return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});
      if(match[1]){start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}else start=Math.max(0,size-Number(match[2]));
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=size)return new Response(null,{status:416,headers:{'Content-Range':`bytes */${size}`}});
      status=206;headers.set('Content-Range',`bytes ${start}-${end}/${size}`);
    }
    headers.set('Content-Length',String(Math.max(0,end-start+1)));
    // Each file is served from the explicitly opened document's directory. No
    // app preload, account files, filesystem listing or external file scheme.
    return new Response(request.method==='HEAD'||!size?null:Readable.toWeb(fs.createReadStream(file,{start,end})) as ReadableStream,{status,headers});
  }catch{return new Response('This file is unavailable for preview.',{status:403});}
}
