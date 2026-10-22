import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {Attachment,Turn} from './types';

export const attachmentLimit=25*1024*1024;
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
export type ContentPart={type:'text';text:string}|{type:'image_url';image_url:{url:string}};

// The renderer supplies bytes, never a path that could read an unrelated local file.
export async function saveAttachment(root:string,chatId:string,name:string,bytes:Uint8Array,prepare:(file:string)=>Promise<{kind:Attachment['kind'];pages?:number;parts:ContentPart[]}>,checkText:(text:string)=>void){
 if(typeof name!=='string'||!name.trim()||name.length>240||/[\\/\x00-\x1f]/.test(name))throw Error('Invalid attachment name.');
 if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>attachmentLimit)throw Error('Choose a file between 1 byte and 25 MB.');
 const id=randomUUID(),folder=path.join(root,id);await fs.mkdir(folder,{recursive:true});
 const source=path.join(folder,'source');await durableWrite(source,bytes);
 const prepared=await prepare(source);
 for(const part of prepared.parts)if(part.type==='text')checkText(part.text);
 const payload=JSON.stringify(prepared.parts);if(Buffer.byteLength(payload)>attachmentLimit)throw Error('The prepared attachment exceeds 25 MB. Use a smaller file.');
 await durableWrite(path.join(folder,'content.json'),payload);
 return {id,chatId,name,size:bytes.length,kind:prepared.kind,pages:prepared.pages,sha256:hash(bytes),contentHash:hash(payload)} satisfies Attachment;
}
async function durableWrite(file:string,value:Uint8Array|string){const handle=await fs.open(file,'wx');try{await handle.writeFile(value);await handle.sync();}finally{await handle.close();}}

export async function attachmentContent(root:string,chatId:string,attachments:Attachment[],native=false):Promise<any[]>{
 const parts:any[]=[];let size=0;
 for(const attachment of attachments){
  if(attachment.chatId!==chatId||! /^[a-f0-9-]{36}$/.test(attachment.id))throw Error('Attachment belongs to another chat.');
  const folder=path.join(root,attachment.id),source=await fs.readFile(path.join(folder,'source')),payload=await fs.readFile(path.join(folder,'content.json'));
  if(hash(source)!==attachment.sha256||hash(payload)!==attachment.contentHash)throw Error('Attachment changed on disk: '+attachment.name+'. Attach it again.');
  size+=payload.length;if(size>attachmentLimit)throw Error('Attachments needed for this conversation exceed 25 MB. Start a new chat with fewer files.');
  parts.push({type:'text',text:'Attached data from this chat: '+JSON.stringify({id:attachment.id,name:attachment.name,kind:attachment.kind,pages:attachment.pages})});
  for(const part of JSON.parse(payload.toString()) as ContentPart[]){
   if(native&&part.type==='image_url'){
    const match=/^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(part.image_url.url);if(!match)throw Error('Invalid prepared image.');
    parts.push({type:'image',source:{type:'base64',media_type:match[1],data:match[2]}});
   }else parts.push(part);
  }
 }
 return parts;
}

export function conversationAttachments(turns:Turn[],current:Turn){
 const own=turns.filter(t=>t.chatId===current.chatId),index=own.findIndex(t=>t.id===current.id);
 return own.slice(0,index+1).flatMap(t=>t.attachments||[]);
}
// Videos go to Google's Gemini models only: Hermes's Gemini adapter is the transport that sends them.
export const readsVideo=(model:string)=>/^api:gemini:gemini-/.test(model);
export function attachmentMismatch(attachments:Attachment[],vision:boolean,model=''){
 if(attachments.some(item=>item.kind==='video')&&!readsVideo(model))return 'This conversation has a video. Videos go to Gemini: connect Gemini in Connections.';
 return attachments.some(item=>item.kind==='image'||item.kind==='pdf')&&!vision?'This conversation has images or PDF pages. Choose a model with image input.':null;
}
