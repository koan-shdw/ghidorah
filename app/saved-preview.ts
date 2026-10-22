import {readChatFile,type ChatFile} from './chat-files';
import {readArtifactFile} from './artifacts';
import {previewMime} from './preview-files';

export async function savedPreviewResponse(request:Request,data:string,row:ChatFile){
 try{
  const relative=decodeURIComponent(new URL(request.url).pathname).slice(1);
  if(!['GET','HEAD'].includes(request.method)||!row.artifact&&relative!==row.name)return new Response('Unavailable',{status:403});
  const bytes=row.artifact?await readArtifactFile(data,row,relative):await readChatFile(data,row);
  const policy=row.artifact?"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src 'self' data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";
  return new Response(request.method==='HEAD'?null:new Uint8Array(bytes),{headers:{'Content-Type':previewMime(relative)||'application/octet-stream','Content-Length':String(bytes.length),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':policy}});
 }catch{return new Response('The saved copy is missing or changed.',{status:410});}
}
