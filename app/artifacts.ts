import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {Backend} from './backend';
import type {Store} from './store';
import type {Chat,Turn} from './types';
import type {ChatFile,ChatOutput} from './chat-files';
import {protectedChatPath} from './chat-links';
import {outputPreview} from './message-previews';

export interface Artifact {entry:string;files:{path:string;size:number;sha256:string}[];}
const limit=100*1024*1024,hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const skipped=new Set(['.git','node_modules','.venv','venv','__pycache__']);
function member(value:unknown):string{
 if(typeof value!=='string'||!value||value.includes('\\')||value.split('/').some(part=>!part||part==='.'||part==='..'||/[<>:"|?*\x00-\x1f\x7f]/.test(part)||/[. ]$/.test(part)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))||protectedChatPath(value))throw Error('Artifact paths must be relative, portable files without private account configuration.');
 return value;
}
async function inventory(base:string,signal:AbortSignal):Promise<string[]>{
 const files:string[]=[];let bytes=0;
 const walk=async(relative:string)=>{for(const entry of await fs.readdir(path.join(base,relative),{withFileTypes:true})){
  signal.throwIfAborted();if(skipped.has(entry.name.toLowerCase()))continue;const name=member(relative?relative+'/'+entry.name:entry.name),absolute=path.join(base,name),real=await fs.realpath(absolute),stat=await fs.lstat(absolute);
  if(real.toLowerCase()!==absolute.toLowerCase()||stat.isSymbolicLink())throw Error('Artifact folders cannot contain file links or junctions.');
  if(stat.isDirectory())await walk(name);else if(stat.isFile()){bytes+=stat.size;files.push(name);if(files.length>1000||bytes>limit)throw Error('Save an artifact with up to 1,000 files and 100 MB of content.');}else throw Error('Artifact folders may contain only regular files.');
 }};await walk('');return files.sort();
}
export async function saveArtifact(store:Store,backend:Backend,turn:Turn,root:string,folder:string,entryValue:unknown,check:(text:string)=>void,signal:AbortSignal){
 const entry=member(entryValue??'index.html');if(!/\.html?$/i.test(entry))throw Error('Choose an HTML entry file for this artifact.');
 if(folder.toLowerCase()===(await fs.realpath(root)).toLowerCase())throw Error('Choose the artifact’s own folder, not the entire working folder.');
 const names=await inventory(folder,signal);if(!names.includes(entry))throw Error('The artifact entry file is missing: '+entry);
 const exports=path.join(backend.dataRoot,'exports'),outputs=path.join(backend.dataRoot,'outputs');for(const base of [exports,outputs]){await fs.mkdir(base,{recursive:true});if((await fs.realpath(base)).toLowerCase()!==base.toLowerCase())throw Error('Saved artifact location changed.');}
 const id=randomUUID(),stage=path.join(exports,id),destination=path.join(outputs,id);await fs.mkdir(stage);const manifest:Artifact={entry,files:[]};
 try{
  for(const name of names){signal.throwIfAborted();const file=path.join(folder,name),real=await fs.realpath(file),stat=await fs.lstat(file);if(real.toLowerCase()!==file.toLowerCase()||!stat.isFile()||stat.size>limit)throw Error('The artifact changed while saving.');const bytes=await fs.readFile(file);check(bytes.toString('utf8'));manifest.files.push({path:name,size:bytes.length,sha256:hash(bytes)});if(manifest.files.reduce((n,f)=>n+f.size,0)>limit)throw Error('Artifact content exceeds 100 MB.');const target=path.join(stage,'files',name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx'});}
  if(JSON.stringify(await inventory(folder,signal))!==JSON.stringify(names))throw Error('The artifact changed while saving.');
  for(const file of manifest.files){signal.throwIfAborted();if(hash(await fs.readFile(path.join(folder,file.path)))!==file.sha256)throw Error('The artifact changed while saving.');}
  const same=store.all<ChatOutput>('chat-output').find(row=>row.turnId===turn.id&&row.originRoot===root&&row.originPath===path.relative(root,folder)&&JSON.stringify(row.artifact)===JSON.stringify(manifest));if(same)return artifactLink(same);
  const packed=await backend.host('chat_export',{staging:stage,contents:'files'},signal);signal.throwIfAborted();if(packed.file!==path.join(stage,'export.zip'))throw Error('Invalid artifact archive location.');const bytes=await fs.readFile(packed.file);if(bytes.length>limit)throw Error('The artifact ZIP exceeds 100 MB.');
  await fs.rename(packed.file,path.join(stage,'source'));signal.throwIfAborted();await fs.rename(stage,destination);
  const chat=store.get<Chat>('chat',turn.chatId),row:ChatOutput={id,blob:id,chatId:chat.parentChatId||chat.id,turnId:turn.id,name:path.basename(folder)+'.zip',size:bytes.length,sha256:hash(bytes),created:Date.now(),model:turn.model,originRoot:root,originPath:path.relative(root,folder),artifact:manifest};store.put('chat-output',row);return artifactLink(row);
 }finally{if((await fs.realpath(stage).catch(()=>'' )).toLowerCase()===stage.toLowerCase())await fs.rm(stage,{recursive:true,force:true});}
}
function artifactLink(row:ChatOutput){return {id:row.id,name:row.name,size:row.size,sha256:row.sha256,link:`[${row.name.replace(/[\[\]\\]/g,'\\$&')}](tris-output:${row.id})`,preview:outputPreview(row.artifact!.entry,row.id),saved:true,artifact:true,entry:row.artifact!.entry,files:row.artifact!.files.length};}
export async function readArtifactFile(data:string,row:ChatFile,relative:unknown){
 const name=member(relative),file=row.artifact?.files.find(file=>file.path===name);if(!file||!/^[a-f0-9-]{36}$/.test(row.blob)||file.size>limit)throw Error('This file is not in the saved artifact.');
 const source=path.join(data,'outputs',row.blob,'files',name);if((await fs.realpath(source)).toLowerCase()!==source.toLowerCase())throw Error('The saved artifact location changed.');const handle=await fs.open(source,'r');try{const stat=await handle.stat();if(!stat.isFile()||stat.size!==file.size)throw Error('The saved artifact file changed.');const bytes=await handle.readFile();if(hash(bytes)!==file.sha256)throw Error('The saved artifact file changed.');return bytes;}finally{await handle.close();}
}
/** Caller owns the chat and validates a fresh destination in the working folder. */
export async function copyArtifact(data:string,row:ChatFile,destination:string,signal:AbortSignal){
 if(!row.artifact||row.artifact.files.length>1000||row.artifact.files.reduce((n,f)=>n+f.size,0)>limit)throw Error('Choose a saved artifact.');const entry=member(row.artifact.entry);if(!row.artifact.files.some(f=>f.path===entry))throw Error('The artifact entry file is missing.');
 const parent=await fs.realpath(path.dirname(destination));if(path.join(parent,path.basename(destination)).toLowerCase()!==destination.toLowerCase())throw Error('The destination folder changed.');
 const stage=await fs.mkdtemp(path.join(parent,'.tris-artifact-'));try{
  for(const file of row.artifact.files){signal.throwIfAborted();const bytes=await readArtifactFile(data,row,file.path),target=path.join(stage,member(file.path));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx'});}
  signal.throwIfAborted();if((await fs.realpath(parent)).toLowerCase()!==parent.toLowerCase())throw Error('The destination folder changed.');if(await fs.lstat(destination).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw Error('Destination already exists. Choose a new directory.');
  await fs.rename(stage,destination);return {directory:destination,entry:path.join(destination,entry),files:row.artifact.files.length,originalUnchanged:true};
 }finally{if((await fs.realpath(stage).catch(()=>'' )).toLowerCase()===stage.toLowerCase())await fs.rm(stage,{recursive:true,force:true});}
}
