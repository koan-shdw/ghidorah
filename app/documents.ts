import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import schemas from '../plugins/trismegistus-permissions/document-tools.json';
import type {Store} from './store';
import type {Backend} from './backend';
import type {Turn} from './types';
import {chatFiles,findChatFile,readChatFile} from './chat-files';
import {copyArtifact} from './artifacts';
import {protectedChatPath,resolveChatLink} from './chat-links';

export const documentTools=schemas.map(tool=>({...tool,_meta:{'anthropic/alwaysLoad':true}}));
export const documentMutations=new Set(['copy_chat_artifact','copy_chat_file','render_document','recalculate_spreadsheet']);
const inside=(root:string,file:string)=>{const p=path.relative(root,file);return p!==''&&!path.isAbsolute(p)&&p!=='..'&&!p.startsWith('..'+path.sep);};
export async function newDocumentPath(root:string,data:string,value:unknown){
 if(typeof value!=='string'||!value.trim()||/[\x00-\x1f]/.test(value)||/^[/\\]{2}/.test(value))throw Error('Choose a new destination inside the working folder.');
 const base=await fs.realpath(root),target=path.resolve(base,value),parent=await fs.realpath(path.dirname(target));
 if(!inside(base,target)||target.toLowerCase()!==path.join(parent,path.basename(target)).toLowerCase()||target===data||inside(data,target)||protectedChatPath(target)||path.basename(target).includes(':'))throw Error('Choose an unprotected destination inside the working folder.');
 try{await fs.lstat(target);throw Error('Destination already exists. Choose a new file or directory.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 return target;
}
export async function documentToolCall(store:Store,backend:Backend,turn:Turn,directory:string,name:string,args:any,signal:AbortSignal,refused:()=>void=()=>{}){
 signal.throwIfAborted();
 if(name==='document_tools')return backend.host('document_info',{},signal);
 if(name==='list_chat_files')return chatFiles(store,turn.chatId).map(({blob,...row})=>row);
 if(!documentMutations.has(name))throw Error('Unknown document tool.');
 let started=false,destination:string|undefined;
 try{
 destination=await newDocumentPath(directory,backend.dataRoot,args?.destination);
 if(name==='copy_chat_artifact'){const row=findChatFile(store,turn.chatId,args?.id);await readChatFile(backend.dataRoot,row);started=true;return await copyArtifact(backend.dataRoot,row,destination,signal);}
 if(name==='copy_chat_file'){
  const row=findChatFile(store,turn.chatId,args?.id),bytes=await readChatFile(backend.dataRoot,row);signal.throwIfAborted();
  await newDocumentPath(directory,backend.dataRoot,args.destination);
  const file=await fs.open(destination,'wx');started=true;try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
  return {file:destination,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),originalUnchanged:true};
 }
 const source=resolveChatLink(directory,args?.path,[backend.dataRoot]);if(source.kind!=='file'||source.directory)throw Error('Choose a document in the working folder.');
 started=true;return await backend.host('document_render',{root:directory,source:path.join(source.root,source.path),destination,recalculate:name==='recalculate_spreadsheet'},signal);
 }catch(error){
  // Validation and a converter which never created its fresh destination have
  // no file effects. Artifact copies remove their temporary directory on cancellation;
  // only a published destination is a file effect. Keep other partial writes uncertain.
  if(!started||(!signal.aborted||name==='copy_chat_artifact')&&destination&&await fs.lstat(destination).then(()=>false,e=>{if(e.code==='ENOENT')return true;throw e;}))refused();
  throw error;
 }
}
