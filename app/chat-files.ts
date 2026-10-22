import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './store';
import type {Backend} from './backend';
import {saveArtifact,type Artifact} from './artifacts';
import type {Attachment,Chat,Turn} from './types';
import {resolveChatLink} from './chat-links';
import {outputPreview} from './message-previews';

export interface ChatOutput {artifact?:Artifact;id:string;blob:string;chatId:string;turnId:string;name:string;size:number;sha256:string;created:number;model:string;originRoot:string;originPath:string;}
export interface ChatFile {artifact?:Artifact;id:string;name:string;size:number;kind:'upload'|'output';turnId?:string;model?:string;created:number;sha256:string;blob:string;}
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const limit=100*1024*1024;
export const outputTool={name:'save_chat_output',_meta:{'anthropic/alwaysLoad':true},description:'Save a finished file from the working folder in this chat’s Chat files library. Keeps an immutable local copy (up to 100 MB), its source message and model. Use this for deliverables such as reports, charts, documents and generated assets; ordinary source edits do not need registration. Returns a link and, for images or HTML, preview markup. Include the returned preview in your reply to show it inline. For a working-folder HTML mockup use ::preview{file="absolute/path.html"}; it supports local scripts and styles, with network access disabled. For an interactive artifact, save its dedicated folder with an HTML entry, local scripts, styles and assets: up to 1,000 files / 100 MB. Excludes .git, node_modules and Python environments/caches; rejects other private configuration and file links. Each changed save creates a version. Use copy_chat_artifact to revise a saved folder. Does not publish online.',inputSchema:{type:'object',properties:{path:{type:'string',description:'Existing file or dedicated artifact folder, absolute or relative to this task’s working directory.'},entry:{type:'string',description:'For artifact folders, the relative HTML entry file. Defaults to index.html.'}},required:['path'],additionalProperties:false}};

export function chatFiles(store:Store,chatId:string):ChatFile[]{
 const chat=store.get<Chat>('chat',chatId),owned=store.all<Chat>('chat').filter(row=>row.id===chat.id||!chat.parentChatId&&row.parentChatId===chat.id),ids=new Set(owned.map(row=>row.id)),turns=store.all<Turn>('turn').filter(row=>ids.has(row.chatId));
 const uploads=new Map<string,ChatFile>();
 const add=(a:Attachment,turn?:Turn)=>{uploads.set(a.id,{id:'upload:'+a.id,name:a.name,size:a.size,kind:'upload',blob:a.id,sha256:a.sha256,turnId:turn?.id,created:turn?.created||Date.now()});};
 for(const row of turns)for(const a of row.attachments||[])add(a,row);
 for(const a of chat.attachments||[])if(!uploads.has(a.id))add(a);
 const outputs=store.all<ChatOutput>('chat-output').filter(row=>ids.has(store.get<Turn>('turn',row.turnId).chatId)).map(row=>({...row,id:'output:'+row.id,kind:'output' as const}));
 return [...outputs,...uploads.values()].sort((a,b)=>b.created-a.created);
}
export function findChatFile(store:Store,chatId:string,id:unknown){
 if(typeof id!=='string')throw Error('Choose a file from this chat.');
 const chat=store.get<Chat>('chat',chatId),mapped=id.startsWith('output:')?'output:'+(chat.historyAliases?.[id.slice(7)]||id.slice(7)):id;
 const row=chatFiles(store,chatId).find(row=>row.id===mapped);if(!row)throw Error('This file is not part of this chat.');return row;
}
export async function readChatFile(data:string,row:ChatFile){
 if(!/^[a-f0-9-]{36}$/.test(row.blob))throw Error('Invalid saved file.');
 const source=path.join(data,row.kind==='upload'?'attachments':'outputs',row.blob,'source');
 try{
  if((await fs.realpath(source)).toLowerCase()!==source.toLowerCase())throw Error('Saved file location changed.');
  const file=await fs.open(source,'r');try{const stat=await file.stat();if(!stat.isFile()||stat.size!==row.size||stat.size>limit)throw Error('Saved file changed.');const bytes=await file.readFile();if(hash(bytes)!==row.sha256)throw Error('Saved file changed.');return bytes;}finally{await file.close();}
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw Error('The saved copy is missing. The original chat record is retained.');throw error;}
}
export async function saveChatOutput(store:Store,data:string,turn:Turn,root:string,args:any,check:(text:string)=>void,signal:AbortSignal,backend?:Backend){
 signal.throwIfAborted();const target=resolveChatLink(root,args?.path,[data]);if(target.kind!=='file')throw Error('Choose an existing file or artifact folder in the working folder.');if(target.directory){if(!backend)throw Error('Artifact archiving is unavailable.');return saveArtifact(store,backend,turn,target.root,path.join(target.root,target.path),args?.entry,check,signal);}
 const source=path.join(target.root,target.path),file=await fs.open(source,'r');let bytes:Buffer;
 try{const stat=await file.stat();if(!stat.isFile()||stat.size>limit)throw Error('Save a file up to 100 MB.');bytes=await file.readFile();if(bytes.length>limit)throw Error('Save a file up to 100 MB.');}finally{await file.close();}
 check(bytes.toString('utf8'));signal.throwIfAborted();const digest=hash(bytes),chat=store.get<Chat>('chat',turn.chatId),chatId=chat.parentChatId||chat.id;
 const same=store.all<ChatOutput>('chat-output').find(row=>row.turnId===turn.id&&row.originRoot===target.root&&row.originPath===target.path&&row.sha256===digest);
 if(same)return outputLink(same);
 const id=randomUUID(),base=path.join(data,'outputs'),folder=path.join(base,id);await fs.mkdir(folder,{recursive:true});
 if((await fs.realpath(folder)).toLowerCase()!==folder.toLowerCase())throw Error('Saved output location must not be a link.');
 const handle=await fs.open(path.join(folder,'source'),'wx');try{await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
 signal.throwIfAborted();const row:ChatOutput={id,blob:id,chatId,turnId:turn.id,name:path.basename(source),size:bytes.length,sha256:digest,created:Date.now(),model:turn.model,originRoot:target.root,originPath:target.path};store.put('chat-output',row);return outputLink(row);
}
function outputLink(row:ChatOutput){return {id:row.id,name:row.name,size:row.size,sha256:row.sha256,link:`[${row.name.replace(/[\[\]\\]/g,'\\$&')}](tris-output:${row.id})`,preview:outputPreview(row.name,row.id),saved:true};}

export function filePreview(name:string,bytes:Buffer):{kind:string;url?:string;text?:string;message?:string}{
 if(bytes.length>25*1024*1024)return {kind:'file',message:'This file is too large for an inline preview. Save a copy to open it.'};
 const mime=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216?'image/jpeg':/^GIF8[79]a/.test(bytes.subarray(0,6).toString())?'image/gif':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;
 if(mime)return {kind:'image',url:'data:'+mime+';base64,'+bytes.toString('base64')};
 if(bytes.subarray(0,5).toString()==='%PDF-')return {kind:'pdf'};
 try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))return {kind:'text',text:text.slice(0,500000),...(text.length>500000?{message:'Preview shortened. Save a copy for the complete file.'}:{})};}catch{}
 return {kind:'file',message:'Save a copy to open this file in its application.'};
}
