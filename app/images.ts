import fs from 'node:fs/promises';
import path from 'node:path';
import schemas from '../plugins/trismegistus-permissions/image-tools.json';
import type {Store} from './store';
import type {Backend} from './backend';
import type {Turn} from './types';
import {newDocumentPath} from './documents';
import {resolveChatLink} from './chat-links';
import {findChatFile,readChatFile,saveChatOutput} from './chat-files';

export const imageTools=schemas.map(tool=>({...tool,_meta:{'anthropic/alwaysLoad':true}}));
export const imageSelection=(store:Store)=>store.all<{id:string;provider:string;model:string}>('settings').find(row=>row.id==='image-provider')||null;
export async function imageSettings(store:Store,backend:Backend,selection?:{provider:string;model:string}|null){
 const info=await backend.host('image_info');
 if(selection!==undefined){
  if(selection===null)store.remove('settings','image-provider');
  else{const provider=info.providers.find((p:any)=>p.id===selection.provider);if(!provider?.connected||!provider.models.includes(selection.model))throw Error('Connect the image supplier and choose an available model.');store.put('settings',{id:'image-provider',provider:selection.provider,model:selection.model});}
 }
 return {...info,selected:imageSelection(store)};
}
export async function imageToolCall(store:Store,backend:Backend,turn:Turn,directory:string,name:string,args:any,signal:AbortSignal,refused:()=>void,changed:()=>void){
 signal.throwIfAborted();
 if(name==='image_options')return {...await backend.host('image_info',{},signal),selected:imageSelection(store)};
 if(name!=='generate_image')throw Error('Unknown image tool.');
 let submitted=false;
 try{
  const selection=imageSelection(store);if(!selection)throw Error('Choose the image provider in Settings > Images, then request the image.');
  let destination=await newDocumentPath(directory,backend.dataRoot,args?.destination);
  if(path.extname(destination).toLowerCase()!=='.png')throw Error('Choose a new .png destination.');
  if(typeof args?.prompt!=='string'||!args.prompt.trim()||args.prompt.length>16000)throw Error('Enter an image prompt between 1 and 16,000 characters.');
  const references=args.references||[];if(!Array.isArray(references)||references.length>4||references.some((r:any)=>typeof r!=='string'))throw Error('Use up to four reference image paths or Chat files IDs.');
  const sources:string[]=[];let size=0;
  for(const reference of references){
   let bytes:Buffer;
   if(/^(upload|output):/.test(reference))bytes=await readChatFile(backend.dataRoot,findChatFile(store,turn.chatId,reference));
   else{const file=resolveChatLink(directory,reference,[backend.dataRoot]);if(file.kind!=='file'||file.directory)throw Error('Choose a reference image inside the working folder.');const source=path.join(file.root,file.path);if((await fs.stat(source)).size>25*1024*1024)throw Error('Reference images together must be at most 25 MB.');bytes=await fs.readFile(source);}
   size+=bytes.length;if(size>25*1024*1024)throw Error('Reference images together must be at most 25 MB.');sources.push(bytes.toString('base64'));
  }
  signal.throwIfAborted();submitted=true;
  const result=await backend.host('image_generate',{...selection,prompt:args.prompt,aspect:args.aspect,transparent:args.transparent,sources},signal);
  if(result.error){if(result.outcome==='refused'||result.outcome==='finished')refused();throw Error(result.error);}
  signal.throwIfAborted();destination=await newDocumentPath(directory,backend.dataRoot,args.destination);
  const file=await fs.open(destination,'wx');try{await file.writeFile(Buffer.from(result.image,'base64'));await file.sync();}finally{await file.close();}
  const saved=await saveChatOutput(store,backend.dataRoot,turn,directory,{path:destination},()=>{},signal);changed();
  return {...saved,file:destination,provider:result.provider,model:result.model,dimensions:result.size,usage:result.usage,requestId:result.requestId,originalsUnchanged:true};
 }catch(error){if(!submitted)refused();throw error;}
}
